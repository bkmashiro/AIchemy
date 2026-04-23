import { Server, Namespace, Socket } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import { store } from "../store";
import { metricsStore } from "../metrics";
import {
  RegisterPayload,
  HeartbeatPayload,
  TaskStartedPayload,
  TaskProgressPayload,
  TaskLogPayload,
  TaskCompletedPayload,
  TaskFailedPayload,
  ShellResultPayload,
  Stub,
} from "../types";
import { checkDagDependencies, checkLossAnomaly, updateTaskProgressTime, updateTaskOutputTime } from "../scheduler";
import { sendDiscordNotification } from "../notifications";

const HEARTBEAT_INTERVAL = 30_000;
const MISSED_HEARTBEAT_LIMIT = 3;

// Pending shell requests: id -> resolve fn
const pendingShellRequests: Map<string, (result: ShellResultPayload) => void> = new Map();

export function setupStubNamespace(ns: Namespace, webNs: Namespace): void {
  // Heartbeat checker
  setInterval(() => {
    for (const stub of store.getAllStubs()) {
      if (stub.status === "online") {
        stub.missed_heartbeats = (stub.missed_heartbeats || 0) + 1;
        if (stub.missed_heartbeats >= MISSED_HEARTBEAT_LIMIT) {
          stub.status = "stale";
          failStubTasks(stub, webNs);
          store.setStub(stub);
          webNs.emit("stub.offline", { stub_id: stub.id });
          console.log(`[stub] ${stub.name} marked stale after ${stub.missed_heartbeats} missed heartbeats`);
        }
      }
    }
  }, HEARTBEAT_INTERVAL);

  ns.on("connection", (socket: Socket) => {
    console.log(`[stub] Socket connected: ${socket.id}`);

    socket.on("register", (payload: RegisterPayload) => {
      const { hostname, gpu, slurm_job_id, max_concurrent, token, type, slurm, remaining_walltime_s, slurm_account_id } = payload;

      // Auth check
      const tokenRecord = store.getToken(token);
      if (!tokenRecord) {
        socket.emit("error", { message: "Invalid token" });
        socket.disconnect();
        return;
      }

      // Check for existing stub with same token + hostname + slurm_job_id (reconnect)
      let stub = store.getStubByHostnameAndToken(hostname, token, slurm_job_id);

      if (stub) {
        // Reconnect: update socket
        stub.socket_id = socket.id;
        stub.status = "online";
        stub.missed_heartbeats = 0;
        stub.last_heartbeat = new Date().toISOString();
        stub.max_concurrent = max_concurrent;
        stub.gpu = gpu;
        if (slurm_job_id) stub.slurm_job_id = slurm_job_id;
        if (slurm_account_id) stub.slurm_account_id = slurm_account_id;
        if (type) stub.type = type;
        if (slurm) stub.slurm = slurm;
        if (remaining_walltime_s !== undefined) stub.remaining_walltime_s = remaining_walltime_s;
        // On reconnect: keep running/dispatched tasks as "running" (stub daemon likely still has them).
        // Only reset paused/migrating/interrupted → queued for re-dispatch.
        for (const task of stub.tasks) {
          if (["paused", "migrating", "interrupted"].includes(task.status)) {
            task.status = "queued";
            task.pid = undefined;
            task.started_at = undefined;
            task.finished_at = undefined;
            task.requeued_at = new Date().toISOString();
          } else if (task.status === "dispatched") {
            // Dispatched = sent to stub before disconnect; stub likely started it already
            task.status = "running";
          }
        }
        store.setStub(stub);
        console.log(`[stub] Re-registered: ${stub.name} (${stub.id})`);
      } else {
        // New stub
        const id = uuidv4();
        const name = `${hostname}-${slurm_job_id || id.slice(0, 6)}`;
        stub = {
          id,
          name,
          hostname,
          gpu,
          slurm_job_id,
          slurm_account_id,
          status: "online",
          type: type || (slurm_job_id ? "slurm" : "workstation"),
          slurm,
          connected_at: new Date().toISOString(),
          last_heartbeat: new Date().toISOString(),
          max_concurrent,
          tasks: [],
          gpu_stats: { timestamp: new Date().toISOString(), gpus: [] },
          token,
          socket_id: socket.id,
          missed_heartbeats: 0,
          remaining_walltime_s,
        };
        store.setStub(stub);
        tokenRecord.used_by = id;
        console.log(`[stub] New stub registered: ${name} (${id})`);
      }

      socket.data.stub_id = stub.id;
      socket.join(`stub:${stub.id}`);

      socket.emit("registered", { stub_id: stub.id });
      webNs.emit("stub.online", sanitizeStub(stub));

      // Dispatch queued tasks
      dispatchQueuedTasks(stub.id, ns);
    });

    socket.on("heartbeat", (payload: HeartbeatPayload) => {
      const stub_id = socket.data.stub_id;
      if (!stub_id) return;
      const stub = store.getStub(stub_id);
      if (!stub) return;

      stub.last_heartbeat = payload.timestamp || new Date().toISOString();
      stub.missed_heartbeats = 0;
      if (stub.status !== "online") {
        stub.status = "online";
        webNs.emit("stub.online", sanitizeStub(stub));
      }
      if (payload.remaining_walltime_s !== undefined) {
        stub.remaining_walltime_s = payload.remaining_walltime_s;
        // Check walltime warnings
        checkWalltimeWarnings(stub, webNs);
      }
      store.setStub(stub);
      socket.emit("pong", { timestamp: new Date().toISOString() });
    });

    socket.on("gpu_stats", (payload: import("../types").GpuStats) => {
      const stub_id = socket.data.stub_id;
      if (!stub_id) return;
      const stub = store.getStub(stub_id);
      if (!stub) return;
      stub.gpu_stats = payload;
      store.setStub(stub);
      webNs.emit("gpu_stats", { stub_id, stats: payload });
      // Record to metrics ring buffer
      if (payload.gpus && payload.gpus.length > 0) {
        metricsStore.pushStubMetrics(stub_id, payload.gpus);
      }
    });

    socket.on("task.started", (payload: TaskStartedPayload) => {
      const stub_id = socket.data.stub_id;
      if (!stub_id) return;
      const task = store.updateTask(stub_id, payload.task_id, {
        status: "running",
        started_at: new Date().toISOString(),
        pid: payload.pid,
      });
      if (task) webNs.emit("task.update", task);
    });

    socket.on("task.progress", (payload: TaskProgressPayload) => {
      const stub_id = socket.data.stub_id;
      if (!stub_id) return;
      const existingTask = store.getTask(stub_id, payload.task_id);
      const previousLoss = existingTask?.progress?.loss;
      const task = store.updateTask(stub_id, payload.task_id, {
        progress: {
          step: payload.step,
          total: payload.total,
          loss: payload.loss,
          metrics: payload.metrics,
        },
      });
      if (task) {
        webNs.emit("task.update", task);
        updateTaskProgressTime(payload.task_id);
        // Record to metrics ring buffer
        metricsStore.pushTaskMetrics(payload.task_id, payload.step, payload.loss, payload.metrics);
        // Check for loss anomalies
        checkLossAnomaly(stub_id, payload.task_id, payload.loss, previousLoss, webNs, ns);
      }
    });

    socket.on("task.log", (payload: TaskLogPayload) => {
      const stub_id = socket.data.stub_id;
      if (!stub_id) return;
      const task = store.getTask(stub_id, payload.task_id);
      if (!task) return;

      // Ring buffer: keep last 500 lines
      const newBuf = [...task.log_buffer, ...payload.lines].slice(-500);
      store.updateTask(stub_id, payload.task_id, { log_buffer: newBuf });

      updateTaskOutputTime(payload.task_id);
      const MAX_LOG_LINES_PER_EMIT = 50;
      let lines = payload.lines;
      if (lines.length > MAX_LOG_LINES_PER_EMIT) {
        lines = [...lines.slice(0, MAX_LOG_LINES_PER_EMIT), `[truncated ${lines.length - MAX_LOG_LINES_PER_EMIT} lines]`];
      }
      webNs.emit("task.log", { stub_id, task_id: payload.task_id, lines });
    });

    socket.on("task.completed", (payload: TaskCompletedPayload & { metrics?: Record<string, number> }) => {
      const stub_id = socket.data.stub_id;
      if (!stub_id) return;
      const task = store.updateTask(stub_id, payload.task_id, {
        status: "completed",
        exit_code: payload.exit_code,
        finished_at: new Date().toISOString(),
        metrics: payload.metrics,
      });
      if (task) {
        webNs.emit("task.update", task);

        // Update grid cell if applicable
        if (task.grid_id && task.grid_cell_id) {
          store.updateGridCell(task.grid_id, task.grid_cell_id, {
            status: "completed",
            metrics: payload.metrics,
          });
          const grid = store.getGrid(task.grid_id);
          if (grid) webNs.emit("grid.update", grid);
        }

        // Dispatch post-hooks
        if (task.post_hooks && task.post_hooks.length > 0) {
          schedulePostHooks(stub_id, task, ns, webNs);
        }

        // Trigger DAG dependency check
        checkDagDependencies(webNs, ns);

        // Try to dispatch queued tasks
        dispatchQueuedTasks(stub_id, ns);

        // Auto-release: if all tasks on this stub are done, shut it down
        checkAutoRelease(stub_id, ns);

        // Discord notification
        sendDiscordNotification(store.getNotificationConfig(), "task.completed", {
          name: task.command.slice(0, 80),
          id: task.id,
          status: "completed",
          stub_id,
          started_at: task.started_at,
          finished_at: task.finished_at,
          exit_code: task.exit_code,
        });
      }
    });

    socket.on("task.failed", (payload: TaskFailedPayload) => {
      const stub_id = socket.data.stub_id;
      if (!stub_id) return;

      // Check auto-retry before marking failed
      const existingTask = store.getTask(stub_id, payload.task_id);
      const retryCount = existingTask?.retry_count ?? 0;
      const maxRetries = existingTask?.max_retries ?? 0;
      // SIGTERM (exit_code -15) = intentional kill, never auto-retry
      const isIntentionalKill = payload.exit_code === -15;

      if (existingTask && !isIntentionalKill && retryCount < maxRetries) {
        // Auto-retry: reset task back to queued
        const updated = store.updateTask(stub_id, payload.task_id, {
          status: "queued",
          retry_count: retryCount + 1,
          exit_code: undefined,
          started_at: undefined,
          finished_at: undefined,
          pid: undefined,
        });
        if (updated) {
          webNs.emit("task.update", updated);
          console.log(`[stub] Auto-retrying task ${payload.task_id} (attempt ${retryCount + 1}/${maxRetries})`);
          dispatchQueuedTasks(stub_id, ns);
        }
        return;
      }

      const updateFields: any = {
        status: "failed",
        exit_code: payload.exit_code,
        finished_at: new Date().toISOString(),
      };
      if (payload.failure_reason) {
        updateFields.failure_reason = payload.failure_reason;
      }
      const task = store.updateTask(stub_id, payload.task_id, updateFields);
      if (task) {
        webNs.emit("task.update", task);

        // Update grid cell if applicable
        if (task.grid_id && task.grid_cell_id) {
          store.updateGridCell(task.grid_id, task.grid_cell_id, { status: "failed" });
          const grid = store.getGrid(task.grid_id);
          if (grid) webNs.emit("grid.update", grid);
        }

        // Trigger DAG: dependents may be blocked
        checkDagDependencies(webNs, ns);

        dispatchQueuedTasks(stub_id, ns);

        // Auto-release: if all tasks on this stub are done, shut it down
        checkAutoRelease(stub_id, ns);

        // Discord notification
        sendDiscordNotification(store.getNotificationConfig(), "task.failed", {
          name: task.command.slice(0, 80),
          id: task.id,
          status: "failed",
          stub_id,
          started_at: task.started_at,
          finished_at: task.finished_at,
          exit_code: task.exit_code,
          error: payload.error,
        });
      }
    });

    // Handle task.checkpoint_and_pause (ManagedTraining migration)
    socket.on("task.checkpointed", (payload: { task_id: string; checkpoint_path: string }) => {
      const stub_id = socket.data.stub_id;
      if (!stub_id) return;
      const task = store.updateTask(stub_id, payload.task_id, {
        checkpoint_path: payload.checkpoint_path,
        status: "migrating",
      });
      if (task) webNs.emit("task.update", task);
    });

    socket.on("shell.result", (payload: ShellResultPayload) => {
      const resolve = pendingShellRequests.get(payload.id);
      if (resolve) {
        resolve(payload);
        pendingShellRequests.delete(payload.id);
      }
    });

    socket.on("disconnect", () => {
      const stub_id = socket.data.stub_id;
      if (!stub_id) return;
      const stub = store.getStub(stub_id);
      if (!stub) return;
      stub.status = "offline";
      failStubTasks(stub, webNs);
      store.setStub(stub);
      webNs.emit("stub.offline", { stub_id });
      console.log(`[stub] Disconnected: ${stub.name}`);
    });
  });
}

/**
 * Schedule post-hooks to run sequentially on the same stub.
 */
async function schedulePostHooks(
  stubId: string,
  task: import("../types").Task,
  ns: Namespace,
  webNs: Namespace
): Promise<void> {
  const hooks = task.post_hooks || [];
  let allPassed = true;

  for (const hookTemplate of hooks) {
    // Variable substitution
    const command = hookTemplate
      .replace(/\{run_dir\}/g, task.run_dir || "")
      .replace(/\{task_id\}/g, task.id)
      .replace(/\{stub_id\}/g, stubId);

    try {
      const result = await execShell(stubId, command, 300, ns);
      if (result.exit_code !== 0) {
        allPassed = false;
        console.warn(`[post-hook] Failed: ${command} (exit ${result.exit_code})`);
        webNs.emit("task.log", {
          stub_id: stubId,
          task_id: task.id,
          lines: [`[post-hook] FAILED: ${command}`, result.stderr],
        });
        break;
      } else {
        webNs.emit("task.log", {
          stub_id: stubId,
          task_id: task.id,
          lines: [`[post-hook] OK: ${command}`],
        });
      }
    } catch (err) {
      allPassed = false;
      console.warn(`[post-hook] Error: ${command}`, err);
      break;
    }
  }

  if (!allPassed) {
    const updated = store.updateTask(stubId, task.id, { status: "completed_with_errors" });
    if (updated) webNs.emit("task.update", updated);
  }
}

export function dispatchQueuedTasks(stubId: string, ns: Namespace): void {
  const stub = store.getStub(stubId);
  if (!stub || stub.status !== "online") return;

  const running = stub.tasks.filter((t) => t.status === "running" || t.status === "dispatched").length;
  let slots = stub.max_concurrent - running;
  if (slots <= 0) return;

  // Check walltime: don't dispatch if < 10min remaining (0 = unknown, treat as OK)
  if (stub.remaining_walltime_s !== undefined && stub.remaining_walltime_s > 0 && stub.remaining_walltime_s < 600) return;

  // Fill from stub-local queue first
  const queued = stub.tasks.filter((t) => t.status === "queued");
  const localToDispatch = queued.slice(0, slots);

  // Mark local tasks as "dispatched" BEFORE emitting to prevent double-dispatch
  for (const task of localToDispatch) {
    store.updateTask(stubId, task.id, { status: "dispatched" });
  }

  for (const task of localToDispatch) {
    if (stub.socket_id) {
      ns.to(`stub:${stubId}`).emit("task.run", {
        task_id: task.id,
        command: task.command,
        cwd: task.cwd,
        env: task.env,
        env_setup: task.env_setup,
        param_overrides: task.param_overrides,
        base_config: task.base_config,
      });
      console.log(`[stub] Dispatched local task ${task.id} to stub ${stubId}`);
    }
  }

  slots -= localToDispatch.length;

  // If we still have capacity, pull from the global queue
  if (slots > 0) {
    const globalQueue = store.getGlobalQueue();
    const globalToDispatch = globalQueue.slice(0, slots);

    for (const task of globalToDispatch) {
      // Move task from global queue to this stub
      store.removeFromGlobalQueue(task.id);
      task.stub_id = stubId;
      task.status = "dispatched";
      stub.tasks.push(task);
      store.setStub(stub);

      if (stub.socket_id) {
        ns.to(`stub:${stubId}`).emit("task.run", {
          task_id: task.id,
          command: task.command,
          cwd: task.cwd,
          env: task.env,
          env_setup: task.env_setup,
          param_overrides: task.param_overrides,
          base_config: task.base_config,
        });
        console.log(`[stub] Dispatched global-queue task ${task.id} to stub ${stubId}`);
      }
    }
  }
}

export function execShell(
  stubId: string,
  command: string,
  timeout: number,
  ns: Namespace
): Promise<ShellResultPayload> {
  return new Promise((resolve, reject) => {
    const stub = store.getStub(stubId);
    if (!stub || stub.status !== "online") {
      reject(new Error("Stub not online"));
      return;
    }

    const id = uuidv4();
    const timer = setTimeout(() => {
      pendingShellRequests.delete(id);
      reject(new Error("Shell exec timeout"));
    }, (timeout + 5) * 1000);

    pendingShellRequests.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });

    ns.to(`stub:${stubId}`).emit("shell.exec", { id, command, timeout });
  });
}

function checkAutoRelease(stubId: string, ns: Namespace): void {
  const stub = store.getStub(stubId);
  if (!stub || !stub.auto_release) return;

  const activeStatuses = ["running", "queued", "dispatched", "paused", "waiting", "blocked", "migrating"];
  const hasActive = stub.tasks.some((t) => activeStatuses.includes(t.status));
  if (hasActive) return;

  console.log(`[stub] Auto-releasing stub ${stub.name} — all tasks done`);
  ns.to(`stub:${stubId}`).emit("shutdown", {});
}

function failStubTasks(stub: Stub, webNs: Namespace): void {
  const toRemove: string[] = [];

  for (const task of stub.tasks) {
    if (task.status === "running") {
      // Mark interrupted — stub is offline. On reconnect the stub re-registers and
      // the reconciliation loop (see register handler) will reset interrupted→queued.
      task.status = "interrupted";
      task.finished_at = new Date().toISOString();
      webNs.emit("task.update", task);

      if (task.grid_id && task.grid_cell_id) {
        store.updateGridCell(task.grid_id, task.grid_cell_id, { status: "failed" });
        const grid = store.getGrid(task.grid_id);
        if (grid) webNs.emit("grid.update", grid);
      }
    } else if (["paused", "dispatched"].includes(task.status)) {
      // Paused/dispatched: mark interrupted (state uncertain without socket)
      task.status = "interrupted";
      task.finished_at = new Date().toISOString();
      webNs.emit("task.update", task);

      if (task.grid_id && task.grid_cell_id) {
        store.updateGridCell(task.grid_id, task.grid_cell_id, { status: "failed" });
        const grid = store.getGrid(task.grid_id);
        if (grid) webNs.emit("grid.update", grid);
      }
    } else if (task.status === "queued") {
      // Queued tasks: return to global queue for reassignment
      toRemove.push(task.id);
      const requeuedTask = { ...task, stub_id: "", requeued_at: new Date().toISOString() };
      store.addToGlobalQueue(requeuedTask);
      console.log(`[stub] Requeued task ${task.id} from offline stub ${stub.name} to global queue`);
      webNs.emit("task.update", { ...requeuedTask, status: "queued" });
    }
  }

  // Remove requeued tasks from stub's task list
  if (toRemove.length > 0) {
    stub.tasks = stub.tasks.filter((t) => !toRemove.includes(t.id));
  }
}

function sanitizeStub(stub: Stub) {
  const { socket_id, ...rest } = stub;
  return rest;
}

function checkWalltimeWarnings(stub: Stub, webNs: Namespace): void {
  const rem = stub.remaining_walltime_s;
  if (rem === undefined) return;

  // 30 min warning
  if (rem <= 1800 && rem > 1770) {
    webNs.emit("walltime.warning", { stub_id: stub.id, remaining_s: rem, level: "warning" });
    console.log(`[walltime] ${stub.name}: 30min remaining`);
  }
  // 5 min warning
  if (rem <= 300 && rem > 270) {
    webNs.emit("walltime.warning", { stub_id: stub.id, remaining_s: rem, level: "critical" });
    console.log(`[walltime] ${stub.name}: 5min remaining`);

    // Set should_checkpoint for running tasks with SDK
    const stub_data = store.getStub(stub.id);
    if (stub_data) {
      for (const task of stub_data.tasks) {
        if (task.status === "running") {
          store.updateTask(stub.id, task.id, { progress: { ...task.progress, step: task.progress?.step || 0, total: task.progress?.total || 0 } });
        }
      }
    }
  }
}
