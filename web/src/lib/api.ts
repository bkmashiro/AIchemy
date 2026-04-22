import axios from "axios";

const BASE = "/api";

export const api = axios.create({ baseURL: BASE });

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

export interface Task {
  id: string;
  stub_id: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  env_setup?: string;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "killed";
  exit_code?: number;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  progress?: TaskProgress;
  log_buffer: string[];
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
  status: "online" | "offline" | "stale";
  type: "slurm" | "workstation";
  slurm?: SlurmInfo;
  connected_at: string;
  last_heartbeat: string;
  max_concurrent: number;
  tasks: Task[];
  gpu_stats: GpuStats;
  remaining_walltime_s?: number;
}

export const stubsApi = {
  list: () => api.get<Stub[]>("/stubs").then((r) => r.data),
  get: (id: string) => api.get<Stub>(`/stubs/${id}`).then((r) => r.data),
  delete: (id: string) => api.delete(`/stubs/${id}`).then((r) => r.data),
  patch: (id: string, data: Partial<Stub>) => api.patch(`/stubs/${id}`, data).then((r) => r.data),
  shell: (id: string, command: string, timeout?: number) =>
    api.post(`/stubs/${id}/shell`, { command, timeout }).then((r) => r.data),
};

export const tasksApi = {
  list: (stubId: string) => api.get<Task[]>(`/stubs/${stubId}/tasks`).then((r) => r.data),
  submit: (stubId: string, data: { command: string; cwd?: string; env?: Record<string, string>; env_setup?: string }) =>
    api.post<Task>(`/stubs/${stubId}/tasks`, data).then((r) => r.data),
  action: (stubId: string, taskId: string, action: "pause" | "resume" | "kill", signal?: string) =>
    api.patch(`/stubs/${stubId}/tasks/${taskId}`, { action, signal }).then((r) => r.data),
  delete: (stubId: string, taskId: string) =>
    api.delete(`/stubs/${stubId}/tasks/${taskId}`).then((r) => r.data),
  logs: (stubId: string, taskId: string) =>
    api.get<{ task_id: string; lines: string[] }>(`/stubs/${stubId}/tasks/${taskId}/logs`).then((r) => r.data),
  listAll: () => api.get<Task[]>("/tasks").then((r) => r.data),
};

export const tokensApi = {
  list: () => api.get("/tokens").then((r) => r.data),
  create: (label?: string) => api.post("/tokens", { label }).then((r) => r.data),
  delete: (token: string) => api.delete(`/tokens/${token}`).then((r) => r.data),
};
