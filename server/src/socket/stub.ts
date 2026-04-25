/**
 * socket/stub.ts — Stub socket.io namespace handler.
 *
 * Unified resume flow: every connection (first / reconnect) uses a single
 * `resume` event. Server reconciles and responds with `resume_response`.
 *
 * Reliable messaging: R-layer for critical S→Stub events.
 */

import { Namespace, Socket } from "socket.io";
import { createHash } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { store } from "../store";
import { metricsStore } from "../metrics";
import {
  Stub, Task, TaskStatus,
  ResumePayload, HeartbeatPayload,
  TaskStartedPayload, TaskProgressPayload, TaskLogPayload,
  TaskCompletedPayload, TaskFailedPayload,
  TaskConfigPayload, TaskCheckpointPayload, PreflightFailPayload,
  TaskResourcePayload, TaskMetricsPayload,
} from "../types";
import { maybeDispatch, triggerSchedule, buildRunPayload, computeRunDir } from "../scheduler";
import {
  registerStubSocket, unregisterStubSocket,
  reliableEmitToStub,
} from "../reliable";
import {
  notifySubmitted, notifyDispatched, notifyRunning,
  notifyCompleted, notifyFailed, notifyKilled, notifyLost,
  notifyGridDone, notifyTaskMessage,
} from "../discord";
import { writeLockTable } from "../dedup";
import { logger } from "../log";
import { loseTask, startTask, completeTask, failTask, killTask, recoverTask, resolveDeadTask, preflightFail, promoteIfDispatched } from "../task-actions";

const HEARTBEAT_TIMEOUT_MS = 180_000; // 6 missed × 30s — generous for CF tunnel latency
const REQUEST_SYNC_INTERVAL_MS = 5 * 60_000;

// Map: socket.id → stub_id (for the duration of the connection)
const socketToStub: Map<string, string> = new Map();

// ─── Stable stub ID ───────────────────────────────────────────────────────────

function computeStubId(hostname: string, gpu: { name: string; count: number }, defaultCwd?: string, slurmJobId?: string): string {
  // Include slurm_job_id so two SLURM jobs on the same node get distinct stubs.
  const input = `${hostname}|${gpu.name}|${gpu.count}|${defaultCwd || ""}|${slurmJobId || ""}`;
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

// ─── Fail stub tasks → lost ───────────────────────────────────────────────────

function markTasksLost(stub: Stub, webNs: Namespace): void {
  for (const task of stub.tasks) {
    if (task.status === "lost") continue; // already lost — don't create duplicate
    if (["running", "dispatched", "paused"].includes(task.status)) {
      if (task.should_stop) {
        // Task was being killed — mark as killed instead of lost
        const updated = killTask(stub.id, task.id, undefined);
        if (updated) {
          webNs.emit("task.update", updated);
          logger.warn("task.killed_on_disconnect", { task_seq: updated.seq, stub: stub.name });
          notifyKilled(updated).catch(() => {});
        }
      } else {
        const updated = loseTask(stub.id, task.id);
        if (updated) {
          webNs.emit("task.update", updated);
          logger.warn("task.lost", { task_seq: updated.seq, stub: stub.name, reason: "stub offline" });
          notifyLost(updated).catch(() => {});
          // Auto-retry for lost tasks
          handleAutoRetry(updated, webNs);
        }
      }
    }
  }
}

function handleAutoRetry(task: Task, webNs: Namespace): void {
  if (task.max_retries > 0 && task.retry_count < task.max_retries) {
    const retryTask: Task = {
      ...task,
      id: uuidv4(),
      seq: store.nextSeq(),
      status: "pending",
      stub_id: undefined,
      retry_count: task.retry_count + 1,
      retry_of: task.retry_of || task.id,
      created_at: new Date().toISOString(),
      started_at: undefined,
      finished_at: undefined,
      exit_code: undefined,
      pid: undefined,
      log_buffer: [],
      progress: undefined,
    };
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
    const failed = tasks.filter((t) => ["failed", "killed", "lost"].includes(t.status)).length;
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
  // Tell the stub to SIGTERM the task (stub's kill_graceful handles grace + SIGKILL).
  // grace_period_s passed to stub = full grace period before SIGKILL.
  store.updateTask(stubId, taskId, { should_stop: true });
  reliableEmitToStub(stubId, "task.kill", { task_id: taskId, grace_period_s: gracePeriodS });

  // Safety net: if task hasn't transitioned after 2× grace period, send another kill
  const timer = setTimeout(() => {
    killTimers.delete(taskId);
    const task = store.getTask(stubId, taskId);
    if (!task || ["completed", "failed", "killed", "lost"].includes(task.status)) return;
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

export function setupStubNamespace(ns: Namespace, webNs: Namespace): void {
  // Heartbeat timeout checker
  setInterval(() => {
    const now = Date.now();
    for (const stub of store.getAllStubs()) {
      if (stub.status !== "online") continue;
      const lastHb = new Date(stub.last_heartbeat).getTime();
      if (now - lastHb > HEARTBEAT_TIMEOUT_MS) {
        logger.warn("stub.offline", { stub: stub.name, reason: "heartbeat_timeout", elapsed_s: Math.floor((now - lastHb) / 1000) });
        stub.status = "offline";
        markTasksLost(stub, webNs);
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
        handleResume(socket, payload, webNs, ns);
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

    // ─── Non-reliable events ────────────────────────────────────────────────

    socket.on("heartbeat", (payload: HeartbeatPayload) => {
      const stubId = socketToStub.get(socket.id);
      if (!stubId) return;
      const stub = store.getStub(stubId);
      if (!stub) return;
      stub.last_heartbeat = payload.timestamp || new Date().toISOString();
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
      promoteIfDispatched(stubId, payload.task_id);
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
      promoteIfDispatched(stubId, payload.task_id);
      const buf = task.log_buffer;
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
      // Buffer in metricsStore (ephemeral, not persisted)
      metricsStore.pushTaskMetricsDirect(task_id, step, metrics);
      // Forward to web clients
      webNs.emit("task.metrics", { task_id, metrics, step });
    });

    // ─── Shell relay: stub → web ────────────────────────────────────────────

    socket.on("shell.output", (data: { request_id: string; chunk: string; stream: string }) => {
      webNs.emit("shell.output", data);
    });

    socket.on("shell.done", (data: { request_id: string; exit_code: number }) => {
      webNs.emit("shell.done", data);
    });

    socket.on("disconnect", () => {
      const stubId = socketToStub.get(socket.id);
      socketToStub.delete(socket.id);
      if (!stubId) return;

      unregisterStubSocket(stubId);

      const stub = store.getStub(stubId);
      if (!stub) return;

      // Only process disconnect if this socket is still the current one
      if (stub.socket_id !== socket.id) return;

      logger.info("stub.offline", { stub: stub.name, stub_id: stubId, reason: "disconnect" });
      stub.status = "offline";
      stub.socket_id = undefined;
      markTasksLost(stub, webNs);
      store.setStub(stub);
      webNs.emit("stub.offline", { stub_id: stubId });
      triggerSchedule();
    });
  });
}

// ─── Resume handler ───────────────────────────────────────────────────────────

function handleResume(
  socket: Socket,
  payload: ResumePayload,
  webNs: Namespace,
  ns: Namespace,
): void {
  const { hostname, gpu, slurm_job_id, max_concurrent, token, env_setup, default_cwd,
    tags, running_tasks, local_queue, available_envs } = payload;

  // Auth check
  const tokenRecord = store.getToken(token);
  if (!tokenRecord) {
    socket.emit("error", { message: "Invalid token" });
    socket.disconnect();
    return;
  }

  // Compute stable stub ID (includes slurm_job_id to disambiguate co-located SLURM jobs)
  const stubId = computeStubId(hostname, gpu, default_cwd, slurm_job_id);

  // Kick any existing connection for this stub — with rate limit to prevent reconnect storms
  const existingStub = store.getStub(stubId);
  if (existingStub?.socket_id && existingStub.socket_id !== socket.id) {
    const lastConnect = existingStub.connected_at ? new Date(existingStub.connected_at).getTime() : 0;
    const elapsed = Date.now() - lastConnect;
    if (elapsed < 3000) {
      logger.warn("stub.reconnect_too_fast", { stub_id: stubId, elapsed_ms: elapsed });
      socket.disconnect(true);
      return;
    }
    const oldSocket = ns.sockets.get(existingStub.socket_id);
    if (oldSocket) {
      logger.info("stub.ghost_kicked", { stub_id: stubId, old_socket: existingStub.socket_id });
      socketToStub.delete(existingStub.socket_id);
      oldSocket.disconnect(true);
    }
  }

  // Determine stub type
  const stubType: "slurm" | "workstation" = slurm_job_id ? "slurm" : "workstation";

  let stub: Stub;
  const now = new Date().toISOString();

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
      socket_id: socket.id,
      env_setup: env_setup ?? existingStub.env_setup,
      default_cwd: default_cwd ?? existingStub.default_cwd,
      // Server is authoritative: preserve stored max_concurrent; only fall back to stub's value if none is stored
      max_concurrent: existingStub.max_concurrent ?? max_concurrent,
      // Update tags from stub if provided, otherwise keep existing
      tags: tags ?? existingStub.tags,
      available_envs: available_envs ?? existingStub.available_envs,
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
      socket_id: socket.id,
      max_concurrent,
      tasks: [],
      env_setup,
      default_cwd,
      tags,
      available_envs,
    };
    logger.info("stub.resume", { stub: stub.name, running: running_tasks.length, queued: local_queue.length, new: true });
  }

  // ─── Reconciliation ───────────────────────────────────────────────────────

  const reportedRunning = new Map(running_tasks.map((r) => [r.task_id, r]));
  const reportedQueue = new Set(local_queue);

  // Register socket for reliable emit
  registerStubSocket(stubId, socket);

  // Case A: Server has task on this stub, stub didn't report → lost
  const adoptTasks: string[] = [];
  const killTasks: string[] = [];

  for (const task of stub.tasks) {
    if (["running", "dispatched", "paused"].includes(task.status)) {
      if (!reportedRunning.has(task.id)) {
        // Case A: server thinks it's running, stub doesn't know about it
        // Skip if already lost (prevents duplicate lost records on reconnect)
        if (task.status === "lost") continue;
        const updated = loseTask(stubId, task.id);
        if (updated) {
          webNs.emit("task.update", updated);
          notifyLost(updated).catch(() => {});
          handleAutoRetry(updated, webNs);
        }
      }
    } else if (task.status === "queued") {
      // Case C: server has queued task, stub should have it — include in adopt
      if (!reportedQueue.has(task.id)) {
        adoptTasks.push(task.id);
      }
    } else if (task.status === "killed") {
      // If stub reports it as running, tell it to kill
      if (reportedRunning.has(task.id)) {
        killTasks.push(task.id);
      }
    }
  }

  // Case B: Stub reports task, server doesn't know it → kill (orphan)
  // Also: recover "lost" tasks that are actually still running on stub
  for (const [reportedId, reported] of reportedRunning) {
    const found = store.findTask(reportedId);
    if (!found) {
      killTasks.push(reportedId);
    } else if (found.task.status === "killed") {
      killTasks.push(reportedId);
    } else if (found.task.status === "lost") {
      // Task was marked lost during disconnect but stub says it's still running — recover
      const recovered = found.archived
        ? store.unarchiveTask(stubId, reportedId, { status: "running" as const, pid: reported.pid, finished_at: undefined })
        : recoverTask(stubId, reportedId, reported.pid);
      if (recovered) {
        logger.info("task.recovered", { task_seq: recovered.seq, stub: stub.name, from_archive: !!found.archived });
        webNs.emit("task.update", recovered);
      }
    }
  }

  // Process dead_tasks from stub (died while offline)
  if (payload.dead_tasks && payload.dead_tasks.length > 0) {
    for (const dead of payload.dead_tasks) {
      const taskEntry = store.getTask(stubId, dead.task_id) ? { task: store.getTask(stubId, dead.task_id)!, archived: false } : store.findTask(dead.task_id);
      const task = taskEntry?.task ?? store.getTask(stubId, dead.task_id);
      if (task && ["running", "dispatched", "paused", "lost"].includes(task.status)) {
        const newStatus = dead.exit_code === 0 ? "completed" : "failed";
        const updated = resolveDeadTask(stubId, dead.task_id, dead.exit_code);
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

  // Get queued tasks for the stub — use server-computed run_dir
  const queuePayloads = stub.tasks
    .filter((t) => t.status === "queued")
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
          if (t && ["running", "dispatched"].includes(t.status)) {
            const updated = loseTask(stubId, reported.task_id);
            if (updated) {
              webNs.emit("task.update", updated);
              logger.warn("task.lost_via_sync", { task_seq: updated.seq, stub: currentStub.name });
            }
          }
        }
      }
      // Check for tasks server has that stub didn't report at all
      const reportedIds = new Set(response.running_tasks.map((r: any) => r.task_id));
      for (const t of currentStub.tasks) {
        if (["running", "dispatched"].includes(t.status) && !reportedIds.has(t.id)) {
          const updated = loseTask(stubId, t.id);
          if (updated) {
            webNs.emit("task.update", updated);
            logger.warn("task.lost_via_sync", { task_seq: updated.seq, stub: currentStub.name, reason: "not_reported" });
          }
        }
      }
    });
  }, REQUEST_SYNC_INTERVAL_MS);

  socket.on("disconnect", () => {
    clearInterval(syncInterval);
  });
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

  const updated = completeTask(stubId, payload.task_id, payload.exit_code);
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
}

function handleTaskFailed(stubId: string, payload: TaskFailedPayload, webNs: Namespace): void {
  const task = store.getTask(stubId, payload.task_id);
  if (!task) return;

  cancelKillChain(payload.task_id);

  // Classify failure
  const isOom = payload.exit_code === 137;
  const isKilled = task.should_stop && payload.exit_code !== 0;

  // Auto-retry for OOM
  if (isOom && task.max_retries > 0 && task.retry_count < task.max_retries) {
    const bumpedMem = task.requirements?.gpu_mem_mb
      ? Math.ceil(task.requirements.gpu_mem_mb * 1.2)
      : undefined;

    const retryTask: Task = {
      ...task,
      id: uuidv4(),
      seq: store.nextSeq(),
      status: "pending",
      stub_id: undefined,
      retry_count: task.retry_count + 1,
      retry_of: task.retry_of || task.id,
      created_at: new Date().toISOString(),
      started_at: undefined,
      finished_at: undefined,
      exit_code: undefined,
      pid: undefined,
      log_buffer: [],
      progress: undefined,
      requirements: bumpedMem
        ? { ...task.requirements, gpu_mem_mb: bumpedMem }
        : task.requirements,
    };

    // Mark original as failed
    const failed = failTask(stubId, payload.task_id, payload.exit_code);
    if (failed) {
      webNs.emit("task.update", failed);
    }

    store.addToGlobalQueue(retryTask);
    webNs.emit("task.update", retryTask);
    logger.info("task.retry", { reason: "oom", task_seq: task.seq, new_seq: retryTask.seq, attempt: retryTask.retry_count, max: task.max_retries });
    triggerSchedule();
    return;
  }

  let updated: Task | undefined;
  if (isKilled) {
    updated = killTask(stubId, payload.task_id, payload.exit_code);
  } else {
    updated = failTask(stubId, payload.task_id, payload.exit_code);
  }
  if (!updated) return;

  webNs.emit("task.update", updated);

  if (isKilled) {
    notifyKilled(updated).catch(() => {});
  } else {
    notifyFailed(updated, payload.exit_code).catch(() => {});
  }

  if (updated.grid_id) {
    checkGridCompletion(updated.grid_id, webNs);
  }

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
  const updated = store.updateTask(stubId, payload.task_id, {
    checkpoint_path: payload.path,
  });
  if (updated) webNs.emit("task.update", updated);
}

function handlePreflightFail(stubId: string, payload: PreflightFailPayload, webNs: Namespace): void {
  const updated = preflightFail(stubId, payload.task_id, payload.errors);
  if (updated) {
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
