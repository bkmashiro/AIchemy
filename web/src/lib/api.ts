import axios from "axios";

const BASE = "/api";

export const api = axios.create({ baseURL: BASE });

export function setApiToken(token: string) {
  api.defaults.headers.common["Authorization"] = `Bearer ${token}`;
}

const storedToken = localStorage.getItem("alchemy_token") || "";
if (storedToken) setApiToken(storedToken);

export function getStoredToken(): string {
  return localStorage.getItem("alchemy_token") || "";
}

export function saveToken(token: string) {
  localStorage.setItem("alchemy_token", token);
  setApiToken(token);
}

export function hasToken(): boolean {
  return !!getStoredToken();
}

export function clearToken() {
  localStorage.removeItem("alchemy_token");
}

// Global 401 handler — set by App to trigger login redirect
let _onAuthFail: (() => void) | null = null;
export function setOnAuthFail(fn: () => void) { _onAuthFail = fn; }

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401 && _onAuthFail) _onAuthFail();
    return Promise.reject(err);
  }
);

// ─── Paginated response ────────────────────────────────────────────────────────

export interface PaginatedTasks {
  tasks: Task[];
  total: number;
  page: number;
  limit: number;
  counts?: Record<string, number>;
}

// ─── Data Models (spec §1) ────────────────────────────────────────────────────

export type TaskStatus =
  | "pending"
  | "queued"
  | "dispatched"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "killed"
  | "lost";

export interface TaskProgress {
  step: number;
  total: number;
  loss?: number;
  metrics?: Record<string, number>;
}

export interface TaskRequirements {
  gpu_mem_mb?: number;
  cpu_mem_mb?: number;
  gpu_type?: string[];
}

export interface Task {
  // Identity
  id: string;
  seq: number;
  fingerprint: string;
  name?: string;
  display_name: string;

  // Structured command
  script: string;
  args?: Record<string, string>;
  raw_args?: string;

  // Environment
  cwd?: string;
  env_setup?: string;
  env?: Record<string, string>;

  // Assembled (read-only, server builds)
  command: string;

  // Resources
  requirements?: TaskRequirements;

  // Scheduling
  status: TaskStatus;
  priority: number;
  stub_id?: string;
  stub_name?: string;            // Enriched by server: stub.name or stub.hostname
  target_tags?: string[];        // Tag-based routing

  // Grid
  grid_id?: string;
  param_overrides?: Record<string, any>;

  // Lifecycle
  created_at: string;
  started_at?: string;
  finished_at?: string;
  exit_code?: number;
  pid?: number;

  // Progress
  progress?: TaskProgress;
  log_buffer: string[];
  config_snapshot?: Record<string, any>;

  // Resume & Retry
  run_dir?: string;
  checkpoint_path?: string;
  retry_count: number;
  max_retries: number;
  retry_of?: string;

  // Lifecycle phase (Stream G — optional, not yet reported by stubs)
  phase?: string;

  // Server signals
  should_stop: boolean;
  should_checkpoint: boolean;

  // Dispatch tracking
  dispatch_attempts?: number;
  target_stub_id?: string;
}

export interface GpuStatEntry {
  index: number;
  utilization_pct: number;
  memory_used_mb: number;
  memory_total_mb: number;
  temperature_c?: number;
}

export interface GpuStats {
  timestamp: string;
  gpus: GpuStatEntry[];
}

export interface SystemStats {
  cpu_pct: number;
  mem_used_mb: number;
  mem_total_mb: number;
  per_task?: Record<string, { cpu_pct: number; mem_mb: number; gpu_mem_mb?: number }>;
}

export interface GpuInfo {
  name: string;
  vram_total_mb: number;
  count: number;
}

export interface Stub {
  id: string;
  name: string;
  hostname: string;
  gpu: GpuInfo;
  system_stats?: SystemStats;
  slurm_job_id?: string;
  status: "online" | "offline";
  type: "slurm" | "workstation";
  connected_at: string;
  last_heartbeat: string;
  max_concurrent: number;
  tasks: Task[];
  gpu_stats?: GpuStats;
  env_setup?: string;
  default_cwd?: string;
  idle_timeout_s?: number;
  tags?: string[];               // Routing tags (--tags a40-cluster,ys25)
  walltime_remaining_s?: number; // SLURM: seconds remaining

  // Inherited from deploy target config
  deploy_python_path?: string;
  deploy_default_cwd?: string;
  deploy_env_setup?: string;
  deploy_default_env?: Record<string, string>;
}

export interface Grid {
  id: string;
  name?: string;
  display_name: string;
  script: string;
  base_args?: Record<string, string>;
  param_space: Record<string, any[]>;
  task_ids: string[];
  status: "pending" | "running" | "partial" | "completed" | "failed";
  created_at: string;
  max_retries: number;
  requirements?: TaskRequirements;
}

export interface OverviewData {
  stubs: { total: number; online: number; offline: number };
  tasks: { total: number; running: number; queued: number; completed: number; failed: number };
  gpus: { total_vram_mb: number; used_vram_mb: number };
  grids: { total: number; running: number; completed: number };
  cached_at: string;
}

// ─── Task submit payload ───────────────────────────────────────────────────────

export interface TaskSubmitPayload {
  script: string;
  args?: Record<string, string>;
  raw_args?: string;
  name?: string;
  cwd?: string;
  env_setup?: string;
  env?: Record<string, string>;
  requirements?: TaskRequirements;
  priority?: number;
  target_tags?: string[];
  max_retries?: number;
  run_dir?: string;
  idempotency_key?: string;
}

// ─── API client functions ──────────────────────────────────────────────────────

export const tasksApi = {
  list: (params?: { page?: number; limit?: number; status?: string; status_group?: string }) =>
    api.get<PaginatedTasks>("/tasks", { params }).then((r) => r.data),
  get: (id: string) => api.get<Task>(`/tasks/${id}`).then((r) => r.data),
  submit: (data: TaskSubmitPayload) => api.post<Task>("/tasks", data).then((r) => r.data),
  patch: (id: string, data: { status?: TaskStatus; priority?: number; name?: string; should_stop?: boolean }) =>
    api.patch<Task>(`/tasks/${id}`, data).then((r) => r.data),
  retry: (id: string) => api.post<Task>(`/tasks/${id}/retry`).then((r) => r.data),
  batch: (action: "kill" | "retry" | "requeue" | "delete", task_ids: string[]) =>
    api.post("/tasks/batch", { action, task_ids }).then((r) => r.data),
  logs: (id: string, tail = 100) =>
    api.get<{ task_id: string; lines: string[] }>(`/tasks/${id}/logs`, { params: { tail } }).then((r) => r.data),
  metrics: (id: string) => api.get(`/tasks/${id}/metrics`).then((r) => r.data),
};

export const stubsApi = {
  list: () => api.get<Stub[]>("/stubs").then((r) => r.data),
  get: (id: string) => api.get<Stub>(`/stubs/${id}`).then((r) => r.data),
  patch: (id: string, data: { name?: string; max_concurrent?: number; tags?: string[]; idle_timeout_s?: number }) =>
    api.patch<{ ok: boolean; stub: Stub }>(`/stubs/${id}`, data).then((r) => r.data.stub),
  release: (id: string) =>
    api.post<{ ok: boolean }>(`/stubs/${id}/release`).then((r) => r.data),
  submitTask: (id: string, data: TaskSubmitPayload) =>
    api.post<Task>(`/stubs/${id}/tasks`, data).then((r) => r.data),
  metrics: (id: string, hours = 1) =>
    api.get(`/stubs/${id}/metrics`, { params: { hours } }).then((r) => r.data),
};

export const gridsApi = {
  list: () => api.get<Grid[]>("/grids").then((r) => r.data),
  get: (id: string) => api.get<Grid & { tasks: Task[] }>(`/grids/${id}`).then((r) => r.data),
  create: (data: {
    script: string;
    base_args?: Record<string, string>;
    param_space: Record<string, any[]>;
    name?: string;
    max_retries?: number;
    requirements?: TaskRequirements;
  }) => api.post<Grid>("/grids", data).then((r) => r.data),
  cancelAll: (id: string) => api.post(`/grids/${id}/cancel`).then((r) => r.data),
  retryFailed: (id: string) => api.post(`/grids/${id}/retry-failed`).then((r) => r.data),
};

export const overviewApi = {
  get: () => api.get<OverviewData>("/overview").then((r) => r.data),
};

export const metricsApi = {
  getStubMetrics: (stubId: string, hours = 1) =>
    api.get(`/stubs/${stubId}/metrics`, { params: { hours } }).then((r) => r.data),
  getTaskMetrics: (taskId: string) => api.get(`/tasks/${taskId}/metrics`).then((r) => r.data),
};

// ─── Experiments API ─────────────────────────────────────────────────────────

export type ExperimentDecision = "keep" | "drop" | "rerun" | "fork";

export type ExperimentEventKind =
  | "created"
  | "forked"
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "resumed"
  | "moved_stub"
  | "metric_best"
  | "note"
  | "decision"
  | "artifact"
  | "checkpoint";

export interface ExperimentEvent {
  id: string;
  experiment_id: string;
  task_id?: string;
  kind: ExperimentEventKind;
  message: string;
  created_at: string;
  actor?: string;
  data?: Record<string, any>;
  deleted_at?: string;
}

export interface CriterionResult {
  value: number;
  threshold: string;
  ok: boolean;
}

export interface TaskValidation {
  passed: boolean;
  checked_at: string;
  details: Record<string, CriterionResult>;
}

export interface Experiment {
  id: string;
  name: string;
  description?: string;
  criteria: Record<string, string>;
  grid_id: string;
  status: "running" | "passed" | "partial" | "failed";
  results: Record<string, TaskValidation>;
  created_at: string;
  // Lineage
  config?: Record<string, any>;
  config_diff?: Record<string, { old: any; new: any }>;
  parent_name?: string;
  parent_id?: string;
  // Intent
  family?: string;
  hypothesis?: string;
  expected_outcome?: string;
  fork_reason?: string;
  // Decision
  decision?: ExperimentDecision;
  decision_reason?: string;
  decision_at?: string;
  // Goal metric (lineage phase 2)
  goal_metric?: string;
  goal_direction?: "min" | "max";
  // Git tracking
  git_tracking?: boolean;
  git_repo_path?: string;
}

export interface ExperimentDetail extends Experiment {
  grid?: {
    id: string;
    display_name: string;
    script: string;
    param_space: Record<string, unknown[]>;
    task_ids: string[];
  };
  tasks?: Task[];
}

export interface ExperimentTimelineResponse {
  experiment_id: string;
  events: ExperimentEvent[];
}

export interface AddEventPayload {
  kind: ExperimentEventKind;
  message: string;
  task_id?: string;
  data?: Record<string, any>;
}

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
  created_at: string;
}

export interface PrimaryMetric {
  metric: string;
  direction: "min" | "max";
  best: number | null;
}

export interface ExperimentRecommendation {
  action: string | null;
  verdict: string | null;
  reason: string | null;
  metric: string | null;
  value: number | null;
  baseline_value: number | null;
  delta: number | null;
  direction: string | null;
}

export interface MetricDeltaEntry {
  id: string;
  best: number | null;
  delta: number | null;
}

export interface ExperimentTreeNode extends ExperimentBrief {
  children: ExperimentTreeNode[];
}

export interface ExperimentMetricAggregate {
  count: number;
  values: number[];
  min: number;
  max: number;
  mean: number;
  best: number;
  passed: number;
  failed: number;
}

export interface ExperimentPassFailSummary {
  total: number;
  passed: number;
  failed: number;
}

export interface ExperimentCompareItem extends ExperimentBrief {
  config: Record<string, any> | null;
  criteria: Record<string, string>;
  metrics: Record<string, ExperimentMetricAggregate>;
  best_metrics: Record<string, number>;
  primary_metric: PrimaryMetric | null;
  pass_fail: ExperimentPassFailSummary;
}

export interface ExperimentCompareResponse {
  ids: string[];
  found: string[];
  missing: string[];
  experiments: ExperimentCompareItem[];
  shared_config_keys: string[];
  differing_config_keys: string[];
  metric_deltas: Record<string, MetricDeltaEntry[]>;
}

export interface ExperimentDiffResponse {
  experiment_id: string;
  name: string;
  config: Record<string, any> | null;
  config_diff: Record<string, { old: any; new: any }> | null;
  parent_name: string | null;
  parent_id: string | null;
  parent_config?: Record<string, any> | null;
}

export interface ExperimentResearchReportFilters {
  family: string | null;
  decision: string | null;
  status: string | null;
  limit: number;
}

export interface ExperimentResearchReportCounts {
  total: number;
  by_status: Record<string, number>;
  by_decision: Record<string, number>;
}

export interface ExperimentResearchReportMetric {
  name: string;
  direction: "min" | "max";
}

export interface ExperimentResearchReportLeaderEntry {
  rank: number;
  id: string;
  name: string;
  status: Experiment["status"];
  decision: ExperimentDecision | null;
  value: number;
  metric: string;
}

export interface ExperimentResearchReportBlock {
  id: string;
  name: string;
  family: string | null;
  status: Experiment["status"];
  decision: ExperimentDecision | null;
  decision_reason: string | null;
  decision_at: string | null;
  created_at: string;
  parent_id: string | null;
  children: ExperimentBrief[];
  task_counts: Record<string, number>;
  primary_metric: { metric: string; direction: "min" | "max"; best: number | null } | null;
  artifact_count: number;
  checkpoint_count: number;
  recent_events: ExperimentEvent[];
}

export interface ExperimentResearchReportResponse {
  filters: ExperimentResearchReportFilters;
  generated_at: string;
  counts: ExperimentResearchReportCounts;
  metric: ExperimentResearchReportMetric | null;
  leaderboard: ExperimentResearchReportLeaderEntry[];
  experiments: ExperimentResearchReportBlock[];
}

export interface ExperimentSummaryResponse {
  id: string;
  name: string;
  status: Experiment["status"];
  family: string | null;
  hypothesis: string | null;
  expected_outcome: string | null;
  fork_reason: string | null;
  goal_metric: string | null;
  goal_direction: "min" | "max" | null;
  decision: ExperimentDecision | null;
  decision_reason: string | null;
  decision_at: string | null;
  created_at: string;
  parent: ExperimentBrief | null;
  children: ExperimentBrief[];
  task_counts: Record<string, number>;
  validation: ExperimentPassFailSummary;
  best_metrics: Record<string, number>;
  primary_metric: PrimaryMetric | null;
  recommendation: ExperimentRecommendation | null;
  timeline_event_count: number;
  config: Record<string, any> | null;
  config_diff: Record<string, { old: any; new: any }> | null;
}

export const experimentsApi = {
  list: () => api.get<Experiment[]>("/experiments").then((r) => r.data),
  get: (id: string) => api.get<ExperimentDetail>(`/experiments/${id}`).then((r) => r.data),
  delete: (id: string) => api.delete(`/experiments/${id}`).then((r) => r.data),
  retryFailed: (id: string) => api.post(`/experiments/${id}/retry-failed`).then((r) => r.data),
  getTimeline: (id: string) =>
    api.get<ExperimentTimelineResponse>(`/experiments/${id}/timeline`).then((r) => r.data),
  addEvent: (id: string, payload: AddEventPayload) =>
    api.post<ExperimentEvent>(`/experiments/${id}/events`, payload).then((r) => r.data),
  addNote: (id: string, message: string, opts?: { task_id?: string; data?: Record<string, any> }) =>
    api
      .post<ExperimentEvent>(`/experiments/${id}/events`, {
        kind: "note" as ExperimentEventKind,
        message,
        task_id: opts?.task_id,
        data: opts?.data,
      })
      .then((r) => r.data),
  decide: (id: string, decision: ExperimentDecision, reason: string) =>
    api
      .patch<Experiment>(`/experiments/${id}/decision`, { decision, reason })
      .then((r) => r.data),
  getTree: () =>
    api.get<{ roots: ExperimentTreeNode[] }>("/experiments/tree").then((r) => r.data.roots),
  compare: (ids: string[]) =>
    api
      .get<ExperimentCompareResponse>("/experiments/compare", { params: { ids: ids.join(",") } })
      .then((r) => r.data),
  getSummary: (id: string) =>
    api.get<ExperimentSummaryResponse>(`/experiments/${id}/summary`).then((r) => r.data),
  getDiff: (id: string) =>
    api.get<ExperimentDiffResponse>(`/experiments/${id}/diff`).then((r) => r.data),
  getResearchBundle: (id: string) =>
    api.get<Record<string, any>>(`/experiments/${id}/research-bundle`).then((r) => r.data),
  getResearchReport: (opts: {
    family?: string;
    decision?: string;
    status?: string;
    limit?: number;
  } = {}) => {
    const params: Record<string, string> = {};
    if (opts.family) params.family = opts.family;
    if (opts.decision) params.decision = opts.decision;
    if (opts.status) params.status = opts.status;
    if (opts.limit != null) params.limit = String(opts.limit);
    return api
      .get<ExperimentResearchReportResponse>("/experiments/research-report", { params })
      .then((r) => r.data);
  },
};

// ─── Cost API ─────────────────────────────────────────────────────────────────

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

export interface TaskCost {
  gpu_hours: number;
  cost_usd: number;
  gpu_type: string;
  rate_per_hour: number;
}

export const costApi = {
  summary: (params?: { from?: string; to?: string }) =>
    api.get<CostSummary>("/metrics/cost", { params }).then((r) => r.data),
  breakdown: (params?: { from?: string; to?: string }) =>
    api.get<CostBreakdown>("/metrics/cost/breakdown", { params }).then((r) => r.data),
  taskCost: (taskId: string) =>
    api.get<{ task_id: string; cost: TaskCost | null }>(`/tasks/${taskId}/cost`).then((r) => r.data),
};

// ─── Deploy API ───────────────────────────────────────────────────────────────

export interface DeployTarget {
  name: string;
  type?: "ssh" | "slurm";
  host?: string;
  user?: string;
  jump_host?: string;
  ssh_host?: string;
  ssh_user?: string;
  partition?: string;
  gres?: string;
  mem?: string;
  time?: string;
  qos?: string;
  python_path?: string;
  default_cwd?: string;
  env_setup?: string;
  tags?: string[] | string;
  max_concurrent?: number;
}

export interface DeployResult {
  ok: boolean;
  target: string;
  step?: string;
  error?: string;
  pid?: number;
  job_id?: string;
}

export interface StubStatus {
  running: boolean;
  pid?: number;
  job_id?: string;
}

export interface TunnelStatus {
  running: boolean;
  url?: string;
  uptime_s?: number;
}

export const deployApi = {
  targets: () => api.get<DeployTarget[]>("/deploy/targets").then((r) => r.data),
  tunnelStatus: () => api.get<TunnelStatus>("/deploy/tunnel").then((r) => r.data),
  status: (name: string, jobId?: string) =>
    api.get<StubStatus>(`/deploy/stubs/${name}/status`, { params: jobId ? { job_id: jobId } : undefined }).then((r) => r.data),
  deploy: (name: string, opts?: { mem?: string; time?: string }) =>
    api.post<DeployResult>(`/deploy/stubs/${name}`, opts ?? {}).then((r) => r.data),
  restart: (name: string, opts?: { mem?: string; time?: string }) =>
    api.post<DeployResult>(`/deploy/stubs/${name}/restart`, opts ?? {}).then((r) => r.data),
  stop: (name: string, jobId?: string) =>
    api.post<DeployResult>(`/deploy/stubs/${name}/stop`, jobId ? { job_id: jobId } : {}).then((r) => r.data),
};
