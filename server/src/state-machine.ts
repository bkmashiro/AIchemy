import { TaskStatus } from "./types";
import { logger } from "./log";

const LEGAL_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending:    ["queued", "killed", "cancelled"],
  queued:     ["dispatched", "pending", "killed", "cancelled"],
  dispatched: ["running", "failed", "lost", "killed"],
  running:    ["completed", "failed", "paused", "killed", "lost"],
  paused:     ["running", "killed", "lost"],
  completed:  [],
  failed:     ["pending"],
  killed:     ["pending"],
  lost:       ["pending", "failed", "running"],  // running = recover on reconnect
  blocked:    ["pending", "cancelled", "killed"],
  cancelled:  ["pending"],  // allow manual re-queue
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return LEGAL_TRANSITIONS[from]?.includes(to) ?? false;
}
