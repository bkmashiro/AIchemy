/**
 * socket/stub.ts — Stub socket.io namespace handler.
 *
 * Unified resume flow: every connection (first / reconnect) uses a single
 * `resume` event. Server reconciles and responds with `resume_response`.
 *
 * Reliable messaging: R-layer for critical S→Stub events.
 */

import { Namespace, Socket } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "crypto";
import { store } from "../store";
import { metricsStore } from "../metrics";
import {
  Stub, Task, TaskStatus,
  ResumePayload, HeartbeatPayload,
  TaskStartedPayload, TaskProgressPayload, TaskLogPayload,
  TaskCompletedPayload, TaskFailedPayload,
  TaskConfigPayload, TaskCheckpointPayload, PreflightFailPayload,
  TaskResourcePayload, TaskMetricsPayload, TaskPhasePayload,
  DeployFileConfig,
} from "../types";
import { maybeDispatch, triggerSchedule, buildRunPayload, computeRunDir, isCheckpointProtected } from "../scheduler";
import { promoteBlockedTasks, cascadeCancellation } from "../dag";
import {
  registerStubSocket, unregisterStubSocket,
  reliableEmitToStub,
} from "../reliable";
import {
  notifySubmitted, notifyDispatched, notifyRunning,
  notifyCompleted, notifyFailed, notifyCancelled,
  notifyGridDone, notifyTaskMessage,
  notifyExperimentPassed, notifyExperimentPartial,
} from "../discord";
import { evaluateCriteria } from "../criteria";
import { deriveExperimentStatus } from "../api/experiments";
import { writeLockTable } from "../dedup";
import { logger } from "../log";
import { ALCHEMY_VERSION } from "../version";
import { startTask, completeTask, failTask, cancelTask, markDisconnected, clearDisconnected, resolveDeadTask, preflightFail, promoteIfAssigned, createRetryTask } from "../task-actions";
import { updateExperimentManifest } from "../git-tracking";

const HEARTBEAT_TIMEOUT_MS = 180_000; // 6 missed × 30s — generous for CF tunnel latency
const DISCONNECT_FAIL_MS = 6 * 3_600_000; // 6 hours — disconnected tasks stay "running" a long time
const REQUEST_SYNC_INTERVAL_MS = 5 * 60_000;

// Module-level stub namespace reference for internal helpers (set in setupStubNamespace)
let _stubNs: Namespace;

// H3: Track per-stub sync intervals to prevent leak on re-resume
const stubSyncIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();

// Map: socket.id → stub_id (for the duration of the connection)
const socketToStub: Map<string, string> = new Map();

// After disconnect: heartbeat timeout before running tasks are failed
// Tasks stay "running" with a disconnected_at flag; only failTask after full timeout
const disconnectFailTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

// ─── Stable stub ID ───────────────────────────────────────────────────────────

/**
 * Compute a stable stub identity hash.
 *
 * Formula: sha256(hostname|user|instance_id|slurm_job_id)[:12]
 *
 * `instance_id` is a stable per-stub discriminator. Workstation stubs use
 * CUDA_VISIBLE_DEVICES so same-host/same-user multi-stub setups do not collide;
 * SLURM stubs use the job id.
 *
 * IMPORTANT: This must match the Python stub's _compute_identity_hash in
 * stub/alchemy_stub/config.py. If you change this, update both sides.
 */
export function computeStubId(hostname: string, user: string = "", instanceId: string = "", slurmJobId: string = ""): string {
  const input = `${hostname}|${user}|${instanceId}|${slurmJobId}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/** Legacy v2.0 identity formula. Keep during rolling upgrades so existing
 * persisted stub rows are reused instead of creating zombie stubs.
 */
export function computeLegacyStubId(
  hostname: string,
  gpu: { name: string; count: number },
  cudaVisibleDevices: string = "",
  user: string = "",
  slurmJobId: string = "",
): string {
  const input = `${hostname}|${cudaVisibleDevices}|${gpu.name}|${gpu.count}|${user}|${slurmJobId}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

// ─── Semantic name generation ─────────────────────────────────────────────────

function generateStubName(hostname: string, gpuName: string, slurmJobId?: string): string {
  const hostnameShort = hostname.split(".")[0];
  // GPU short: "NVIDIA RTX 2080 Ti" → "2080ti", "A40" → "a40"
  const gpuShort = gpuName
    .toLowerCase()
    .replace(/nvidia|geforce|quadro|tesla/gi, "")
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, "")
    .replace(/^rtx/, "")
    .replace(/^gtx/, "");
  const base = `${hostnameShort}-${gpuShort}`;
  return slurmJobId ? `${base}-${slurmJobId}` : base;
}

// ─── Mark running tasks as disconnected (flag only, no status change) ────────

function markTasksDisconnected(stub: Stub, webNs: Namespace): void {
  const tasksSnapshot = [...stub.tasks];
  for (const task of tasksSnapshot) {
    if (["running", "paused"].includes(task.status)) {
      const updated = markDisconnected(stub.id, task.id);
      if (updated) {
        webNs.emit("task.update", updated);
        logger.info("task.disconnected", { task_seq: updated.seq, stub: stub.name });
      }
    }
  }
}

// ─── Fail disconnected running tasks after heartbeat timeout ─────────────────

function failDisconnectedTasks(stub: Stub, webNs: Namespace): void {
  const tasksSnapshot = [...stub.tasks];
  for (const task of tasksSnapshot) {
    if (["running", "paused"].includes(task.status) && task.stub_offline) {
      if (task.should_stop) {
        // Task was being killed — mark as cancelled
        const updated = cancelTask(stub.id, task.id, undefined);
        if (updated) {
          webNs.emit("task.update", updated);
          logger.warn("task.cancelled_on_disconnect", { task_seq: updated.seq, stub: stub.name });
          notifyCancelled(updated).catch(() => {});
        }
      } else {
        const updated = failTask(stub.id, task.id, undefined, { death_cause: "disappeared" });
        if (updated) {
          webNs.emit("task.update", updated);
          logger.warn("task.failed_on_disconnect", { task_seq: updated.seq, stub: stub.name, reason: "heartbeat_timeout" });
          notifyFailed(updated).catch(() => {});
          handleAutoRetry(updated, webNs);
        }
      }
    }
  }
}

function handleAutoRetry(task: Task, webNs: Namespace): void {
  if (task.max_retries > 0 && task.retry_count < task.max_retries) {
    // Dedup: check if a retry already exists for this task (or its retry chain root)
    const retryRoot = task.retry_of || task.id;
    const allTasks = store.getAllTasks();
    const existingRetry = allTasks.find(
      (t) =>
        (t.retry_of === retryRoot || t.retry_of === task.id) &&
        t.id !== task.id &&
        ["pending", "assigned", "running"].includes(t.status),
    );
    if (existingRetry) {
      logger.info("task.retry_dedup", { task_seq: task.seq, existing_retry: existingRetry.seq });
      return;
    }

    const retryTask = createRetryTask(task);
    store.addToGlobalQueue(retryTask);
    webNs.emit("task.update", retryTask);
    logger.info("task.retry", { task_seq: task.seq, new_seq: retryTask.seq, attempt: retryTask.retry_count, max: task.max_retries });
    triggerSchedule();
  }
}

// ─── Check grid completion ────────────────────────────────────────────────────

function checkGridCompletion(gridId: string, webNs: Namespace): void {
  const grid = store.getGrid(gridId);
  if (!grid) return;
  store.updateGridStatus(gridId);
  const updated = store.getGrid(gridId)!;
  webNs.emit("grid.update", updated);

  if (updated.status === "completed" || updated.status === "partial" || updated.status === "failed") {
    const tasks = store.getGridTasks(gridId);
    const completed = tasks.filter((t) => t.status === "completed").length;
    const failed = tasks.filter((t) => ["failed", "cancelled"].includes(t.status)).length;
    const bestLoss = tasks
      .filter((t) => t.status === "completed" && t.progress?.loss !== undefined)
      .reduce((best: { loss: number; params?: Record<string, any> } | null, t) => {
        const loss = t.progress!.loss!;
        if (!best || loss < best.loss) return { loss, params: t.param_overrides };
        return best;
      }, null);

    notifyGridDone({
      name: updated.display_name,
      total: tasks.length,
      completed,
      failed,
      best_loss: bestLoss?.loss,
      best_params: bestLoss?.params,
    }).catch(() => {});
  }
}

// ─── Kill chain ───────────────────────────────────────────────────────────────

const killTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

export function initiateKillChain(
  stubId: string,
  taskId: string,
  gracePeriodS: number = 30
): void {
  // Checkpoint protection: if the task is currently writing a checkpoint,
  // defer the kill to avoid corrupting saved state. The caller should retry later.
  const task = store.getTask(stubId, taskId);
  if (task && isCheckpointProtected(task)) {
    logger.info("task.kill_deferred_checkpoint", { task_id: taskId, stub: stubId });
    const deferTimer = setTimeout(() => initiateKillChain(stubId, taskId, gracePeriodS), 30_000);
    killTimers.set(taskId, deferTimer);
    return;
  }

  // Tell the stub to SIGTERM the task (stub's kill_graceful handles grace + SIGKILL).
  // grace_period_s passed to stub = full grace period before SIGKILL.
  store.updateTask(stubId, taskId, { should_stop: true });
  reliableEmitToStub(stubId, "task.kill", { task_id: taskId, grace_period_s: gracePeriodS });

  // Safety net: if task hasn't transitioned after 2× grace period, send another kill
  const timer = setTimeout(() => {
    killTimers.delete(taskId);
    const task = store.getTask(stubId, taskId);
    if (!task || ["completed", "failed", "cancelled"].includes(task.status)) return;
    reliableEmitToStub(stubId, "task.kill", { task_id: taskId, grace_period_s: 5 });
  }, gracePeriodS * 2 * 1000);

  killTimers.set(taskId, timer);
}

export function cancelKillChain(taskId: string): void {
  const timer = killTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    killTimers.delete(taskId);
  }
}

// ─── Setup stub namespace ─────────────────────────────────────────────────────

export function setupStubNamespace(ns: Namespace, webNs: Namespace, deployConfig?: DeployFileConfig | null): void {
  _stubNs = ns;
  // Heartbeat timeout checker
  setInterval(() => {
    const now = Date.now();
    for (const stub of store.getAllStubs()) {
      if (stub.status !== "online") continue;
      const lastHb = new Date(stub.last_heartbeat).getTime();
      if (now - lastHb > HEARTBEAT_TIMEOUT_MS) {
        logger.warn("stub.offline", { stub: stub.name, reason: "heartbeat_timeout", elapsed_s: Math.floor((now - lastHb) / 1000) });
        stub.status = "offline";
        // Re-queue assigned tasks back to global pending so they can be rescheduled
        const requeued = store.requeueStubTasks(stub.id);
        for (const task of requeued) {
          webNs.emit("task.update", task);
        }
        // Heartbeat timeout = fail running tasks immediately (not just flag them)
        failDisconnectedTasks(stub, webNs);
        // Also fail any tasks that were flagged as disconnected but not yet timed out
        // (this handles the case where heartbeat checker fires before the disconnect timer)
        store.setStub(stub);
        webNs.emit("stub.offline", { stub_id: stub.id });
      }
    }
  }, 30_000);

  ns.on("connection", (socket: Socket) => {
    logger.info("sio.connect", { socket_id: socket.id });

    // ─── Resume ─────────────────────────────────────────────────────────────
    socket.on("resume", (payload: ResumePayload, ack?: Function) => {
      try {
        handleResume(socket, payload, webNs, ns, deployConfig);
        if (ack) ack({ ok: true });
      } catch (err) {
        logger.error("resume.handler_error", { error: String(err) });
      }
    });

    // ─── Stub→Server reliable events (direct, with native ack) ─────────────

    socket.on("task.started", (payload: TaskStartedPayload, ack?: Function) => {
      const stubId = socketToStub.get(socket.id);
      if (stubId) handleTaskStarted(stubId, payload, webNs);
      if (ack) ack({ ok: true });
    });

    socket.on("task.completed", (payload: TaskCompletedPayload, ack?: Function) => {
      const stubId = socketToStub.get(socket.id);
      if (stubId) handleTaskCompleted(stubId, payload, webNs);
      if (ack) ack({ ok: true });
    });

    socket.on("task.failed", (payload: TaskFailedPayload, ack?: Function) => {
      const stubId = socketToStub.get(socket.id);
      if (stubId) handleTaskFailed(stubId, payload, webNs);
      if (ack) ack({ ok: true });
    });

    socket.on("task.config", (payload: TaskConfigPayload, ack?: Function) => {
      const stubId = socketToStub.get(socket.id);
      if (stubId) handleTaskConfig(stubId, payload, webNs);
      if (ack) ack({ ok: true });
    });

    socket.on("task.checkpoint", (payload: TaskCheckpointPayload, ack?: Function) => {
      const stubId = socketToStub.get(socket.id);
      if (stubId) handleTaskCheckpoint(stubId, payload, webNs);
      if (ack) ack({ ok: true });
    });

    socket.on("preflight.fail", (payload: PreflightFailPayload, ack?: Function) => {
      const stubId = socketToStub.get(socket.id);
      if (stubId) handlePreflightFail(stubId, payload, webNs);
      if (ack) ack({ ok: true });
    });

    socket.on("task.zombie", (payload: { task_id: string }, ack?: Function) => {
      const stubId = socketToStub.get(socket.id);
      if (stubId) logger.warn("task.zombie", { stub: stubId, task_id: payload.task_id });
      if (ack) ack({ ok: true });
    });

    socket.on("task.notify", (payload: { task_id: string; message: string; level: string }, ack?: Function) => {
      const stubId = socketToStub.get(socket.id);
      if (stubId) handleTaskNotify(stubId, payload, webNs);
      if (ack) ack({ ok: true });
    });

    socket.on("task.phase", (payload: TaskPhasePayload, ack?: Function) => {
      const stubId = socketToStub.get(socket.id);
      if (stubId) handleTaskPhase(stubId, payload, webNs);
      if (ack) ack({ ok: true });
    });

    socket.on("task.export", (payload: { task_id: string; key: string; value: any }, ack?: Function) => {
      const stubId = socketToStub.get(socket.id);
      if (!stubId) { if (ack) ack({ ok: false }); return; }
      const task = store.getTask(stubId, payload.task_id);
      if (!task) { if (ack) ack({ ok: false }); return; }
      const exports = { ...(task.exports || {}), [payload.key]: payload.value };
      const updated = store.updateTask(stubId, payload.task_id, { exports });
      if (updated) webNs.emit("task.update", updated);
      if (ack) ack({ ok: true });
    });

    // ─── Non-reliable events ────────────────────────────────────────────────

    socket.on("heartbeat", (payload: HeartbeatPayload) => {
      const stubId = socketToStub.get(socket.id);
      if (!stubId) return;
      const stub = store.getStub(stubId);
      if (!stub) return;
      stub.last_heartbeat = payload.timestamp || new Date().toISOString();
      stub.last_seen = stub.last_heartbeat;
      store.setStub(stub);
    });

    socket.on("gpu_stats", (payload: import("../types").GpuStats) => {
      const stubId = socketToStub.get(socket.id);
      if (!stubId) return;
      const stub = store.getStub(stubId);
      if (!stub) return;
      stub.gpu_stats = payload;
      store.setStub(stub);
      webNs.emit("gpu_stats", { stub_id: stubId, stats: payload });
      if (payload.gpus?.length > 0) {
        metricsStore.pushStubMetrics(stubId, payload.gpus);
      }
    });

    socket.on("system_stats", (payload: import("../types").SystemStats) => {
      const stubId = socketToStub.get(socket.id);
      if (!stubId) return;
      const stub = store.getStub(stubId);
      if (!stub) return;
      stub.system_stats = payload;
      store.setStub(stub);
      webNs.emit("system_stats", { stub_id: stubId, stats: payload });
    });

    socket.on("task.progress", (payload: TaskProgressPayload) => {
      const stubId = socketToStub.get(socket.id);
      if (!stubId) return;
      const existing = store.getTask(stubId, payload.task_id);
      if (!existing) return;
      // Auto-promote dispatched → running
      promoteIfAssigned(stubId, payload.task_id);
      const updated = store.updateTask(stubId, payload.task_id, {
        progress: { step: payload.step, total: payload.total, loss: payload.loss, metrics: payload.metrics },
      });
      if (updated) {
        webNs.emit("task.update", updated);
        metricsStore.pushTaskMetrics(payload.task_id, payload.step, payload.loss, payload.metrics);
      }
    });

    socket.on("task.log", (payload: TaskLogPayload) => {
      const stubId = socketToStub.get(socket.id);
      if (!stubId) return;
      const task = store.getTask(stubId, payload.task_id);
      if (!task) return;
      // Auto-promote dispatched → running
      promoteIfAssigned(stubId, payload.task_id);
      const freshTask = store.getTask(stubId, payload.task_id);
      if (!freshTask) return;
      const buf = freshTask.log_buffer;
      buf.push(...payload.lines);
      if (buf.length > 500) buf.splice(0, buf.length - 500);
      store.updateTask(stubId, payload.task_id, { log_buffer: buf });
      webNs.emit("task.log", { stub_id: stubId, task_id: payload.task_id, lines: payload.lines });
    });

    socket.on("task.resource", (payload: TaskResourcePayload) => {
      // Resource stats — forward to web, no state update needed
      const stubId = socketToStub.get(socket.id);
      if (!stubId) return;
      webNs.emit("task.resource", { stub_id: stubId, ...payload });
    });

    socket.on("task.metrics", (payload: TaskMetricsPayload) => {
      const stubId = socketToStub.get(socket.id);
      if (!stubId) return;
      const { task_id, metrics, step } = payload;
      if (!task_id || !metrics || step === undefined) return;
      // Buffer in metricsStore (ephemeral) and snapshot onto task state for restart-safe reads.
      metricsStore.pushTaskMetricsDirect(task_id, step, metrics);
      const task = store.getTask(stubId, task_id);
      if (task) {
        const nextBuffer: Record<string, Array<{ step: number; value: number; ts: string }>> = { ...(task.metrics_buffer || {}) };
        const ts = new Date().toISOString();
        for (const [key, value] of Object.entries(metrics)) {
          const existing = Array.isArray(nextBuffer[key]) ? nextBuffer[key] : [];
          nextBuffer[key] = [...existing, { step, value, ts }].slice(-500);
        }
        const updated = store.updateTask(stubId, task_id, { metrics_buffer: nextBuffer });
        if (updated) webNs.emit("task.update", updated);
      }
      // Forward to web clients
      webNs.emit("task.metrics", { task_id, metrics, step });
    });

    socket.on("task.eval", (payload: { task_id: string; metrics: Record<string, number> }, ack?: Function) => {
      const stubId = socketToStub.get(socket.id);
      if (!stubId) { if (ack) ack({ ok: false }); return; }

      const task = store.getTask(stubId, payload.task_id);
      if (!task) { if (ack) ack({ ok: false }); return; }

      // Store eval metrics on the task + auto-export
      const evalExports = { ...(task.exports || {}) };
      for (const [k, v] of Object.entries(payload.metrics)) {
        evalExports[`eval_${k}`] = v;
      }
      store.updateTask(stubId, payload.task_id, {
        eval_metrics: payload.metrics,
        exports: evalExports,
      });

      // Check experiment criteria
      if (task.grid_id) {
        const exp = store.getExperimentByGridId(task.grid_id);
        if (exp) {
          const prevStatus = exp.status;
          const result = evaluateCriteria(exp.criteria, payload.metrics);
          exp.results[payload.task_id] = {
            passed: result.passed,
            checked_at: new Date().toISOString(),
            details: result.details,
          };
          exp.status = deriveExperimentStatus(exp);
          store.setExperiment(exp);
          webNs.emit("experiment.update", exp);

          // Discord notification on status change
          if (exp.status !== prevStatus) {
            if (exp.status === "passed") {
              notifyExperimentPassed(exp).catch(() => {});
            } else if (exp.status === "partial") {
              notifyExperimentPartial(exp).catch(() => {});
            }
          }
        }
      }

      // Forward to web
      webNs.emit("task.eval", { stub_id: stubId, task_id: payload.task_id, metrics: payload.metrics });
      if (ack) ack({ ok: true });
    });

    socket.on("task.result", (payload: { task_id: string; path: string; result?: Record<string, unknown>; schema?: Record<string, unknown> }, ack?: Function) => {
      const stubId = socketToStub.get(socket.id);
      if (!stubId) { if (ack) ack({ ok: false }); return; }

      const task = store.getTask(stubId, payload.task_id);
      if (!task) { if (ack) ack({ ok: false }); return; }

      const exports = {
        ...(task.exports || {}),
        result_path: payload.path,
        result: payload.result || {},
        result_schema: payload.schema || {},
      };
      const updated = store.updateTask(stubId, payload.task_id, { exports });
      if (updated) webNs.emit("task.update", updated);
      if (task.experiment_id) {
        store.addExperimentEvent({
          id: uuidv4(),
          experiment_id: task.experiment_id,
          task_id: payload.task_id,
          kind: "artifact",
          message: `Result artifact reported for ${task.ref || payload.task_id}`,
          actor: "sdk",
          created_at: new Date().toISOString(),
          data: {
            artifact_type: "metrics",
            name: "result",
            path: payload.path,
            result: payload.result || {},
            schema: payload.schema || {},
            task_ref: task.ref || null,
          },
        });
      }
      webNs.emit("task.result", {
        stub_id: stubId,
        task_id: payload.task_id,
        path: payload.path,
        result: payload.result || {},
        schema: payload.schema || {},
      });
      if (ack) ack({ ok: true });
    });

    // ─── Shell relay: stub → web ────────────────────────────────────────────

    socket.on("shell.output", (data: { request_id: string; chunk: string; stream: string }) => {
      webNs.emit("shell.output", data);
    });

    socket.on("shell.done", (data: { request_id: string; exit_code: number }) => {
      webNs.emit("shell.done", data);
    });

    // ─── Exec (Spec 3) ──────────────────────────────────────────────────────
    // exec.request is emitted directly to the stub socket with a native ack
    // callback from api/exec.ts. The stub's ack carries the exec.response payload
    // back to the waiting HTTP handler. No relay needed on the server side —
    // the socket.emit(..., callback) in exec.ts handles the full round-trip.

    socket.on("disconnect", () => {
      const stubId = socketToStub.get(socket.id);
      socketToStub.delete(socket.id);
      if (!stubId) return;

      unregisterStubSocket(stubId, socket.id);

      const stub = store.getStub(stubId);
      if (!stub) return;

      // Only process disconnect if this socket is still the current one
      if (stub.socket_id !== socket.id) return;

      logger.info("stub.disconnect", { stub: stub.name, stub_id: stubId, reason: "disconnect" });
      stub.status = "offline";
      stub.socket_id = undefined;
      // L1: Clear any pending killTimers for this stub's tasks
      for (const task of stub.tasks) {
        cancelKillChain(task.id);
      }
      // Bug 4 fix: Clear sync interval on disconnect to prevent leak
      const syncIv = stubSyncIntervals.get(stubId);
      if (syncIv) {
        clearInterval(syncIv);
        stubSyncIntervals.delete(stubId);
      }
      // Re-queue assigned tasks back to global pending so they can be rescheduled
      const requeued = store.requeueStubTasks(stubId);
      for (const task of requeued) {
        webNs.emit("task.update", task);
      }
      // Flag running/paused tasks as disconnected (keeps status as "running")
      markTasksDisconnected(stub, webNs);
      store.setStub(stub);
      webNs.emit("stub.offline", { stub_id: stubId });
      triggerSchedule();

      // After heartbeat timeout, fail tasks that are still disconnected
      // (stub didn't reconnect within HEARTBEAT_TIMEOUT_MS)
      const failTimer = setTimeout(() => {
        disconnectFailTimers.delete(stubId);
        const currentStub = store.getStub(stubId);
        if (!currentStub || currentStub.status === "online") return; // reconnected in time
        logger.info("stub.heartbeat_timeout", { stub: currentStub.name, stub_id: stubId });
        failDisconnectedTasks(currentStub, webNs);
        store.setStub(currentStub);
      }, DISCONNECT_FAIL_MS);
      disconnectFailTimers.set(stubId, failTimer);
    });
  });
}

// ─── Resume handler ───────────────────────────────────────────────────────────

function handleResume(
  socket: Socket,
  payload: ResumePayload,
  webNs: Namespace,
  ns: Namespace,
  deployConfig?: DeployFileConfig | null,
): void {
  const { hostname, gpu, slurm_job_id, max_concurrent, token, env_setup, default_cwd, default_output_dir,
    tags, running_tasks: rawRunningTasks, local_queue: rawLocalQueue, available_envs, user, slurm_constraints,
    cuda_visible_devices } = payload;
  const running_tasks = Array.isArray(rawRunningTasks) ? rawRunningTasks : [];
  const local_queue = Array.isArray(rawLocalQueue) ? rawLocalQueue : [];

  // Auth check
  const tokenRecord = store.getToken(token);
  if (!tokenRecord) {
    socket.emit("error", { message: "Invalid token" });
    socket.disconnect();
    return;
  }

  const stubVersion = payload.stub_version;
  const enforceVersion = process.env.ALCHEMY_ENFORCE_VERSION === "1" || process.env.ALCHEMY_ENFORCE_VERSION === "true";
  if (!stubVersion) {
    if (enforceVersion) {
      const error = `Alchemy version missing in resume payload. Expected server=${ALCHEMY_VERSION}.`;
      const details = { hostname, server_version: ALCHEMY_VERSION };
      logger.error("stub.version_missing", details);
      socket.emit("resume_response", { error, server_version: ALCHEMY_VERSION, stub_version: undefined });
      socket.disconnect(true);
      return;
    }
    logger.warn("stub.version_missing", { hostname, server_version: ALCHEMY_VERSION });
  } else if (stubVersion !== ALCHEMY_VERSION) {
    const details = { hostname, stub_version: stubVersion, server_version: ALCHEMY_VERSION };
    if (enforceVersion) {
      const error = `Alchemy version mismatch: server=${ALCHEMY_VERSION} stub=${stubVersion}. Redeploy the stub package.`;
      logger.error("stub.version_mismatch", details);
      socket.emit("resume_response", { error, server_version: ALCHEMY_VERSION, stub_version: stubVersion });
      socket.disconnect(true);
      return;
    }
    logger.warn("stub.version_mismatch_allowed", details);
  }

  // Compute stable stub ID from hostname + user + per-instance discriminator.
  // Prefer client-provided IDs from new stubs. For rolling upgrades, when an old
  // stub does not send stub_id, reuse an existing legacy-ID row if present.
  const identityInstanceId = slurm_job_id || cuda_visible_devices || (payload.stub_id ? "" : gpu?.name) || "";
  const serverComputedId = computeStubId(hostname, user ?? "", identityInstanceId, slurm_job_id ?? "");
  const legacyComputedId = computeLegacyStubId(hostname, gpu, cuda_visible_devices ?? "", user ?? "", slurm_job_id ?? "");
  let stubId: string;
  if (payload.stub_id) {
    if (payload.stub_id !== serverComputedId && payload.stub_id !== legacyComputedId) {
      logger.warn("stub.id_mismatch", {
        client_id: payload.stub_id,
        server_id: serverComputedId,
        legacy_id: legacyComputedId,
        hostname,
        user,
        slurm_job_id,
        identity_instance_id: identityInstanceId,
      });
    }
    // Trust the client-provided ID — it was computed with the stub's actual identity inputs.
    stubId = payload.stub_id;
  } else {
    stubId = store.getStub(legacyComputedId) ? legacyComputedId : serverComputedId;
    if (stubId === legacyComputedId && legacyComputedId !== serverComputedId) {
      logger.warn("stub.legacy_identity_reused", { hostname, user, legacy_id: legacyComputedId, new_id: serverComputedId });
    }
  }

  // Cancel disconnect fail timer if stub is reconnecting within heartbeat timeout
  const pendingFailTimer = disconnectFailTimers.get(stubId);
  if (pendingFailTimer) {
    clearTimeout(pendingFailTimer);
    disconnectFailTimers.delete(stubId);
    logger.info("stub.reconnected_before_timeout", { stub_id: stubId, hostname });
  }

  // Kick any existing connection for this stub.
  // Rate limit is configurable via RECONNECT_RATE_LIMIT_MS env var (default: 0 = disabled).
  const existingStub = store.getStub(stubId);
  if (existingStub?.socket_id && existingStub.socket_id !== socket.id) {
    const rateLimitMs = parseInt(process.env.RECONNECT_RATE_LIMIT_MS || "0", 10);
    if (rateLimitMs > 0) {
      const lastConnect = existingStub.connected_at ? new Date(existingStub.connected_at).getTime() : 0;
      const elapsed = Date.now() - lastConnect;
      if (elapsed < rateLimitMs) {
        logger.warn("stub.reconnect_too_fast", { stub_id: stubId, elapsed_ms: elapsed, rate_limit_ms: rateLimitMs });
        socket.disconnect(true);
        return;
      }
    }
    const oldSocket = ns.sockets.get(existingStub.socket_id);
    if (oldSocket) {
      logger.info("stub.ghost_kicked", { stub_id: stubId, old_socket: existingStub.socket_id });
      // Bug 1 fix: Remove old socket mapping BEFORE disconnecting so the
      // disconnect handler sees socket_id mismatch and skips markTasksLost.
      socketToStub.delete(existingStub.socket_id);
      unregisterStubSocket(stubId, existingStub.socket_id);
      // Update stored socket_id so disconnect handler's
      // `stub.socket_id !== socket.id` check correctly skips the old socket.
      existingStub.socket_id = socket.id;
      store.setStub(existingStub);
      oldSocket.disconnect(true);
    }
  }

  // Determine stub type
  const stubType: "slurm" | "workstation" = slurm_job_id ? "slurm" : "workstation";

  // Look up deploy config target for this stub by hostname (support FQDN matching)
  const shortHostname = hostname.split(".")[0];
  const deployTarget = deployConfig?.stubs?.find(
    (t) => t.host === hostname || t.host === shortHostname || t.name === hostname || t.name === shortHostname,
  );

  let stub: Stub;
  const now = new Date().toISOString();

  if (existingStub?.released) {
    logger.info("stub.reject_released", { stub_id: stubId, hostname });
    socket.emit("resume_response", { error: "Stub was explicitly released. Re-register to reconnect." });
    socket.disconnect(true);
    return;
  }

  if (existingStub) {
    // Reconnect — update fields
    stub = {
      ...existingStub,
      hostname,
      gpu,
      slurm_job_id,
      status: "online",
      type: stubType,
      connected_at: now,
      last_heartbeat: now,
      last_seen: now,
      socket_id: socket.id,
      env_setup: env_setup ?? existingStub.env_setup,
      default_cwd: default_cwd ?? existingStub.default_cwd,
      default_output_dir: default_output_dir ?? existingStub.default_output_dir,
      // Server is authoritative: preserve stored max_concurrent; only fall back to stub's value if none is stored
      max_concurrent: existingStub.max_concurrent ?? max_concurrent,
      // Update tags from stub only if non-empty; empty array would overwrite API-set tags
      tags: (tags && tags.length > 0) ? tags : existingStub.tags,
      available_envs: available_envs ?? existingStub.available_envs,
      user: user ?? existingStub.user,
      slurm_constraints: slurm_constraints ?? existingStub.slurm_constraints,
      // Always refresh deploy config defaults from current deploy-config.yaml
      deploy_python_path: deployTarget?.python_path,
      deploy_default_cwd: deployTarget?.default_cwd,
      deploy_env_setup: deployTarget?.env_setup,
      deploy_default_env: deployTarget?.default_env,
    };
    logger.info("stub.resume", { stub: stub.name, running: running_tasks.length, queued: local_queue.length });
  } else {
    // New stub
    const name = generateStubName(hostname, gpu.name, slurm_job_id);
    stub = {
      id: stubId,
      name,
      hostname,
      gpu,
      slurm_job_id,
      status: "online",
      type: stubType,
      connected_at: now,
      last_heartbeat: now,
      first_seen: now,
      last_seen: now,
      socket_id: socket.id,
      max_concurrent,
      tasks: [],
      env_setup,
      default_cwd,
      default_output_dir,
      tags,
      available_envs,
      user,
      slurm_constraints,
      deploy_python_path: deployTarget?.python_path,
      deploy_default_cwd: deployTarget?.default_cwd,
      deploy_env_setup: deployTarget?.env_setup,
      deploy_default_env: deployTarget?.default_env,
    };
    logger.info("stub.resume", { stub: stub.name, running: running_tasks.length, queued: local_queue.length, new: true });
  }

  // ─── Conservative stale-stub cleanup ───────────────────────────────────────
  // Disabled by default. During rolling upgrades, identity formulas and versions
  // can legitimately differ while old tasks are still running. Never fail running
  // tasks from this path; the disconnect timeout/reconciliation path owns that.
  if (process.env.ALCHEMY_ENABLE_ZOMBIE_CLEANUP === "1") {
    for (const oldStub of store.getAllStubs()) {
      if (oldStub.id === stubId) continue; // skip self
      if (oldStub.hostname !== hostname) continue;
      if ((oldStub.user ?? "") !== (user ?? "")) continue;
      if (oldStub.status === "online") continue; // don't touch live stubs
      const lastHeartbeat = oldStub.last_seen || oldStub.last_heartbeat;
      if (!lastHeartbeat) continue;
      const lastSeen = new Date(lastHeartbeat).getTime();
      const stale = Number.isFinite(lastSeen) && Date.now() - lastSeen >= DISCONNECT_FAIL_MS;
      if (!stale) continue;

      const hasRunning = oldStub.tasks.some((t) => ["running", "paused"].includes(t.status));
      if (hasRunning) {
        logger.warn("stub.zombie_cleanup_skipped_running", { zombie_stub: oldStub.name, zombie_id: oldStub.id, new_stub: stub.name });
        continue;
      }

      const requeued = store.requeueStubTasks(oldStub.id);
      for (const t of requeued) webNs.emit("task.update", t);
      if (requeued.length > 0) {
        logger.info("stub.zombie_cleanup", { zombie_stub: oldStub.name, zombie_id: oldStub.id, new_stub: stub.name, requeued: requeued.length });
      }

      const hasActive = oldStub.tasks.some((t) => ["running", "paused", "assigned"].includes(t.status));
      if (!hasActive) {
        store.deleteStub(oldStub.id);
        webNs.emit("stub.removed", { stub_id: oldStub.id });
        logger.info("stub.zombie_removed", { stub: oldStub.name, stub_id: oldStub.id });
      }
    }
  }

  // ─── Reconciliation ───────────────────────────────────────────────────────

  const reportedRunning = new Map(running_tasks.map((r) => [r.task_id, r]));
  const reportedQueue = new Set(local_queue);
  // Tasks in dead_tasks are handled separately — skip Case A for them
  const deadTaskIds = new Set((payload.dead_tasks ?? []).map((d: any) => d.task_id));

  // Register socket for reliable emit
  registerStubSocket(stubId, socket);

  // Case A: Server has task on this stub, stub didn't report → fail it
  const adoptTasks: string[] = [];
  const killTasks: string[] = [];

  const stubTasksSnapshot = [...stub.tasks];
  for (const task of stubTasksSnapshot) {
    if (["running", "paused"].includes(task.status)) {
      if (!reportedRunning.has(task.id) && !deadTaskIds.has(task.id)) {
        // Case A: server thinks it's running, stub doesn't know about it → fail
        const updated = failTask(stubId, task.id, undefined, { death_cause: "disappeared" });
        if (updated) {
          webNs.emit("task.update", updated);
          notifyFailed(updated).catch(() => {});
          handleAutoRetry(updated, webNs);
        }
      } else {
        // Stub reports it running — clear any disconnected flag
        if (task.stub_offline) {
          const cleared = clearDisconnected(stubId, task.id);
          if (cleared) webNs.emit("task.update", cleared);
        }
        // Re-send kill if task was being killed when stub disconnected
        if (task.should_stop && reportedRunning.has(task.id)) {
          killTasks.push(task.id);
        }
      }
    } else if (task.status === "assigned") {
      // Case C: server has assigned task, stub should have it — include in adopt
      if (!reportedQueue.has(task.id)) {
        adoptTasks.push(task.id);
      }
    } else if (task.status === "cancelled") {
      // If stub reports it as running, tell it to kill
      if (reportedRunning.has(task.id)) {
        killTasks.push(task.id);
      }
    }
  }

  // Case B: Stub reports task, server doesn't know it → kill (orphan)
  for (const [reportedId, reported] of reportedRunning) {
    const found = store.findTask(reportedId);
    if (!found) {
      killTasks.push(reportedId);
    } else if (found.task.status === "cancelled") {
      killTasks.push(reportedId);
    } else if (found.task.status === "running" && store.getTask(stubId, reportedId)) {
      // Already running on this stub — no action needed (prevents duplicate on rapid reconnect)
    }
  }

  // Process dead_tasks from stub (died while offline)
  if (payload.dead_tasks && payload.dead_tasks.length > 0) {
    for (const dead of payload.dead_tasks) {
      // Bug 3 fix: Use store.findTask to get the authoritative stubId for this
      // task, not the reconnecting stub's ID — tasks may have been moved.
      const directTask = store.getTask(stubId, dead.task_id);
      const taskEntry = directTask
        ? { task: directTask, stubId, archived: false }
        : store.findTask(dead.task_id);
      if (!taskEntry) continue;
      const task = taskEntry.task;
      const taskStubId = taskEntry.stubId ?? stubId;
      if (task && ["running", "assigned", "paused"].includes(task.status)) {
        const newStatus = dead.exit_code === 0 ? "completed" : "failed";
        const updated = resolveDeadTask(taskStubId, dead.task_id, dead.exit_code);
        if (updated) {
          webNs.emit("task.update", updated);
          logger.info("task.dead_on_reattach", { task_seq: updated.seq, status: newStatus, exit_code: dead.exit_code });
          if (newStatus === "completed") {
            notifyCompleted(updated).catch(() => {});
          } else {
            notifyFailed(updated, dead.exit_code).catch(() => {});
          }
          if (updated.grid_id) checkGridCompletion(updated.grid_id, webNs);
        }
      }
    }
  }

  // Case D: max_concurrent mismatch — server authoritative
  const maxConcurrent = stub.max_concurrent;

  // Update stub in store
  store.setStub(stub);
  socketToStub.set(socket.id, stubId);
  socket.join(`stub:${stubId}`);

  // Build adopt task payloads — use server-computed run_dir
  const adoptPayloads = adoptTasks.map((taskId) => {
    const task = store.getTask(stubId, taskId);
    if (!task) return null;
    return buildRunPayload(task, stub);
  }).filter(Boolean);

  // Get assigned tasks for the stub — use server-computed run_dir
  const queuePayloads = stub.tasks
    .filter((t) => t.status === "assigned")
    .map((t) => buildRunPayload(t, stub));

  // Send resume_response via reliable emit (native ack)
  reliableEmitToStub(stubId, "resume_response", {
    stub_id: stubId,
    name: stub.name,
    adopt_tasks: adoptPayloads,
    kill_tasks: killTasks,
    queue: queuePayloads,
    config: { max_concurrent: maxConcurrent },
  });

  // Notify web
  webNs.emit("stub.online", sanitizeStub(stub));

  // Rebuild write locks after reconnect
  store.rebuildWriteLocks();

  // Trigger scheduler to fill any new slots
  triggerSchedule();

  // H3: Clear previous sync interval for this stub to prevent leak on re-resume
  const prevInterval = stubSyncIntervals.get(stubId);
  if (prevInterval) clearInterval(prevInterval);

  // Schedule periodic status.sync for this stub (ack-based full process status)
  const syncInterval = setInterval(() => {
    const currentStub = store.getStub(stubId);
    if (!currentStub || currentStub.status !== "online" || currentStub.socket_id !== socket.id) {
      clearInterval(syncInterval);
      return;
    }
    socket.emit("status.sync", {}, (response: any) => {
      if (!response?.running_tasks) return;
      // Check for tasks server thinks are running but stub says are dead/absent
      for (const reported of response.running_tasks as Array<{ task_id: string; pid: number; alive: boolean }>) {
        if (!reported.alive) {
          const t = store.getTask(stubId, reported.task_id);
          if (t && ["running", "assigned"].includes(t.status)) {
            const updated = failTask(stubId, reported.task_id, undefined, { death_cause: "disappeared" });
            if (updated) {
              webNs.emit("task.update", updated);
              logger.warn("task.failed_via_sync", { task_seq: updated.seq, stub: currentStub.name });
              handleAutoRetry(updated, webNs);
            }
          }
        }
      }
      // Check for tasks server has that stub didn't report at all
      const reportedIds = new Set(response.running_tasks.map((r: any) => r.task_id));
      for (const t of currentStub.tasks) {
        if (["running", "assigned"].includes(t.status) && !reportedIds.has(t.id)) {
          const updated = failTask(stubId, t.id, undefined, { death_cause: "disappeared" });
          if (updated) {
            webNs.emit("task.update", updated);
            logger.warn("task.failed_via_sync", { task_seq: updated.seq, stub: currentStub.name, reason: "not_reported" });
            handleAutoRetry(updated, webNs);
          }
        }
      }
    });
  }, REQUEST_SYNC_INTERVAL_MS);
  stubSyncIntervals.set(stubId, syncInterval);
}

function handleTaskStarted(stubId: string, payload: TaskStartedPayload, webNs: Namespace): void {
  const updated = startTask(stubId, payload.task_id, payload.pid);
  if (updated) {
    logger.info("task.started", { task_seq: updated.seq, stub: stubId, pid: payload.pid });
    webNs.emit("task.update", updated);
    // Acquire write lock if task has run_dir
    if (updated.run_dir) {
      writeLockTable.acquire(updated.run_dir, updated.id);
    }
    notifyRunning(updated).catch(() => {});
  }
}

function handleTaskCompleted(stubId: string, payload: TaskCompletedPayload, webNs: Namespace): void {
  const task = store.getTask(stubId, payload.task_id);
  if (!task) return;

  cancelKillChain(payload.task_id);

  const updated = store.updateTask(stubId, payload.task_id, {
    status: "completed" as import("../types").TaskStatus,
    exit_code: payload.exit_code,
    finished_at: new Date().toISOString(),
    ...(payload.death_cause !== undefined ? { death_cause: payload.death_cause } : {}),
    ...(payload.has_checkpoint !== undefined ? { has_checkpoint: payload.has_checkpoint } : {}),
  });
  if (!updated) return;

  logger.info("task.completed", { task_seq: updated.seq, stub: stubId, exit_code: payload.exit_code });
  webNs.emit("task.update", updated);

  // Notify
  notifyCompleted(updated).catch(() => {});

  // Update grid
  if (updated.grid_id) {
    checkGridCompletion(updated.grid_id, webNs);
  }

  // Trigger scheduling to fill the freed slot
  const stub = store.getStub(stubId);
  if (stub) {
    maybeDispatch(stub);
  }
  triggerSchedule();

  // DAG: promote downstream blocked tasks
  promoteBlockedTasks(payload.task_id, webNs);

  // Git tracking: update manifest fire-and-forget
  if (updated.experiment_id) {
    const exp = store.getExperiment(updated.experiment_id);
    if (exp?.git_tracking) {
      updateExperimentManifest(exp, updated, stubId, _stubNs).catch(() => {});
    }
  }
}

function handleTaskFailed(stubId: string, payload: TaskFailedPayload, webNs: Namespace): void {
  const task = store.getTask(stubId, payload.task_id);
  if (!task) return;

  cancelKillChain(payload.task_id);

  const deathCause = payload.death_cause || (payload.exit_code === 137 ? "oom" : undefined);
  const hasCheckpoint = payload.has_checkpoint ?? false;
  const isKilled = task.should_stop && payload.exit_code !== 0;

  // auto_retry_on: exit code based retry (user-configured, no checkpoint required)
  if (
    !isKilled &&
    task.auto_retry_on &&
    task.auto_retry_on.length > 0 &&
    payload.exit_code !== undefined &&
    task.auto_retry_on.includes(payload.exit_code) &&
    task.max_retries > 0 &&
    task.retry_count < task.max_retries
  ) {
    const retryRoot = task.retry_of || task.id;
    const allTasks = store.getAllTasks();
    const existingRetry = allTasks.find(
      (t) =>
        (t.retry_of === retryRoot || t.retry_of === task.id) &&
        t.id !== task.id &&
        ["pending", "assigned", "running"].includes(t.status),
    );
    if (!existingRetry) {
      const retryTask = createRetryTask(task);
      const failed = failTask(stubId, payload.task_id, payload.exit_code, {
        death_cause: deathCause,
        has_checkpoint: hasCheckpoint,
        error_message: payload.error,
      });
      if (failed) webNs.emit("task.update", failed);
      store.addToGlobalQueue(retryTask);
      webNs.emit("task.update", retryTask);
      logger.info("task.auto_retry_on", {
        exit_code: payload.exit_code,
        task_seq: task.seq,
        new_seq: retryTask.seq,
        attempt: retryTask.retry_count,
        max: task.max_retries,
      });
      triggerSchedule();
      return;
    }
  }

  // B2: Auto-resume for OOM, walltime, preempt
  const resumableDeathCauses = ["oom", "walltime", "preempt"];
  if (
    !isKilled &&
    deathCause &&
    resumableDeathCauses.includes(deathCause) &&
    task.max_retries > 0 &&
    task.retry_count < task.max_retries &&
    (hasCheckpoint || deathCause === "walltime" || deathCause === "preempt")
  ) {
    // Dedup: check if a retry already exists
    const retryRoot = task.retry_of || task.id;
    const allTasks = store.getAllTasks();
    const existingRetry = allTasks.find(
      (t) =>
        (t.retry_of === retryRoot || t.retry_of === task.id) &&
        t.id !== task.id &&
        ["pending", "assigned", "running"].includes(t.status),
    );
    if (existingRetry) {
      logger.info("task.auto_resume_dedup", { task_seq: task.seq, existing_retry: existingRetry.seq, death_cause: deathCause });
    } else {
      // For OOM: bump memory by 25%
      let retryOpts: import("../task-actions").RetryTaskOpts | undefined;
      if (deathCause === "oom") {
        const currentMem = task.requirements?.cpu_mem_mb || 60000;
        const bumpedMem = Math.ceil(currentMem * 1.25);
        retryOpts = {
          requirements: { ...task.requirements, cpu_mem_mb: bumpedMem },
        };
      }

      const retryTask = createRetryTask(task, retryOpts);

      // Mark original as failed with death metadata
      const failed = failTask(stubId, payload.task_id, payload.exit_code, {
        death_cause: deathCause,
        has_checkpoint: hasCheckpoint,
        error_message: payload.error,
      });
      if (failed) {
        webNs.emit("task.update", failed);
      }

      store.addToGlobalQueue(retryTask);
      webNs.emit("task.update", retryTask);
      logger.info("task.auto_resume", {
        reason: deathCause,
        task_seq: task.seq,
        new_seq: retryTask.seq,
        attempt: retryTask.retry_count,
        max: task.max_retries,
        has_checkpoint: hasCheckpoint,
        mem_bumped: deathCause === "oom",
      });
      triggerSchedule();
      return;
    }
  }

  let updated: Task | undefined;
  if (isKilled) {
    updated = cancelTask(stubId, payload.task_id, payload.exit_code);
  } else {
    const extra: Partial<Task> = {
      death_cause: deathCause,
      has_checkpoint: hasCheckpoint,
    };
    if (payload.error) extra.error_message = payload.error;
    updated = failTask(stubId, payload.task_id, payload.exit_code, extra);
  }
  if (!updated) return;

  if (isKilled) {
    logger.warn("task.cancelled", { task_seq: updated.seq, stub: stubId, exit_code: payload.exit_code });
  } else {
    logger.warn("task.failed", {
      task_seq: updated.seq,
      stub: stubId,
      exit_code: payload.exit_code,
      death_cause: deathCause,
      error: payload.error ? String(payload.error).slice(0, 500) : undefined,
    });
  }

  webNs.emit("task.update", updated);

  if (isKilled) {
    notifyCancelled(updated).catch(() => {});
  } else {
    notifyFailed(updated, payload.exit_code).catch(() => {});
  }

  if (updated.grid_id) {
    checkGridCompletion(updated.grid_id, webNs);
  }

  // DAG: cascade cancellation to downstream blocked tasks
  cascadeCancellation(payload.task_id, webNs);

  const stub = store.getStub(stubId);
  if (stub) {
    maybeDispatch(stub);
  }
  triggerSchedule();
}

function handleTaskConfig(stubId: string, payload: TaskConfigPayload, webNs: Namespace): void {
  const updated = store.updateTask(stubId, payload.task_id, {
    config_snapshot: payload.config,
  });
  if (updated) webNs.emit("task.update", updated);
}

function handleTaskCheckpoint(stubId: string, payload: TaskCheckpointPayload, webNs: Namespace): void {
  const task = store.getTask(stubId, payload.task_id);
  if (!task) return;

  const newCount = (task.checkpoint_count || 0) + 1;
  const exports = { ...(task.exports || {}), last_checkpoint_path: payload.path };
  const updated = store.updateTask(stubId, payload.task_id, {
    checkpoint_path: payload.path,
    checkpoint_count: newCount,
    exports,
  });
  if (updated) {
    webNs.emit("task.update", updated);

    // G2: Auto-eval subtask creation
    if (updated.auto_eval?.script) {
      const { trigger, n } = updated.auto_eval;
      let shouldEval = false;
      if (trigger === "on_every") {
        shouldEval = true;
      } else if (trigger === "every_n_checkpoints" && n && n > 0) {
        shouldEval = newCount % n === 0;
      }
      if (shouldEval) {
        createAutoEvalTask(updated, stubId, webNs);
      }
    }
  }
}

function createAutoEvalTask(parentTask: Task, stubId: string, webNs: Namespace): void {
  const { v4: uuidv4 } = require("uuid");
  const evalTask: Task = {
    id: uuidv4(),
    seq: store.nextSeq(),
    fingerprint: `eval_${parentTask.fingerprint}_ckpt${parentTask.checkpoint_count}`,
    display_name: `eval:${parentTask.display_name}:ckpt${parentTask.checkpoint_count}`,
    script: parentTask.auto_eval!.script,
    command: parentTask.auto_eval!.script,
    status: "pending",
    priority: parentTask.priority,
    target_tags: parentTask.target_tags,
    parent_task_id: parentTask.id,
    created_at: new Date().toISOString(),
    log_buffer: [],
    retry_count: 0,
    max_retries: 0,
    should_stop: false,
    should_checkpoint: false,
  };
  store.addToGlobalQueue(evalTask);
  webNs.emit("task.update", evalTask);
  logger.info("task.auto_eval_created", {
    parent_seq: parentTask.seq,
    eval_seq: evalTask.seq,
    checkpoint_count: parentTask.checkpoint_count,
  });
  triggerSchedule();
}

function handleTaskPhase(stubId: string, payload: TaskPhasePayload, webNs: Namespace): void {
  const validPhases = ["warmup", "training", "eval", "checkpoint", "cooldown"];
  const phase = validPhases.includes(payload.phase) ? payload.phase : undefined;
  if (!phase) return;

  const updated = store.updateTask(stubId, payload.task_id, { phase });
  if (updated) {
    webNs.emit("task.update", updated);
  }
}

function handlePreflightFail(stubId: string, payload: PreflightFailPayload, webNs: Namespace): void {
  const updated = preflightFail(stubId, payload.task_id, payload.errors);
  if (updated) {
    logger.warn("task.preflight_fail", {
      task_seq: updated.seq,
      stub: stubId,
      errors: payload.errors,
      error_message: updated.error_message,
    });
    webNs.emit("task.update", updated);
    notifyFailed(updated).catch(() => {});
    if (updated.grid_id) checkGridCompletion(updated.grid_id, webNs);
    const stub = store.getStub(stubId);
    if (stub) maybeDispatch(stub);
    triggerSchedule();
  }
}

// ─── Public helpers ───────────────────────────────────────────────────────────

/** Dispatch queued tasks for a stub (called by API handlers). */
export function dispatchQueuedTasks(stubId: string, _ns: Namespace): void {
  const stub = store.getStub(stubId);
  if (!stub) return;
  maybeDispatch(stub);
}

function handleTaskNotify(
  stubId: string,
  payload: { task_id: string; message: string; level: string },
  webNs: Namespace,
): void {
  const { task_id, message, level } = payload;
  const task = store.getTask(stubId, task_id);
  if (!task) return;

  const validLevels = ["debug", "info", "warning", "critical"];
  const safeLevel = validLevels.includes(level) ? level : "info";

  logger.info("task.notify", { task_seq: task.seq, level: safeLevel, message: message.slice(0, 200) });

  // Always store in log_buffer
  const logLine = `[notify:${safeLevel}] ${message}`;
  const buf = task.log_buffer;
  buf.push(logLine);
  if (buf.length > 500) buf.splice(0, buf.length - 500);
  store.updateTask(stubId, task_id, { log_buffer: buf });

  // info/warning/critical: emit to web frontend
  if (safeLevel !== "debug") {
    webNs.emit("task.notify", { task_id, message, level: safeLevel });
  }

  // warning/critical: send Discord notification
  if (safeLevel === "warning" || safeLevel === "critical") {
    notifyTaskMessage(task, message, safeLevel).catch(() => {});
  }
}

function sanitizeStub(stub: Stub): Omit<Stub, "socket_id"> {
  const { socket_id, ...rest } = stub;
  return rest;
}
