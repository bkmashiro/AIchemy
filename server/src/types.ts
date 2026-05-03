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
  | "lost"         // Stub disconnected, fate unknown
  | "blocked"      // Waiting for dependency tasks to complete
  | "cancelled";   // Cancelled because a dependency failed

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
  env_overrides?: Record<string, string>;  // Per-task env overrides, merged by stub after default_env
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

  // === DAG / Experiment ===
  depends_on?: string[];               // Prerequisite task IDs
  ref?: string;                        // Reference name within an experiment (for DAG wiring)
  exports?: Record<string, any>;       // Runtime key-value outputs
  args_template?: Record<string, string>; // Template strings resolved at promotion time
  experiment_id?: string;              // Owning experiment ID
  outputs?: string[];                  // Declared output file paths for artifact rollback

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
  resolved_config?: Record<string, any>;    // Experiment config merged with task overrides

  // === Lifecycle Phase ===
  phase?: string;

  // === Auto-eval ===
  auto_eval?: { script: string; trigger: string; n?: number };
  parent_task_id?: string;
  checkpoint_count?: number;

  // === Eval Metrics ===
  eval_metrics?: Record<string, number>;

  // === Metrics buffer (ephemeral, not persisted) ===
  metrics_buffer?: Record<string, Array<{ step: number; value: number; ts: string }>>;

  // === Submission ===
  submitted_by?: string;

  // === Error ===
  error_message?: string;

  // === Resume & Retry ===
  run_dir?: string;
  checkpoint_path?: string;
  retry_count: number;
  max_retries: number;
  retry_of?: string;
  auto_retry_on?: number[];       // Exit codes that trigger automatic retry (e.g. [-9, -15])

  // === Death classification (B1) ===
  death_cause?: string;           // 'success' | 'code_error' | 'oom' | 'walltime' | 'preempt' | 'lost'
  has_checkpoint?: boolean;

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
  user?: string;                    // OS user ($USER) reported by stub
  auto_renew?: boolean;            // SLURM: auto-submit new sbatch when walltime < 15min
  deploy_config?: DeployConfig;    // Persisted deploy config for auto-renew
  default_output_dir?: string;     // Base dir for server-computed run_dir
  first_seen?: string;              // ISO timestamp: first time this stub connected
  last_seen?: string;               // ISO timestamp: last known activity
  slurm_constraints?: {            // SLURM resource allocation (B3)
    mem_mb?: number;
    time_min?: number;
    gpus?: number;
    cpus?: number;
  };
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

// ─── Task Spec (DAG pipeline definition) ────────────────────────────────────

export interface TaskSpec {
  ref: string;
  script: string;
  raw_args?: string;
  args?: Record<string, string>;
  args_template?: Record<string, string>;
  depends_on?: string[];  // ref names within experiment
  cwd?: string;
  python_env?: string;
  env_setup?: string;
  env?: Record<string, string>;
  env_overrides?: Record<string, string>;
  requirements?: Task["requirements"];
  target_tags?: string[];
  max_retries?: number;
  priority?: number;
  outputs?: string[];     // Declared output file paths for artifact rollback
  config_overrides?: Record<string, any>;   // Per-task config overrides (dot-path → value)
  resolved_config?: Record<string, any>;    // Merged experiment config + task overrides (computed by SDK)
}

// ─── Experiment ─────────────────────────────────────────────────────────────

export interface CriterionResult {
  value: number;
  threshold: string;    // e.g. "> 0.3"
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
  criteria: Record<string, string>;    // "metric_name": "op value"
  grid_id: string;
  status: "running" | "passed" | "partial" | "failed";
  results: Record<string, TaskValidation>;  // taskId → validation
  created_at: string;
  task_specs?: TaskSpec[];                  // Original DAG spec
  task_refs?: Record<string, string>;      // ref name → task_id mapping
  // Config + Lineage
  config?: Record<string, any>;                           // Full config snapshot
  config_diff?: Record<string, { old: any; new: any }>;   // Diff against parent
  parent_name?: string;                                    // Fork source experiment name
  parent_id?: string;                                      // Fork source experiment ID (best-effort)
  // Git tracking
  git_tracking?: boolean;                                  // Enable git manifest tracking
  git_repo_path?: string;                                  // Absolute path to git repo on stub
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
  experiments: Experiment[];
  seq_counter: number;
  archive?: Task[];
  global_queue?: Task[];
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
  stub_id?: string;  // Client-computed stub ID (aligned with server formula). If provided, server validates and uses it.
  hostname: string;
  gpu: GpuInfo;
  slurm_job_id?: string;
  max_concurrent: number;
  token: string;
  env_setup?: string;
  default_cwd?: string;
  tags?: string[];
  user?: string;
  running_tasks: Array<{ task_id: string; pid: number; step?: number; status: string }>;
  local_queue: string[];
  dead_tasks?: Array<{ task_id: string; exit_code: number }>;
  available_envs?: Array<{ name: string; type: string; path: string }>;
  slurm_constraints?: { mem_mb?: number; time_min?: number; gpus?: number; cpus?: number };
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
  death_cause?: string;
  has_checkpoint?: boolean;
}

export interface TaskFailedPayload {
  task_id: string;
  exit_code: number;
  error?: string;
  death_cause?: string;
  has_checkpoint?: boolean;
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

export interface TaskPhasePayload {
  task_id: string;
  phase: string;
}

// ─── Exec (Spec 3) ───────────────────────────────────────────────────────────

export interface ExecRequest {
  /** Shell command to run on the stub. */
  command: string;
  /** Timeout in milliseconds. Server default: 30000. */
  timeout?: number;
}

export interface ExecResponse {
  stdout: string;
  stderr: string;
  exit_code: number;
  /** True if stdout or stderr were truncated to 4KB. */
  truncated: boolean;
}

export interface ExecRequestPayload {
  /** Unique request ID for correlation. */
  request_id: string;
  command: string;
  /** Timeout in seconds passed to stub subprocess. */
  timeout_s: number;
}

export interface ExecResponsePayload {
  request_id: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  truncated: boolean;
  /** Set if exec was rejected (e.g. --allow-exec not set). */
  error?: string;
}
