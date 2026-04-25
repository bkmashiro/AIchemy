// ============================================================
// Alchemy v2.1 Types
// ============================================================

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

export interface SystemStats {
  cpu_pct: number;
  mem_used_mb: number;
  mem_total_mb: number;
  per_task?: Record<string, { cpu_pct: number; mem_mb: number; gpu_mem_mb?: number }>;
}

export type TaskStatus =
  | "pending"      // In global queue, unassigned
  | "queued"       // In stub local queue, waiting
  | "dispatched"   // Sent to stub, awaiting task.started
  | "running"      // Executing
  | "paused"       // SIGSTOP
  | "completed"    // Exit 0
  | "failed"       // Non-zero exit
  | "killed"       // User cancelled
  | "lost";        // Stub disconnected, fate unknown

export interface Task {
  // === Identity ===
  id: string;
  seq: number;
  fingerprint: string;
  name?: string;
  display_name: string;

  // === Structured Command ===
  script: string;
  args?: Record<string, string>;
  raw_args?: string;

  // === Environment ===
  cwd?: string;
  env_setup?: string;
  env?: Record<string, string>;
  python_env?: string;           // e.g. "jema", "base", "~/venv" — resolved to activate command

  // === Assembled (read-only, server builds) ===
  command: string;

  // === Resources ===
  requirements?: {
    gpu_mem_mb?: number;
    cpu_mem_mb?: number;
    gpu_type?: string[];
  };

  // === Scheduling ===
  status: TaskStatus;
  priority: number;
  stub_id?: string;
  target_tags?: string[];        // Tag-based routing (scheduler filters stubs by tag)

  // === Grid ===
  grid_id?: string;
  param_overrides?: Record<string, any>;

  // === Lifecycle ===
  created_at: string;
  started_at?: string;
  finished_at?: string;
  exit_code?: number;
  pid?: number;

  // === Progress ===
  progress?: { step: number; total: number; loss?: number; metrics?: Record<string, number> };
  log_buffer: string[];
  config_snapshot?: Record<string, any>;

  // === Metrics buffer (ephemeral, not persisted) ===
  metrics_buffer?: Record<string, Array<{ step: number; value: number; ts: string }>>;

  // === Resume & Retry ===
  run_dir?: string;
  checkpoint_path?: string;
  retry_count: number;
  max_retries: number;
  retry_of?: string;

  // === Server Signals ===
  should_stop: boolean;
  should_checkpoint: boolean;
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
  tags?: string[];                 // Stub tags for task routing
  available_envs?: Array<{ name: string; type: string; path: string; activate?: string }>;  // Python envs on this stub
  auto_renew?: boolean;            // SLURM: auto-submit new sbatch when walltime < 15min
  deploy_config?: DeployConfig;    // Persisted deploy config for auto-renew
  default_output_dir?: string;     // Base dir for server-computed run_dir
  // Internal — not serialized to API
  socket_id?: string;
}

export interface DeployConfig {
  type: "slurm" | "workstation";
  ssh_host: string;
  ssh_user?: string;
  partition?: string;
  gres?: string;
  mem?: string;
  time?: string;
  qos?: string;
  max_concurrent?: number;
  env_setup?: string;
  default_cwd?: string;
  python_path?: string;
  server_url?: string;
  token?: string;
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
  requirements?: Task["requirements"];
  target_tags?: string[];          // Propagated to all tasks in this grid
}

export interface Token {
  token: string;
  name: string;                  // Semantic name (required)
  created_at: string;
}

export interface ServerState {
  stubs: Stub[];
  tokens: Token[];
  grids: Grid[];
  seq_counter: number;
  archive?: Task[];
}

// ─── Reliable Messaging ──────────────────────────────────────────────────────

export interface ReliableMessage {
  seq: number;
  event: string;
  payload: any;
  ts: number;
}

// ─── Socket Payloads ─────────────────────────────────────────────────────────

export interface ResumePayload {
  hostname: string;
  gpu: GpuInfo;
  slurm_job_id?: string;
  max_concurrent: number;
  token: string;
  env_setup?: string;
  default_cwd?: string;
  tags?: string[];
  running_tasks: Array<{ task_id: string; pid: number; step?: number; status: string }>;
  local_queue: string[];
  dead_tasks?: Array<{ task_id: string; exit_code: number }>;
  available_envs?: Array<{ name: string; type: string; path: string }>;
}

export interface HeartbeatPayload {
  timestamp: string;
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

export interface TaskConfigPayload {
  task_id: string;
  config: Record<string, any>;
}

export interface TaskCheckpointPayload {
  task_id: string;
  path: string;
}

export interface PreflightFailPayload {
  task_id: string;
  errors: string[];
}

export interface TaskResourcePayload {
  task_id: string;
  gpu_mem_mb: number;
  cpu_mem_mb: number;
  gpu_util_pct: number;
}

export interface TaskMetricsPayload {
  task_id: string;
  metrics: Record<string, number>;
  step: number;
}
