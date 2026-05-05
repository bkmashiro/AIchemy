/**
 * dag.ts — DAG resolution engine for pipeline experiments.
 *
 * Handles template resolution, dependency checking, blocked→pending promotion,
 * and cascading cancellation on failure.
 */

import { Task, TaskSpec } from "./types";
import { store } from "./store";
import { Namespace } from "socket.io";
import { triggerSchedule } from "./scheduler";
import { assembleCommand, generateDisplayName } from "./api/tasks";
import { logger } from "./log";

const TEMPLATE_RE = /\{\{deps\.([^.]+)\.exports\.([^}]+)\}\}/g;

// ─── Template resolution ─────────────────────────────────────────────────────

/** Resolve a single template string like "{{deps.train.exports.checkpoint}}" */
function resolveTemplate(template: string, taskRefMap: Map<string, Task>): string {
  return template.replace(TEMPLATE_RE, (_match, refName, key) => {
    const depTask = taskRefMap.get(refName);
    if (!depTask) {
      logger.warn("dag.resolve_template.missing_ref", { ref: refName, key });
      return `{{deps.${refName}.exports.${key}}}`;
    }
    const value = depTask.exports?.[key];
    if (value === undefined) {
      logger.warn("dag.resolve_template.missing_export", { ref: refName, key, task_id: depTask.id });
      return "";
    }
    return String(value);
  });
}

/** Resolve all args_template on a task, returns concrete args */
function resolveTaskArgs(task: Task, taskRefMap: Map<string, Task>): Record<string, string> {
  if (!task.args_template) return task.args || {};
  const resolved: Record<string, string> = { ...(task.args || {}) };
  for (const [k, v] of Object.entries(task.args_template)) {
    resolved[k] = resolveTemplate(v, taskRefMap);
  }
  return resolved;
}

// ─── Dependency checks ───────────────────────────────────────────────────────

/** Check if all depends_on tasks are completed */
function areDependenciesSatisfied(task: Task): boolean {
  if (!task.depends_on || task.depends_on.length === 0) return true;
  for (const depId of task.depends_on) {
    const found = store.findTask(depId);
    if (!found || found.task.status !== "completed") return false;
  }
  return true;
}

/** Check if any depends_on task is in terminal failure state */
function hasFailedDependency(task: Task): boolean {
  if (!task.depends_on || task.depends_on.length === 0) return false;
  for (const depId of task.depends_on) {
    const found = store.findTask(depId);
    if (!found) continue;
    const s = found.task.status;
    if (s === "failed" || s === "killed" || s === "cancelled") return true;
  }
  return false;
}

// ─── Downstream lookup ───────────────────────────────────────────────────────

/** Get all blocked tasks in global queue whose depends_on includes taskId */
function getDownstreamBlockedTasks(taskId: string): Task[] {
  return store.getBlockedTasksDependingOn(taskId);
}

// ─── DAG validation ──────────────────────────────────────────────────────────

/** Validate DAG has no cycles (topological sort). Input: task_specs with ref-based depends_on */
export function validateDag(specs: TaskSpec[]): { valid: boolean; error?: string } {
  const refSet = new Set(specs.map((s) => s.ref));

  // Check all depends_on refs exist
  for (const spec of specs) {
    for (const dep of spec.depends_on || []) {
      if (!refSet.has(dep)) {
        return { valid: false, error: `ref "${spec.ref}" depends on unknown ref "${dep}"` };
      }
    }
  }

  // Kahn's algorithm for cycle detection
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const spec of specs) {
    inDegree.set(spec.ref, 0);
    adjList.set(spec.ref, []);
  }
  for (const spec of specs) {
    for (const dep of spec.depends_on || []) {
      adjList.get(dep)!.push(spec.ref);
      inDegree.set(spec.ref, (inDegree.get(spec.ref) || 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [ref, deg] of inDegree) {
    if (deg === 0) queue.push(ref);
  }

  let sorted = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    sorted++;
    for (const next of adjList.get(cur) || []) {
      const newDeg = (inDegree.get(next) || 1) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  if (sorted !== specs.length) {
    return { valid: false, error: "DAG contains a cycle" };
  }
  return { valid: true };
}

// ─── Build ref map from experiment ───────────────────────────────────────────

function buildRefMap(experimentId: string): Map<string, Task> {
  const exp = store.getExperiment(experimentId);
  if (!exp || !exp.task_refs) return new Map();

  const refMap = new Map<string, Task>();
  for (const [ref, taskId] of Object.entries(exp.task_refs)) {
    const found = store.findTask(taskId);
    if (found) {
      refMap.set(ref, found.task);
    }
  }
  return refMap;
}

// ─── Promotion ───────────────────────────────────────────────────────────────

/**
 * Called when a task completes — promote downstream blocked tasks.
 *
 * 1. Find blocked tasks that depend on completedTaskId
 * 2. For each, check ALL deps satisfied
 * 3. If yes: build ref map, resolve args_template, update args + command, blocked→pending
 * 4. Trigger scheduler
 */
export function promoteBlockedTasks(completedTaskId: string, webNs: Namespace): void {
  const downstream = getDownstreamBlockedTasks(completedTaskId);
  if (downstream.length === 0) return;

  let promoted = 0;

  for (const task of downstream) {
    if (task.status !== "blocked") continue;
    if (!areDependenciesSatisfied(task)) continue;

    // Build ref map from experiment context
    const refMap = task.experiment_id ? buildRefMap(task.experiment_id) : new Map<string, Task>();

    // Resolve templated args
    const resolvedArgs = resolveTaskArgs(task, refMap);

    // Reassemble command with resolved args
    const command = assembleCommand({
      script: task.script,
      args: resolvedArgs,
      raw_args: task.raw_args,
      cwd: task.cwd,
      env_setup: task.env_setup,
      env: task.env,
    });

    const display_name = generateDisplayName({ script: task.script, args: resolvedArgs, name: task.name, command });

    // Transition blocked → pending
    const updated = store.updateGlobalQueueTask(task.id, {
      status: "pending",
      args: resolvedArgs,
      command,
      display_name,
    });

    if (updated) {
      logger.info("dag.promote", { task_id: task.id, display_name });
      webNs.emit("task.update", updated);
      promoted++;
    }
  }

  if (promoted > 0) {
    triggerSchedule();
  }
}

// ─── Cascading cancellation ──────────────────────────────────────────────────

/**
 * Called when a task fails/killed/lost (and NOT being retried) — cascade cancel downstream.
 *
 * 1. Find blocked tasks depending on failedTaskId
 * 2. Mark each cancelled
 * 3. Recursively cancel their downstream too
 * 4. Emit task.update for each
 */
export function cascadeCancellation(failedTaskId: string, webNs: Namespace): void {
  const downstream = getDownstreamBlockedTasks(failedTaskId);
  if (downstream.length === 0) return;

  for (const task of downstream) {
    if (task.status !== "blocked") continue;

    const updated = store.updateGlobalQueueTask(task.id, {
      status: "cancelled",
      finished_at: new Date().toISOString(),
      error_message: `Dependency ${failedTaskId} failed`,
    });

    if (updated) {
      logger.info("dag.cascade_cancel", { task_id: task.id, cause: failedTaskId });
      webNs.emit("task.update", updated);

      // Recursively cancel downstream of this cancelled task
      cascadeCancellation(task.id, webNs);
    }
  }
}
