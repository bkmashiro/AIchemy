/**
 * scheduler.ts — Constraint-aware task scheduler.
 *
 * Scoring: hard constraints (GPU mem, GPU type, CPU mem, online) → -Infinity.
 * Soft scoring: idle ratio, queue depth, grid locality, VRAM waste.
 *
 * Triggers: new task in global queue, stub comes online, task completes, 30s periodic.
 */

import path from "path";
import { Namespace } from "socket.io";
import { store } from "./store";
import { Stub, Task } from "./types";
import { reliableEmitToStub } from "./reliable";
import { logger } from "./log";
import { dispatchTask } from "./task-actions";
import { notifyDispatched } from "./discord";

// ─── GPU name normalization ───────────────────────────────────────────────────

function normalizeGpuName(name: string): string {
  return name.toLowerCase().replace(/[\s\-_]/g, "").replace("nvidia", "").replace("geforce", "");
}

// ─── Available VRAM calculation ───────────────────────────────────────────────

function availableVram(stub: Stub): number {
  // Use GPU stats if available
  if (stub.gpu_stats?.gpus && stub.gpu_stats.gpus.length > 0) {
    return stub.gpu_stats.gpus.reduce((sum, g) => sum + (g.memory_total_mb - g.memory_used_mb), 0);
  }
  // Estimate from running tasks' requirements
  const reservedMb = stub.tasks
    .filter((t) => ["running", "dispatched"].includes(t.status))
    .reduce((sum, t) => sum + (t.requirements?.gpu_mem_mb || 0), 0);
  return Math.max(0, stub.gpu.vram_total_mb - reservedMb);
}

function availableMem(stub: Stub): number {
  if (stub.system_stats) {
    return stub.system_stats.mem_total_mb - stub.system_stats.mem_used_mb;
  }
  return Infinity; // Unknown — don't block
}

/** Return human-readable reason why a stub can't run a task, or null if it can. */
function rejectReason(stub: Stub, task: Task): string | null {
  if (stub.status !== "online") return "offline";
  if (task.target_tags?.length) {
    const stubTags = new Set(stub.tags || []);
    if (!task.target_tags.every(t => stubTags.has(t))) return "tag_mismatch";
  }
  if (task.requirements?.gpu_mem_mb && availableVram(stub) < task.requirements.gpu_mem_mb) {
    return `vram_insufficient(need=${task.requirements.gpu_mem_mb},avail=${Math.floor(availableVram(stub))})`;
  }
  if (task.requirements?.gpu_type?.length) {
    if (!task.requirements.gpu_type.some(t => normalizeGpuName(stub.gpu.name).includes(normalizeGpuName(t)))) {
      return "gpu_type_mismatch";
    }
  }
  if (task.python_env && stub.available_envs) {
    if (!stub.available_envs.some(e => e.name === task.python_env)) return "python_env_missing";
  }
  const running = stub.tasks.filter(t => ["running", "dispatched"].includes(t.status)).length;
  const queued = stub.tasks.filter(t => t.status === "queued").length;
  if (running + queued >= stub.max_concurrent) return `slots_full(${running}+${queued}>=${stub.max_concurrent})`;
  return null;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export function scoreStub(stub: Stub, task: Task): number {
  // Hard constraints
  if (stub.status !== "online") return -Infinity;

  // Tag filter: stub must have ALL target_tags
  if (task.target_tags && task.target_tags.length > 0) {
    const stubTags = new Set(stub.tags || []);
    if (!task.target_tags.every((tag) => stubTags.has(tag))) return -Infinity;
  }

  if (task.requirements?.gpu_mem_mb) {
    if (availableVram(stub) < task.requirements.gpu_mem_mb) return -Infinity;
  }

  if (task.requirements?.gpu_type?.length) {
    const stubNorm = normalizeGpuName(stub.gpu.name);
    const matches = task.requirements.gpu_type.some(
      (t) => normalizeGpuName(t) === stubNorm || stubNorm.includes(normalizeGpuName(t))
    );
    if (!matches) return -Infinity;
  }

  if (task.requirements?.cpu_mem_mb && stub.system_stats) {
    if (availableMem(stub) < task.requirements.cpu_mem_mb) return -Infinity;
  }

  // Python env constraint
  if (task.python_env) {
    const envs = stub.available_envs || [];
    if (!envs.some((e) => e.name === task.python_env)) return -Infinity;
  }

  // Concurrency hard constraint
  const running = stub.tasks.filter((t) => ["running", "dispatched"].includes(t.status)).length;
  const queued = stub.tasks.filter((t) => t.status === "queued").length;
  if (running + queued >= stub.max_concurrent) return -Infinity;

  // Soft scoring
  let s = 0;

  // Idle ratio bonus (0–40 points)
  s += 40 * Math.max(0, stub.max_concurrent - running) / Math.max(1, stub.max_concurrent);
  // Queue depth penalty
  s -= 10 * queued;

  // Grid locality: prefer stubs already running tasks from the same grid
  if (task.grid_id) {
    const gridTasks = store.getGridTasks(task.grid_id);
    const gridStubIds = new Set(gridTasks.map((t) => t.stub_id).filter(Boolean));
    if (gridStubIds.has(stub.id)) {
      s += 20;
    }
  }

  // VRAM waste penalty: avoid over-provisioning
  if (task.requirements?.gpu_mem_mb) {
    s -= (stub.gpu.vram_total_mb - task.requirements.gpu_mem_mb) / 1000;
  }

  return s;
}

// ─── Compute server-authoritative run_dir ────────────────────────────────────

/**
 * Compute run_dir for a task at dispatch time.
 * Priority: task.run_dir > stub.default_output_dir > (stub.default_cwd or cwd) / "runs"
 * Final path: base_output_dir / fingerprint[:12]
 */
export function computeRunDir(task: Task, stub: Stub): string {
  // If task has an explicit run_dir set by user, use it as-is (treat as full path)
  if (task.run_dir) {
    return task.run_dir;
  }

  // Determine base_output_dir
  let baseOutputDir: string;
  if (stub.default_output_dir) {
    baseOutputDir = stub.default_output_dir;
  } else {
    const base = task.cwd || stub.default_cwd || process.cwd();
    baseOutputDir = path.join(base, "runs");
  }

  return path.join(baseOutputDir, task.fingerprint.slice(0, 12));
}

// ─── Build run payload ────────────────────────────────────────────────────────

/** Resolve python_env name to activation command using stub's available_envs. */
function resolveEnvSetup(task: Task, stub: Stub): string | undefined {
  if (!task.python_env) return task.env_setup;
  const envs = stub.available_envs || [];
  const match = envs.find((e) => e.name === task.python_env);
  if (!match) return task.env_setup;

  // Use the activate command from stub's env discovery if available
  const activateCmd = match.activate
    || (match.type === "venv" ? `source ${match.path}/bin/activate` : `micromamba activate ${match.path}`);

  // Prepend to existing env_setup if any
  return task.env_setup ? `${activateCmd} && ${task.env_setup}` : activateCmd;
}

export function buildRunPayload(task: Task, stub: Stub): object {
  const run_dir = computeRunDir(task, stub);
  return {
    task_id: task.id,
    command: task.command,
    cwd: task.cwd,
    env: task.env,
    env_setup: resolveEnvSetup(task, stub),
    run_dir,
    params: task.param_overrides,
  };
}

// ─── Dispatch queued tasks for a stub ────────────────────────────────────────

export function maybeDispatch(stub: Stub): void {
  if (stub.status !== "online") return;

  const active = stub.tasks.filter((t) => ["running", "dispatched"].includes(t.status)).length;
  const slots = stub.max_concurrent - active;
  if (slots <= 0) return;

  const queued = stub.tasks
    .filter((t) => t.status === "queued")
    .sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at));

  logger.info("maybeDispatch", { stub: stub.name, active, slots, queued: queued.length, total_tasks: stub.tasks.length });

  const toDispatch = queued.slice(0, slots);

  for (const task of toDispatch) {
    const run_dir = computeRunDir(task, stub);
    // Persist computed run_dir into task so write lock and display work correctly
    const updated = dispatchTask(stub.id, task.id, run_dir);
    reliableEmitToStub(stub.id, "task.run", buildRunPayload(task, stub));
    logger.info("task.dispatch", { task_seq: task.seq, stub: stub.name, display_name: task.display_name, run_dir });
    if (updated) notifyDispatched(updated).catch(() => {});
  }
}

// ─── Main schedule loop ───────────────────────────────────────────────────────

export function schedule(): void {
  const stubs = store.getOnlineStubs();
  if (stubs.length === 0) return;

  // Dispatch any queued tasks already on stubs (e.g. after retry/status reset)
  for (const stub of stubs) {
    maybeDispatch(stub);
  }

  const queue = store.getGlobalQueue(); // sorted: priority desc, created_at asc
  if (queue.length === 0) return;

  for (const task of queue) {
    // Re-fetch stubs each iteration — previous assignment mutates store
    const freshStubs = store.getOnlineStubs();
    const candidates = freshStubs
      .map((s) => ({ stub: s, score: scoreStub(s, task) }))
      .filter((c) => c.score > -Infinity)
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      const reasons = freshStubs.map(s => `${s.name}:${rejectReason(s, task) || "?"}`).join(", ");
      logger.info("scheduler.no_candidate", {
        task_seq: task.seq,
        display_name: task.display_name,
        reasons,
      });
      continue;
    }

    const best = candidates[0].stub;
    logger.info("scheduler.assign", { task_seq: task.seq, stub: best.name, score: candidates[0].score });
    const moved = store.moveToStubQueue(task.id, best.id);
    if (moved) {
      const updatedStub = store.getStub(best.id);
      if (updatedStub) {
        maybeDispatch(updatedStub);
      }
    }
  }
}

// ─── Trigger helpers ─────────────────────────────────────────────────────────

export function triggerSchedule(): void {
  try {
    schedule();
  } catch (err) {
    logger.error("scheduler.error", { error: String(err) });
  }
}

// ─── Periodic scheduling ─────────────────────────────────────────────────────

export function startScheduler(_webNs: Namespace, _stubNs: Namespace): void {
  // Periodic schedule: every 30s
  setInterval(() => triggerSchedule(), 30_000);
  // Also drain immediately on startup (tasks may be pending)
  setTimeout(() => triggerSchedule(), 1_000);
}
