export const TERMINAL_STATUSES = ["completed", "completed_with_errors", "failed", "killed", "interrupted", "blocked"] as const;
export const ACTIVE_STATUSES = ["running", "dispatched", "paused", "migrating"] as const;

export type TerminalStatus = typeof TERMINAL_STATUSES[number];
export type ActiveStatus = typeof ACTIVE_STATUSES[number];
