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
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "killed"
  | "waiting"
  | "blocked"
  | "completed_with_errors"
  | "migrating"
  | "interrupted";

export interface MigrationRecord {
  from_stub: string;
  to_stub: string;
  at_step: number;
  timestamp: string;
}

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
  // DAG
  depends_on?: string[];
  post_hooks?: string[];
  // Run dir / metrics
  run_dir?: string;
  metrics?: Record<string, number>;
  // ManagedTraining
  resumable?: boolean;
  checkpoint_path?: string;
  migration_history?: MigrationRecord[];
  // VRAM requirements
  estimated_vram_mb?: number;
  auto_estimate?: boolean;
  // Grid cell reference
  grid_id?: string;
  grid_cell_id?: string;
  // Param passing (Mode B+C)
  param_overrides?: Record<string, any>;
  base_config?: string;  // base YAML content for config generation
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

// Grid Tasks
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
  base_config?: string;       // base YAML content
  parameters: Record<string, any[]>;
  cells: GridCell[];
  status: "pending" | "running" | "completed" | "partial";
  created_at: string;
  stub_id?: string;           // optional target stub
}

// Anomaly alerts
export interface AnomalyAlert {
  id: string;
  stub_id: string;
  task_id?: string;
  type: "stall" | "gpu_idle" | "loss_nan" | "loss_spike" | "no_output";
  message: string;
  created_at: string;
  resolved: boolean;
}

// Migration suggestion
export interface MigrationSuggestion {
  id: string;
  task_id: string;
  from_stub: string;
  to_stub: string;
  reason: string;
  created_at: string;
}

// SLURM Accounts
export interface SlurmAccount {
  id: string;
  name: string;                // e.g. "ys25", "hw2025"
  ssh_target: string;          // e.g. "ys25@gpucluster2"
  qos_limit: number;           // max concurrent jobs
  partitions: string[];        // e.g. ["a40", "a30", "a100"]
  default_walltime: string;
  default_mem: string;
  stub_command: string;        // template for stub launch
}

// SLURM Auto-Queue
export interface AutoQueueConfig {
  id: string;
  account_id: string;
  target_slots: number;        // how many stubs to maintain
  idle_timeout_min: number;    // don't renew if idle this long
  check_interval_s: number;
  enabled: boolean;
}

export interface StallConfig {
  enabled: boolean;
  no_progress_timeout_min: number;
  gpu_idle_threshold_pct: number;
  gpu_idle_timeout_min: number;
}

export interface ServerState {
  stubs: Stub[];
  tokens: Token[];
  slurm_pool?: SlurmPoolConfig;
  grids?: GridTask[];
  stall_config?: StallConfig;
  slurm_accounts?: SlurmAccount[];
  autoqueue_configs?: AutoQueueConfig[];
}

// Socket event payloads
export interface RegisterPayload {
  hostname: string;
  gpu: GpuInfo;
  slurm_job_id?: string;
  slurm_account_id?: string;
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
