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
  | "assigned"     // Owned by stub (queued locally or dispatched), awaiting task.started
  | "running"      // Executing
  | "paused"       // SIGSTOP
  | "completed"    // Exit 0
  | "failed"       // Non-zero exit
  | "cancelled"    // User cancelled or dependency failed
  | "blocked";     // Waiting for dependency tasks to complete

export type WebhookEvent = "task.completed" | "task.failed" | "task.cancelled" | "task.terminal";

export interface WebhookSubscription {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  secret?: string;
  created_at: string;
  updated_at: string;
}

export interface WebhookDelivery {
  id: string;
  delivery_id: string;
  subscription_id: string;
  subscription_name: string;
  event: WebhookEvent;
  task_id?: string;
  status: "success" | "failed";
  http_status?: number;
  error?: string;
  delivered_at: string;
}

export type WebhookOutboxStatus = "pending" | "in_flight" | "succeeded" | "exhausted";

export interface WebhookDeliveryOutbox {
  id: string;
  delivery_id: string;
  subscription_id: string;
  event: WebhookEvent;
  task_id: string;
  previous_status: TaskStatus;
  status: WebhookOutboxStatus;
  attempt_count: number;
  max_attempts: number;
  next_retry_at: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export interface TaskMark {
  task_id: string;
  actor: string;
  pinned: boolean;
  watched: boolean;
  read_at?: string;
  acked_at?: string;
  note?: string;
  updated_at: string;
}

export interface SubmissionLintIssue {
  code: string;
  severity: "warning" | "error";
  message: string;
  ref?: string;
  field?: string;
  script?: string;
  priority?: number;
  path?: string;
  refs?: string[];
}

export interface Task {
  // === Identity ===
  id: string;
  seq: number;
  fingerprint: string;
  name?: string;
  display_name: string;

  // === Structured Command ===
  script: string;
  argv?: string[];                 // Structured argv appended after script; preferred over raw_args for new tasks
  args?: Record<string, string> | string;
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
  target_stub_id?: string;       // Hard-pin task to a specific stub by ID
  target_tags?: string[];        // Tag-based routing (scheduler filters stubs by tag)
  dispatch_attempts?: number;    // Number of failed dispatch attempts (for retry logic)

  // === DAG / Experiment ===
  depends_on?: string[];               // Prerequisite task IDs
  ref?: string;                        // Reference name within an experiment (for DAG wiring)
  exports?: Record<string, any>;       // Runtime key-value outputs
  args_template?: Record<string, string>; // Template strings resolved at promotion time
  ref_template?: string;                  // SDK template ref before grid expansion
  param_point?: Record<string, any>;       // SDK grid point for this expanded task
  experiment_id?: string;              // Owning experiment ID
  outputs?: string[];                  // Declared output file paths for artifact rollback
  metric_schema?: Record<string, string>; // SDK-declared metric directions
  result_schema?: Record<string, string>; // SDK-declared final result schema

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
  submission_warnings?: SubmissionLintIssue[];

  // === Error ===
  error_message?: string;

  // === Resume & Retry ===
  run_dir?: string;
  checkpoint_path?: string;
  retry_count: number;
  max_retries: number;
  retry_of?: string;
  auto_retry_on?: number[];       // Exit codes that trigger automatic retry (e.g. [-9, -15])
  attempt?: number;               // Surgical replacement attempt number for this logical task ref
  replaces_task_id?: string;      // Previous attempt replaced by this task
  replaced_by_task_id?: string;   // Newer canonical attempt that supersedes this task

  // === Death classification (B1) ===
  death_cause?: string;           // 'success' | 'code_error' | 'oom' | 'walltime' | 'preempt' | 'lost'
  has_checkpoint?: boolean;

  // === Server Signals ===
  // should_stop is a cooperative SDK signal. It must not imply process kill.
  should_stop: boolean;
  should_checkpoint: boolean;
  // kill_requested is server-internal intent for destructive task.kill chains.
  kill_requested?: boolean;

  // === Disconnect tracking (not a status change) ===
  disconnected_at?: string;   // ISO timestamp: when stub went offline (task stays "running")
  stub_offline?: boolean;     // true while stub is disconnected
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
  // Deploy config inherited defaults (set at connect time from deploy-config.yaml)
  deploy_python_path?: string;
  deploy_default_cwd?: string;
  deploy_env_setup?: string;
  deploy_default_env?: Record<string, string>;

  // Internal — not serialized to API
  socket_id?: string;
  released?: boolean;              // Set when user explicitly releases stub; blocks auto-reconnect
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
  default_output_dir?: string;
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
  argv?: string[];
  raw_args?: string;
  args?: Record<string, string> | string;
  args_template?: Record<string, string>;
  depends_on?: string[];  // ref names within experiment
  cwd?: string;
  python_env?: string;
  env_setup?: string;
  env?: Record<string, string>;
  env_overrides?: Record<string, string>;
  requirements?: Task["requirements"];
  target_tags?: string[];
  target_stub_id?: string;
  max_retries?: number;
  priority?: number;
  outputs?: string[];     // Declared output file paths for artifact rollback
  metric_schema?: Record<string, string>; // SDK-declared metric directions
  result_schema?: Record<string, string>; // SDK-declared final result schema
  ref_template?: string;                  // SDK template ref before grid expansion
  param_point?: Record<string, any>;      // SDK grid point for this expanded task
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

export type ExperimentDecision = "keep" | "try_more" | "discard" | "drop" | "rerun" | "fork";

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

export interface Experiment {
  id: string;
  code_id?: string;
  name: string;
  description?: string;
  criteria: Record<string, string>;    // "metric_name": "op value"
  grid_id: string;
  status: "running" | "passed" | "partial" | "failed";
  results: Record<string, TaskValidation>;  // taskId → validation
  created_at: string;
  task_specs?: TaskSpec[];                  // Original DAG spec
  task_refs?: Record<string, string>;      // ref name → task_id mapping
  submission_warnings?: SubmissionLintIssue[];
  // Config + Lineage
  config?: Record<string, any>;                           // Full config snapshot
  config_diff?: Record<string, { old: any; new: any }>;   // Diff against parent
  parent_name?: string;                                    // Fork source experiment name
  parent_id?: string;                                      // Fork source experiment ID (write-time frozen)
  // Research intent
  family?: string;
  hypothesis?: string;
  expected_outcome?: string;
  fork_reason?: string;
  // Goal metric (Phase 2 lineage): when set, drives "best/primary" reporting.
  goal_metric?: string;
  goal_direction?: "min" | "max";
  // Decision metadata (undefined = never decided)
  decision?: ExperimentDecision;
  decision_reason?: string;
  decision_at?: string;
  // Git tracking
  git_tracking?: boolean;                                  // Enable git manifest tracking
  git_repo_path?: string;                                  // Absolute path to git repo on stub
  // SDK-first spec fields
  storage?: Record<string, any>;
  sdk_spec?: Record<string, any>;
  param_space?: Record<string, any[]>;
  param_points?: Record<string, any>[];
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
  stub_version?: string;  // Alchemy stub package version; must match server version.
  hostname: string;
  gpu: GpuInfo;
  slurm_job_id?: string;
  cuda_visible_devices?: string;  // CUDA_VISIBLE_DEVICES value; workstation identity discriminator
  max_concurrent: number;
  token: string;
  env_setup?: string;
  default_cwd?: string;
  default_output_dir?: string;
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

// ─── Deployment Types ────────────────────────────────────────────────────────

export interface StubTarget {
  name: string;
  // SSH/workstation fields
  type?: "ssh" | "slurm";
  host?: string;        // SSH: target host; optional for slurm
  user?: string;
  jump_host?: string;
  remote_dir: string;
  python_path: string;
  max_concurrent: number;
  tags?: string;
  default_cwd?: string;
  default_output_dir?: string;
  env_setup?: string;
  idle_timeout?: number;
  default_env?: Record<string, string>;
  allow_exec?: boolean;
  // SLURM-specific fields
  ssh_host?: string;    // SLURM: host to run sbatch from
  ssh_user?: string;    // SLURM: user for sbatch SSH
  partition?: string;
  gres?: string;
  mem?: string;
  time?: string;
  qos?: string;
}

export interface TunnelConfig {
  enabled: boolean;
  token: string;
  cloudflared: string;
  restart_on_failure: boolean;
}

export interface DeployFileConfig {
  tunnel?: TunnelConfig;
  ssh?: { key_path: string };
  stub_package?: { local_path: string; sdk_path?: string };
  stubs: StubTarget[];
}

export interface DeployResult {
  ok: boolean;
  target: string;
  step?: string;
  error?: string;
  pid?: number;
  job_id?: string;    // SLURM: submitted job ID
}
