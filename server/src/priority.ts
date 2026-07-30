import type { Task } from "./types";

const BUMPS: Record<NonNullable<Task["expedite_class"]>, number> = {
  elevated: 100,
  urgent: 1000,
};

export function effectiveTaskPriority(task: Task, nowMs: number = Date.now()): number {
  const base = task.base_priority ?? task.priority;
  if (!task.expedite_class || !task.expedite_until) return base;
  const until = Date.parse(task.expedite_until);
  if (!Number.isFinite(until) || until <= nowMs) return base;
  return base + BUMPS[task.expedite_class];
}

export function withEffectivePriority(task: Task, nowMs: number = Date.now()): Task {
  task.effective_priority = effectiveTaskPriority(task, nowMs);
  return task;
}
