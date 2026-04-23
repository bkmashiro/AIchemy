import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { Stub, Task, Token, ServerState, SlurmPoolConfig, GridTask, GridCell, AnomalyAlert, MigrationSuggestion, StallConfig, SlurmAccount, AutoQueueConfig, Workflow, WorkflowRun, NotificationConfig } from "../types";
import { resetAuditLog } from "../audit";

const STATE_FILE = process.env.STATE_FILE || path.join(process.cwd(), "state.json");
const SNAPSHOT_INTERVAL = 60_000;
const BACKUP_INTERVAL = 30 * 60_000; // 30 minutes
const BACKUP_KEEP_COUNT = 48;        // 24 hours at 30-min intervals
export const BACKUPS_DIR = path.join(path.dirname(STATE_FILE), "backups");

class Store {
  private stubs: Map<string, Stub> = new Map();
  private tokens: Map<string, Token> = new Map();
  private globalQueue: Task[] = [];  // tasks not assigned to any stub yet
  private grids: Map<string, GridTask> = new Map();
  private alerts: Map<string, AnomalyAlert> = new Map();
  private migrationSuggestions: Map<string, MigrationSuggestion> = new Map();
  private slurmAccounts: Map<string, SlurmAccount> = new Map();
  private autoqueueConfigs: Map<string, AutoQueueConfig> = new Map();
  private workflows: Map<string, Workflow> = new Map();
  private workflowRuns: Map<string, WorkflowRun> = new Map();
  private slurmPool: SlurmPoolConfig = {
    enabled: false,
    ssh_target: "gpucluster2",
    max_concurrent_jobs: 3,
    partitions: ["a40", "a30", "a100"],
    default_walltime: "72:00:00",
    default_mem: "64G",
    stub_command: "python -m alchemy_stub",
    min_queue_ahead: 1,
  };
  private stallConfig: StallConfig = {
    enabled: true,
    no_progress_timeout_min: 30,
    gpu_idle_threshold_pct: 5,
    gpu_idle_timeout_min: 10,
  };
  private notificationConfig: NotificationConfig = {
    enabled: false,
    events: ["task.completed", "task.failed", "workflow.completed", "workflow.failed", "node.failed"],
  };

  constructor() {
    this.load();
    setInterval(() => this.saveAsync(), SNAPSHOT_INTERVAL);
    // Auto-backup every 30 minutes
    setInterval(() => this.autoBackup(), BACKUP_INTERVAL);
  }

  private async autoBackup(): Promise<void> {
    try {
      // Save current state first, then back it up
      await this.saveAsync();
      const { backupState, pruneBackups } = await import("./backup");
      await backupState(STATE_FILE, BACKUPS_DIR);
      await pruneBackups(BACKUPS_DIR, BACKUP_KEEP_COUNT);
      console.log("[store] Auto-backup completed");
    } catch (err) {
      console.error("[store] Auto-backup failed:", err);
    }
  }

  getStateFile(): string {
    return STATE_FILE;
  }

  getBackupsDir(): string {
    return BACKUPS_DIR;
  }

  // Stubs
  getStub(id: string): Stub | undefined {
    return this.stubs.get(id);
  }

  getStubByToken(token: string): Stub | undefined {
    for (const stub of this.stubs.values()) {
      if (stub.token === token) return stub;
    }
    return undefined;
  }

  getStubByHostnameAndToken(hostname: string, token: string, slurm_job_id?: string): Stub | undefined {
    for (const stub of this.stubs.values()) {
      if (stub.token !== token || stub.hostname !== hostname) continue;
      // For SLURM stubs, match by job ID to allow multiple stubs per host
      if (slurm_job_id) {
        if (stub.slurm_job_id === slurm_job_id) return stub;
      } else if (!stub.slurm_job_id) {
        return stub;
      }
    }
    return undefined;
  }

  getAllStubs(): Stub[] {
    return Array.from(this.stubs.values());
  }

  setStub(stub: Stub): void {
    this.stubs.set(stub.id, stub);
  }

  deleteStub(id: string): void {
    this.stubs.delete(id);
  }

  // Tokens
  getToken(token: string): Token | undefined {
    return this.tokens.get(token);
  }

  getAllTokens(): Token[] {
    return Array.from(this.tokens.values());
  }

  addToken(token: Token): void {
    this.tokens.set(token.token, token);
  }

  deleteToken(token: string): void {
    this.tokens.delete(token);
  }

  // SLURM Pool
  getSlurmPool(): SlurmPoolConfig {
    return this.slurmPool;
  }

  setSlurmPool(config: Partial<SlurmPoolConfig>): void {
    this.slurmPool = { ...this.slurmPool, ...config };
  }

  // Tasks helpers
  getTask(stubId: string, taskId: string): Task | undefined {
    const stub = this.stubs.get(stubId);
    if (!stub) return undefined;
    return stub.tasks.find((t) => t.id === taskId);
  }

  getAllTasks(): Task[] {
    const tasks: Task[] = [];
    for (const stub of this.stubs.values()) {
      tasks.push(...stub.tasks);
    }
    // Include global queue tasks
    tasks.push(...this.globalQueue);
    return tasks;
  }

  // Global Queue
  getGlobalQueue(): Task[] {
    return this.globalQueue;
  }

  addToGlobalQueue(task: Task): void {
    task.stub_id = "";
    this.globalQueue.push(task);
    // Maintain sorted order: by priority (lower number = higher priority, default 5), then by created_at
    this.globalQueue.sort((a, b) => {
      const pa = a.priority ?? 5;
      const pb = b.priority ?? 5;
      if (pa !== pb) return pa - pb;
      return a.created_at.localeCompare(b.created_at);
    });
  }

  /** Remove a task from the global queue by id. Returns the task if found. */
  removeFromGlobalQueue(taskId: string): Task | undefined {
    const idx = this.globalQueue.findIndex((t) => t.id === taskId);
    if (idx === -1) return undefined;
    const [task] = this.globalQueue.splice(idx, 1);
    return task;
  }

  /** Update a task in the global queue. */
  updateGlobalQueueTask(taskId: string, update: Partial<Task>): Task | undefined {
    const idx = this.globalQueue.findIndex((t) => t.id === taskId);
    if (idx === -1) return undefined;
    this.globalQueue[idx] = { ...this.globalQueue[idx], ...update };
    return this.globalQueue[idx];
  }

  /** Find a task by id across all stubs AND the global queue. */
  findTask(taskId: string): { task: Task; stubId: string | null } | undefined {
    // Search stubs first
    for (const stub of this.stubs.values()) {
      const task = stub.tasks.find((t) => t.id === taskId);
      if (task) return { task, stubId: stub.id };
    }
    // Search global queue
    const gq = this.globalQueue.find((t) => t.id === taskId);
    if (gq) return { task: gq, stubId: null };
    return undefined;
  }

  updateTask(stubId: string, taskId: string, update: Partial<Task>): Task | undefined {
    const stub = this.stubs.get(stubId);
    if (!stub) return undefined;
    const idx = stub.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return undefined;
    stub.tasks[idx] = { ...stub.tasks[idx], ...update };
    return stub.tasks[idx];
  }

  // Grid Tasks
  getGrid(id: string): GridTask | undefined {
    return this.grids.get(id);
  }

  getAllGrids(): GridTask[] {
    return Array.from(this.grids.values());
  }

  setGrid(grid: GridTask): void {
    this.grids.set(grid.id, grid);
  }

  deleteGrid(id: string): void {
    this.grids.delete(id);
  }

  updateGridCell(gridId: string, cellId: string, update: Partial<GridCell>): GridCell | undefined {
    const grid = this.grids.get(gridId);
    if (!grid) return undefined;
    const idx = grid.cells.findIndex((c) => c.id === cellId);
    if (idx === -1) return undefined;
    grid.cells[idx] = { ...grid.cells[idx], ...update };
    // Update grid status
    const statuses = grid.cells.map((c) => c.status);
    if (statuses.every((s) => s === "completed")) grid.status = "completed";
    else if (statuses.some((s) => s === "running")) grid.status = "running";
    else if (statuses.some((s) => s === "failed") && statuses.every((s) => s === "failed" || s === "completed")) grid.status = "partial";
    else if (statuses.some((s) => s === "failed")) grid.status = "partial";
    else if (statuses.some((s) => s === "completed")) grid.status = "running";
    this.grids.set(gridId, grid);
    return grid.cells[idx];
  }

  // Alerts
  addAlert(alert: AnomalyAlert): void {
    this.alerts.set(alert.id, alert);
  }

  getAlert(id: string): AnomalyAlert | undefined {
    return this.alerts.get(id);
  }

  getAllAlerts(): AnomalyAlert[] {
    return Array.from(this.alerts.values());
  }

  resolveAlert(id: string): void {
    const alert = this.alerts.get(id);
    if (alert) {
      alert.resolved = true;
      this.alerts.set(id, alert);
    }
  }

  // Migration suggestions
  addMigrationSuggestion(s: MigrationSuggestion): void {
    this.migrationSuggestions.set(s.id, s);
  }

  getAllMigrationSuggestions(): MigrationSuggestion[] {
    return Array.from(this.migrationSuggestions.values());
  }

  deleteMigrationSuggestion(id: string): void {
    this.migrationSuggestions.delete(id);
  }

  // SLURM Accounts
  getSlurmAccount(id: string): SlurmAccount | undefined {
    return this.slurmAccounts.get(id);
  }

  getAllSlurmAccounts(): SlurmAccount[] {
    return Array.from(this.slurmAccounts.values());
  }

  setSlurmAccount(account: SlurmAccount): void {
    this.slurmAccounts.set(account.id, account);
  }

  deleteSlurmAccount(id: string): void {
    this.slurmAccounts.delete(id);
  }

  // Auto-Queue Configs
  getAutoQueueConfig(id: string): AutoQueueConfig | undefined {
    return this.autoqueueConfigs.get(id);
  }

  getAllAutoQueueConfigs(): AutoQueueConfig[] {
    return Array.from(this.autoqueueConfigs.values());
  }

  setAutoQueueConfig(config: AutoQueueConfig): void {
    this.autoqueueConfigs.set(config.id, config);
  }

  deleteAutoQueueConfig(id: string): void {
    this.autoqueueConfigs.delete(id);
  }

  // Workflows
  getWorkflow(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  getWorkflows(): Workflow[] {
    return Array.from(this.workflows.values());
  }

  setWorkflow(w: Workflow): void {
    this.workflows.set(w.id, w);
  }

  deleteWorkflow(id: string): void {
    this.workflows.delete(id);
  }

  // Workflow Runs
  getWorkflowRun(id: string): WorkflowRun | undefined {
    return this.workflowRuns.get(id);
  }

  getWorkflowRuns(workflow_id?: string): WorkflowRun[] {
    const all = Array.from(this.workflowRuns.values());
    if (workflow_id) return all.filter((r) => r.workflow_id === workflow_id);
    return all;
  }

  setWorkflowRun(run: WorkflowRun): void {
    this.workflowRuns.set(run.id, run);
  }

  deleteWorkflowRun(id: string): void {
    this.workflowRuns.delete(id);
  }

  // Store reset (for testing)
  reset(): void {
    this.stubs.clear();
    this.tokens.clear();
    this.globalQueue = [];
    this.grids.clear();
    this.alerts.clear();
    this.migrationSuggestions.clear();
    this.slurmAccounts.clear();
    this.autoqueueConfigs.clear();
    this.workflows.clear();
    this.workflowRuns.clear();
    // Reset audit log
    resetAuditLog();
  }

  // Stall config
  getStallConfig(): StallConfig {
    return this.stallConfig;
  }

  setStallConfig(cfg: Partial<StallConfig>): void {
    this.stallConfig = { ...this.stallConfig, ...cfg };
  }

  // Notification config
  getNotificationConfig(): NotificationConfig {
    return this.notificationConfig;
  }

  setNotificationConfig(cfg: Partial<NotificationConfig>): void {
    this.notificationConfig = { ...this.notificationConfig, ...cfg };
  }

  // Persistence
  private serializeState(): string {
    const state: ServerState = {
      stubs: Array.from(this.stubs.values()).map((s) => ({
        ...s,
        socket_id: undefined, // don't persist socket ids
        status: s.status === "online" ? "offline" : s.status,
      })),
      tokens: Array.from(this.tokens.values()),
      global_queue: this.globalQueue,
      slurm_pool: this.slurmPool,
      grids: Array.from(this.grids.values()),
      stall_config: this.stallConfig,
      slurm_accounts: Array.from(this.slurmAccounts.values()),
      autoqueue_configs: Array.from(this.autoqueueConfigs.values()),
      workflows: Array.from(this.workflows.values()),
      workflow_runs: Array.from(this.workflowRuns.values()),
      notification_config: this.notificationConfig,
    };
    return JSON.stringify(state, null, 2);
  }

  /** Sync save — used by shutdown signal handlers only. */
  save(): void {
    try {
      fs.writeFileSync(STATE_FILE, this.serializeState());
    } catch (err) {
      console.error("[store] Failed to save state:", err);
    }
  }

  /** Async save — atomic write via temp file + rename. */
  async saveAsync(): Promise<void> {
    try {
      const data = this.serializeState();
      const dir = path.dirname(STATE_FILE);
      const tmpFile = path.join(dir, `.state.tmp.${process.pid}`);
      await fsp.writeFile(tmpFile, data);
      await fsp.rename(tmpFile, STATE_FILE);
    } catch (err) {
      console.error("[store] Failed to save state:", err);
    }
  }

  load(): void {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      const state: ServerState = JSON.parse(raw);

      for (const stub of state.stubs || []) {
        stub.missed_heartbeats = 0;
        stub.status = "offline";
        this.stubs.set(stub.id, stub);
      }

      for (const token of state.tokens || []) {
        this.tokens.set(token.token, token);
      }

      if (state.global_queue) {
        this.globalQueue = state.global_queue;
      }

      if (state.slurm_pool) {
        this.slurmPool = state.slurm_pool;
      }

      for (const grid of state.grids || []) {
        this.grids.set(grid.id, grid);
      }

      if (state.stall_config) {
        this.stallConfig = state.stall_config;
      }

      for (const account of state.slurm_accounts || []) {
        this.slurmAccounts.set(account.id, account);
      }

      for (const config of state.autoqueue_configs || []) {
        this.autoqueueConfigs.set(config.id, config);
      }

      for (const wf of state.workflows || []) {
        this.workflows.set(wf.id, wf);
      }

      for (const run of state.workflow_runs || []) {
        this.workflowRuns.set(run.id, run);
      }

      if (state.notification_config) {
        this.notificationConfig = state.notification_config;
      }

      console.log(`[store] Loaded state: ${this.stubs.size} stubs, ${this.tokens.size} tokens, ${this.grids.size} grids, ${this.slurmAccounts.size} slurm accounts`);
    } catch (err) {
      console.error("[store] Failed to load state:", err);
    }
  }

  /** Load state from a pre-parsed object (used by restore-from-backup). */
  loadFromState(state: ServerState): void {
    this.reset();

    for (const stub of state.stubs || []) {
      stub.missed_heartbeats = 0;
      stub.status = "offline";
      this.stubs.set(stub.id, stub);
    }

    for (const token of state.tokens || []) {
      this.tokens.set(token.token, token);
    }

    if (state.global_queue) this.globalQueue = state.global_queue;
    if (state.slurm_pool) this.slurmPool = state.slurm_pool;

    for (const grid of state.grids || []) this.grids.set(grid.id, grid);
    if (state.stall_config) this.stallConfig = state.stall_config;
    for (const account of state.slurm_accounts || []) this.slurmAccounts.set(account.id, account);
    for (const config of state.autoqueue_configs || []) this.autoqueueConfigs.set(config.id, config);
    for (const wf of state.workflows || []) this.workflows.set(wf.id, wf);
    for (const run of state.workflow_runs || []) this.workflowRuns.set(run.id, run);
    if (state.notification_config) this.notificationConfig = state.notification_config;

    console.log(`[store] Restored state from backup: ${this.stubs.size} stubs, ${this.tokens.size} tokens`);
  }
}

export const store = new Store();
