/**
 * store/index.ts — In-memory state management with JSON persistence.
 *
 * State: tasks (inside stubs + global pending queue), stubs, grids, seq counter.
 * Persistence: atomic write to state.json (tmp + rename) every 60s.
 *              Backup to backups/ every 30min, keep last 48.
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { Stub, Task, Grid, Token, Experiment, ServerState, TaskStatus } from "../types";
import { writeLockTable } from "../dedup";
import { backupState, pruneBackups } from "./backup";
import { logger } from "../log";
import { canTransition } from "../state-machine";

const STATE_FILE = process.env.STATE_FILE || path.join(process.cwd(), "state.json");
const SNAPSHOT_INTERVAL = 60_000;
const BACKUP_INTERVAL = 30 * 60_000;
const BACKUP_KEEP_COUNT = 48;
export const BACKUPS_DIR = path.join(path.dirname(STATE_FILE), "backups");

// Fingerprint index: fingerprint → task_id (for active tasks only)
type FingerprintIndex = Map<string, string>;

class Store {
  private stubs: Map<string, Stub> = new Map();
  private tokens: Map<string, Token> = new Map();
  // Global queue: tasks with no stub assigned (status="pending")
  private globalQueue: Task[] = [];
  private grids: Map<string, Grid> = new Map();
  private experiments: Map<string, Experiment> = new Map();
  private seqCounter: number = 0;
  // Fingerprint index: fingerprint → task_id for active tasks
  private fingerprintIndex: FingerprintIndex = new Map();
  // Archive: terminal tasks moved here so they don't clutter stub.tasks
  private archive: Task[] = [];

  constructor() {
    this.load();
  }

  // ─── Seq Counter ───────────────────────────────────────────────────────────

  nextSeq(): number {
    return ++this.seqCounter;
  }

  getSeqCounter(): number {
    return this.seqCounter;
  }

  // ─── Stubs ─────────────────────────────────────────────────────────────────

  getStub(id: string): Stub | undefined {
    return this.stubs.get(id);
  }

  getAllStubs(): Stub[] {
    return Array.from(this.stubs.values());
  }

  getOnlineStubs(): Stub[] {
    return Array.from(this.stubs.values()).filter((s) => s.status === "online");
  }

  setStub(stub: Stub): void {
    this.stubs.set(stub.id, stub);
  }

  deleteStub(id: string): void {
    this.stubs.delete(id);
  }

  /** Remove stubs that have been offline for too long with no active tasks. */
  pruneStaleStubs(maxOfflineHours: number = 24): number {
    const cutoff = Date.now() - maxOfflineHours * 3600_000;
    let pruned = 0;
    for (const [id, stub] of this.stubs) {
      if (stub.status === "offline" && stub.tasks.length === 0) {
        const lastSeen = new Date(stub.last_heartbeat).getTime();
        if (lastSeen < cutoff) {
          this.stubs.delete(id);
          pruned++;
          logger.info("stub.pruned", { stub: stub.name, last_seen: stub.last_heartbeat });
        }
      }
    }
    return pruned;
  }

  // ─── Tokens ────────────────────────────────────────────────────────────────

  getToken(token: string): Token | undefined {
    return this.tokens.get(token);
  }

  getTokenByName(name: string): Token | undefined {
    for (const token of this.tokens.values()) {
      if (token.name === name) return token;
    }
    return undefined;
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

  // ─── Tasks ─────────────────────────────────────────────────────────────────

  getAllTasks(): Task[] {
    const tasks: Task[] = [...this.globalQueue];
    for (const stub of this.stubs.values()) {
      tasks.push(...stub.tasks);
    }
    tasks.push(...this.archive);
    return tasks;
  }

  /** Active tasks only (no archive). Used by dashboard/stubs. */
  getActiveTasks(): Task[] {
    const tasks: Task[] = [...this.globalQueue];
    for (const stub of this.stubs.values()) {
      tasks.push(...stub.tasks);
    }
    return tasks;
  }

  getArchive(): Task[] {
    return this.archive;
  }

  setArchive(tasks: Task[]): void {
    this.archive = tasks;
  }

  removeFromArchive(taskId: string): Task | undefined {
    const idx = this.archive.findIndex((t) => t.id === taskId);
    if (idx === -1) return undefined;
    const [task] = this.archive.splice(idx, 1);
    return task;
  }

  /** Move a terminal task to archive. Removes from stub.tasks. */
  private _archiveTask(stubId: string, taskId: string, task: Task): void {
    const stub = this.stubs.get(stubId);
    if (stub) {
      stub.tasks = stub.tasks.filter((t) => t.id !== taskId);
    }
    this.archive.push(task);
  }

  /** Move a task from archive back to a stub's task list (for lost→running recovery). */
  unarchiveTask(stubId: string, taskId: string, update: Partial<Task>): Task | undefined {
    const idx = this.archive.findIndex((t) => t.id === taskId);
    if (idx === -1) return undefined;
    const stub = this.stubs.get(stubId);
    if (!stub) return undefined;
    const [task] = this.archive.splice(idx, 1);
    if (update.status && !canTransition(task.status, update.status)) {
      logger.warn("unarchiveTask.illegal_transition", { taskId, from: task.status, to: update.status });
      this.archive.push(task); // put it back
      return undefined;
    }
    const recovered = { ...task, ...update };
    stub.tasks.push(recovered);
    this._reindexTask(task, recovered);
    return recovered;
  }

  getGlobalQueue(): Task[] {
    // Sorted: priority desc, created_at asc
    return [...this.globalQueue].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.created_at.localeCompare(b.created_at);
    });
  }

  addToGlobalQueue(task: Task): void {
    task.stub_id = undefined;
    this.globalQueue.push(task);
    if (task.fingerprint) {
      this._indexFingerprint(task);
    }
  }

  removeFromGlobalQueue(taskId: string): Task | undefined {
    const idx = this.globalQueue.findIndex((t) => t.id === taskId);
    if (idx === -1) return undefined;
    const [task] = this.globalQueue.splice(idx, 1);
    return task;
  }

  updateGlobalQueueTask(taskId: string, update: Partial<Task>): Task | undefined {
    const idx = this.globalQueue.findIndex((t) => t.id === taskId);
    if (idx === -1) return undefined;
    const prev = this.globalQueue[idx];
    // Validate state transition
    if (update.status && update.status !== prev.status) {
      if (!canTransition(prev.status, update.status)) {
        logger.error("state.illegal_transition", {
          task_id: taskId,
          from: prev.status,
          to: update.status,
        });
        return undefined;
      }
    }
    this.globalQueue[idx] = { ...prev, ...update };
    const updated = this.globalQueue[idx];
    this._reindexTask(prev, updated);
    // Auto-archive: move to archive when transitioning to terminal status
    if (this._isActive(prev.status) && !this._isActive(updated.status)) {
      this.globalQueue.splice(idx, 1);
      this.archive.push(updated);
    }
    return updated;
  }

  getTask(stubId: string, taskId: string): Task | undefined {
    const stub = this.stubs.get(stubId);
    if (!stub) return undefined;
    return stub.tasks.find((t) => t.id === taskId);
  }

  /** Find a task by id across global queue, all stubs, and archive. */
  findTask(taskId: string): { task: Task; stubId: string | null; archived?: boolean } | undefined {
    for (const stub of this.stubs.values()) {
      const task = stub.tasks.find((t) => t.id === taskId);
      if (task) return { task, stubId: stub.id };
    }
    const gq = this.globalQueue.find((t) => t.id === taskId);
    if (gq) return { task: gq, stubId: null };
    const arch = this.archive.find((t) => t.id === taskId);
    if (arch) return { task: arch, stubId: arch.stub_id || null, archived: true };
    return undefined;
  }

  updateTask(stubId: string, taskId: string, update: Partial<Task>): Task | undefined {
    const stub = this.stubs.get(stubId);
    if (!stub) return undefined;
    const idx = stub.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return undefined;
    const prev = stub.tasks[idx];
    // Validate state transition
    if (update.status && update.status !== prev.status) {
      if (!canTransition(prev.status, update.status)) {
        logger.error("state.illegal_transition", {
          task_id: taskId,
          from: prev.status,
          to: update.status,
        });
        return undefined;
      }
    }
    stub.tasks[idx] = { ...prev, ...update };
    const updated = stub.tasks[idx];
    this._reindexTask(prev, updated);
    // Auto-archive: archive any terminal task still in stub.tasks
    if (!this._isActive(updated.status)) {
      this._archiveTask(stubId, taskId, updated);
    }
    return updated;
  }

  /** Move a task from global queue to a stub's local queue. */
  moveToStubQueue(taskId: string, stubId: string): Task | undefined {
    const task = this.removeFromGlobalQueue(taskId);
    if (!task) return undefined;
    const stub = this.stubs.get(stubId);
    if (!stub) {
      // Put back
      this.globalQueue.push(task);
      return undefined;
    }
    task.stub_id = stubId;
    task.status = "queued";
    stub.tasks.push(task);
    return task;
  }

  // ─── Fingerprint Index ─────────────────────────────────────────────────────

  private _activeStatuses: Set<TaskStatus> = new Set([
    "pending", "queued", "dispatched", "running", "paused",
  ]);

  private _isActive(status: TaskStatus): boolean {
    return this._activeStatuses.has(status);
  }

  private _indexFingerprint(task: Task): void {
    if (task.fingerprint && this._isActive(task.status)) {
      this.fingerprintIndex.set(task.fingerprint, task.id);
    }
  }

  private _reindexTask(prev: Task, updated: Task): void {
    // Remove old index entry if status changed to terminal
    if (prev.fingerprint && this._isActive(prev.status) && !this._isActive(updated.status)) {
      if (this.fingerprintIndex.get(prev.fingerprint) === prev.id) {
        this.fingerprintIndex.delete(prev.fingerprint);
      }
    }
    // Add new index entry if status is active
    if (updated.fingerprint && this._isActive(updated.status)) {
      this.fingerprintIndex.set(updated.fingerprint, updated.id);
    }
    // Handle write lock on terminal transitions
    if (!this._isActive(updated.status) && updated.run_dir) {
      writeLockTable.release(updated.run_dir);
    }
  }

  /**
   * Check if a task with the given fingerprint is currently active.
   * Returns the task_id if found, undefined otherwise.
   */
  findActiveByFingerprint(fingerprint: string): string | undefined {
    return this.fingerprintIndex.get(fingerprint);
  }

  rebuildFingerprintIndex(): void {
    this.fingerprintIndex.clear();
    for (const task of this.getAllTasks()) {
      if (task.fingerprint && this._isActive(task.status)) {
        this.fingerprintIndex.set(task.fingerprint, task.id);
      }
    }
  }

  rebuildWriteLocks(): void {
    writeLockTable.rebuild(this.getAllTasks());
  }

  // ─── Grids ─────────────────────────────────────────────────────────────────

  getGrid(id: string): Grid | undefined {
    return this.grids.get(id);
  }

  getAllGrids(): Grid[] {
    return Array.from(this.grids.values());
  }

  setGrid(grid: Grid): void {
    this.grids.set(grid.id, grid);
  }

  deleteGrid(id: string): void {
    this.grids.delete(id);
  }

  getGridTasks(gridId: string): Task[] {
    // M6: Use getActiveTasks to exclude archive — grid status should reflect live tasks only
    // Include archive terminal tasks for grid completion detection
    const active = this.getActiveTasks().filter((t) => t.grid_id === gridId);
    const archived = this.archive.filter((t) => t.grid_id === gridId);
    // Deduplicate by id (a task might appear in both during transition)
    const seen = new Set(active.map((t) => t.id));
    return [...active, ...archived.filter((t) => !seen.has(t.id))];
  }

  updateGridStatus(gridId: string): void {
    const grid = this.grids.get(gridId);
    if (!grid) return;
    const tasks = this.getGridTasks(gridId);
    if (tasks.length === 0) return;

    const statuses = tasks.map((t) => t.status);
    const allCompleted = statuses.every((s) => s === "completed");
    const anyRunning = statuses.some((s) => ["running", "dispatched", "queued"].includes(s));
    const anyFailed = statuses.some((s) => ["failed", "killed", "lost"].includes(s));
    const anyCompleted = statuses.some((s) => s === "completed");

    if (allCompleted) {
      grid.status = "completed";
    } else if (anyRunning) {
      grid.status = "running";
    } else if (anyFailed && anyCompleted) {
      grid.status = "partial";
    } else if (anyFailed && !anyCompleted) {
      grid.status = "failed";
    } else {
      grid.status = "pending";
    }

    this.grids.set(gridId, grid);
  }

  // ─── Experiments ────────────────────────────────────────────────────────────

  getExperiment(id: string): Experiment | undefined {
    return this.experiments.get(id);
  }

  getAllExperiments(): Experiment[] {
    return Array.from(this.experiments.values());
  }

  setExperiment(exp: Experiment): void {
    this.experiments.set(exp.id, exp);
  }

  deleteExperiment(id: string): void {
    this.experiments.delete(id);
  }

  getExperimentByGridId(gridId: string): Experiment | undefined {
    for (const exp of this.experiments.values()) {
      if (exp.grid_id === gridId) return exp;
    }
    return undefined;
  }

  // ─── Persistence ───────────────────────────────────────────────────────────

  startPersistence(): void {
    setInterval(() => this.saveAsync(), SNAPSHOT_INTERVAL);
    setInterval(() => this._autoBackup(), BACKUP_INTERVAL);
    // Note: pruneStaleStubs is called from scheduler.ts on its own interval — don't duplicate here
  }

  private async _autoBackup(): Promise<void> {
    try {
      await this.saveAsync();
      const filename = await backupState(STATE_FILE, BACKUPS_DIR);
      await pruneBackups(BACKUPS_DIR, BACKUP_KEEP_COUNT);
      logger.info("state.backup", { filename });
    } catch (err) {
      logger.error("state.backup_failed", { error: String(err) });
    }
  }

  private _serializeState(): string {
    const state: ServerState = {
      stubs: Array.from(this.stubs.values()).map((s) => ({
        ...s,
        socket_id: undefined,
        status: "offline" as const,
      })),
      tokens: Array.from(this.tokens.values()),
      grids: Array.from(this.grids.values()),
      experiments: Array.from(this.experiments.values()),
      seq_counter: this.seqCounter,
      archive: this.archive,
    };
    return JSON.stringify(state, null, 2);
  }

  /** Sync save — used only by shutdown handlers. */
  save(): void {
    try {
      fs.writeFileSync(STATE_FILE, this._serializeState());
      logger.info("state.save", { file: STATE_FILE, sync: true });
    } catch (err) {
      logger.error("state.save_failed", { error: String(err) });
    }
  }

  /** Async atomic save via tmp file + rename. */
  async saveAsync(): Promise<void> {
    try {
      const data = this._serializeState();
      const dir = path.dirname(STATE_FILE);
      const tmpFile = path.join(dir, `.state.tmp.${process.pid}`);
      await fsp.writeFile(tmpFile, data);
      await fsp.rename(tmpFile, STATE_FILE);
      logger.info("state.save", { file: STATE_FILE });
    } catch (err) {
      logger.error("state.save_failed", { error: String(err) });
    }
  }

  load(): void {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      const state: ServerState = JSON.parse(raw);
      this._applyState(state);
      logger.info("state.load", { stubs: this.stubs.size, tokens: this.tokens.size, grids: this.grids.size, experiments: this.experiments.size, seq: this.seqCounter });
    } catch (err) {
      logger.error("state.load_failed", { error: String(err) });
    }
  }

  private _applyState(state: ServerState): void {
    // Load stubs — mark offline, preserve tasks
    for (const stub of state.stubs || []) {
      stub.socket_id = undefined;
      stub.status = "offline";
      this.stubs.set(stub.id, stub);
    }

    for (const token of state.tokens || []) {
      this.tokens.set(token.token, token);
    }

    for (const grid of state.grids || []) {
      this.grids.set(grid.id, grid);
    }

    for (const exp of state.experiments || []) {
      this.experiments.set(exp.id, exp);
    }

    if (state.archive) {
      this.archive = state.archive;
    }

    if (state.seq_counter) {
      this.seqCounter = state.seq_counter;
    }

    // On load, move any terminal tasks from stubs to archive
    for (const stub of this.stubs.values()) {
      const terminal = stub.tasks.filter((t) => !this._isActive(t.status));
      if (terminal.length > 0) {
        stub.tasks = stub.tasks.filter((t) => this._isActive(t.status));
        this.archive.push(...terminal);
      }
    }

    // Rebuild indices after loading
    this.rebuildFingerprintIndex();
  }

  loadFromState(state: ServerState): void {
    this.stubs.clear();
    this.tokens.clear();
    this.globalQueue = [];
    this.grids.clear();
    this.experiments.clear();
    this.fingerprintIndex.clear();
    this.archive = [];
    this.seqCounter = 0;
    this._applyState(state);
    logger.info("state.restore", { stubs: this.stubs.size });
  }

  getStateFile(): string {
    return STATE_FILE;
  }

  getBackupsDir(): string {
    return BACKUPS_DIR;
  }

  /** For testing. */
  reset(): void {
    this.stubs.clear();
    this.tokens.clear();
    this.globalQueue = [];
    this.grids.clear();
    this.experiments.clear();
    this.fingerprintIndex.clear();
    this.archive = [];
    this.seqCounter = 0;
    writeLockTable.clear();
  }
}

export const store = new Store();
