/**
 * cost.ts — GPU cost calculation module.
 *
 * Rate card based on approximate cloud GPU pricing.
 * Cost is informational only.
 */

import { Task, Stub } from "./types";

// ─── Rate Card ($/hr per GPU) ────────────────────────────────────────────────

export const GPU_RATE_CARD: Record<string, number> = {
  A100: 2.0,
  A40: 1.0,
  A30: 0.7,
  RTX4080: 0.5,
  RTX3090: 0.4,
  default: 0.5,
};

// ─── Fuzzy GPU name matching ─────────────────────────────────────────────────

/**
 * Match a full GPU name (e.g. "NVIDIA A100-SXM4-80GB") to a rate card key.
 * Strips common prefixes, normalizes whitespace, and does substring matching.
 */
export function matchGpuType(gpuName: string): string {
  const normalized = gpuName
    .toUpperCase()
    .replace(/NVIDIA|GEFORCE|QUADRO|TESLA/g, "")
    .replace(/[-_\s]+/g, "");

  for (const key of Object.keys(GPU_RATE_CARD)) {
    if (key === "default") continue;
    const normalizedKey = key.toUpperCase().replace(/[-_\s]+/g, "");
    if (normalized.includes(normalizedKey)) return key;
  }
  return "default";
}

/**
 * Get the hourly rate for a GPU by its full name.
 */
export function getGpuRate(gpuName: string): number {
  const key = matchGpuType(gpuName);
  return GPU_RATE_CARD[key] ?? GPU_RATE_CARD.default;
}

// ─── Cost Computation ────────────────────────────────────────────────────────

export interface TaskCost {
  gpu_hours: number;
  cost_usd: number;
  gpu_type: string;
  rate_per_hour: number;
}

/**
 * Compute GPU-hours and cost for a task.
 * Uses started_at/finished_at for terminal tasks, started_at/now for running.
 * Returns null if task has no timing data.
 */
export function computeTaskCost(task: Task, gpuName: string, gpuCount: number): TaskCost | null {
  if (!task.started_at) return null;

  const start = new Date(task.started_at).getTime();
  const end = task.finished_at
    ? new Date(task.finished_at).getTime()
    : Date.now();

  if (isNaN(start) || isNaN(end) || end <= start) return null;

  const hours = (end - start) / 3_600_000;
  const gpuHours = hours * gpuCount;
  const gpuType = matchGpuType(gpuName);
  const rate = GPU_RATE_CARD[gpuType] ?? GPU_RATE_CARD.default;

  return {
    gpu_hours: Math.round(gpuHours * 1000) / 1000,
    cost_usd: Math.round(gpuHours * rate * 100) / 100,
    gpu_type: gpuType,
    rate_per_hour: rate,
  };
}

// ─── Aggregate Cost Stats ────────────────────────────────────────────────────

export interface CostSummary {
  total_gpu_hours: number;
  total_cost_usd: number;
  utilization_pct: number;
  task_count: number;
}

export interface CostBreakdownEntry {
  gpu_type: string;
  gpu_hours: number;
  cost_usd: number;
  task_count: number;
}

export interface ExperimentCostEntry {
  experiment: string;
  gpu_hours: number;
  cost_usd: number;
  task_count: number;
}

export interface CostBreakdown {
  by_gpu_type: CostBreakdownEntry[];
  by_experiment: ExperimentCostEntry[];
}

/**
 * Compute aggregate cost for a set of tasks within a time range.
 * stubMap: stub_id → { gpu_name, gpu_count } for GPU info lookup.
 * stubWallHours: total stub-hours for utilization calculation.
 */
export function aggregateCosts(
  tasks: Task[],
  stubMap: Map<string, { gpu_name: string; gpu_count: number }>,
  from?: Date,
  to?: Date,
): { summary: CostSummary; breakdown: CostBreakdown } {
  let totalGpuHours = 0;
  let totalCost = 0;
  let taskCount = 0;

  const byGpu = new Map<string, { gpu_hours: number; cost_usd: number; task_count: number }>();
  const byExp = new Map<string, { gpu_hours: number; cost_usd: number; task_count: number }>();

  // Track total stub wall time for utilization
  let totalStubGpuHours = 0;

  for (const task of tasks) {
    if (!task.started_at) continue;

    // Time range filter
    const startTime = new Date(task.started_at).getTime();
    if (from && startTime < from.getTime()) continue;
    if (to && startTime > to.getTime()) continue;

    const stubInfo = task.stub_id ? stubMap.get(task.stub_id) : undefined;
    const gpuName = stubInfo?.gpu_name || "default";
    const gpuCount = stubInfo?.gpu_count || 1;

    const cost = computeTaskCost(task, gpuName, gpuCount);
    if (!cost) continue;

    totalGpuHours += cost.gpu_hours;
    totalCost += cost.cost_usd;
    taskCount++;

    // By GPU type
    const gpuEntry = byGpu.get(cost.gpu_type) || { gpu_hours: 0, cost_usd: 0, task_count: 0 };
    gpuEntry.gpu_hours += cost.gpu_hours;
    gpuEntry.cost_usd += cost.cost_usd;
    gpuEntry.task_count++;
    byGpu.set(cost.gpu_type, gpuEntry);

    // By experiment (use task name prefix or grid_id)
    const expName = task.grid_id || task.name || task.display_name || "ungrouped";
    const expEntry = byExp.get(expName) || { gpu_hours: 0, cost_usd: 0, task_count: 0 };
    expEntry.gpu_hours += cost.gpu_hours;
    expEntry.cost_usd += cost.cost_usd;
    expEntry.task_count++;
    byExp.set(expName, expEntry);
  }

  // Compute stub wall hours for utilization
  for (const [, info] of stubMap) {
    // Rough estimate: each stub contributes its uptime × gpu_count
    // We track first_seen/last_seen on stubs for this
    totalStubGpuHours += info.gpu_count; // placeholder per-hour
  }

  const summary: CostSummary = {
    total_gpu_hours: Math.round(totalGpuHours * 1000) / 1000,
    total_cost_usd: Math.round(totalCost * 100) / 100,
    utilization_pct: 0, // computed by caller with stub wall time
    task_count: taskCount,
  };

  const breakdown: CostBreakdown = {
    by_gpu_type: Array.from(byGpu.entries()).map(([gpu_type, v]) => ({
      gpu_type,
      gpu_hours: Math.round(v.gpu_hours * 1000) / 1000,
      cost_usd: Math.round(v.cost_usd * 100) / 100,
      task_count: v.task_count,
    })).sort((a, b) => b.cost_usd - a.cost_usd),
    by_experiment: Array.from(byExp.entries()).map(([experiment, v]) => ({
      experiment,
      gpu_hours: Math.round(v.gpu_hours * 1000) / 1000,
      cost_usd: Math.round(v.cost_usd * 100) / 100,
      task_count: v.task_count,
    })).sort((a, b) => b.cost_usd - a.cost_usd),
  };

  return { summary, breakdown };
}
