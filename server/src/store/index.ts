/**
 * store/index.ts — SQLite-backed state management.
 *
 * All writes go directly to SQLite (WAL mode). No periodic JSON dump.
 * On first startup, if state.json exists and state.db does not, migrates automatically.
 *
 * Schema:
 *   stubs       — id PK + data JSON blob (tasks embedded)
 *   tokens      — token PK + name, created_at
 *   tasks       — id PK + status, stub_id, priority, seq, created_at, data JSON blob
 *   grids       — id PK + data JSON blob
 *   experiments — id PK + data JSON blob
 *   meta        — key/value for seq_counter etc.
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import Database from "better-sqlite3";
import { Stub, Task, Grid, Token, Experiment, ServerState, TaskStatus } from "../types";
import { writeLockTable } from "../dedup";
import { backupState, pruneBackups } from "./backup";
import { logger } from "../log";
import { canTransition } from "../state-machine";

const STATE_DIR = process.env.STATE_DIR || process.cwd();
const STATE_FILE = process.env.STATE_FILE || path.join(STATE_DIR, "state.json");
const DB_FILE = process.env.DB_FILE || path.join(path.dirname(STATE_FILE), "state.db");
const BACKUP_INTERVAL = 30 * 60_000;
const WAL_CHECKPOINT_INTERVAL = 30_000; // 30s periodic WAL flush
const BACKUP_KEEP_COUNT = 48;
const ARCHIVE_LOG_TAIL = 50;
const ARCHIVE_MAX = 500;
export const BACKUPS_DIR = path.join(path.dirname(STATE_FILE), "backups");

// Fingerprint index: fingerprint → task_id (for active tasks only)
type FingerprintIndex = Map<string, string>;

// ─── In-memory caches (rebuilt from DB on startup) ──────────────────────────

class Store {
  private db!: Database.Database;

  // In-memory caches for fast access
  private stubs: Map<string, Stub> = new Map();
  private tokens: Map<string, Token> = new Map();
  private globalQueue: Task[] = [];
  private grids: Map<string, Grid> = new Map();
  private experiments: Map<string, Experiment> = new Map();
  private seqCounter: number = 0;
  private fingerprintIndex: FingerprintIndex = new Map();
  private archive: Task[] = [];
  private _taskIndex = new Map<string, { stubId?: string; location: "global" | "stub" | "archive" }>();

  // Prepared statements (set after DB init)
  private _stmts!: ReturnType<typeof this._prepareStatements>;

  constructor() {
    this._initDb();
    this._loadFromDb();
  }

  // ─── DB Initialization ────────────────────────────────────────────────────

  private _initDb(): void {
    // Auto-migrate if state.json exists and state.db does not
    const needsMigration = fs.existsSync(STATE_FILE) && !fs.existsSync(DB_FILE);

    this.db = new Database(DB_FILE);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    // NORMAL is safe with WAL — each write is atomic; only risk is losing
    // the very last transaction on OS crash (acceptable, WAL replays on open).
    this.db.pragma("synchronous = NORMAL");
    // Increase WAL auto-checkpoint threshold (pages). Default is 1000 (~4MB).
    // Lower to 500 (~2MB) so SQLite auto-checkpoints more aggressively.
    this.db.pragma("wal_autocheckpoint = 500");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stubs (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tokens (
        token TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        stub_id TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT 'archive',
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_stub_id ON tasks(stub_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_location ON tasks(location);

      CREATE TABLE IF NOT EXISTS grids (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS experiments (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    this._stmts = this._prepareStatements();

    // State machine migration: normalize old status values to new ones
    this.db.exec(`
      UPDATE tasks SET status = 'failed' WHERE status = 'lost';
      UPDATE tasks SET status = 'cancelled' WHERE status = 'killed';
      UPDATE tasks SET status = 'assigned' WHERE status IN ('queued', 'dispatched');
    `);

    if (needsMigration) {
      this._migrateFromJson();
    }
  }

  private _prepareStatements() {
    return {
      // stubs
      upsertStub: this.db.prepare("INSERT OR REPLACE INTO stubs(id, data) VALUES (?, ?)"),
      deleteStub: this.db.prepare("DELETE FROM stubs WHERE id = ?"),
      // tokens
      upsertToken: this.db.prepare("INSERT OR REPLACE INTO tokens(token, name, created_at) VALUES (?, ?, ?)"),
      deleteToken: this.db.prepare("DELETE FROM tokens WHERE token = ?"),
      // tasks
      upsertTask: this.db.prepare(
        "INSERT OR REPLACE INTO tasks(id, status, stub_id, priority, seq, created_at, location, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ),
      deleteTask: this.db.prepare("DELETE FROM tasks WHERE id = ?"),
      // grids
      upsertGrid: this.db.prepare("INSERT OR REPLACE INTO grids(id, data) VALUES (?, ?)"),
      deleteGrid: this.db.prepare("DELETE FROM grids WHERE id = ?"),
      // experiments
      upsertExperiment: this.db.prepare("INSERT OR REPLACE INTO experiments(id, data) VALUES (?, ?)"),
      deleteExperiment: this.db.prepare("DELETE FROM experiments WHERE id = ?"),
      // meta
      getMeta: this.db.prepare("SELECT value FROM meta WHERE key = ?"),
      setMeta: this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)"),
    };
  }

  // ─── Migration ────────────────────────────────────────────────────────────

  private _migrateFromJson(): void {
    try {
      logger.info("state.migrate_start", { from: STATE_FILE, to: DB_FILE });
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      const state: ServerState = JSON.parse(raw);

      const migrate = this.db.transaction(() => {
        for (const stub of state.stubs || []) {
          stub.socket_id = undefined;
          stub.status = "offline";
          this._stmts.upsertStub.run(stub.id, JSON.stringify(stub));
        }
        for (const token of state.tokens || []) {
          const name = token.name || (token as any).label || "default";
          this._stmts.upsertToken.run(token.token, name, token.created_at);
        }
        for (const grid of state.grids || []) {
          this._stmts.upsertGrid.run(grid.id, JSON.stringify(grid));
        }
        for (const exp of state.experiments || []) {
          this._stmts.upsertExperiment.run(exp.id, JSON.stringify(exp));
        }
        // global_queue tasks
        for (const task of state.global_queue || []) {
          this._stmts.upsertTask.run(
            task.id, task.status, task.stub_id ?? null,
            task.priority, task.seq, task.created_at, "global",
            JSON.stringify(task)
          );
        }
        // archive tasks
        for (const task of state.archive || []) {
          this._stmts.upsertTask.run(
            task.id, task.status, task.stub_id ?? null,
            task.priority, task.seq, task.created_at, "archive",
            JSON.stringify(task)
          );
        }
        // stub-embedded tasks
        for (const stub of state.stubs || []) {
          for (const task of stub.tasks || []) {
            this._stmts.upsertTask.run(
              task.id, task.status, stub.id,
              task.priority, task.seq, task.created_at, "stub",
              JSON.stringify(task)
            );
          }
        }

        const seq = typeof state.seq_counter === "number" ? state.seq_counter : 0;
        this._stmts.setMeta.run("seq_counter", String(seq));
      });

      migrate();
      fs.renameSync(STATE_FILE, STATE_FILE + ".bak");
      logger.info("state.migrate_done", { backup: STATE_FILE + ".bak" });
    } catch (err) {
      logger.error("state.migrate_failed", { error: String(err) });
    }
  }

  // ─── Load from DB into memory ────────────────────────────────────────────

  private _loadFromDb(): void {
    try {
      // stubs
      const stubRows = this.db.prepare("SELECT data FROM stubs").all() as { data: string }[];
      for (const row of stubRows) {
        const stub: Stub = JSON.parse(row.data);
        stub.socket_id = undefined;
        stub.status = "offline";
        stub.tasks = [];
        this.stubs.set(stub.id, stub);
      }

      // tokens
      const tokenRows = this.db.prepare("SELECT token, name, created_at FROM tokens").all() as Token[];
      for (const row of tokenRows) {
        this.tokens.set(row.token, row);
      }

      // grids
      const gridRows = this.db.prepare("SELECT data FROM grids").all() as { data: string }[];
      for (const row of gridRows) {
        const grid: Grid = JSON.parse(row.data);
        this.grids.set(grid.id, grid);
      }

      // experiments
      const expRows = this.db.prepare("SELECT data FROM experiments").all() as { data: string }[];
      for (const row of expRows) {
        const exp: Experiment = JSON.parse(row.data);
        this.experiments.set(exp.id, exp);
      }

      // seq counter
      const seqRow = this._stmts.getMeta.get("seq_counter") as { value: string } | undefined;
      this.seqCounter = seqRow ? parseInt(seqRow.value, 10) : 0;

      // tasks — place into correct in-memory location
      const taskRows = this.db.prepare("SELECT location, data FROM tasks").all() as { location: string; data: string }[];
      for (const row of taskRows) {
        const task: Task = JSON.parse(row.data);
        if (row.location === "stub") {
          const stub = this.stubs.get(task.stub_id!);
          if (stub) {
            // On load, terminal tasks go to archive
            if (this._isActive(task.status)) {
              stub.tasks.push(task);
            } else {
              this._truncateLogBuffer(task);
              this.archive.push(task);
              // Fix location in DB
              this._stmts.upsertTask.run(
                task.id, task.status, task.stub_id ?? null,
                task.priority, task.seq, task.created_at, "archive",
                JSON.stringify(task)
              );
            }
          } else {
            // Orphan: stub gone, put in archive
            this._truncateLogBuffer(task);
            this.archive.push(task);
          }
        } else if (row.location === "global") {
          this.globalQueue.push(task);
        } else {
          // archive
          this._truncateLogBuffer(task);
          this.archive.push(task);
        }
      }

      // Truncate existing archive log_buffers and prune
      for (const t of this.archive) this._truncateLogBuffer(t);
      this._pruneArchiveInMemory();

      // Rebuild indices
      this.rebuildFingerprintIndex();
      this._rebuildTaskIndex();

      logger.info("state.load", {
        stubs: this.stubs.size,
        tokens: this.tokens.size,
        grids: this.grids.size,
        experiments: this.experiments.size,
        seq: this.seqCounter,
        archive: this.archive.length,
        queue: this.globalQueue.length,
      });
    } catch (err) {
      logger.error("state.load_failed", { error: String(err) });
    }
  }

  // ─── DB write helpers ─────────────────────────────────────────────────────

  private _saveTask(task: Task, location: "global" | "stub" | "archive"): void {
    this._stmts.upsertTask.run(
      task.id, task.status, task.stub_id ?? null,
      task.priority, task.seq, task.created_at, location,
      JSON.stringify(task)
    );
  }

  private _saveStub(stub: Stub): void {
    // Don't persist ephemeral fields
    const toSave = { ...stub, socket_id: undefined, status: "offline" as const };
    this._stmts.upsertStub.run(stub.id, JSON.stringify(toSave));
  }

  // ─── Seq Counter ──────────────────────────────────────────────────────────

  nextSeq(): number {
    this.seqCounter++;
    this._stmts.setMeta.run("seq_counter", String(this.seqCounter));
    return this.seqCounter;
  }

  getSeqCounter(): number {
    return this.seqCounter;
  }

  // ─── Stubs ────────────────────────────────────────────────────────────────

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
    this._saveStub(stub);
  }

  deleteStub(id: string): void {
    this.stubs.delete(id);
    this._stmts.deleteStub.run(id);
  }

  pruneStaleStubs(maxOfflineHours: number = 1): number {
    const cutoff = Date.now() - maxOfflineHours * 3600_000;
    let pruned = 0;
    for (const [id, stub] of this.stubs) {
      if (stub.status !== "offline") continue;
      const lastSeen = new Date(stub.last_heartbeat).getTime();
      if (lastSeen >= cutoff) continue;
      const hasActiveTasks = stub.tasks.some((t) => this._isActive(t.status));
      if (hasActiveTasks) continue;

      const prune = this.db.transaction(() => {
        for (const task of stub.tasks) {
          this._truncateLogBuffer(task);
          this.archive.push(task);
          this._taskIndex.set(task.id, { location: "archive" });
          this._saveTask(task, "archive");
        }
        this.stubs.delete(id);
        this._stmts.deleteStub.run(id);
      });
      prune();
      pruned++;
      logger.info("stub.pruned", { stub: stub.name, last_seen: stub.last_heartbeat, tasks_archived: stub.tasks.length });
    }
    if (pruned > 0) this._pruneArchive();
    return pruned;
  }

  // ─── Tokens ───────────────────────────────────────────────────────────────

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
    this._stmts.upsertToken.run(token.token, token.name, token.created_at);
  }

  deleteToken(token: string): void {
    this.tokens.delete(token);
    this._stmts.deleteToken.run(token);
  }

  // ─── Tasks ────────────────────────────────────────────────────────────────

  getAllTasks(): Task[] {
    // Active tasks from memory + ALL archived tasks from DB (not just in-memory archive)
    const tasks: Task[] = [...this.globalQueue];
    for (const stub of this.stubs.values()) {
      tasks.push(...stub.tasks);
    }
    const activeIds = new Set(tasks.map((t) => t.id));

    // Query all archived tasks from DB — includes evicted ones
    const dbRows = this.db.prepare("SELECT data FROM tasks WHERE location = 'archive'").all() as { data: string }[];
    for (const row of dbRows) {
      try {
        const task = JSON.parse(row.data) as Task;
        if (!activeIds.has(task.id)) {
          tasks.push(task);
        }
      } catch { /* skip corrupt rows */ }
    }
    return tasks;
  }

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
    const update = this.db.transaction(() => {
      // Remove all current archive tasks from DB
      for (const t of this.archive) {
        this._stmts.deleteTask.run(t.id);
        this._taskIndex.delete(t.id);
      }
      // Write new archive
      this.archive = tasks;
      for (const t of tasks) {
        this._saveTask(t, "archive");
        this._taskIndex.set(t.id, { location: "archive" });
      }
    });
    update();
  }

  removeFromArchive(taskId: string): Task | undefined {
    const idx = this.archive.findIndex((t) => t.id === taskId);
    if (idx === -1) return undefined;
    const [task] = this.archive.splice(idx, 1);
    this._taskIndex.delete(taskId);
    this._stmts.deleteTask.run(taskId);
    return task;
  }

  private _archiveTask(stubId: string, taskId: string, task: Task): void {
    const stub = this.stubs.get(stubId);

    const doArchive = this.db.transaction(() => {
      if (stub) {
        stub.tasks = stub.tasks.filter((t) => t.id !== taskId);
        this._saveStub(stub);
      }
      this._truncateLogBuffer(task);
      this.archive.push(task);
      this._saveTask(task, "archive");
      this._taskIndex.set(taskId, { location: "archive" });
    });
    doArchive();
    this._pruneArchive();
  }

  private _truncateLogBuffer(task: Task): void {
    if (task.log_buffer && task.log_buffer.length > ARCHIVE_LOG_TAIL) {
      task.log_buffer = task.log_buffer.slice(-ARCHIVE_LOG_TAIL);
    }
  }

  /** Prune archive: evict old tasks from memory, strip logs from DB (keep metadata). */
  private _pruneArchiveInMemory(): void {
    if (this.archive.length <= ARCHIVE_MAX) return;
    const sorted = [...this.archive].sort((a, b) => {
      return (a.finished_at ?? a.created_at).localeCompare(b.finished_at ?? b.created_at);
    });
    const toRemove = sorted.length - ARCHIVE_MAX;
    const evicted = sorted.slice(0, toRemove);
    const kept = new Set(sorted.slice(toRemove).map((t) => t.id));

    // Strip logs from evicted tasks in DB to save space, but keep the task record
    const doStrip = this.db.transaction(() => {
      for (const task of evicted) {
        const stripped = { ...task, log_buffer: [] };
        this._stmts.upsertTask.run(
          task.id, task.status, task.stub_id || null,
          task.priority, task.seq, task.created_at, "archive",
          JSON.stringify(stripped)
        );
        this._taskIndex.delete(task.id);
      }
    });
    doStrip();

    this.archive = this.archive.filter((t) => kept.has(t.id));
    if (evicted.length > 0) {
      logger.info("archive.prune_memory", { evicted: evicted.length, remaining: this.archive.length });
    }
  }

  private _pruneArchive(): void {
    if (this.archive.length <= ARCHIVE_MAX) return;

    const sorted = [...this.archive].sort((a, b) => {
      return (a.finished_at ?? a.created_at).localeCompare(b.finished_at ?? b.created_at);
    });

    const toRemove = sorted.length - ARCHIVE_MAX;
    const evicted = sorted.slice(0, toRemove);
    const kept = new Set(sorted.slice(toRemove).map((t) => t.id));

    // Strip logs from evicted tasks in DB, keep metadata
    const doStrip = this.db.transaction(() => {
      for (const task of evicted) {
        const stripped = { ...task, log_buffer: [] };
        this._stmts.upsertTask.run(
          task.id, task.status, task.stub_id || null,
          task.priority, task.seq, task.created_at, "archive",
          JSON.stringify(stripped)
        );
        this._taskIndex.delete(task.id);
      }
    });
    doStrip();

    this.archive = this.archive.filter((t) => kept.has(t.id));
    logger.info("archive.prune_memory", { evicted: toRemove, remaining: this.archive.length });
  }

  unarchiveTask(stubId: string, taskId: string, update: Partial<Task>): Task | undefined {
    const stub = this.stubs.get(stubId);
    if (!stub) return undefined;
    let task: Task;
    const idx = this.archive.findIndex((t) => t.id === taskId);
    if (idx !== -1) {
      [task] = this.archive.splice(idx, 1);
    } else {
      // DB fallback: task may have been evicted from memory but still in DB
      const row = this.db.prepare("SELECT data FROM tasks WHERE id = ?").get(taskId) as { data: string } | undefined;
      if (!row) return undefined;
      try { task = JSON.parse(row.data) as Task; } catch { return undefined; }
      logger.info("unarchiveTask.db_fallback", { taskId, status: task.status });
    }
    if (update.status && !canTransition(task.status, update.status)) {
      logger.warn("unarchiveTask.illegal_transition", { taskId, from: task.status, to: update.status });
      if (idx !== -1) this.archive.push(task); // put back if it was in memory
      return undefined;
    }
    const recovered = { ...task, ...update };

    const doUnarchive = this.db.transaction(() => {
      // Prevent duplicate: remove any existing entry with same id before pushing
      const existingIdx = stub.tasks.findIndex((t) => t.id === taskId);
      if (existingIdx !== -1) stub.tasks.splice(existingIdx, 1);
      stub.tasks.push(recovered);
      this._saveTask(recovered, "stub");
      this._saveStub(stub);
    });
    doUnarchive();

    this._taskIndex.set(taskId, { stubId, location: "stub" });
    this._reindexTask(task, recovered);
    return recovered;
  }

  getGlobalQueue(): Task[] {
    return [...this.globalQueue].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.created_at.localeCompare(b.created_at);
    });
  }

  addToGlobalQueue(task: Task): void {
    task.stub_id = undefined;
    this.globalQueue.push(task);
    this._taskIndex.set(task.id, { location: "global" });
    this._saveTask(task, "global");
    if (task.fingerprint) {
      this._indexFingerprint(task);
    }
  }

  removeFromGlobalQueue(taskId: string): Task | undefined {
    const idx = this.globalQueue.findIndex((t) => t.id === taskId);
    if (idx === -1) return undefined;
    const [task] = this.globalQueue.splice(idx, 1);
    this._taskIndex.delete(taskId);
    this._stmts.deleteTask.run(taskId);
    return task;
  }

  updateGlobalQueueTask(taskId: string, update: Partial<Task>): Task | undefined {
    const idx = this.globalQueue.findIndex((t) => t.id === taskId);
    if (idx === -1) return undefined;
    const prev = this.globalQueue[idx];
    if (update.status && update.status !== prev.status) {
      if (!canTransition(prev.status, update.status)) {
        logger.error("state.illegal_transition", { task_id: taskId, from: prev.status, to: update.status });
        return undefined;
      }
    }
    this.globalQueue[idx] = { ...prev, ...update };
    const updated = this.globalQueue[idx];

    if (this._isActive(prev.status) && !this._isActive(updated.status)) {
      this.globalQueue.splice(idx, 1);
      const archived = { ...updated };
      this._truncateLogBuffer(archived);

      const doArchive = this.db.transaction(() => {
        this.archive.push(archived);
        this._saveTask(archived, "archive");
        this._taskIndex.set(taskId, { location: "archive" });
      });
      doArchive();
      this._pruneArchive();
    } else {
      this._saveTask(updated, "global");
    }

    this._reindexTask(prev, updated);
    return updated;
  }

  getTask(stubId: string, taskId: string): Task | undefined {
    const stub = this.stubs.get(stubId);
    if (!stub) return undefined;
    return stub.tasks.find((t) => t.id === taskId);
  }

  findTask(taskId: string): { task: Task; stubId: string | null; archived?: boolean } | undefined {
    const entry = this._taskIndex.get(taskId);
    if (entry) {
      if (entry.location === "stub" && entry.stubId) {
        const stub = this.stubs.get(entry.stubId);
        const task = stub?.tasks.find((t) => t.id === taskId);
        if (task) return { task, stubId: entry.stubId };
      } else if (entry.location === "global") {
        const task = this.globalQueue.find((t) => t.id === taskId);
        if (task) return { task, stubId: null };
      } else if (entry.location === "archive") {
        const task = this.archive.find((t) => t.id === taskId);
        if (task) return { task, stubId: task.stub_id || null, archived: true };
      }
    }
    // Slow fallback
    for (const stub of this.stubs.values()) {
      const task = stub.tasks.find((t) => t.id === taskId);
      if (task) {
        this._taskIndex.set(taskId, { stubId: stub.id, location: "stub" });
        return { task, stubId: stub.id };
      }
    }
    const gq = this.globalQueue.find((t) => t.id === taskId);
    if (gq) {
      this._taskIndex.set(taskId, { location: "global" });
      return { task: gq, stubId: null };
    }
    const arch = this.archive.find((t) => t.id === taskId);
    if (arch) {
      this._taskIndex.set(taskId, { location: "archive" });
      return { task: arch, stubId: arch.stub_id || null, archived: true };
    }
    // DB fallback for evicted archive tasks
    const row = this.db.prepare("SELECT data FROM tasks WHERE id = ?").get(taskId) as { data: string } | undefined;
    if (row) {
      try {
        const task = JSON.parse(row.data) as Task;
        return { task, stubId: task.stub_id || null, archived: true };
      } catch { /* skip */ }
    }
    return undefined;
  }

  updateTask(stubId: string, taskId: string, update: Partial<Task>): Task | undefined {
    const stub = this.stubs.get(stubId);
    if (!stub) return undefined;
    const idx = stub.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return undefined;
    const prev = stub.tasks[idx];
    if (update.status && update.status !== prev.status) {
      if (!canTransition(prev.status, update.status)) {
        logger.error("state.illegal_transition", { task_id: taskId, from: prev.status, to: update.status });
        return undefined;
      }
    }
    stub.tasks[idx] = { ...prev, ...update };
    const updated = stub.tasks[idx];
    this._reindexTask(prev, updated);

    if (!this._isActive(updated.status)) {
      // _archiveTask handles DB writes atomically
      this._archiveTask(stubId, taskId, updated);
    } else {
      // Write updated task and stub
      const doUpdate = this.db.transaction(() => {
        this._saveTask(updated, "stub");
        this._saveStub(stub);
      });
      doUpdate();
    }
    return updated;
  }

  moveToStubQueue(taskId: string, stubId: string): Task | undefined {
    const task = this.removeFromGlobalQueue(taskId);
    if (!task) return undefined;
    const stub = this.stubs.get(stubId);
    if (!stub) {
      this.addToGlobalQueue(task);
      return undefined;
    }
    if (!canTransition(task.status, "assigned")) {
      logger.warn("moveToStubQueue.illegal_transition", { taskId, from: task.status, to: "assigned" });
      this.addToGlobalQueue(task);
      return undefined;
    }
    const prev = { ...task };
    task.stub_id = stubId;
    task.status = "assigned";

    const doMove = this.db.transaction(() => {
      stub.tasks.push(task);
      this._saveTask(task, "stub");
      this._saveStub(stub);
    });
    doMove();

    this._taskIndex.set(taskId, { stubId, location: "stub" });
    this._reindexTask(prev, task);
    return task;
  }

  /**
   * Atomically move a single dispatched task back to the global queue as pending.
   * Caller must have already removed the task from stub.tasks before calling this.
   * Used by dispatch timeout recovery in scheduler.ts.
   */
  requeueDispatchedTask(stub: Stub, recovered: Task): void {
    const doRequeue = this.db.transaction(() => {
      recovered.stub_id = undefined;
      this.globalQueue.push(recovered);
      this._saveTask(recovered, "global");
      this._taskIndex.set(recovered.id, { location: "global" });
      this._saveStub(stub);
    });
    doRequeue();
    if (recovered.fingerprint) {
      this._indexFingerprint(recovered);
    }
  }

  requeueStubTasks(stubId: string): Task[] {
    const stub = this.stubs.get(stubId);
    if (!stub) return [];
    const requeued: Task[] = [];
    const remaining: Task[] = [];

    const doRequeue = this.db.transaction(() => {
      for (const task of stub.tasks) {
        if (task.status === "assigned") {
          const prev = { ...task };
          task.status = "pending";
          task.stub_id = undefined;
          this.globalQueue.push(task);
          this._saveTask(task, "global");
          this._taskIndex.set(task.id, { location: "global" });
          this._reindexTask(prev, task);
          requeued.push(task);
          logger.info("task.requeued_on_disconnect", { task_id: task.id, from: prev.status, stub: stub.name });
        } else {
          remaining.push(task);
        }
      }
      stub.tasks = remaining;
      this._saveStub(stub);
    });
    doRequeue();

    return requeued;
  }

  // ─── Fingerprint Index ────────────────────────────────────────────────────

  private _activeStatuses: Set<TaskStatus> = new Set([
    "pending", "assigned", "running", "paused", "blocked",
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
    if (prev.fingerprint && this._isActive(prev.status) && !this._isActive(updated.status)) {
      if (this.fingerprintIndex.get(prev.fingerprint) === prev.id) {
        this.fingerprintIndex.delete(prev.fingerprint);
      }
    }
    if (updated.fingerprint && this._isActive(updated.status)) {
      this.fingerprintIndex.set(updated.fingerprint, updated.id);
    }
    if (!this._isActive(updated.status) && updated.run_dir) {
      writeLockTable.release(updated.run_dir);
    }
  }

  findActiveByFingerprint(fingerprint: string): string | undefined {
    const taskId = this.fingerprintIndex.get(fingerprint);
    if (!taskId) return undefined;
    const found = this.findTask(taskId);
    if (!found) {
      this.fingerprintIndex.delete(fingerprint);
      return undefined;
    }
    if (found.task.should_stop) return undefined;
    // Stub-offline tasks (disconnected) should not block resubmission
    if (found.task.stub_offline) return undefined;
    return taskId;
  }

  rebuildFingerprintIndex(): void {
    this.fingerprintIndex.clear();
    for (const task of this.getAllTasks()) {
      if (task.fingerprint && this._isActive(task.status)) {
        this.fingerprintIndex.set(task.fingerprint, task.id);
      }
    }
  }

  private _rebuildTaskIndex(): void {
    this._taskIndex.clear();
    for (const task of this.globalQueue) {
      this._taskIndex.set(task.id, { location: "global" });
    }
    for (const stub of this.stubs.values()) {
      for (const task of stub.tasks) {
        this._taskIndex.set(task.id, { stubId: stub.id, location: "stub" });
      }
    }
    for (const task of this.archive) {
      this._taskIndex.set(task.id, { location: "archive" });
    }
  }

  rebuildWriteLocks(): void {
    writeLockTable.rebuild(this.getAllTasks());
  }

  // ─── Grids ────────────────────────────────────────────────────────────────

  getGrid(id: string): Grid | undefined {
    return this.grids.get(id);
  }

  getAllGrids(): Grid[] {
    return Array.from(this.grids.values());
  }

  setGrid(grid: Grid): void {
    this.grids.set(grid.id, grid);
    this._stmts.upsertGrid.run(grid.id, JSON.stringify(grid));
  }

  deleteGrid(id: string): void {
    this.grids.delete(id);
    this._stmts.deleteGrid.run(id);
  }

  getGridTasks(gridId: string): Task[] {
    const active = this.getActiveTasks().filter((t) => t.grid_id === gridId);
    const archived = this.archive.filter((t) => t.grid_id === gridId);
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
    const anyRunning = statuses.some((s) => ["running", "assigned"].includes(s));
    const anyFailed = statuses.some((s) => ["failed", "cancelled"].includes(s));
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
    this._stmts.upsertGrid.run(grid.id, JSON.stringify(grid));
  }

  // ─── Experiments ──────────────────────────────────────────────────────────

  getExperiment(id: string): Experiment | undefined {
    return this.experiments.get(id);
  }

  getAllExperiments(): Experiment[] {
    return Array.from(this.experiments.values());
  }

  setExperiment(exp: Experiment): void {
    this.experiments.set(exp.id, exp);
    this._stmts.upsertExperiment.run(exp.id, JSON.stringify(exp));
  }

  deleteExperiment(id: string): void {
    this.experiments.delete(id);
    this._stmts.deleteExperiment.run(id);
  }

  getBlockedTasksDependingOn(taskId: string): Task[] {
    return this.globalQueue.filter(
      (t) => t.status === "blocked" && t.depends_on?.includes(taskId)
    );
  }

  getExperimentByGridId(gridId: string): Experiment | undefined {
    for (const exp of this.experiments.values()) {
      if (exp.grid_id === gridId) return exp;
    }
    return undefined;
  }

  findExperimentByName(name: string): Experiment | undefined {
    let best: Experiment | undefined;
    for (const exp of this.experiments.values()) {
      if (exp.name !== name) continue;
      if (!best) { best = exp; continue; }
      const bestTerminal = ["passed", "completed", "partial", "failed"].includes(best.status);
      const expTerminal = ["passed", "completed", "partial", "failed"].includes(exp.status);
      if (expTerminal && !bestTerminal) { best = exp; continue; }
      if (bestTerminal && !expTerminal) continue;
      if (exp.created_at > best.created_at) best = exp;
    }
    return best;
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  /** Start backup and WAL checkpoint timers. */
  startPersistence(): void {
    setInterval(() => this._autoBackup(), BACKUP_INTERVAL);
    // Periodic WAL checkpoint to prevent unbounded WAL growth and ensure
    // DB file is durable even without an explicit save() call.
    setInterval(() => {
      try {
        this.db.pragma("wal_checkpoint(PASSIVE)");
      } catch (err) {
        logger.error("state.wal_checkpoint_failed", { error: String(err) });
      }
    }, WAL_CHECKPOINT_INTERVAL);
  }

  /** Export current state as a ServerState JSON object (for backups and restore). */
  exportState(): ServerState {
    return {
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
      global_queue: this.globalQueue,
    };
  }

  private async _autoBackup(): Promise<void> {
    try {
      // Write a JSON snapshot to backups/ (compatible with restoreFromBackup)
      await fsp.mkdir(BACKUPS_DIR, { recursive: true });
      const timestamp = Date.now();
      const filename = `state_${timestamp}.json`;
      const dest = path.join(BACKUPS_DIR, filename);
      await fsp.writeFile(dest, JSON.stringify(this.exportState(), null, 2));
      await pruneBackups(BACKUPS_DIR, BACKUP_KEEP_COUNT);
      logger.info("state.backup", { filename });
    } catch (err) {
      logger.error("state.backup_failed", { error: String(err) });
    }
  }

  /** Sync save — called on graceful shutdown. Forces a full WAL checkpoint. */
  save(): void {
    try {
      // TRUNCATE: blocks until all WAL pages are flushed to main DB, then
      // truncates the WAL file. Use this on shutdown for maximum durability.
      this.db.pragma("wal_checkpoint(TRUNCATE)");
      logger.info("state.save", { file: DB_FILE, sync: true });
    } catch (err) {
      logger.error("state.save_failed", { error: String(err) });
    }
  }

  /** Async save — kept for API compatibility. Forces a full WAL checkpoint. */
  async saveAsync(): Promise<void> {
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
      logger.info("state.save", { file: DB_FILE });
    } catch (err) {
      logger.error("state.save_failed", { error: String(err) });
    }
  }

  /** Load from a ServerState object (used by restore endpoint). */
  load(): void {
    // Called from constructor via _loadFromDb — no-op here.
  }

  loadFromState(state: ServerState): void {
    // Clear in-memory state
    this.stubs.clear();
    this.tokens.clear();
    this.globalQueue = [];
    this.grids.clear();
    this.experiments.clear();
    this.fingerprintIndex.clear();
    this._taskIndex.clear();
    this.archive = [];
    this.seqCounter = 0;

    // Clear DB
    const clearAll = this.db.transaction(() => {
      this.db.prepare("DELETE FROM stubs").run();
      this.db.prepare("DELETE FROM tokens").run();
      this.db.prepare("DELETE FROM tasks").run();
      this.db.prepare("DELETE FROM grids").run();
      this.db.prepare("DELETE FROM experiments").run();
      this.db.prepare("DELETE FROM meta").run();
    });
    clearAll();

    // Apply state (this calls the migration path)
    this._applyState(state);
    logger.info("state.restore", { stubs: this.stubs.size });
  }

  private _applyState(state: ServerState): void {
    const apply = this.db.transaction(() => {
      for (const stub of state.stubs || []) {
        stub.socket_id = undefined;
        stub.status = "offline";
        this.stubs.set(stub.id, stub);
        this._saveStub(stub);
      }
      for (const token of state.tokens || []) {
        this.tokens.set(token.token, token);
        this._stmts.upsertToken.run(token.token, token.name, token.created_at);
      }
      for (const grid of state.grids || []) {
        this.grids.set(grid.id, grid);
        this._stmts.upsertGrid.run(grid.id, JSON.stringify(grid));
      }
      for (const exp of state.experiments || []) {
        this.experiments.set(exp.id, exp);
        this._stmts.upsertExperiment.run(exp.id, JSON.stringify(exp));
      }

      if (state.archive) {
        this.archive = state.archive;
        for (const t of this.archive) this._saveTask(t, "archive");
      }
      if (state.global_queue) {
        this.globalQueue = state.global_queue;
        for (const t of this.globalQueue) this._saveTask(t, "global");
      }
      if (typeof state.seq_counter === "number") {
        this.seqCounter = state.seq_counter;
        this._stmts.setMeta.run("seq_counter", String(this.seqCounter));
      }

      // Move terminal tasks from stubs to archive
      for (const stub of this.stubs.values()) {
        const terminal = stub.tasks.filter((t) => !this._isActive(t.status));
        if (terminal.length > 0) {
          stub.tasks = stub.tasks.filter((t) => this._isActive(t.status));
          for (const t of terminal) {
            this._truncateLogBuffer(t);
            this.archive.push(t);
            this._saveTask(t, "archive");
          }
          this._saveStub(stub);
        }
        // Write active stub tasks
        for (const t of stub.tasks) this._saveTask(t, "stub");
      }
    });
    apply();

    for (const t of this.archive) this._truncateLogBuffer(t);
    this._pruneArchive();

    this.rebuildFingerprintIndex();
    this._rebuildTaskIndex();
  }

  getStateFile(): string {
    return DB_FILE;
  }

  getBackupsDir(): string {
    return BACKUPS_DIR;
  }

  reset(): void {
    this.stubs.clear();
    this.tokens.clear();
    this.globalQueue = [];
    this.grids.clear();
    this.experiments.clear();
    this.fingerprintIndex.clear();
    this._taskIndex.clear();
    this.archive = [];
    this.seqCounter = 0;
    writeLockTable.clear();

    const clearAll = this.db.transaction(() => {
      this.db.prepare("DELETE FROM stubs").run();
      this.db.prepare("DELETE FROM tokens").run();
      this.db.prepare("DELETE FROM tasks").run();
      this.db.prepare("DELETE FROM grids").run();
      this.db.prepare("DELETE FROM experiments").run();
      this.db.prepare("DELETE FROM meta").run();
    });
    clearAll();
  }
}

export const store = new Store();
