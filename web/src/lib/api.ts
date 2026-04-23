import axios from "axios";

const BASE = "/api";

export const api = axios.create({ baseURL: BASE });

export function setApiToken(token: string) {
  api.defaults.headers.common["Authorization"] = `Bearer ${token}`;
}

// Initialize with default token
const storedToken = localStorage.getItem("alchemy_token") || "alchemy-v2-token";
setApiToken(storedToken);

export function getStoredToken(): string {
  return localStorage.getItem("alchemy_token") || "alchemy-v2-token";
}

export function saveToken(token: string) {
  localStorage.setItem("alchemy_token", token);
  setApiToken(token);
}

export interface GpuInfo {
  name: string;
  vram_total_mb: number;
  count: number;
}

export interface GpuStatEntry {
  index: number;
  utilization_pct: number;
  memory_used_mb: number;
  memory_total_mb: number;
  temperature_c: number;
}

export interface GpuStats {
  timestamp: string;
  gpus: GpuStatEntry[];
}

export interface TaskProgress {
  step: number;
  total: number;
  loss?: number;
  metrics?: Record<string, number>;
}

export type TaskStatus =
  | "queued"
  | "waiting"
  | "dispatched"
  | "running"
  | "paused"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "killed"
  | "interrupted"
  | "blocked"
  | "migrating";

export interface Task {
  id: string;
  stub_id: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  env_setup?: string;
  status: TaskStatus;
  exit_code?: number;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  progress?: TaskProgress;
  log_buffer: string[];
  pid?: number;
  label?: string;
  retry_count?: number;
  max_retries?: number;
  retry_of?: string;
  depends_on?: string[];
  post_hooks?: string[];
  estimated_vram_mb?: number;
  checkpoint_path?: string;
  run_dir?: string;
  resumable?: boolean;
  requeued_at?: string;
  grid_id?: string;
  grid_cell_id?: string;
  param_overrides?: Record<string, any>;
  metrics?: Record<string, number>;
  // New fields (v2.1)
  priority?: number;
  should_stop?: boolean;
  timeout_s?: number;
}

export interface SlurmInfo {
  job_id: string;
  partition: string;
  walltime_remaining_s: number;
  node: string;
}

export interface Stub {
  id: string;
  name: string;
  hostname: string;
  gpu: GpuInfo;
  slurm_job_id?: string;
  slurm_account_id?: string;
  status: "online" | "offline" | "stale";
  type: "slurm" | "workstation";
  slurm?: SlurmInfo;
  connected_at: string;
  last_heartbeat: string;
  max_concurrent: number;
  tasks: Task[];
  gpu_stats: GpuStats;
  remaining_walltime_s?: number;
  auto_release?: boolean;
  idle_timeout_s?: number;
  missed_heartbeats?: number;
}

export interface Token {
  token: string;
  created_at: string;
  label?: string;
  used_by?: string;
}

export interface GridCell {
  id: string;
  grid_id: string;
  params: Record<string, any>;
  task_id?: string;
  status: "pending" | "running" | "completed" | "failed";
  metrics?: Record<string, number>;
}

export interface GridTask {
  id: string;
  name: string;
  command_template: string;
  base_config?: string;
  parameters: Record<string, any[]>;
  cells: GridCell[];
  status: "pending" | "running" | "completed" | "partial";
  created_at: string;
  stub_id?: string;
}

export interface AnomalyAlert {
  id: string;
  stub_id: string;
  task_id?: string;
  type: "stall" | "gpu_idle" | "loss_nan" | "loss_spike" | "no_output";
  message: string;
  created_at: string;
  resolved: boolean;
}

export interface SlurmAccount {
  id: string;
  name: string;
  ssh_target: string;
  qos_limit: number;
  partitions: string[];
  default_walltime: string;
  default_mem: string;
  stub_command: string;
  ssh_key_path?: string;
}

export interface NotificationConfig {
  discord_webhook_url?: string;
  enabled: boolean;
  events: string[];
}

export interface StallConfig {
  enabled: boolean;
  no_progress_timeout_min: number;
  gpu_idle_threshold_pct: number;
  gpu_idle_timeout_min: number;
}

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  variables: Record<string, any>;
  nodes: Array<{
    node_id: string;
    status: "pending" | "ready" | "running" | "completed" | "failed" | "skipped";
    task_id?: string;
    result?: any;
    started_at?: string;
    finished_at?: string;
    exit_code?: number;
    error?: string;
  }>;
  status: "running" | "completed" | "failed" | "paused" | "cancelled";
  created_at: string;
  started_at: string;
  finished_at?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  nodes: any[];
  edges: any[];
  variables?: any[];
  status: "draft" | "validating" | "ready";
  created_at: string;
}

export interface OverviewData {
  stubs: { total: number; online: number; offline: number };
  tasks: { total: number; running: number; queued: number; completed: number; failed: number };
  gpus: { total_vram_mb: number; used_vram_mb: number };
  grids: { total: number; running: number; completed: number };
  cached_at: string;
}

export const stubsApi = {
  list: () => api.get<Stub[]>("/stubs").then((r) => r.data),
  get: (id: string) => api.get<Stub>(`/stubs/${id}`).then((r) => r.data),
  delete: (id: string) => api.delete(`/stubs/${id}`).then((r) => r.data),
  purgeOffline: () => api.delete("/stubs/offline").then((r) => r.data),
  patch: (id: string, data: { name?: string; max_concurrent?: number; auto_release?: boolean; idle_timeout_s?: number }) =>
    api.patch(`/stubs/${id}`, data).then((r) => r.data),
  shell: (id: string, command: string, timeout?: number) =>
    api.post(`/stubs/${id}/shell`, { command, timeout }).then((r) => r.data),
};

export const tasksApi = {
  list: (stubId: string) => api.get<Task[]>(`/stubs/${stubId}/tasks`).then((r) => r.data),
  get: (stubId: string, taskId: string) => api.get<Task>(`/stubs/${stubId}/tasks/${taskId}`).then((r) => r.data),
  submit: (stubId: string, data: {
    command: string; cwd?: string; env?: Record<string, string>;
    env_setup?: string; resumable?: boolean; estimated_vram_mb?: number;
    max_retries?: number; run_dir?: string; depends_on?: string[];
  }) => api.post<Task>(`/stubs/${stubId}/tasks`, data).then((r) => r.data),
  action: (stubId: string, taskId: string, action: "pause" | "resume" | "kill", signal?: string) =>
    api.patch(`/stubs/${stubId}/tasks/${taskId}`, { action, signal }).then((r) => r.data),
  delete: (stubId: string, taskId: string) =>
    api.delete(`/stubs/${stubId}/tasks/${taskId}`).then((r) => r.data),
  logs: (stubId: string, taskId: string) =>
    api.get<{ task_id: string; lines: string[] }>(`/stubs/${stubId}/tasks/${taskId}/logs`).then((r) => r.data),
  listAll: () => api.get<Task[]>("/tasks").then((r) => r.data),
  getGlobal: (taskId: string) => api.get<Task>(`/tasks/${taskId}`).then((r) => r.data),
  submitGlobal: (data: {
    command: string; label?: string; cwd?: string; env?: Record<string, string>;
    env_setup?: string; estimated_vram_mb?: number; max_retries?: number;
    depends_on?: string[]; resumable?: boolean; run_dir?: string; force?: boolean;
  }) => api.post<Task>("/tasks", data).then((r) => r.data),
  retry: (taskId: string) => api.post(`/tasks/${taskId}/retry`).then((r) => r.data),
  move: (taskId: string, stub_id: string) => api.post(`/tasks/${taskId}/move`, { stub_id }).then((r) => r.data),
  batchKill: (taskIds: string[]) => api.post("/tasks/batch/kill", { task_ids: taskIds }).then((r) => r.data),
  batchRetry: (taskIds: string[]) => api.post("/tasks/batch/retry", { task_ids: taskIds }).then((r) => r.data),
  batchRequeue: (taskIds: string[]) => api.post("/tasks/batch/requeue", { task_ids: taskIds }).then((r) => r.data),
  batchDelete: (taskIds: string[]) => api.delete("/tasks/batch", { data: { task_ids: taskIds } }).then((r) => r.data),
  cleanup: (olderThanHours: number) => api.post("/cleanup", { older_than_hours: olderThanHours }).then((r) => r.data),
  stop: (stubId: string, taskId: string) => api.post(`/stubs/${stubId}/tasks/${taskId}/stop`).then((r) => r.data),
};

export const gridsApi = {
  list: () => api.get<GridTask[]>("/grids").then((r) => r.data),
  get: (id: string) => api.get<GridTask>(`/grids/${id}`).then((r) => r.data),
  create: (data: {
    name: string; command_template: string; parameters: Record<string, any[]>;
    base_config?: string; stub_id?: string; force?: boolean;
  }) => api.post<GridTask>("/grids", data).then((r) => r.data),
  retryFailed: (id: string) => api.post(`/grids/${id}/retry-failed`).then((r) => r.data),
  retryCell: (gridId: string, cellId: string) => api.post(`/grids/${gridId}/cells/${cellId}/retry`).then((r) => r.data),
  delete: (id: string) => api.delete(`/grids/${id}`).then((r) => r.data),
};

export const alertsApi = {
  list: () => api.get<AnomalyAlert[]>("/alerts").then((r) => r.data),
  resolve: (id: string) => api.patch(`/alerts/${id}/resolve`).then((r) => r.data),
};

export const tokensApi = {
  list: () => api.get<Token[]>("/tokens").then((r) => r.data),
  create: (label?: string) => api.post<Token>("/tokens", { label }).then((r) => r.data),
  delete: (token: string) => api.delete(`/tokens/${token}`).then((r) => r.data),
};

export const slurmAccountsApi = {
  list: () => api.get<SlurmAccount[]>("/slurm/accounts").then((r) => r.data),
  get: (id: string) => api.get<SlurmAccount>(`/slurm/accounts/${id}`).then((r) => r.data),
  create: (data: Omit<SlurmAccount, "id">) => api.post<SlurmAccount>("/slurm/accounts", data).then((r) => r.data),
  update: (id: string, data: Partial<SlurmAccount>) => api.patch<SlurmAccount>(`/slurm/accounts/${id}`, data).then((r) => r.data),
  delete: (id: string) => api.delete(`/slurm/accounts/${id}`).then((r) => r.data),
  getUtilization: (id: string) => api.get(`/slurm/accounts/${id}/utilization`).then((r) => r.data),
  getAutoqueue: (id: string) => api.get(`/slurm/accounts/${id}/autoqueue`).then((r) => r.data),
  createAutoqueue: (id: string, data: Record<string, any>) =>
    api.post(`/slurm/accounts/${id}/autoqueue`, data).then((r) => r.data),
};

export const notificationsApi = {
  get: () => api.get<NotificationConfig>("/notifications").then((r) => r.data),
  update: (data: Partial<NotificationConfig>) => api.patch<NotificationConfig>("/notifications", data).then((r) => r.data),
  test: () => api.post("/notifications/test").then((r) => r.data),
};

export const configApi = {
  getStall: () => api.get<StallConfig>("/config/stall").then((r) => r.data),
  updateStall: (data: Partial<StallConfig>) => api.patch<StallConfig>("/config/stall", data).then((r) => r.data),
};

export const workflowsApi = {
  list: () => api.get<Workflow[]>("/workflows").then((r) => r.data),
  get: (id: string) => api.get<Workflow>(`/workflows/${id}`).then((r) => r.data),
  getRuns: (id: string) => api.get<WorkflowRun[]>(`/workflows/${id}/runs`).then((r) => r.data),
  getRun: (runId: string) => api.get<WorkflowRun>(`/workflows/runs/${runId}`).then((r) => r.data),
  run: (id: string, variables?: Record<string, any>) =>
    api.post<WorkflowRun>(`/workflows/${id}/run`, { variables }).then((r) => r.data),
  pauseRun: (runId: string) => api.post(`/workflows/runs/${runId}/pause`).then((r) => r.data),
  resumeRun: (runId: string) => api.post(`/workflows/runs/${runId}/resume`).then((r) => r.data),
  cancelRun: (runId: string) => api.post(`/workflows/runs/${runId}/cancel`).then((r) => r.data),
  retryRun: (runId: string) => api.post(`/workflows/runs/${runId}/retry`).then((r) => r.data),
  delete: (id: string) => api.delete(`/workflows/${id}`).then((r) => r.data),
};

export const overviewApi = {
  get: () => fetch("/api/overview").then((r) => r.json()) as Promise<OverviewData>,
};

export const metricsApi = {
  getStubMetrics: (stubId: string, hours = 1) =>
    api.get(`/stubs/${stubId}/metrics`, { params: { hours } }).then((r) => r.data),
  getTaskMetrics: (taskId: string) =>
    api.get(`/tasks/${taskId}/metrics`).then((r) => r.data),
  getSummary: () =>
    api.get(`/metrics/summary`).then((r) => r.data),
};

export const auditApi = {
  list: (limit = 100) => api.get(`/audit`, { params: { limit } }).then((r) => r.data),
};

export const adminApi = {
  backup: () => api.post(`/admin/backup`).then((r) => r.data),
  listBackups: () => api.get(`/admin/backups`).then((r) => r.data),
  restore: (filename: string) => api.post(`/admin/restore`, { filename }).then((r) => r.data),
};
