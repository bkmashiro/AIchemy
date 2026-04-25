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

import { store } from "./store";
import { Task, TaskStatus } from "./types";
import { logger } from "./log";

const now = () => new Date().toISOString();

// ─── Stub-scoped actions ────────────────────────────────────────────────────

/** queued → dispatched */
export function dispatchTask(stubId: string, taskId: string, run_dir: string): Task | undefined {
  return store.updateTask(stubId, taskId, { status: "dispatched" as TaskStatus, run_dir });
}

/** dispatched → running */
export function startTask(stubId: string, taskId: string, pid: number): Task | undefined {
  return store.updateTask(stubId, taskId, {
    status: "running" as TaskStatus,
    started_at: now(),
    pid,
  });
}

/** dispatched → running (auto-promote on first log/progress, no-op if already running) */
export function promoteIfDispatched(stubId: string, taskId: string): void {
  const task = store.getTask(stubId, taskId);
  if (task?.status === "dispatched") {
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

/** running/dispatched → failed */
export function failTask(stubId: string, taskId: string, exitCode?: number, extra?: Partial<Task>): Task | undefined {
  return store.updateTask(stubId, taskId, {
    ...extra,
    status: "failed" as TaskStatus,
    exit_code: exitCode,
    finished_at: now(),
  });
}

/** any active → killed */
export function killTask(stubId: string, taskId: string, exitCode?: number): Task | undefined {
  return store.updateTask(stubId, taskId, {
    status: "killed" as TaskStatus,
    exit_code: exitCode,
    finished_at: now(),
  });
}

/** running/dispatched/paused → lost (stub offline or sync detected dead) */
export function loseTask(stubId: string, taskId: string): Task | undefined {
  return store.updateTask(stubId, taskId, {
    status: "lost" as TaskStatus,
    finished_at: now(),
  });
}

/** lost → running (stub reconnects and reports task still alive) */
export function recoverTask(stubId: string, taskId: string, pid: number): Task | undefined {
  return store.updateTask(stubId, taskId, {
    status: "running" as TaskStatus,
    pid,
    finished_at: undefined,
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
  return store.updateTask(stubId, taskId, {
    status: "failed" as TaskStatus,
    finished_at: now(),
    log_buffer: errors,
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

// ─── Global queue actions ───────────────────────────────────────────────────

/** Kill a task in the global queue (pending → killed) */
export function killGlobalTask(taskId: string): Task | undefined {
  return store.updateGlobalQueueTask(taskId, {
    status: "killed" as TaskStatus,
    finished_at: now(),
  });
}
