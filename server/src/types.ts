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
  | "interrupted"
  | "dispatched";

export interface MigrationRecord {
  from_stub: string;
  to_stub: string;
  at_step: number;
  timestamp: string;
}

export interface Task {
  id: string;
  stub_id: string;  // empty string "" when task is in global queue (no stub assigned yet)
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
  requeued_at?: string;  // timestamp when auto-requeued on reconnect
  // Retry
  retry_of?: string;     // original task ID this is a retry of
  retry_count?: number;  // how many times this task has been auto-retried
  max_retries?: number;  // max auto-retries (0 = disabled)
  // Priority queue (0-9, lower = higher priority, default 5)
  priority?: number;
  // should_stop flag: set by server to signal SDK tasks to stop gracefully
  should_stop?: boolean;
  // Timeout enforcement
  timeout_s?: number;    // if set, kill task after this many seconds
  // Failure classification (set by stub via error_classifier)
  failure_reason?: {
    reason: string;
    detail?: string;
  };
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
  // Server-side controls
  auto_release?: boolean;        // shut down stub when all tasks are done
  idle_timeout_s?: number;       // server-side idle timeout override (seconds)
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
  ssh_key_path?: string;       // path to SSH private key
}

// SLURM Auto-Queue
export interface AutoQueueConfig {
  id: string;
  account_id: string;
  max_running: number;         // a: target active/running stubs
  max_pending: number;         // b: target pending/queued SLURM jobs
  qos_running_limit: number;   // c: QOS max concurrent running jobs
  qos_pending_limit: number;   // d: QOS max pending jobs allowed
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

export interface NotificationConfig {
  discord_webhook_url?: string;
  enabled: boolean;
  events: string[];  // "task.completed", "task.failed", "workflow.completed", "workflow.failed", "node.failed"
}

export interface ServerState {
  stubs: Stub[];
  tokens: Token[];
  global_queue?: Task[];      // tasks not yet assigned to any stub
  slurm_pool?: SlurmPoolConfig;
  grids?: GridTask[];
  stall_config?: StallConfig;
  slurm_accounts?: SlurmAccount[];
  autoqueue_configs?: AutoQueueConfig[];
  workflows?: Workflow[];
  workflow_runs?: WorkflowRun[];
  notification_config?: NotificationConfig;
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
  failure_reason?: {
    reason: string;
    detail?: string;
  };
}

export interface ShellResultPayload {
  id: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
}

// Workflow Engine
export type PortType = "dir" | "file" | "checkpoint" | "metrics" | "params" | "bool" | "string" | "number" | "any";

export interface Port {
  id: string;
  name: string;
  type: PortType;
  required: boolean;
  value?: any;
}

export type WorkflowNodeType = "compute" | "copy" | "filter" | "branch" | "merge" | "transform" | "checkpoint_select";

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  config: Record<string, any>;  // may include timeout_s for compute nodes
  position: { x: number; y: number };
  inputs: Port[];
  outputs: Port[];
}

export interface WorkflowEdge {
  id: string;
  source_node: string;
  source_port: string;
  target_node: string;
  target_port: string;
}

export interface WorkflowVariable {
  name: string;
  type: "string" | "number" | "bool" | "path";
  description?: string;
  default?: any;
  required?: boolean;
}

export type WorkflowStatus = "draft" | "validating" | "ready";

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  variables?: WorkflowVariable[];
  status: WorkflowStatus;
  created_at: string;
}

// WorkflowRun — execution instance of a Workflow template
export interface WorkflowRunNode {
  node_id: string;
  status: "pending" | "ready" | "running" | "completed" | "failed" | "skipped";
  task_id?: string;
  result?: any;
  started_at?: string;
  finished_at?: string;
  exit_code?: number;
  error?: string;
  log_buffer?: string[];
}

export type WorkflowRunStatus = "running" | "completed" | "failed" | "paused" | "cancelled";

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  workflow_snapshot: Workflow;  // snapshot of workflow definition at run creation time
  variables: Record<string, any>;
  nodes: WorkflowRunNode[];
  status: WorkflowRunStatus;
  created_at: string;
  started_at: string;
  finished_at?: string;
}
