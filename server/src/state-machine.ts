import { TaskStatus } from "./types";
import { logger } from "./log";

const LEGAL_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending:    ["assigned", "cancelled"],
  assigned:   ["running", "failed", "pending", "cancelled"],
  running:    ["completed", "failed", "paused", "cancelled"],
  paused:     ["running", "cancelled"],
  completed:  [],
  failed:     ["pending"],
  cancelled:  ["pending"],  // allow manual re-queue
  blocked:    ["pending", "cancelled"],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return LEGAL_TRANSITIONS[from]?.includes(to) ?? false;
}
