/**
 * api/experiments.ts — Experiment CRUD.
 *
 * POST   /experiments           — create experiment (creates grid internally)
 * GET    /experiments           — list all experiments
 * GET    /experiments/:id       — experiment detail + task validations
 * DELETE /experiments/:id       — delete experiment (does NOT delete tasks)
 * POST   /experiments/:id/retry-failed — retry tasks that failed criteria
 * GET    /experiments/:id/research-bundle — read-only export composite payload
 * GET    /experiments/research-report — filtered family/decision/status rollup
 */

import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { store } from "../store";
import { Experiment, ExperimentDecision, ExperimentEvent, ExperimentEventKind, Grid, Task, TaskSpec } from "../types";
import { Namespace } from "socket.io";
import { createTask } from "./tasks";
import { triggerSchedule } from "../scheduler";
import { computeFingerprint } from "../dedup";
import { evaluateCriteria } from "../criteria";
import { validateDag } from "../dag";
import { logger } from "../log";
import { initExperimentManifest, readExperimentManifest } from "../git-tracking";

// ─── Cartesian product (same as grids.ts) ────────────────────────────────────

function cartesianProduct(params: Record<string, any[]>): Record<string, any>[] {
  const keys = Object.keys(params);
  if (keys.length === 0) return [{}];

  return keys.reduce((results: Record<string, any>[], key) => {
    const values = params[key];
    const expanded: Record<string, any>[] = [];
    for (const result of results) {
      for (const value of values) {
        expanded.push({ ...result, [key]: value });
      }
    }
    return expanded;
  }, [{}]);
}

// ─── Experiment status derivation ────────────────────────────────────────────

export function deriveExperimentStatus(exp: Experiment): Experiment["status"] {
  const grid = store.getGrid(exp.grid_id);
  if (!grid) return "running";

  const totalTasks = grid.task_ids.length;
  const validated = Object.values(exp.results);
  const passed = validated.filter((v) => v.passed).length;
  const failed = validated.filter((v) => !v.passed).length;

  // Check if all tasks in grid are terminal
  const tasks = store.getGridTasks(exp.grid_id);
  const allDone = tasks.length > 0 && tasks.every((t) =>
    ["completed", "failed", "cancelled"].includes(t.status)
  );
  const completed = tasks.filter((t) => t.status === "completed").length;
  const terminalFailed = tasks.filter((t) => ["failed", "cancelled"].includes(t.status)).length;

  if (passed === totalTasks && totalTasks > 0) return "passed";
  if (allDone && failed > 0) return passed > 0 ? "partial" : "failed";
  if (allDone && validated.length === 0) {
    if (completed === totalTasks) return "passed";
    return completed > 0 && terminalFailed > 0 ? "partial" : "failed";
  }
  return "running";
}

const DECISIONS = new Set<ExperimentDecision>(["keep", "drop", "rerun", "fork"]);
const EXPERIMENT_STATUSES = new Set<Experiment["status"]>(["running", "passed", "partial", "failed"]);
const EVENT_KINDS = new Set<ExperimentEventKind>([
  "created", "forked", "task_started", "task_completed", "task_failed",
  "resumed", "moved_stub", "metric_best", "note", "decision",
  "artifact", "checkpoint",
]);

// Artifact/checkpoint events must carry a non-empty path or uri so consumers
// can answer "产物在哪？". Other event kinds keep the looser shape.
const ARTIFACT_KINDS = new Set<ExperimentEventKind>(["artifact", "checkpoint"]);
const ARTIFACT_TYPES = new Set<string>(["checkpoint", "tensorboard", "log", "file", "metrics"]);

function validateArtifactData(kind: ExperimentEventKind, data: unknown): string | undefined {
  if (!ARTIFACT_KINDS.has(kind)) return undefined;
  if (!data || typeof data !== "object" || Array.isArray(data)) return "artifact data must be an object";
  const obj = data as Record<string, unknown>;
  const path = typeof obj.path === "string" ? obj.path.trim() : "";
  const uri = typeof obj.uri === "string" ? obj.uri.trim() : "";
  if (!path && !uri) {
    return "artifact/checkpoint requires non-empty data.path or data.uri";
  }
  for (const locator of [path, uri]) {
    if (locator.length > 2048) return "artifact path/uri too long";
  }
  if (obj.artifact_type !== undefined && obj.artifact_type !== null) {
    if (typeof obj.artifact_type !== "string" || !ARTIFACT_TYPES.has(obj.artifact_type)) {
      return `artifact_type must be one of ${[...ARTIFACT_TYPES].join(", ")}`;
    }
  }
  if (obj.name !== undefined && obj.name !== null && typeof obj.name !== "string") {
    return "artifact name must be a string";
  }
  if (obj.step !== undefined && obj.step !== null) {
    if (typeof obj.step !== "number" || !Number.isFinite(obj.step)) {
      return "artifact step must be a finite number";
    }
  }
  return undefined;
}

function operatorActor(_req: Request): string {
  // Auth currently validates tokens but does not expose identity on Request.
  // Never trust actor from the body; use a stable server-side fallback.
  return "operator";
}

function validateMessage(message: unknown, field = "message"): string | undefined {
  if (typeof message !== "string" || message.trim().length === 0) return `${field} required`;
  if (message.length > 4096) return `${field} too long`;
  return undefined;
}

function validateEventData(data: unknown): string | undefined {
  if (data === undefined) return undefined;
  if (!data || typeof data !== "object" || Array.isArray(data)) return "data must be an object";
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > 8192) return "data too large";
  return undefined;
}

function synthesizeTaskEvents(exp: Experiment, tasks: Task[]): ExperimentEvent[] {
  const events: ExperimentEvent[] = [];
  for (const task of tasks) {
    const taskName = task.display_name || task.ref || `task ${task.id}`;
    if (task.started_at) {
      events.push({
        id: `synth:${task.id}:started`, experiment_id: exp.id, task_id: task.id,
        kind: "task_started", message: `${taskName} started`, created_at: task.started_at,
        data: { status: task.status, stub_id: task.stub_id ?? null },
      });
    }
    if (task.finished_at && task.status === "completed") {
      events.push({
        id: `synth:${task.id}:completed`, experiment_id: exp.id, task_id: task.id,
        kind: "task_completed", message: `${taskName} completed`, created_at: task.finished_at,
        data: { exit_code: task.exit_code ?? null, stub_id: task.stub_id ?? null },
      });
    }
    if (task.finished_at && ["failed", "cancelled", "killed", "lost"].includes(task.status)) {
      events.push({
        id: `synth:${task.id}:failed`, experiment_id: exp.id, task_id: task.id,
        kind: "task_failed", message: `${taskName} failed`, created_at: task.finished_at,
        data: { status: task.status, exit_code: task.exit_code ?? null, stub_id: task.stub_id ?? null },
      });
    }
  }
  return events;
}

function timelineFor(exp: Experiment): ExperimentEvent[] {
  const grid = store.getGrid(exp.grid_id);
  const tasks = grid ? store.getGridTasks(exp.grid_id) : [];
  const stored = store.getExperimentEvents(exp.id).filter((e) => !e.deleted_at);
  const storedKeys = new Set(stored.filter((e) => e.task_id).map((e) => `${e.kind}:${e.task_id}`));
  const synthesized = synthesizeTaskEvents(exp, tasks).filter((e) => !storedKeys.has(`${e.kind}:${e.task_id}`));
  return [...stored, ...synthesized].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// ─── Lineage helpers (tree / compare / summary) ─────────────────────────────

export interface ExperimentBrief {
  id: string;
  name: string;
  status: Experiment["status"];
  family: string | null;
  parent_id: string | null;
  decision: ExperimentDecision | null;
  fork_reason: string | null;
  goal_metric: string | null;
  goal_direction: "min" | "max" | null;
  recommendation: Recommendation;
  created_at: string;
}

export interface MetricAggregate {
  count: number;
  values: number[];
  min: number;
  max: number;
  mean: number;
  best: number;
  passed: number;
  failed: number;
}

export interface PassFailSummary {
  total: number;
  passed: number;
  failed: number;
}

export function experimentBrief(exp: Experiment): ExperimentBrief {
  const allExperiments = store.getAllExperiments();
  return {
    id: exp.id,
    name: exp.name,
    status: deriveExperimentStatus(exp),
    family: exp.family ?? null,
    parent_id: exp.parent_id ?? null,
    decision: exp.decision ?? null,
    fork_reason: exp.fork_reason ?? null,
    goal_metric: exp.goal_metric ?? null,
    goal_direction: exp.goal_direction ?? null,
    recommendation: recommendationForExperiment(exp, allExperiments),
    created_at: exp.created_at,
  };
}

function compareExperiments(a: Experiment, b: Experiment): number {
  if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
  if (a.name !== b.name) return a.name.localeCompare(b.name);
  return a.id.localeCompare(b.id);
}

export function aggregateMetrics(exp: Experiment): Record<string, MetricAggregate> {
  const out: Record<string, MetricAggregate> = {};
  const buckets = new Map<string, { values: number[]; passed: number; failed: number }>();
  for (const validation of Object.values(exp.results)) {
    for (const [metric, detail] of Object.entries(validation.details)) {
      let bucket = buckets.get(metric);
      if (!bucket) {
        bucket = { values: [], passed: 0, failed: 0 };
        buckets.set(metric, bucket);
      }
      bucket.values.push(detail.value);
      if (detail.ok) bucket.passed += 1;
      else bucket.failed += 1;
    }
  }
  for (const [metric, bucket] of buckets.entries()) {
    const values = bucket.values;
    const count = values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const mean = values.reduce((s, v) => s + v, 0) / count;
    const expr = exp.criteria?.[metric];
    let best = max;
    if (expr) {
      const trimmed = expr.trim();
      if (trimmed.startsWith("<")) best = min;
      else if (trimmed.startsWith(">")) best = max;
    }
    out[metric] = {
      count,
      values,
      min,
      max,
      mean,
      best,
      passed: bucket.passed,
      failed: bucket.failed,
    };
  }
  return out;
}

export function passFailSummary(exp: Experiment): PassFailSummary {
  const results = Object.values(exp.results);
  const passed = results.filter((r) => r.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
  };
}

function bestMetricValues(exp: Experiment): Record<string, number> {
  const agg = aggregateMetrics(exp);
  const out: Record<string, number> = {};
  for (const [metric, info] of Object.entries(agg)) {
    out[metric] = info.best;
  }
  return out;
}

export interface PrimaryMetric {
  metric: string;
  direction: "min" | "max";
  best: number | null;
}

export type RecommendationAction = "keep" | "drop" | "rerun" | "fork";
export type RecommendationVerdict = "best" | "improved" | "regressed" | "inconclusive" | "failed" | "running";

export interface Recommendation {
  action: RecommendationAction;
  verdict: RecommendationVerdict;
  reason: string;
  metric: string | null;
  value: number | null;
  baseline_value: number | null;
  delta: number | null;
  direction: "min" | "max" | null;
}

function numeric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function betterDirection(direction: "min" | "max", value: number, baseline: number): boolean {
  return direction === "min" ? value < baseline : value > baseline;
}

function recommendationForExperiment(exp: Experiment, allExperiments: Experiment[]): Recommendation {
  const status = deriveExperimentStatus(exp);

  const recommendation: Recommendation = {
    action: "rerun",
    verdict: "inconclusive",
    reason: "Recommendation unavailable",
    metric: exp.goal_metric ?? null,
    value: null,
    baseline_value: null,
    delta: null,
    direction: exp.goal_direction ?? null,
  };

  const primary = primaryMetricFor(exp);
  if (primary?.metric && primary?.direction) {
    recommendation.metric = primary.metric;
    recommendation.direction = primary.direction;
    if (numeric(primary.best)) recommendation.value = primary.best;
  }

  // Explicit status override always wins over action/verdict, but preserve
  // declared metric/direction/value context so UI/tree nodes remain informative.
  if (status === "failed") {
    recommendation.verdict = "failed";
    recommendation.action = "rerun";
    recommendation.reason = "Experiment failed";
    return recommendation;
  }

  if (status === "running") {
    recommendation.verdict = "running";
    recommendation.action = "rerun";
    recommendation.reason = "Experiment is running";
    return recommendation;
  }

  if (!primary?.metric || !primary?.direction) {
    return recommendation;
  }

  if (!numeric(primary.best)) {
    recommendation.reason = "Goal metric not yet available";
    return recommendation;
  }

  const value = primary.best;

  // Parent-first baseline lookup with exact family/generic metric+direction match.
  let baselineValue: number | null = null;
  let baselineReason: "parent" | "family" | null = null;

  if (exp.parent_id) {
    const parent = allExperiments.find((candidate) => candidate.id === exp.parent_id && candidate.id !== exp.id);
    if (parent) {
      const parentPrimary = primaryMetricFor(parent);
      if (parentPrimary?.metric && parentPrimary.direction === primary.direction && numeric(parentPrimary.best)) {
        baselineValue = parentPrimary.best;
        baselineReason = "parent";
      }
    }
  }

  if (baselineValue === null) {
    const sameFamily = allExperiments.filter(
      (candidate) => candidate.family && candidate.family === exp.family && candidate.id !== exp.id,
    );
    const sameFamilyNumeric = sameFamily
      .map((candidate) => ({
        candidate,
        primary: primaryMetricFor(candidate),
      }))
      .filter((entry): entry is { candidate: Experiment; primary: { metric: string; direction: "min" | "max"; best: number } } =>
        !!entry.primary && !!entry.primary.metric && entry.primary.metric === primary.metric &&
        entry.primary.direction === primary.direction && numeric(entry.primary.best)
      )
      .map((entry) => ({
        best: entry.primary.best,
      }));

    if (sameFamilyNumeric.length > 0) {
      baselineReason = "family";
      baselineValue = sameFamilyNumeric
        .map((entry) => entry.best)
        .reduce((best, current) => (betterDirection(primary.direction, current, best) ? current : best),
          primary.direction === "min" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
        );
    }
  }

  if (baselineValue === null) {
    recommendation.reason = "No comparable numeric baseline found";
    return recommendation;
  }

  recommendation.baseline_value = baselineValue;
  recommendation.delta = Number((value - baselineValue).toPrecision(12));

  if (baselineReason === "parent") {
    if (numeric(baselineValue)) {
      if (recommendation.delta === 0) {
        recommendation.action = "rerun";
        recommendation.verdict = "inconclusive";
        recommendation.reason = "Metric equals parent baseline";
      } else if (betterDirection(primary.direction, value, baselineValue)) {
        recommendation.action = "keep";
        recommendation.verdict = "improved";
        recommendation.reason = "Better than parent baseline";
      } else {
        recommendation.action = "drop";
        recommendation.verdict = "regressed";
        recommendation.reason = "Worse than parent baseline";
      }
    }
    return recommendation;
  }

  // Same-family fallback (best-in-family when no parent baseline).
  if (recommendation.delta === 0 || betterDirection(primary.direction, value, baselineValue)) {
    recommendation.action = "keep";
    recommendation.verdict = "best";
    recommendation.reason = "Current best in family";
  } else {
    recommendation.action = "rerun";
    recommendation.verdict = "inconclusive";
    recommendation.reason = "Not family best";
  }
  return recommendation;
}

// Surface a primary metric only when both `goal_metric` and explicit
// `goal_direction` exist. Do not infer winners from metric names or criteria.
export function primaryMetricFor(exp: Experiment): PrimaryMetric | null {
  const metric = exp.goal_metric;
  const direction = exp.goal_direction;
  if (!metric || !direction) return null;
  const agg = aggregateMetrics(exp)[metric];
  const best = agg ? (direction === "min" ? agg.min : agg.max) : null;
  return { metric, direction, best };
}

// Shared keys across a set of configs: intersection of keys. Treats null/
// undefined configs as having no keys (so any experiment without config makes
// the intersection empty). Result is sorted for determinism.
function sharedConfigKeys(configs: Array<Record<string, any> | null | undefined>): string[] {
  if (configs.length === 0) return [];
  let shared: Set<string> | null = null;
  for (const cfg of configs) {
    if (!cfg || typeof cfg !== "object") return [];
    const keys = new Set<string>(Object.keys(cfg));
    if (shared === null) {
      shared = keys;
    } else {
      const next = new Set<string>();
      for (const k of shared) if (keys.has(k)) next.add(k);
      shared = next;
    }
  }
  return Array.from(shared ?? []).sort();
}

// Of the shared keys, the subset where values differ across experiments.
// JSON-based equality is used to handle nested objects/arrays consistently.
function differingConfigKeys(
  configs: Array<Record<string, any> | null | undefined>,
  shared: string[],
): string[] {
  const out: string[] = [];
  for (const key of shared) {
    const first = JSON.stringify(configs[0]?.[key]);
    if (configs.some((cfg) => JSON.stringify(cfg?.[key]) !== first)) out.push(key);
  }
  return out;
}

export interface MetricDeltaEntry {
  id: string;
  best: number | null;
  delta: number | null;
}

// For each metric appearing in any experiment, list per-experiment best value
// and delta vs the first experiment that has the metric (the "reference").
// Null entries mean the experiment has no data for that metric.
function metricDeltas(
  ids: string[],
  bestByExp: Map<string, Record<string, number>>,
): Record<string, MetricDeltaEntry[]> {
  const metrics = new Set<string>();
  for (const id of ids) {
    const best = bestByExp.get(id);
    if (best) for (const m of Object.keys(best)) metrics.add(m);
  }
  const result: Record<string, MetricDeltaEntry[]> = {};
  for (const metric of Array.from(metrics).sort()) {
    let reference: number | null = null;
    const entries: MetricDeltaEntry[] = [];
    for (const id of ids) {
      const value = bestByExp.get(id)?.[metric];
      const best = typeof value === "number" ? value : null;
      if (reference === null && best !== null) reference = best;
      const delta = best !== null && reference !== null ? best - reference : null;
      entries.push({ id, best, delta });
    }
    result[metric] = entries;
  }
  return result;
}

function taskCountsByStatus(exp: Experiment): Record<string, number> {
  const grid = store.getGrid(exp.grid_id);
  if (!grid) return {};
  const tasks = store.getGridTasks(exp.grid_id);
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  return counts;
}

type FoundTask = NonNullable<ReturnType<typeof store.findTask>>;

const METADATA_FIELDS = [
  "description", "family", "parent_id", "parent_name", "hypothesis",
  "expected_outcome", "fork_reason", "goal_metric", "goal_direction",
  "config", "config_diff", "criteria",
] as const;

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateTaskIdList(value: unknown): string[] | string {
  if (!Array.isArray(value) || value.length === 0) return "task_ids required (non-empty array)";
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) return "task_ids must contain non-empty strings";
    const id = item.trim();
    if (seen.has(id)) return `duplicate task_id: ${id}`;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function validateExperimentMetadata(body: Record<string, any>): string | undefined {
  if (body.goal_direction !== undefined && body.goal_direction !== null && !["min", "max"].includes(body.goal_direction)) {
    return "goal_direction must be min or max";
  }
  for (const field of ["config", "config_diff"] as const) {
    if (body[field] !== undefined && body[field] !== null && !isPlainObject(body[field])) {
      return `${field} must be an object`;
    }
  }
  if (body.criteria !== undefined && !isPlainObject(body.criteria)) return "criteria must be an object";
  return undefined;
}

function metadataFromBody(body: Record<string, any>): Partial<Experiment> {
  const out: Partial<Experiment> = {};
  for (const field of METADATA_FIELDS) {
    if (body[field] !== undefined) (out as Record<string, any>)[field] = body[field] || undefined;
  }
  return out;
}

function findTasksOrError(taskIds: string[]): { found?: FoundTask[]; error?: { status: number; body: any } } {
  const found: FoundTask[] = [];
  const missing: string[] = [];
  for (const id of taskIds) {
    const located = store.findTask(id);
    if (!located) missing.push(id);
    else found.push(located);
  }
  if (missing.length > 0) return { error: { status: 404, body: { error: "Task not found", missing } } };
  return { found };
}

function updateFoundTask(found: FoundTask, update: Partial<Task>): Task | undefined {
  if (found.archived) return store.updateArchivedTask(found.task.id, update);
  if (found.stubId) return store.updateTask(found.stubId, found.task.id, update);
  return store.updateGlobalQueueTask(found.task.id, update);
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((item) => bs.has(item));
}

function gridStatusFromTasks(tasks: Task[]): Grid["status"] {
  if (tasks.length === 0) return "pending";
  const terminal = tasks.filter((t) => ["completed", "failed", "cancelled"].includes(t.status)).length;
  if (terminal !== tasks.length) return "running";
  const completed = tasks.filter((t) => t.status === "completed").length;
  if (completed === tasks.length) return "completed";
  return completed > 0 ? "partial" : "failed";
}

function experimentStatusFromTasks(tasks: Task[]): Experiment["status"] {
  const gridStatus = gridStatusFromTasks(tasks);
  if (gridStatus === "completed") return "passed";
  if (gridStatus === "partial") return "partial";
  if (gridStatus === "failed") return "failed";
  return "running";
}

function allocateRef(preferred: string | undefined, used: Set<string>, fallbackBase: string): string {
  const trimmed = preferred?.trim();
  if (trimmed && !used.has(trimmed)) {
    used.add(trimmed);
    return trimmed;
  }
  let i = 1;
  let candidate = fallbackBase;
  while (used.has(candidate)) {
    i += 1;
    candidate = `${fallbackBase}-${i}`;
  }
  used.add(candidate);
  return candidate;
}

function addUniqueTaskIds(grid: Grid, taskIds: string[]): boolean {
  let changed = false;
  for (const taskId of taskIds) {
    if (!grid.task_ids.includes(taskId)) {
      grid.task_ids.push(taskId);
      changed = true;
    }
  }
  return changed;
}

function tasksForIds(taskIds: string[]): Task[] {
  return taskIds.flatMap((id) => {
    const found = store.findTask(id);
    return found ? [found.task] : [];
  });
}

function removeTaskFromGrid(taskId: string, gridId: string | undefined): Grid | undefined {
  if (!gridId) return undefined;
  const oldGrid = store.getGrid(gridId);
  if (!oldGrid) return undefined;
  const next = oldGrid.task_ids.filter((id) => id !== taskId);
  if (next.length === oldGrid.task_ids.length) return oldGrid;
  const updated: Grid = { ...oldGrid, task_ids: next, status: gridStatusFromTasks(tasksForIds(next)) };
  store.setGrid(updated);
  return updated;
}

// ─── Router ──────────────────────────────────────────────────────────────────

export function createExperimentsRouter(stubNs: Namespace, webNs: Namespace): Router {
  const router = Router();

  // POST /experiments/adopt — retroactively create an experiment from existing tasks.
  // Metadata-only operation: does not reschedule, kill, retry, or otherwise touch runtime state.
  router.post("/adopt", (req: Request, res: Response) => {
    const body = req.body as Record<string, any>;
    const { name } = body;
    if (typeof name !== "string" || name.trim().length === 0) { res.status(400).json({ error: "name required" }); return; }
    const experimentName = name.trim();
    const taskIds = validateTaskIdList(body.task_ids);
    if (typeof taskIds === "string") { res.status(400).json({ error: taskIds }); return; }
    const metadataError = validateExperimentMetadata(body);
    if (metadataError) { res.status(400).json({ error: metadataError }); return; }
    const existing = store.findExperimentByName(experimentName);
    if (existing) {
      const existingGrid = store.getGrid(existing.grid_id);
      if (existingGrid && sameStringSet(existingGrid.task_ids, taskIds)) {
        res.status(200).json({ ...existing, grid: existingGrid, tasks: store.getGridTasks(existing.grid_id), idempotent: true }); return;
      }
      res.status(409).json({ error: "Experiment name already exists", experiment_id: existing.id }); return;
    }
    const located = findTasksOrError(taskIds);
    if (located.error) { res.status(located.error.status).json(located.error.body); return; }
    const found = located.found!;
    for (const entry of found) {
      if (entry.task.experiment_id || entry.task.grid_id) {
        res.status(409).json({
          error: "Task already belongs to an experiment; use /experiments/:id/tasks/adopt with mode=move",
          task_id: entry.task.id,
          experiment_id: entry.task.experiment_id,
          grid_id: entry.task.grid_id,
        }); return;
      }
    }

    const experimentId = uuidv4();
    const gridId = uuidv4();
    const now = new Date().toISOString();
    const firstTask = found[0].task;
    const gridStatus = gridStatusFromTasks(found.map((entry) => entry.task));
    const grid: Grid = {
      id: gridId,
      name: `exp:${experimentName}`,
      display_name: `${experimentName} — adopted (${taskIds.length} tasks)`,
      script: firstTask.script,
      param_space: {},
      task_ids: [...taskIds],
      status: gridStatus,
      created_at: now,
      max_retries: 0,
      target_tags: firstTask.target_tags,
    };

    const usedRefs = new Set<string>();
    const taskRefs: Record<string, string> = {};
    const updatedTasks: Task[] = [];
    for (const [index, entry] of found.entries()) {
      const ref = allocateRef(entry.task.ref, usedRefs, `task-${index + 1}`);
      taskRefs[ref] = entry.task.id;
      const updated = updateFoundTask(entry, { experiment_id: experimentId, grid_id: gridId, ref });
      if (!updated) {
        res.status(409).json({ error: "Task could not be updated", task_id: entry.task.id }); return;
      }
      updatedTasks.push(updated);
      webNs.emit("task.update", updated);
    }

    store.setGrid(grid);
    const experiment: Experiment = {
      id: experimentId,
      name: experimentName,
      description: body.description || undefined,
      grid_id: gridId,
      status: experimentStatusFromTasks(updatedTasks),
      results: {},
      created_at: now,
      task_refs: taskRefs,
      ...metadataFromBody(body),
      criteria: body.criteria || {},
    };
    store.setExperiment(experiment);
    store.addExperimentEvent({
      id: uuidv4(), experiment_id: experiment.id, kind: "created",
      message: "Created experiment by adopting existing tasks",
      actor: operatorActor(req), created_at: now,
      data: { adopted_task_count: taskIds.length, task_ids: taskIds },
    });
    store.addExperimentEvent({
      id: uuidv4(), experiment_id: experiment.id, kind: "note",
      message: `Adopted ${taskIds.length} existing task${taskIds.length === 1 ? "" : "s"}`,
      actor: operatorActor(req), created_at: now,
      data: { task_ids: taskIds },
    });
    webNs.emit("grid.update", grid);
    webNs.emit("experiment.update", experiment);
    logger.info("experiment.adopted", { id: experiment.id, name: experiment.name, tasks: taskIds.length });
    res.status(201).json({ ...experiment, grid, tasks: updatedTasks });
  });

  // POST /experiments/:id/tasks/adopt — attach existing tasks to an experiment.
  router.post("/:id/tasks/adopt", (req: Request, res: Response) => {
    const exp = store.getExperiment(req.params.id);
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }
    const body = req.body as Record<string, any>;
    const mode = body.mode ?? "attach";
    if (!["attach", "move"].includes(mode)) { res.status(400).json({ error: "mode must be attach or move" }); return; }
    const taskIds = validateTaskIdList(body.task_ids);
    if (typeof taskIds === "string") { res.status(400).json({ error: taskIds }); return; }
    const located = findTasksOrError(taskIds);
    if (located.error) { res.status(located.error.status).json(located.error.body); return; }
    const found = located.found!;

    for (const entry of found) {
      const ownedByOtherExperiment = !!entry.task.experiment_id && entry.task.experiment_id !== exp.id;
      const ownedByOtherGrid = !!entry.task.grid_id && entry.task.grid_id !== exp.grid_id;
      if (mode === "attach" && (ownedByOtherExperiment || ownedByOtherGrid)) {
        res.status(409).json({
          error: "Task already belongs to a different experiment or grid",
          task_id: entry.task.id,
          experiment_id: entry.task.experiment_id,
          grid_id: entry.task.grid_id,
        }); return;
      }
    }

    const grid = store.getGrid(exp.grid_id);
    if (!grid) { res.status(404).json({ error: "Grid not found" }); return; }
    const nextGrid: Grid = { ...grid, task_ids: [...grid.task_ids] };
    const taskRefs: Record<string, string> = { ...(exp.task_refs || {}) };
    const usedRefs = new Set(Object.keys(taskRefs));
    for (const [ref, taskId] of Object.entries(taskRefs)) {
      if (taskIds.includes(taskId)) usedRefs.delete(ref);
    }
    const updatedTasks: Task[] = [];
    const sourceUpdates = new Map<string, { experiment: Experiment; grid?: Grid }>();
    const initialTaskCount = nextGrid.task_ids.length;
    for (const [index, entry] of found.entries()) {
      if (mode === "move" && entry.task.grid_id && entry.task.grid_id !== exp.grid_id) {
        const sourceGrid = removeTaskFromGrid(entry.task.id, entry.task.grid_id);
        if (entry.task.experiment_id && entry.task.experiment_id !== exp.id) {
          const sourceExp = store.getExperiment(entry.task.experiment_id);
          if (sourceExp) {
            const nextRefs = Object.fromEntries(
              Object.entries(sourceExp.task_refs || {}).filter(([, taskId]) => taskId !== entry.task.id),
            );
            const sourceTasks = tasksForIds(sourceGrid?.task_ids || []);
            const updatedSourceExp: Experiment = {
              ...sourceExp,
              task_refs: nextRefs,
              status: experimentStatusFromTasks(sourceTasks),
            };
            store.setExperiment(updatedSourceExp);
            sourceUpdates.set(updatedSourceExp.id, { experiment: updatedSourceExp, grid: sourceGrid });
          }
        }
      }
      const existingRef = Object.entries(taskRefs).find(([, taskId]) => taskId === entry.task.id)?.[0];
      const ref = existingRef || allocateRef(entry.task.ref, usedRefs, `task-${initialTaskCount + index + 1}`);
      taskRefs[ref] = entry.task.id;
      addUniqueTaskIds(nextGrid, [entry.task.id]);
      const updated = updateFoundTask(entry, { experiment_id: exp.id, grid_id: exp.grid_id, ref });
      if (!updated) {
        res.status(409).json({ error: "Task could not be updated", task_id: entry.task.id }); return;
      }
      updatedTasks.push(updated);
      webNs.emit("task.update", updated);
    }
    nextGrid.status = gridStatusFromTasks(store.getGridTasks(exp.grid_id).filter((task) => !taskIds.includes(task.id)).concat(updatedTasks));
    store.setGrid(nextGrid);
    const updatedExp = { ...exp, task_refs: taskRefs, status: experimentStatusFromTasks(store.getGridTasks(exp.grid_id).filter((task) => !taskIds.includes(task.id)).concat(updatedTasks)) };
    store.setExperiment(updatedExp);
    const now = new Date().toISOString();
    store.addExperimentEvent({
      id: uuidv4(), experiment_id: exp.id, kind: "note",
      message: `${mode === "move" ? "Moved" : "Attached"} ${taskIds.length} existing task${taskIds.length === 1 ? "" : "s"}`,
      actor: operatorActor(req), created_at: now,
      data: { mode, task_ids: taskIds },
    });
    webNs.emit("grid.update", nextGrid);
    webNs.emit("experiment.update", updatedExp);
    for (const { experiment: sourceExp, grid: sourceGrid } of sourceUpdates.values()) {
      if (sourceGrid) webNs.emit("grid.update", sourceGrid);
      webNs.emit("experiment.update", sourceExp);
    }
    res.json({ experiment: updatedExp, grid: nextGrid, tasks: updatedTasks });
  });

  // PATCH /experiments/:id — update research metadata only.
  router.patch("/:id", (req: Request, res: Response) => {
    const exp = store.getExperiment(req.params.id);
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }
    const body = req.body as Record<string, any>;
    const metadataError = validateExperimentMetadata(body);
    if (metadataError) { res.status(400).json({ error: metadataError }); return; }
    const allowed = new Set<string>(METADATA_FIELDS as readonly string[]);
    const changed: string[] = [];
    const patch: Partial<Experiment> = {};
    for (const [key, value] of Object.entries(body)) {
      if (!allowed.has(key)) continue;
      const nextValue = value || undefined;
      if (JSON.stringify((exp as any)[key]) !== JSON.stringify(nextValue)) {
        (patch as any)[key] = nextValue;
        changed.push(key);
      }
    }
    if (changed.length === 0) { res.json(exp); return; }
    const updated: Experiment = { ...exp, ...patch };
    store.setExperiment(updated);
    const now = new Date().toISOString();
    store.addExperimentEvent({
      id: uuidv4(), experiment_id: exp.id, kind: "note",
      message: `Updated experiment metadata: ${changed.join(", ")}`,
      actor: operatorActor(req), created_at: now,
      data: { fields: changed },
    });
    webNs.emit("experiment.update", updated);
    res.json(updated);
  });

  // POST /experiments
  router.post("/", (req: Request, res: Response) => {
    const {
      name, description, criteria, script,
      matrix, base_args, max_retries,
      requirements, target_tags, task_specs,
      python_env, cwd,
      config, config_diff, parent_name, parent_id,
      family, hypothesis, expected_outcome, fork_reason,
      goal_metric, goal_direction,
      git_tracking, git_repo_path,
    } = req.body;

    if (!name) { res.status(400).json({ error: "name required" }); return; }

    // ─── DAG task_specs path ──────────────────────────────────────────
    if (task_specs && Array.isArray(task_specs) && task_specs.length > 0) {
      const dagResult = validateDag(task_specs as TaskSpec[]);
      if (!dagResult.valid) {
        res.status(400).json({ error: `Invalid DAG: ${dagResult.error}` }); return;
      }

      const experimentId = uuidv4();
      const gridId = uuidv4();
      const refToTaskId: Record<string, string> = {};
      const taskIds: string[] = [];

      // Resolve parent_id from parent_name (best-effort)
      let parentId: string | undefined = typeof parent_id === "string" && parent_id ? parent_id : undefined;
      if (!parentId && parent_name) {
        const parentExp = store.findExperimentByName(parent_name);
        if (parentExp) parentId = parentExp.id;
      }

      // Create tasks in topological order (specs are assumed ordered, but we process roots first)
      for (const spec of task_specs as TaskSpec[]) {
        // Convert ref-based depends_on to task ID-based
        const dependsOnIds: string[] = [];
        for (const depRef of spec.depends_on || []) {
          const depId = refToTaskId[depRef];
          if (!depId) {
            res.status(400).json({ error: `ref "${spec.ref}" depends on "${depRef}" which hasn't been created yet — check task_specs order` });
            return;
          }
          dependsOnIds.push(depId);
        }

        const task = createTask({
          script: spec.script,
          args: spec.args,
          raw_args: spec.raw_args,
          args_template: spec.args_template,
          depends_on: dependsOnIds.length > 0 ? dependsOnIds : undefined,
          ref: spec.ref,
          experiment_id: experimentId,
          grid_id: gridId,
          cwd: spec.cwd ?? cwd,
          python_env: spec.python_env ?? python_env,
          env_setup: spec.env_setup,
          env: spec.env,
          env_overrides: spec.env_overrides,
          requirements: spec.requirements,
          target_tags: spec.target_tags ?? target_tags,
          max_retries: spec.max_retries ?? 0,
          priority: spec.priority,
        });

        // Attach resolved_config from SDK (experiment config + task overrides)
        if (spec.resolved_config) {
          (task as any).resolved_config = spec.resolved_config;
        }

        store.addToGlobalQueue(task);
        webNs.emit("task.update", task);
        refToTaskId[spec.ref] = task.id;
        taskIds.push(task.id);
      }

      // Create grid to hold all task_ids (compat with existing grid status tracking)
      const grid: Grid = {
        id: gridId,
        name: `exp:${name}`,
        display_name: `${name} — DAG (${taskIds.length} tasks)`,
        script: (task_specs as TaskSpec[])[0].script,
        param_space: {},
        task_ids: taskIds,
        status: "pending",
        created_at: new Date().toISOString(),
        max_retries: 0,
        target_tags,
      };
      store.setGrid(grid);

      const experiment: Experiment = {
        id: experimentId,
        name,
        description,
        criteria: criteria || {},
        grid_id: gridId,
        status: "running",
        results: {},
        created_at: new Date().toISOString(),
        task_specs: task_specs as TaskSpec[],
        task_refs: refToTaskId,
        config: config || undefined,
        config_diff: config_diff || undefined,
        parent_name: parent_name || undefined,
        parent_id: parentId,
        family: family || undefined,
        hypothesis: hypothesis || undefined,
        expected_outcome: expected_outcome || undefined,
        fork_reason: fork_reason || undefined,
        goal_metric: goal_metric || undefined,
        goal_direction: goal_direction || undefined,
        git_tracking: git_tracking === true ? true : undefined,
        git_repo_path: git_repo_path || undefined,
      };

      store.setExperiment(experiment);
      const forkData = parentId || parent_name ? { parent_name: parent_name ?? null, parent_id: parentId ?? null } : undefined;
      store.addExperimentEvent({
        id: uuidv4(),
        experiment_id: experiment.id,
        kind: forkData ? "forked" : "created",
        message: forkData ? `Forked from ${parent_name || parentId}` : "Created experiment",
        actor: operatorActor(req),
        created_at: experiment.created_at,
        data: forkData,
      });
      triggerSchedule();

      webNs.emit("grid.update", grid);
      webNs.emit("experiment.update", experiment);

      // Git tracking: init manifest fire-and-forget
      if (experiment.git_tracking && taskIds.length > 0) {
        const firstTaskStubId = store.getTask("", taskIds[0])?.stub_id;
        // Use first available online stub that matches target_tags, or any online stub
        const candidateStub = store.getAllStubs().find((s) => s.status === "online");
        if (candidateStub) {
          initExperimentManifest(experiment, candidateStub.id, stubNs).catch(() => {});
        }
      }

      logger.info("experiment.created", { id: experimentId, name, tasks: taskIds.length, dag: true, has_config: !!config, parent: parent_name || null });
      res.status(201).json(experiment);
      return;
    }

    // ─── Legacy matrix path ───────────────────────────────────────────
    if (!criteria || typeof criteria !== "object" || Object.keys(criteria).length === 0) {
      res.status(400).json({ error: "criteria required (object of metric: expression)" }); return;
    }
    if (!script) { res.status(400).json({ error: "script required" }); return; }
    if (!matrix || typeof matrix !== "object") {
      res.status(400).json({ error: "matrix required (object of arrays)" }); return;
    }
    if (Object.values(matrix).some((v: any) => !Array.isArray(v))) {
      res.status(400).json({ error: "matrix values must be arrays" }); return;
    }

    // Create grid internally
    const gridId = uuidv4();
    const combinations = cartesianProduct(matrix);
    const paramKeys = Object.keys(matrix);
    const paramSummary = paramKeys
      .map((k) => `${k}=[${(matrix as Record<string, any[]>)[k].join(",")}]`)
      .join(" ");
    const gridDisplayName = `${name} — ${path.basename(script)} ${paramSummary}`;

    const grid: Grid = {
      id: gridId,
      name: `exp:${name}`,
      display_name: gridDisplayName,
      script,
      base_args,
      param_space: matrix,
      task_ids: [],
      status: "pending",
      created_at: new Date().toISOString(),
      max_retries: max_retries ?? 0,
      requirements,
      target_tags,
    };

    store.setGrid(grid);

    // Create tasks
    const taskIds: string[] = [];
    for (const combo of combinations) {
      const mergedArgs: Record<string, string> = { ...(base_args || {}) };
      for (const [k, v] of Object.entries(combo)) {
        mergedArgs[`--${k}`] = String(v);
      }

      const task = createTask({
        script,
        args: mergedArgs,
        requirements,
        max_retries: max_retries ?? 0,
        grid_id: gridId,
        param_overrides: combo,
        target_tags,
      });
      store.addToGlobalQueue(task);
      webNs.emit("task.update", task);
      taskIds.push(task.id);
    }

    grid.task_ids = taskIds;
    store.setGrid(grid);

    // Create experiment
    const experiment: Experiment = {
      id: uuidv4(),
      name,
      description,
      criteria,
      grid_id: gridId,
      status: "running",
      results: {},
      created_at: new Date().toISOString(),
      family: family || undefined,
      hypothesis: hypothesis || undefined,
      expected_outcome: expected_outcome || undefined,
      fork_reason: fork_reason || undefined,
      goal_metric: goal_metric || undefined,
      goal_direction: goal_direction || undefined,
      git_tracking: git_tracking === true ? true : undefined,
      git_repo_path: git_repo_path || undefined,
    };

    store.setExperiment(experiment);
    store.addExperimentEvent({
      id: uuidv4(),
      experiment_id: experiment.id,
      kind: "created",
      message: "Created experiment",
      actor: operatorActor(req),
      created_at: experiment.created_at,
    });
    triggerSchedule();

    webNs.emit("grid.update", grid);
    webNs.emit("experiment.update", experiment);

    // Git tracking: init manifest fire-and-forget
    if (experiment.git_tracking) {
      const candidateStub = store.getAllStubs().find((s) => s.status === "online");
      if (candidateStub) {
        initExperimentManifest(experiment, candidateStub.id, stubNs).catch(() => {});
      }
    }

    logger.info("experiment.created", { id: experiment.id, name, tasks: taskIds.length, criteria: Object.keys(criteria) });
    res.status(201).json(experiment);
  });

  // GET /experiments — optional ?family=&decision=&status= filters
  router.get("/", (req: Request, res: Response) => {
    const familyFilter = typeof req.query.family === "string" ? req.query.family : undefined;
    const decisionFilter = typeof req.query.decision === "string" ? req.query.decision : undefined;
    const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
    let experiments = store.getAllExperiments().map((exp) => ({
      ...exp,
      status: deriveExperimentStatus(exp),
    }));
    if (familyFilter) experiments = experiments.filter((e) => (e.family ?? "") === familyFilter);
    if (decisionFilter) {
      if (decisionFilter === "none") experiments = experiments.filter((e) => !e.decision);
      else experiments = experiments.filter((e) => e.decision === decisionFilter);
    }
    if (statusFilter) experiments = experiments.filter((e) => e.status === statusFilter);
    res.json(experiments);
  });

  // GET /experiments/tree — parent_id forest of experiments
  // NOTE: must be registered before /:id so Express does not capture "tree" as an id.
  router.get("/tree", (_req: Request, res: Response) => {
    const all = store.getAllExperiments();
    const knownIds = new Set(all.map((e) => e.id));
    const childrenByParent = new Map<string, Experiment[]>();
    const roots: Experiment[] = [];

    for (const exp of all) {
      if (exp.parent_id && knownIds.has(exp.parent_id)) {
        const bucket = childrenByParent.get(exp.parent_id) ?? [];
        bucket.push(exp);
        childrenByParent.set(exp.parent_id, bucket);
      } else {
        roots.push(exp);
      }
    }

    const build = (exp: Experiment): any => {
      const kids = (childrenByParent.get(exp.id) ?? []).slice().sort(compareExperiments);
      return {
        ...experimentBrief(exp),
        children: kids.map(build),
      };
    };

    const tree = roots.slice().sort(compareExperiments).map(build);
    res.json({ roots: tree });
  });

  // GET /experiments/compare?ids=a,b,c — side-by-side comparison
  // NOTE: must be registered before /:id.
  router.get("/compare", (req: Request, res: Response) => {
    const raw = req.query.ids;
    const idsParam = Array.isArray(raw) ? raw.join(",") : typeof raw === "string" ? raw : "";
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const part of idsParam.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      ids.push(trimmed);
    }
    if (ids.length === 0) {
      res.status(400).json({ error: "ids query parameter required (comma-separated experiment IDs)" });
      return;
    }
    if (ids.length > 6) {
      res.status(400).json({ error: "compare supports at most 6 ids" });
      return;
    }

    const missing: string[] = [];
    const found: string[] = [];
    const experiments: Experiment[] = [];
    for (const id of ids) {
      const exp = store.getExperiment(id);
      if (!exp) missing.push(id);
      else {
        experiments.push(exp);
        found.push(id);
      }
    }

    const bestByExp = new Map<string, Record<string, number>>();
    const items = experiments.map((exp) => {
      const best = bestMetricValues(exp);
      bestByExp.set(exp.id, best);
      return {
        ...experimentBrief(exp),
        config: exp.config ?? null,
        criteria: exp.criteria ?? {},
        metrics: aggregateMetrics(exp),
        best_metrics: best,
        primary_metric: primaryMetricFor(exp),
        pass_fail: passFailSummary(exp),
      };
    });

    const configs = experiments.map((e) => e.config ?? null);
    const shared = sharedConfigKeys(configs);
    const differing = differingConfigKeys(configs, shared);

    res.json({
      ids,
      found,
      missing,
      experiments: items,
      shared_config_keys: shared,
      differing_config_keys: differing,
      metric_deltas: metricDeltas(found, bestByExp),
    });
  });

  // GET /experiments/research-report — filtered family/decision/status rollup
  // NOTE: must be registered before /:id so Express does not capture
  // "research-report" as an id. Read-only: never writes events, never reads
  // git manifests, never touches scheduler.
  router.get("/research-report", (req: Request, res: Response) => {
    const readScalarQuery = (name: "family" | "decision" | "status" | "limit"): string | undefined | null => {
      const value = req.query[name];
      if (value === undefined) return undefined;
      if (typeof value !== "string") return null;
      return value;
    };
    const familyFilter = readScalarQuery("family");
    const decisionFilter = readScalarQuery("decision");
    const statusFilter = readScalarQuery("status");
    const limitFilter = readScalarQuery("limit");
    if (familyFilter === null || decisionFilter === null || statusFilter === null || limitFilter === null) {
      res.status(400).json({ error: "family, decision, status, and limit must be scalar query parameters" });
      return;
    }

    // limit: positive integer, default 50, cap 200. Reject non-integer / non-positive.
    let limit = 50;
    if (limitFilter !== undefined) {
      if (limitFilter.length === 0) {
        res.status(400).json({ error: "limit must be a positive integer" });
        return;
      }
      const parsed = Number(limitFilter);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
        res.status(400).json({ error: "limit must be a positive integer" });
        return;
      }
      limit = Math.min(parsed, 200);
    }

    if (decisionFilter !== undefined && decisionFilter !== "none" && !DECISIONS.has(decisionFilter as ExperimentDecision)) {
      res.status(400).json({ error: "decision must be one of keep, drop, rerun, fork, none" });
      return;
    }
    if (statusFilter !== undefined && !EXPERIMENT_STATUSES.has(statusFilter as Experiment["status"])) {
      res.status(400).json({ error: "status must be one of running, passed, partial, failed" });
      return;
    }

    let experiments = store.getAllExperiments();
    if (familyFilter !== undefined) experiments = experiments.filter((e) => (e.family ?? "") === familyFilter);
    if (decisionFilter !== undefined) {
      if (decisionFilter === "none") experiments = experiments.filter((e) => !e.decision);
      else experiments = experiments.filter((e) => e.decision === decisionFilter);
    }
    const statusByExp = new Map<string, Experiment["status"]>();
    for (const exp of experiments) statusByExp.set(exp.id, deriveExperimentStatus(exp));
    if (statusFilter !== undefined) experiments = experiments.filter((e) => statusByExp.get(e.id) === statusFilter);

    // Deterministic sort: family asc (nulls last), created_at asc, name, id.
    experiments = experiments.slice().sort((a, b) => {
      const fa = a.family ?? null;
      const fb = b.family ?? null;
      if (fa !== fb) {
        if (fa === null) return 1;
        if (fb === null) return -1;
        return fa.localeCompare(fb);
      }
      return compareExperiments(a, b);
    });

    const matchingExperiments = experiments;
    const returnedExperiments = matchingExperiments.slice(0, limit);

    // Counts reflect the full filtered rollup, not only the returned page.
    const byStatus: Record<string, number> = {};
    const byDecision: Record<string, number> = {};
    for (const exp of matchingExperiments) {
      const status = statusByExp.get(exp.id) ?? deriveExperimentStatus(exp);
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      const dKey = exp.decision ?? "none";
      byDecision[dKey] = (byDecision[dKey] ?? 0) + 1;
    }

    // Report-level metric: pick the (goal_metric, goal_direction) pair shared by
    // the most matching experiments. Ties break by metric name then direction
    // for determinism. If no experiment in the filtered set has a goal_metric,
    // return null and leaderboard stays empty — we never infer winners from criteria.
    type MetricPick = { name: string; direction: "min" | "max"; n: number };
    const picks = new Map<string, MetricPick>();
    for (const exp of matchingExperiments) {
      if (!exp.goal_metric || !exp.goal_direction) continue;
      const key = `${exp.goal_metric} ${exp.goal_direction}`;
      const existing = picks.get(key);
      if (existing) existing.n += 1;
      else picks.set(key, { name: exp.goal_metric, direction: exp.goal_direction, n: 1 });
    }
    let reportMetric: { name: string; direction: "min" | "max" } | null = null;
    for (const candidate of picks.values()) {
      if (
        !reportMetric ||
        candidate.n > (picks.get(`${reportMetric.name} ${reportMetric.direction}`)?.n ?? 0) ||
        (candidate.n === (picks.get(`${reportMetric.name} ${reportMetric.direction}`)?.n ?? 0) &&
          (candidate.name.localeCompare(reportMetric.name) < 0 ||
            (candidate.name === reportMetric.name && candidate.direction.localeCompare(reportMetric.direction) < 0)))
      ) {
        reportMetric = { name: candidate.name, direction: candidate.direction };
      }
    }

    // Leaderboard: experiments that have a numeric aggregate for the report
    // metric. Sort by direction; assign deterministic rank starting at 1.
    type LeaderboardEntry = {
      id: string;
      name: string;
      status: Experiment["status"];
      decision: ExperimentDecision | null;
      value: number;
      metric: string;
      rank: number;
    };
    const leaderboard: LeaderboardEntry[] = [];
    if (reportMetric) {
      const rows: Omit<LeaderboardEntry, "rank">[] = [];
      for (const exp of matchingExperiments) {
        const agg = aggregateMetrics(exp)[reportMetric.name];
        if (!agg) continue;
        const value = reportMetric.direction === "min" ? agg.min : agg.max;
        if (!Number.isFinite(value)) continue;
        rows.push({
          id: exp.id,
          name: exp.name,
          status: statusByExp.get(exp.id) ?? deriveExperimentStatus(exp),
          decision: exp.decision ?? null,
          value,
          metric: reportMetric.name,
        });
      }
      rows.sort((a, b) => {
        if (a.value !== b.value) {
          return reportMetric!.direction === "min" ? a.value - b.value : b.value - a.value;
        }
        if (a.name !== b.name) return a.name.localeCompare(b.name);
        return a.id.localeCompare(b.id);
      });
      rows.slice(0, limit).forEach((row, i) => leaderboard.push({ ...row, rank: i + 1 }));
    }

    // Per-experiment block. Children come from the full experiment set (not
    // the filtered slice) so the report still shows downstream lineage even
    // when filters exclude the forks.
    const allExperiments = store.getAllExperiments();
    const childrenByParent = new Map<string, Experiment[]>();
    for (const e of allExperiments) {
      if (!e.parent_id) continue;
      const bucket = childrenByParent.get(e.parent_id) ?? [];
      bucket.push(e);
      childrenByParent.set(e.parent_id, bucket);
    }

    const blocks = returnedExperiments.map((exp) => {
      const storedEvents = store.getExperimentEvents(exp.id).filter((e) => !e.deleted_at);
      const artifactCount = storedEvents.filter((e) => e.kind === "artifact").length;
      const checkpointCount = storedEvents.filter((e) => e.kind === "checkpoint").length;
      const events = timelineFor(exp);
      const recent = events.slice(-3);
      const kids = (childrenByParent.get(exp.id) ?? []).slice().sort(compareExperiments).map(experimentBrief);
      return {
        id: exp.id,
        name: exp.name,
        family: exp.family ?? null,
        status: statusByExp.get(exp.id) ?? deriveExperimentStatus(exp),
        recommendation: recommendationForExperiment(exp, allExperiments),
        decision: exp.decision ?? null,
        decision_reason: exp.decision_reason ?? null,
        decision_at: exp.decision_at ?? null,
        created_at: exp.created_at,
        parent_id: exp.parent_id ?? null,
        children: kids,
        task_counts: taskCountsByStatus(exp),
        primary_metric: primaryMetricFor(exp),
        artifact_count: artifactCount,
        checkpoint_count: checkpointCount,
        recent_events: recent,
      };
    });

    res.json({
      filters: {
        family: familyFilter ?? null,
        decision: decisionFilter ?? null,
        status: statusFilter ?? null,
        limit,
      },
      generated_at: new Date().toISOString(),
      counts: {
        total: matchingExperiments.length,
        by_status: byStatus,
        by_decision: byDecision,
      },
      metric: reportMetric,
      leaderboard,
      experiments: blocks,
    });
  });

  // GET /experiments/:id/summary — detailed summary including lineage
  // Registered before /:id-with-no-suffix is fine because path segments differ.
  router.get("/:id/summary", (req: Request, res: Response) => {
    const exp = store.getExperiment(req.params.id);
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }

    const parent = exp.parent_id ? store.getExperiment(exp.parent_id) : undefined;
    const children = store.getAllExperiments()
      .filter((e) => e.parent_id === exp.id)
      .sort(compareExperiments);
    const eventCount = store.getExperimentEvents(exp.id).filter((e) => !e.deleted_at).length;

    res.json({
      id: exp.id,
      name: exp.name,
      status: deriveExperimentStatus(exp),
      recommendation: recommendationForExperiment(exp, store.getAllExperiments()),
      family: exp.family ?? null,
      hypothesis: exp.hypothesis ?? null,
      expected_outcome: exp.expected_outcome ?? null,
      fork_reason: exp.fork_reason ?? null,
      goal_metric: exp.goal_metric ?? null,
      goal_direction: exp.goal_direction ?? null,
      decision: exp.decision ?? null,
      decision_reason: exp.decision_reason ?? null,
      decision_at: exp.decision_at ?? null,
      created_at: exp.created_at,
      parent: parent ? experimentBrief(parent) : null,
      children: children.map(experimentBrief),
      task_counts: taskCountsByStatus(exp),
      validation: passFailSummary(exp),
      best_metrics: bestMetricValues(exp),
      primary_metric: primaryMetricFor(exp),
      timeline_event_count: eventCount,
      config: exp.config ?? null,
      config_diff: exp.config_diff ?? null,
    });
  });

  // GET /experiments/:id/recommendation — decision recommendation only.
  // Registered before /:id so clients can fetch a compact recommendation payload.
  router.get("/:id/recommendation", (req: Request, res: Response) => {
    const exp = store.getExperiment(req.params.id);
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }
    res.json(recommendationForExperiment(exp, store.getAllExperiments()));
  });

  // GET /experiments/:id
  router.get("/:id", (req: Request, res: Response) => {
    const exp = store.getExperiment(req.params.id);
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }

    const grid = store.getGrid(exp.grid_id);
    const tasks = grid ? store.getGridTasks(exp.grid_id) : [];
    const status = deriveExperimentStatus(exp);

    res.json({ ...exp, status, grid, tasks });
  });

  // GET /experiments/:id/diff — config diff for lineage tracking
  router.get("/:id/diff", (req: Request, res: Response) => {
    const exp = store.getExperiment(req.params.id);
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }

    const result: Record<string, any> = {
      experiment_id: exp.id,
      name: exp.name,
      config: exp.config || null,
      config_diff: exp.config_diff || null,
      parent_name: exp.parent_name || null,
      parent_id: exp.parent_id || null,
    };

    // If parent exists, include parent config for context
    if (exp.parent_id) {
      const parent = store.getExperiment(exp.parent_id);
      if (parent) {
        result.parent_config = parent.config || null;
      }
    }

    res.json(result);
  });

  // GET /experiments/:id/timeline — stored events plus synthesized task lifecycle
  router.get("/:id/timeline", (req: Request, res: Response) => {
    const exp = store.getExperiment(req.params.id);
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }
    res.json({ experiment_id: exp.id, events: timelineFor(exp) });
  });

  // POST /experiments/:id/events — append note or operational event
  router.post("/:id/events", (req: Request, res: Response) => {
    const exp = store.getExperiment(req.params.id);
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }
    const { kind, message, task_id, data } = req.body;
    if (!EVENT_KINDS.has(kind)) { res.status(400).json({ error: "invalid event kind" }); return; }
    const messageError = validateMessage(message);
    if (messageError) { res.status(400).json({ error: messageError }); return; }
    const dataError = validateEventData(data);
    if (dataError) { res.status(400).json({ error: dataError }); return; }
    const artifactError = validateArtifactData(kind, data);
    if (artifactError) { res.status(400).json({ error: artifactError }); return; }

    const event: ExperimentEvent = {
      id: uuidv4(),
      experiment_id: exp.id,
      task_id: typeof task_id === "string" && task_id ? task_id : undefined,
      kind,
      message,
      actor: operatorActor(req),
      data,
      created_at: new Date().toISOString(),
    };
    store.addExperimentEvent(event);
    res.status(201).json(event);
  });

  // PATCH /experiments/:id/decision — set decision metadata and append event
  router.patch("/:id/decision", (req: Request, res: Response) => {
    const exp = store.getExperiment(req.params.id);
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }
    const { decision, reason } = req.body;
    if (!DECISIONS.has(decision)) { res.status(400).json({ error: "invalid decision" }); return; }
    const reasonError = validateMessage(reason, "reason");
    if (reasonError) { res.status(400).json({ error: reasonError }); return; }

    const decisionAt = new Date().toISOString();
    const updated: Experiment = {
      ...exp,
      decision,
      decision_reason: reason,
      decision_at: decisionAt,
    };
    store.setExperiment(updated);
    store.addExperimentEvent({
      id: uuidv4(),
      experiment_id: exp.id,
      kind: "decision",
      message: `Marked ${decision}: ${reason}`,
      actor: operatorActor(req),
      data: { decision },
      created_at: decisionAt,
    });
    webNs.emit("experiment.update", updated);
    res.json(updated);
  });

  // GET /experiments/:id/research-bundle — read-only export of decision-relevant
  // context: detail + summary + diff + manifest + timeline + decision + artifacts.
  // Composes existing read-only surfaces; never writes events or touches scheduler.
  router.get("/:id/research-bundle", async (req: Request, res: Response) => {
    const exp = store.getExperiment(req.params.id);
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }

    const status = deriveExperimentStatus(exp);
    const grid = store.getGrid(exp.grid_id);
    const tasks = grid ? store.getGridTasks(exp.grid_id) : [];

    const detail = { ...exp, status, grid, tasks };

    const parent = exp.parent_id ? store.getExperiment(exp.parent_id) : undefined;
    const children = store.getAllExperiments()
      .filter((e) => e.parent_id === exp.id)
      .sort(compareExperiments);
    const storedEvents = store.getExperimentEvents(exp.id).filter((e) => !e.deleted_at);
    const eventCount = storedEvents.length;

    const summary = {
      id: exp.id,
      name: exp.name,
      status: deriveExperimentStatus(exp),
      recommendation: recommendationForExperiment(exp, store.getAllExperiments()),
      family: exp.family ?? null,
      hypothesis: exp.hypothesis ?? null,
      expected_outcome: exp.expected_outcome ?? null,
      fork_reason: exp.fork_reason ?? null,
      goal_metric: exp.goal_metric ?? null,
      goal_direction: exp.goal_direction ?? null,
      decision: exp.decision ?? null,
      decision_reason: exp.decision_reason ?? null,
      decision_at: exp.decision_at ?? null,
      created_at: exp.created_at,
      parent: parent ? experimentBrief(parent) : null,
      children: children.map(experimentBrief),
      task_counts: taskCountsByStatus(exp),
      validation: passFailSummary(exp),
      best_metrics: bestMetricValues(exp),
      primary_metric: primaryMetricFor(exp),
      timeline_event_count: eventCount,
      config: exp.config ?? null,
      config_diff: exp.config_diff ?? null,
    };


    const diff: Record<string, any> = {
      experiment_id: exp.id,
      name: exp.name,
      config: exp.config || null,
      config_diff: exp.config_diff || null,
      parent_name: exp.parent_name || null,
      parent_id: exp.parent_id || null,
    };
    if (exp.parent_id) {
      const parentExp = store.getExperiment(exp.parent_id);
      if (parentExp) diff.parent_config = parentExp.config || null;
    }

    const events = timelineFor(exp);
    const timeline = { experiment_id: exp.id, events };

    // Artifacts: only artifact/checkpoint kinds, preserving locator data. The
    // timeline already filters out deleted events and orders deterministically.
    const artifacts = events.filter((e) => ARTIFACT_KINDS.has(e.kind));

    const decision = {
      decision: exp.decision ?? null,
      reason: exp.decision_reason ?? null,
      decided_at: exp.decision_at ?? null,
    };

    // Manifest is best-effort: requires git_tracking, git_repo_path, and an
    // online stub. Failing any precondition or hitting an exec error must not
    // 500 the bundle — surface status so consumers can show "manifest
    // unavailable" without rerouting through /manifest themselves.
    let manifest: { enabled: boolean; content: string | null; status: string; error: string | null };
    if (!exp.git_tracking || !exp.git_repo_path) {
      manifest = { enabled: false, content: null, status: "not_enabled", error: null };
    } else {
      const stub = store.getAllStubs().find((s) => s.status === "online");
      if (!stub) {
        manifest = { enabled: true, content: null, status: "no_online_stub", error: null };
      } else {
        try {
          const content = await readExperimentManifest(exp, stub.id, stubNs);
          manifest = { enabled: true, content, status: "ok", error: null };
        } catch (err: any) {
          logger.warn("experiment.bundle-manifest-read-failed", { id: exp.id, name: exp.name, error: String(err) });
          manifest = { enabled: true, content: null, status: "error", error: err?.message ? String(err.message) : String(err) };
        }
      }
    }

    res.json({
      experiment: detail,
      summary,
      diff,
      manifest,
      timeline,
      decision,
      artifacts,
      generated_at: new Date().toISOString(),
    });
  });

  // GET /experiments/:id/manifest
  router.get("/:id/manifest", async (req: Request, res: Response) => {
    const exp = store.getExperiment(req.params.id);
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }
    if (!exp.git_tracking) { res.status(400).json({ error: "git_tracking not enabled for this experiment" }); return; }
    if (!exp.git_repo_path) { res.status(400).json({ error: "git_repo_path not set on experiment" }); return; }

    // Find an online stub to exec on
    const stub = store.getAllStubs().find((s) => s.status === "online");
    if (!stub) { res.status(503).json({ error: "No online stub available" }); return; }

    try {
      const content = await readExperimentManifest(exp, stub.id, stubNs);
      res.set("Content-Type", "text/yaml").send(content);
    } catch (err: any) {
      logger.warn("experiment.manifest-read-failed", { id: exp.id, name: exp.name, error: String(err) });
      res.status(500).json({ error: `Failed to read manifest: ${err.message}` });
    }
  });

  // DELETE /experiments/:id
  router.delete("/:id", (req: Request, res: Response) => {
    const exp = store.getExperiment(req.params.id);
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }

    store.deleteExperiment(exp.id);
    logger.info("experiment.deleted", { id: exp.id, name: exp.name });
    res.json({ ok: true });
  });

  // POST /experiments/:id/retry-failed
  router.post("/:id/retry-failed", (req: Request, res: Response) => {
    const exp = store.getExperiment(req.params.id);
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }

    const grid = store.getGrid(exp.grid_id);
    if (!grid) { res.status(404).json({ error: "Grid not found" }); return; }

    const tasks = store.getGridTasks(exp.grid_id);
    let retried = 0;

    for (const task of tasks) {
      // Retry tasks that failed criteria (validation exists but !passed) or failed execution
      const validation = exp.results[task.id];
      const criteriaFailed = validation && !validation.passed;
      const execFailed = ["failed", "killed", "lost"].includes(task.status);

      if (criteriaFailed || execFailed) {
        const seq = store.nextSeq();
        const retryTask: Task = {
          ...task,
          id: uuidv4(),
          seq,
          status: "pending",
          stub_id: undefined,
          retry_count: task.retry_count + 1,
          retry_of: task.retry_of || task.id,
          created_at: new Date().toISOString(),
          started_at: undefined,
          finished_at: undefined,
          exit_code: undefined,
          pid: undefined,
          log_buffer: [],
          progress: undefined,
          eval_metrics: undefined,
          should_stop: false,
          should_checkpoint: false,
        };
        store.addToGlobalQueue(retryTask);

        // Update grid task_ids
        const idx = grid.task_ids.indexOf(task.id);
        if (idx !== -1) grid.task_ids[idx] = retryTask.id;

        // Clear old validation result, will be re-evaluated
        if (exp.results[task.id]) {
          delete exp.results[task.id];
        }

        webNs.emit("task.update", retryTask);
        retried++;
      }
    }

    if (retried > 0) {
      store.setGrid(grid);
      store.setExperiment(exp);
      triggerSchedule();
    }

    res.json({ ok: true, retried });
  });

  return router;
}
