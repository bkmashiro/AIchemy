/**
 * Scheduler: smart task allocation + anomaly detection + migration suggestions.
 */
import { Namespace } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import { store } from "./store";
import { Task, Stub, AnomalyAlert, MigrationSuggestion } from "./types";

// Track last progress timestamps per task
const lastProgressAt: Map<string, number> = new Map();
// Track GPU idle start per stub
const gpuIdleSince: Map<string, number> = new Map();
// Track last log output per task
const lastOutputAt: Map<string, number> = new Map();

export function updateTaskProgressTime(taskId: string): void {
  lastProgressAt.set(taskId, Date.now());
}

export function updateTaskOutputTime(taskId: string): void {
  lastOutputAt.set(taskId, Date.now());
}

/**
 * Pick the best stub for a task based on VRAM, load, and GPU type preference.
 */
export function pickBestStub(estimatedVramMb?: number, preferGpuType?: string): Stub | undefined {
  const onlineStubs = store.getAllStubs().filter((s) => s.status === "online");
  if (onlineStubs.length === 0) return undefined;

  let candidates = onlineStubs;

  // Filter by VRAM
  if (estimatedVramMb && estimatedVramMb > 0) {
    const fits = candidates.filter((s) => s.gpu.vram_total_mb >= estimatedVramMb);
    if (fits.length > 0) candidates = fits;
  }

  // Sort: prefer same GPU type → prefer idle → prefer low load
  candidates.sort((a, b) => {
    const sameA = preferGpuType ? (a.gpu.name.includes(preferGpuType) ? 0 : 1) : 0;
    const sameB = preferGpuType ? (b.gpu.name.includes(preferGpuType) ? 0 : 1) : 0;
    if (sameA !== sameB) return sameA - sameB;

    const aLoad = a.tasks.filter((t) => ["running", "queued", "dispatched"].includes(t.status)).length;
    const bLoad = b.tasks.filter((t) => ["running", "queued", "dispatched"].includes(t.status)).length;
    return aLoad - bLoad;
  });

  return candidates[0];
}

/**
 * Check DAG dependencies: transition waiting tasks to queued if deps are met,
 * or to blocked if a dependency failed.
 */
export function checkDagDependencies(webNs: Namespace, stubNs: Namespace): void {
  const allTasks = store.getAllTasks();
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));

  for (const task of allTasks) {
    if (task.status !== "waiting") continue;
    if (!task.depends_on || task.depends_on.length === 0) continue;

    const deps = task.depends_on.map((id) => taskMap.get(id));
    const anyMissing = deps.some((d) => d === undefined);
    if (anyMissing) continue;

    // Helper: update task regardless of whether it's on a stub or in global queue
    const updateTask = (update: Partial<Task>): Task | undefined => {
      if (!task.stub_id) {
        // Global queue task
        return store.updateGlobalQueueTask(task.id, update);
      }
      return store.updateTask(task.stub_id, task.id, update);
    };

    const anyFailed = deps.some((d) => d && ["failed", "killed", "blocked"].includes(d.status));
    if (anyFailed) {
      const updated = updateTask({ status: "blocked" });
      if (updated) webNs.emit("task.update", updated);
      continue;
    }

    const allDone = deps.every((d) => d && ["completed", "completed_with_errors"].includes(d.status));
    if (allDone) {
      const updated = updateTask({ status: "queued" });
      if (updated) {
        webNs.emit("task.update", updated);
        // Try to dispatch — use lazy require to break circular dependency
        try {
          const stubModule = require("./socket/stub");
          if (task.stub_id) {
            stubModule.dispatchQueuedTasks(task.stub_id, stubNs);
          } else {
            // Global queue task: pick best stub and dispatch
            const bestStub = pickBestStub(task.estimated_vram_mb);
            if (bestStub) stubModule.dispatchQueuedTasks(bestStub.id, stubNs);
          }
        } catch {
          // Module not available yet (e.g. during tests before full init); skip dispatch
        }
      }
    }
  }
}

/**
 * Detect training anomalies: stalls, GPU idle, NaN loss, etc.
 */
export function runAnomalyDetection(webNs: Namespace): void {
  const cfg = store.getStallConfig();
  if (!cfg.enabled) return;

  const now = Date.now();

  for (const stub of store.getAllStubs()) {
    if (stub.status !== "online") continue;

    // GPU idle detection
    const gpuStats = stub.gpu_stats?.gpus || [];
    if (gpuStats.length > 0) {
      const avgUtil = gpuStats.reduce((s, g) => s + g.utilization_pct, 0) / gpuStats.length;
      const hasRunningTasks = stub.tasks.some((t) => t.status === "running");

      if (hasRunningTasks && avgUtil < cfg.gpu_idle_threshold_pct) {
        const idleSince = gpuIdleSince.get(stub.id);
        if (!idleSince) {
          gpuIdleSince.set(stub.id, now);
        } else {
          const idleMinutes = (now - idleSince) / 60_000;
          if (idleMinutes >= cfg.gpu_idle_timeout_min) {
            // Check if we already have a recent alert for this
            const existingAlert = store.getAllAlerts().find(
              (a) => a.stub_id === stub.id && a.type === "gpu_idle" && !a.resolved &&
                (now - new Date(a.created_at).getTime()) < 60_000 * cfg.gpu_idle_timeout_min * 2
            );
            if (!existingAlert) {
              emitAlert(stub.id, undefined, "gpu_idle",
                `GPU on stub ${stub.name} has been idle (${avgUtil.toFixed(1)}% util) for ${idleMinutes.toFixed(0)} minutes`,
                webNs);
            }
          }
        }
      } else {
        gpuIdleSince.delete(stub.id);
      }
    }

    // Per-task stall detection
    for (const task of stub.tasks) {
      if (task.status !== "running") continue;

      // Progress stall (SDK mode)
      if (task.progress) {
        const lastProg = lastProgressAt.get(task.id);
        if (lastProg) {
          const staleMin = (now - lastProg) / 60_000;
          if (staleMin >= cfg.no_progress_timeout_min) {
            const existingAlert = store.getAllAlerts().find(
              (a) => a.task_id === task.id && a.type === "stall" && !a.resolved
            );
            if (!existingAlert) {
              emitAlert(stub.id, task.id, "stall",
                `Task ${task.id} has not reported progress for ${staleMin.toFixed(0)} minutes`,
                webNs);
            }
          }
        } else {
          // Initialize
          lastProgressAt.set(task.id, now);
        }
      }

      // No output stall (non-SDK mode)
      if (!task.progress) {
        const lastOut = lastOutputAt.get(task.id);
        if (lastOut) {
          const staleMin = (now - lastOut) / 60_000;
          if (staleMin >= cfg.no_progress_timeout_min) {
            const existingAlert = store.getAllAlerts().find(
              (a) => a.task_id === task.id && a.type === "no_output" && !a.resolved
            );
            if (!existingAlert) {
              emitAlert(stub.id, task.id, "no_output",
                `Task ${task.id} has produced no log output for ${staleMin.toFixed(0)} minutes`,
                webNs);
            }
          }
        } else {
          lastOutputAt.set(task.id, now);
        }
      }
    }
  }
}

function emitAlert(
  stubId: string,
  taskId: string | undefined,
  type: AnomalyAlert["type"],
  message: string,
  webNs: Namespace
): void {
  const alert: AnomalyAlert = {
    id: uuidv4(),
    stub_id: stubId,
    task_id: taskId,
    type,
    message,
    created_at: new Date().toISOString(),
    resolved: false,
  };
  store.addAlert(alert);
  webNs.emit("anomaly.alert", alert);
  console.warn(`[anomaly] ${type}: ${message}`);
}

/**
 * Check for loss anomalies reported from SDK (NaN/Inf or spike).
 * Called when a progress update arrives.
 */
export function checkLossAnomaly(
  stubId: string,
  taskId: string,
  loss: number | undefined,
  previousLoss: number | undefined,
  webNs: Namespace,
  stubNs: Namespace
): void {
  if (loss === undefined) return;

  // NaN or Inf → auto-pause
  if (!isFinite(loss) || isNaN(loss)) {
    const task = store.updateTask(stubId, taskId, { status: "paused" });
    if (task) {
      stubNs.to(`stub:${stubId}`).emit("task.pause", { task_id: taskId });
      webNs.emit("task.update", task);
    }
    emitAlert(stubId, taskId, "loss_nan",
      `Task ${taskId} reported loss=${loss} (NaN/Inf) — task auto-paused`,
      webNs);
    return;
  }

  // 10x spike → warning only
  if (previousLoss !== undefined && previousLoss > 0 && loss > previousLoss * 10) {
    emitAlert(stubId, taskId, "loss_spike",
      `Task ${taskId} loss spiked from ${previousLoss.toFixed(4)} to ${loss.toFixed(4)} (${(loss / previousLoss).toFixed(1)}x jump)`,
      webNs);
  }
}

/**
 * Generate migration suggestions based on load imbalance.
 */
export function generateMigrationSuggestions(webNs: Namespace): void {
  const onlineStubs = store.getAllStubs().filter((s) => s.status === "online");
  if (onlineStubs.length < 2) return;

  const loads = onlineStubs.map((s) => ({
    stub: s,
    running: s.tasks.filter((t) => t.status === "running").length,
    queued: s.tasks.filter((t) => t.status === "queued").length,
  }));

  const busy = loads.filter((l) => l.running >= 2 && l.queued > 0);
  const idle = loads.filter((l) => l.running === 0 && l.queued === 0);

  for (const busyStub of busy) {
    for (const idleStub of idle) {
      // Suggest migrating first queued task from busy to idle
      const task = busyStub.stub.tasks.find((t) => t.status === "queued");
      if (!task) continue;

      // Don't duplicate existing suggestions
      const existing = store.getAllMigrationSuggestions().find(
        (s) => s.task_id === task.id && s.to_stub === idleStub.stub.id
      );
      if (existing) continue;

      const suggestion: MigrationSuggestion = {
        id: uuidv4(),
        task_id: task.id,
        from_stub: busyStub.stub.id,
        to_stub: idleStub.stub.id,
        reason: `Stub ${busyStub.stub.name} has ${busyStub.queued} queued tasks while ${idleStub.stub.name} is idle`,
        created_at: new Date().toISOString(),
      };

      store.addMigrationSuggestion(suggestion);
      webNs.emit("migration.suggestion", suggestion);
    }
  }
}

/**
 * Check running tasks for timeout violations. Kill any that have exceeded timeout_s.
 */
export function checkTaskTimeouts(stubNs: Namespace, webNs: Namespace): void {
  const now = Date.now();
  for (const stub of store.getAllStubs()) {
    for (const task of stub.tasks) {
      if (task.status !== "running") continue;
      if (!task.timeout_s || !task.started_at) continue;

      const elapsed = now - new Date(task.started_at).getTime();
      if (elapsed > task.timeout_s * 1000) {
        // Kill the task
        stubNs.to(`stub:${stub.id}`).emit("task.kill", { task_id: task.id, signal: "SIGTERM" });
        const updated = store.updateTask(stub.id, task.id, {
          status: "killed",
          finished_at: new Date().toISOString(),
        });
        if (updated) webNs.emit("task.update", updated);

        // Create a timeout alert
        const alert: AnomalyAlert = {
          id: uuidv4(),
          stub_id: stub.id,
          task_id: task.id,
          type: "stall",
          message: `Task ${task.id} exceeded timeout of ${task.timeout_s}s and was killed`,
          created_at: new Date().toISOString(),
          resolved: false,
        };
        store.addAlert(alert);
        webNs.emit("anomaly.alert", alert);
        console.warn(`[scheduler] Task ${task.id} timed out after ${task.timeout_s}s`);
      }
    }
  }
}

/**
 * Drain global queue: dispatch queued tasks to stubs with available slots.
 */
export function drainGlobalQueue(stubNs: Namespace): void {
  const globalQueue = store.getGlobalQueue();
  if (globalQueue.length === 0) return;

  const onlineStubs = store.getAllStubs().filter((s) => s.status === "online");
  for (const stub of onlineStubs) {
    const running = stub.tasks.filter((t) => t.status === "running" || t.status === "dispatched").length;
    if (running < stub.max_concurrent) {
      try {
        const stubModule = require("./socket/stub");
        stubModule.dispatchQueuedTasks(stub.id, stubNs);
      } catch {}
    }
  }
}

/**
 * Start background monitoring loops.
 */
export function startScheduler(webNs: Namespace, stubNs: Namespace): void {
  // DAG dependency check every 5s
  setInterval(() => checkDagDependencies(webNs, stubNs), 5_000);
  // Global queue drain every 10s
  setInterval(() => drainGlobalQueue(stubNs), 10_000);
  // Anomaly detection every 60s
  setInterval(() => runAnomalyDetection(webNs), 60_000);
  // Migration suggestions every 2 minutes
  setInterval(() => generateMigrationSuggestions(webNs), 120_000);
  // Task timeout enforcement every 30s
  setInterval(() => checkTaskTimeouts(stubNs, webNs), 30_000);
}
