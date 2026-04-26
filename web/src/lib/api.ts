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

  // Server signals
  should_stop: boolean;
  should_checkpoint: boolean;
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
  list: (params?: { page?: number; limit?: number; status?: string }) =>
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
  get: () =>
    fetch("/api/overview", { headers: { Authorization: `Bearer ${getStoredToken()}` } }).then(
      (r) => r.json()
    ) as Promise<OverviewData>,
};

export const metricsApi = {
  getStubMetrics: (stubId: string, hours = 1) =>
    api.get(`/stubs/${stubId}/metrics`, { params: { hours } }).then((r) => r.data),
  getTaskMetrics: (taskId: string) => api.get(`/tasks/${taskId}/metrics`).then((r) => r.data),
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
