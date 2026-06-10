import type { Task, TaskStatus } from "./api";

export const TASK_STATUS_ORDER: TaskStatus[] = [
  "running",
  "assigned",
  "pending",
  "blocked",
  "paused",
  "completed",
  "failed",
  "cancelled",
];

export const ACTIVE_TASK_STATUSES = new Set<TaskStatus>([
  "pending",
  "assigned",
  "running",
  "paused",
  "blocked",
]);

export const TERMINAL_TASK_STATUSES = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export const RETRYABLE_TASK_STATUSES = new Set<TaskStatus>([
  "failed",
  "cancelled",
]);

export const TASK_STATUS_BADGE_CLASS: Record<TaskStatus, string> = {
  pending: "bg-yellow-900/30 text-yellow-400 border-yellow-700/40",
  assigned: "bg-indigo-900/30 text-indigo-400 border-indigo-700/40",
  running: "bg-blue-900/40 text-blue-300 border-blue-700/50",
  paused: "bg-orange-900/30 text-orange-300 border-orange-700/40",
  blocked: "bg-purple-900/30 text-purple-300 border-purple-700/40",
  completed: "bg-green-900/30 text-green-400 border-green-700/40",
  failed: "bg-red-900/40 text-red-400 border-red-700/50",
  cancelled: "bg-gray-800/60 text-gray-500 border-gray-700/40",
};

export const TASK_STATUS_TEXT_CLASS: Record<TaskStatus, string> = {
  pending: "text-yellow-400",
  assigned: "text-indigo-400",
  running: "text-blue-400",
  paused: "text-orange-400",
  blocked: "text-purple-300",
  completed: "text-green-400",
  failed: "text-red-400",
  cancelled: "text-gray-500",
};

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return ACTIVE_TASK_STATUSES.has(status);
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function isRetryableTaskStatus(status: TaskStatus): boolean {
  return RETRYABLE_TASK_STATUSES.has(status);
}

export function taskStatusLabel(task: Task): string {
  if (task.status === "running" && task.stub_offline) return "RUNNING · OFFLINE";
  return task.status.toUpperCase();
}
