/**
 * task-actions.ts — Typed action methods for task state transitions.
 *
 * Every status change goes through one of these methods.
 * No other code should set task.status directly.
 *
 * Each method encapsulates: which status to set + which timestamps to fill.
 * Side effects (write lock release, fingerprint reindex, auto-archive) are
 * handled by store.updateTask() internally.
 */

import { v4 as uuidv4 } from "uuid";
import { store } from "./store";
import { Task, TaskStatus } from "./types";
import { logger } from "./log";

const now = () => new Date().toISOString();

// ─── Stub-scoped actions ────────────────────────────────────────────────────

/** pending → assigned (stub owns the task) */
export function assignTask(stubId: string, taskId: string, run_dir: string): Task | undefined {
  return store.updateTask(stubId, taskId, { status: "assigned" as TaskStatus, run_dir });
}

/** assigned → running */
export function startTask(stubId: string, taskId: string, pid: number): Task | undefined {
  return store.updateTask(stubId, taskId, {
    status: "running" as TaskStatus,
    started_at: now(),
    pid,
  });
}

/** assigned → running (auto-promote on first log/progress, no-op if already running) */
export function promoteIfAssigned(stubId: string, taskId: string): void {
  const task = store.getTask(stubId, taskId);
  if (task?.status === "assigned") {
    store.updateTask(stubId, taskId, {
      status: "running" as TaskStatus,
      started_at: now(),
    });
  }
}

/** running → completed */
export function completeTask(stubId: string, taskId: string, exitCode: number): Task | undefined {
  return store.updateTask(stubId, taskId, {
    status: "completed" as TaskStatus,
    exit_code: exitCode,
    finished_at: now(),
  });
}

/** running/assigned → failed */
export function failTask(stubId: string, taskId: string, exitCode?: number, extra?: Partial<Task>): Task | undefined {
  return store.updateTask(stubId, taskId, {
    ...extra,
    status: "failed" as TaskStatus,
    exit_code: exitCode,
    finished_at: now(),
  });
}

/** any active → cancelled */
export function cancelTask(stubId: string, taskId: string, exitCode?: number): Task | undefined {
  return store.updateTask(stubId, taskId, {
    status: "cancelled" as TaskStatus,
    exit_code: exitCode,
    finished_at: now(),
  });
}

/** Set disconnected_at flag on a running/paused task without changing status */
export function markDisconnected(stubId: string, taskId: string): Task | undefined {
  const found = store.findTask(taskId);
  if (!found || !["running", "paused"].includes(found.task.status)) return undefined;
  return store.updateTask(stubId, taskId, {
    disconnected_at: now(),
    stub_offline: true,
  });
}

/** Clear disconnected_at flag when stub reconnects */
export function clearDisconnected(stubId: string, taskId: string): Task | undefined {
  return store.updateTask(stubId, taskId, {
    disconnected_at: undefined,
    stub_offline: undefined,
  });
}

/** dead_tasks on reattach — resolve to completed or failed based on exit code */
export function resolveDeadTask(stubId: string, taskId: string, exitCode: number): Task | undefined {
  const status: TaskStatus = exitCode === 0 ? "completed" : "failed";
  return store.updateTask(stubId, taskId, {
    status,
    exit_code: exitCode,
    finished_at: now(),
  });
}

/** preflight fail → failed with error log */
export function preflightFail(stubId: string, taskId: string, errors: string[]): Task | undefined {
  const task = store.getTask(stubId, taskId);
  return store.updateTask(stubId, taskId, {
    status: "failed" as TaskStatus,
    finished_at: now(),
    log_buffer: [...(task?.log_buffer ?? []), ...errors],
  });
}

/** running → paused */
export function pauseTask(stubId: string, taskId: string): Task | undefined {
  return store.updateTask(stubId, taskId, {
    status: "paused" as TaskStatus,
  });
}

/** paused → running */
export function resumeTask(stubId: string, taskId: string): Task | undefined {
  return store.updateTask(stubId, taskId, {
    status: "running" as TaskStatus,
  });
}

// ─── Retry task creation ───────────────────────────────────────────────────

export interface RetryTaskOpts {
  /** Override requirements (e.g., bumped gpu_mem_mb for OOM retries) */
  requirements?: Task["requirements"];
  /** Clear run_dir so scheduler assigns a fresh path (default: true) */
  clearRunDir?: boolean;
}

/**
 * Create a retry copy of a terminal task.
 * Unified helper — used by auto-retry, OOM retry, and manual retry.
 */
export function createRetryTask(task: Task, opts?: RetryTaskOpts): Task {
  const clearRunDir = opts?.clearRunDir ?? true;
  return {
    ...task,
    id: uuidv4(),
    seq: store.nextSeq(),
    status: "pending" as TaskStatus,
    stub_id: undefined,
    run_dir: clearRunDir ? undefined : task.run_dir,
    retry_count: task.retry_count + 1,
    retry_of: task.retry_of || task.id,
    created_at: now(),
    started_at: undefined,
    finished_at: undefined,
    exit_code: undefined,
    pid: undefined,
    log_buffer: [],
    progress: undefined,
    should_stop: false,
    should_checkpoint: false,
    disconnected_at: undefined,
    stub_offline: undefined,
    requirements: opts?.requirements ?? task.requirements,
  };
}

// ─── Global queue actions ───────────────────────────────────────────────────

/** Cancel a task in the global queue (pending → cancelled) */
export function cancelGlobalTask(taskId: string): Task | undefined {
  return store.updateGlobalQueueTask(taskId, {
    status: "cancelled" as TaskStatus,
    finished_at: now(),
  });
}

/** Cancel a blocked task in the global queue (blocked → cancelled) */
export function cancelBlockedTask(taskId: string, reason?: string): Task | undefined {
  return store.updateGlobalQueueTask(taskId, {
    status: "cancelled" as TaskStatus,
    finished_at: now(),
    error_message: reason,
  });
}

/** Promote a blocked task to pending (blocked → pending), updating args and command */
export function promoteBlockedTask(
  taskId: string,
  update: { args?: Record<string, string>; command?: string; display_name?: string },
): Task | undefined {
  return store.updateGlobalQueueTask(taskId, {
    status: "pending" as TaskStatus,
    ...update,
  });
}
