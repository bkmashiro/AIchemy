import type { Task } from "./api";

/** Format elapsed milliseconds as human-readable duration */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** Format ISO timestamp as relative time ("3m ago") */
export function formatRelTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Format megabytes as GB/MB */
export function formatBytes(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}G`;
  return `${Math.round(mb)}M`;
}

/** Duration of a task from started_at to finished_at (or now) */
export function taskDuration(task: Task): string {
  if (!task.started_at) return "—";
  const start = new Date(task.started_at).getTime();
  const end = task.finished_at ? new Date(task.finished_at).getTime() : Date.now();
  return formatDuration(Math.max(0, end - start));
}

/** ETA string for a running task */
export function taskEta(task: Task): string | null {
  if (!task.progress || !task.started_at) return null;
  const { step, total } = task.progress;
  if (step <= 0 || step >= total) return null;
  const elapsed = Date.now() - new Date(task.started_at).getTime();
  if (elapsed <= 0) return null;
  const remainMs = ((total - step) / step) * elapsed;
  return "ETA " + formatDuration(remainMs);
}

/**
 * Generate display_name for a task (spec §1 rules):
 * 1. Has name → use it
 * 2. Has script + args → basename(script) + args summary
 * 3. Only command → extract last meaningful segment
 */
export function generateDisplayName(task: {
  name?: string;
  script?: string;
  args?: Record<string, string>;
  command?: string;
  display_name?: string;
}): string {
  if (task.display_name) return task.display_name;
  if (task.name) return task.name;
  if (task.script) {
    const base = task.script.split("/").pop() || task.script;
    if (task.args && Object.keys(task.args).length > 0) {
      const argSummary = Object.entries(task.args)
        .map(([k, v]) => {
          // Clean up key: --config → config
          const key = k.replace(/^-+/, "");
          // For value, use basename for paths, raw otherwise
          const val = v.includes("/") ? v.split("/").pop() || v : v;
          return `${key}=${val}`;
        })
        .join(" ");
      return `${base} ${argSummary}`;
    }
    return base;
  }
  if (task.command) {
    // Extract last meaningful segment from raw command
    const parts = task.command.trim().split(/\s+/);
    // Find the script-like part
    const scriptPart = parts.find((p) => p.endsWith(".py") || p.endsWith(".sh") || p.endsWith(".js"));
    if (scriptPart) return scriptPart.split("/").pop() || scriptPart;
    return parts[parts.length - 1] || task.command.slice(0, 40);
  }
  return "(unnamed)";
}

/** Truncate ID to first N chars */
export function truncateId(id: string, len = 8): string {
  return id.slice(0, len);
}
