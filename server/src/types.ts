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
  pid?: number;
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
  token: string;
  socket_id?: string;
  missed_heartbeats: number;
  remaining_walltime_s?: number;
}

export interface Token {
  token: string;
  created_at: string;
  label?: string;
  used_by?: string; // stub id
}

export interface SlurmPoolConfig {
  enabled: boolean;
  ssh_target: string;
  submit_script?: string;
  max_concurrent_jobs: number;
  partitions: string[];
  default_walltime: string;
  default_mem: string;
  stub_command: string;
  min_queue_ahead: number;
}

export interface ServerState {
  stubs: Stub[];
  tokens: Token[];
  slurm_pool?: SlurmPoolConfig;
}

// Socket event payloads
export interface RegisterPayload {
  hostname: string;
  gpu: GpuInfo;
  slurm_job_id?: string;
  max_concurrent: number;
  token: string;
  type?: "slurm" | "workstation";
  slurm?: SlurmInfo;
  remaining_walltime_s?: number;
}

export interface HeartbeatPayload {
  timestamp: string;
  remaining_walltime_s?: number;
}

export interface TaskStartedPayload {
  task_id: string;
  pid: number;
}

export interface TaskProgressPayload {
  task_id: string;
  step: number;
  total: number;
  loss?: number;
  metrics?: Record<string, number>;
}

export interface TaskLogPayload {
  task_id: string;
  lines: string[];
}

export interface TaskCompletedPayload {
  task_id: string;
  exit_code: number;
}

export interface TaskFailedPayload {
  task_id: string;
  exit_code: number;
  error?: string;
}

export interface ShellResultPayload {
  id: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
}
