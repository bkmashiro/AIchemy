/**
 * store/index.ts — Drizzle ORM + SQLite state management.
 *
 * All writes go directly to SQLite (WAL mode) via Drizzle ORM.
 * In-memory caches are rebuilt from DB on startup.
 *
 * Tables: stubs, tokens, tasks, grids, experiments, meta
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq, sql } from "drizzle-orm";
import * as schema from "./schema";
import { Stub, Task, Grid, Token, Experiment, ServerState, TaskStatus } from "../types";
import { writeLockTable } from "../dedup";
import { backupState, pruneBackups } from "./backup";
import { logger } from "../log";
import { canTransition } from "../state-machine";

const STATE_DIR = process.env.STATE_DIR || process.cwd();
const STATE_FILE = process.env.STATE_FILE || path.join(STATE_DIR, "state.json");
const DB_FILE = process.env.DB_FILE || path.join(path.dirname(STATE_FILE), "state.db");
const BACKUP_INTERVAL = 30 * 60_000;
const WAL_CHECKPOINT_INTERVAL = 30_000;
const BACKUP_KEEP_COUNT = 48;
const ARCHIVE_LOG_TAIL = 50;
const ARCHIVE_MAX = 500;
export const BACKUPS_DIR = path.join(path.dirname(STATE_FILE), "backups");

type FingerprintIndex = Map<string, string>;

// ─── Store ──────────────────────────────────────────────────────────────────

class Store {
  private sqlite!: Database.Database;
  private db!: BetterSQLite3Database<typeof schema>;

  // In-memory caches
  private stubs: Map<string, Stub> = new Map();
  private tokens: Map<string, Token> = new Map();
  private globalQueue: Task[] = [];
  private grids: Map<string, Grid> = new Map();
  private experiments: Map<string, Experiment> = new Map();
  private seqCounter: number = 0;
  private fingerprintIndex: FingerprintIndex = new Map();
  private archive: Task[] = [];
  private _taskIndex = new Map<string, { stubId?: string; location: "global" | "stub" | "archive" }>();

  constructor() {
    this._initDb();
    this._loadFromDb();
  }

  // ─── DB Initialization ──────────────────────────────────────────────────

  private _initDb(): void {
    this.sqlite = new Database(DB_FILE);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("synchronous = NORMAL");
    this.sqlite.pragma("wal_autocheckpoint = 500");

    this.db = drizzle(this.sqlite, { schema });

    // Create tables via Drizzle push is not available at runtime,
    // so use raw SQL for CREATE TABLE IF NOT EXISTS
    this.sqlite.exec(`
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

    // Normalize old status values
    this.db.update(schema.tasks).set({ status: "failed" }).where(eq(schema.tasks.status, "lost")).run();
    this.db.update(schema.tasks).set({ status: "cancelled" }).where(eq(schema.tasks.status, "killed")).run();
    this.db.run(sql`UPDATE tasks SET status = 'assigned' WHERE status IN ('queued', 'dispatched')`);
  }

  // ─── Load from DB ───────────────────────────────────────────────────────

  private _loadFromDb(): void {
    try {
      // stubs
      for (const row of this.db.select({ data: schema.stubs.data }).from(schema.stubs).all()) {
        const stub: Stub = JSON.parse(row.data);
        stub.socket_id = undefined;
        stub.status = "offline";
        stub.tasks = [];
        this.stubs.set(stub.id, stub);
      }

      // tokens
      for (const row of this.db.select().from(schema.tokens).all()) {
        this.tokens.set(row.token, row);
      }

      // grids
      for (const row of this.db.select({ data: schema.grids.data }).from(schema.grids).all()) {
        const grid: Grid = JSON.parse(row.data);
        this.grids.set(grid.id, grid);
      }

      // experiments
      for (const row of this.db.select({ data: schema.experiments.data }).from(schema.experiments).all()) {
        const exp: Experiment = JSON.parse(row.data);
        this.experiments.set(exp.id, exp);
      }

      // seq counter
      const seqRow = this.db.select({ value: schema.meta.value })
        .from(schema.meta)
        .where(eq(schema.meta.key, "seq_counter"))
        .get();
      this.seqCounter = seqRow ? parseInt(seqRow.value, 10) : 0;

      // tasks
      const taskRows = this.db.select({ location: schema.tasks.location, data: schema.tasks.data })
        .from(schema.tasks).all();
      for (const row of taskRows) {
        const task: Task = JSON.parse(row.data);
        if (row.location === "stub") {
          const stub = this.stubs.get(task.stub_id!);
          if (stub) {
            if (this._isActive(task.status)) {
              stub.tasks.push(task);
            } else {
              this._truncateLogBuffer(task);
              this.archive.push(task);
              this._saveTask(task, "archive");
            }
          } else {
            this._truncateLogBuffer(task);
            this.archive.push(task);
          }
        } else if (row.location === "global") {
          this.globalQueue.push(task);
        } else {
          this._truncateLogBuffer(task);
          this.archive.push(task);
        }
      }

      for (const t of this.archive) this._truncateLogBuffer(t);
      this._pruneArchiveInMemory();

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

  // ─── DB write helpers ───────────────────────────────────────────────────

  /**
   * Write task to DB. Throws on failure — callers inside transactions
   * should let the error propagate so the transaction rolls back.
   */
  private _saveTask(task: Task, location: "global" | "stub" | "archive"): void {
    this.db.insert(schema.tasks)
      .values({
        id: task.id,
        status: task.status,
        stub_id: task.stub_id ?? null,
        priority: task.priority,
        seq: task.seq,
        created_at: task.created_at,
        location,
        data: JSON.stringify(task),
      })
      .onConflictDoUpdate({
        target: schema.tasks.id,
        set: {
          status: task.status,
          stub_id: task.stub_id ?? null,
          priority: task.priority,
          seq: task.seq,
          location,
          data: JSON.stringify(task),
        },
      })
      .run();
  }

  /** Write stub to DB. Throws on failure — see _saveTask. */
  private _saveStub(stub: Stub): void {
    const toSave = { ...stub, socket_id: undefined, status: "offline" as const };
    this.db.insert(schema.stubs)
      .values({ id: stub.id, data: JSON.stringify(toSave) })
      .onConflictDoUpdate({
        target: schema.stubs.id,
        set: { data: JSON.stringify(toSave) },
      })
      .run();
  }

  private _deleteTask(taskId: string): void {
    try {
      this.db.delete(schema.tasks).where(eq(schema.tasks.id, taskId)).run();
    } catch (err) {
      logger.error("db.delete_task_failed", { task_id: taskId, error: String(err) });
    }
  }

  private _deleteStub(stubId: string): void {
    try {
      this.db.delete(schema.stubs).where(eq(schema.stubs.id, stubId)).run();
    } catch (err) {
      logger.error("db.delete_stub_failed", { stub_id: stubId, error: String(err) });
    }
  }

  // ─── Seq Counter ────────────────────────────────────────────────────────

  nextSeq(): number {
    this.seqCounter++;
    try {
      this.db.insert(schema.meta)
        .values({ key: "seq_counter", value: String(this.seqCounter) })
        .onConflictDoUpdate({
          target: schema.meta.key,
          set: { value: String(this.seqCounter) },
        })
        .run();
    } catch (err) {
      logger.error("db.save_seq_failed", { error: String(err) });
    }
    return this.seqCounter;
  }

  getSeqCounter(): number {
    return this.seqCounter;
  }

  // ─── Stubs ──────────────────────────────────────────────────────────────

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
    try {
      this._saveStub(stub);
    } catch (err) {
      logger.error("db.save_stub_failed", { stub_id: stub.id, error: String(err) });
    }
  }

  deleteStub(id: string): void {
    this.stubs.delete(id);
    this._deleteStub(id);
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

      this.db.transaction((tx) => {
        for (const task of stub.tasks) {
          this._truncateLogBuffer(task);
          this.archive.push(task);
          this._taskIndex.set(task.id, { location: "archive" });
          this._saveTask(task, "archive");
        }
        this.stubs.delete(id);
        this._deleteStub(id);
      });
      pruned++;
      logger.info("stub.pruned", { stub: stub.name, last_seen: stub.last_heartbeat, tasks_archived: stub.tasks.length });
    }
    if (pruned > 0) this._pruneArchive();
    return pruned;
  }

  // ─── Tokens ─────────────────────────────────────────────────────────────

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
    try {
      this.db.insert(schema.tokens)
        .values({ token: token.token, name: token.name, created_at: token.created_at })
        .onConflictDoUpdate({
          target: schema.tokens.token,
          set: { name: token.name, created_at: token.created_at },
        })
        .run();
    } catch (err) {
      logger.error("db.save_token_failed", { error: String(err) });
    }
  }

  deleteToken(token: string): void {
    this.tokens.delete(token);
    try {
      this.db.delete(schema.tokens).where(eq(schema.tokens.token, token)).run();
    } catch (err) {
      logger.error("db.delete_token_failed", { error: String(err) });
    }
  }

  // ─── Tasks ──────────────────────────────────────────────────────────────

  getAllTasks(): Task[] {
    const tasks: Task[] = [...this.globalQueue];
    for (const stub of this.stubs.values()) {
      tasks.push(...stub.tasks);
    }
    const activeIds = new Set(tasks.map((t) => t.id));

    // Query all archived tasks from DB (includes evicted ones)
    try {
      const dbRows = this.db.select({ data: schema.tasks.data })
        .from(schema.tasks)
        .where(eq(schema.tasks.location, "archive"))
        .all();
      for (const row of dbRows) {
        try {
          const task = JSON.parse(row.data) as Task;
          if (!activeIds.has(task.id)) {
            tasks.push(task);
          }
        } catch { /* skip corrupt rows */ }
      }
    } catch (err) {
      logger.error("db.get_all_tasks_failed", { error: String(err) });
      // Fallback to in-memory archive
      for (const t of this.archive) {
        if (!activeIds.has(t.id)) tasks.push(t);
      }
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
    this.db.transaction((tx) => {
      for (const t of this.archive) {
        tx.delete(schema.tasks).where(eq(schema.tasks.id, t.id)).run();
        this._taskIndex.delete(t.id);
      }
      this.archive = tasks;
      for (const t of tasks) {
        tx.insert(schema.tasks)
          .values({
            id: t.id, status: t.status, stub_id: t.stub_id ?? null,
            priority: t.priority, seq: t.seq, created_at: t.created_at,
            location: "archive", data: JSON.stringify(t),
          })
          .onConflictDoUpdate({
            target: schema.tasks.id,
            set: { status: t.status, location: "archive", data: JSON.stringify(t) },
          })
          .run();
        this._taskIndex.set(t.id, { location: "archive" });
      }
    });
  }

  removeFromArchive(taskId: string): Task | undefined {
    const idx = this.archive.findIndex((t) => t.id === taskId);
    if (idx === -1) return undefined;
    const [task] = this.archive.splice(idx, 1);
    this._taskIndex.delete(taskId);
    this._deleteTask(taskId);
    return task;
  }

  private _archiveTask(stubId: string, taskId: string, task: Task): void {
    const stub = this.stubs.get(stubId);

    this.db.transaction((tx) => {
      if (stub) {
        stub.tasks = stub.tasks.filter((t) => t.id !== taskId);
        this._saveStub(stub);
      }
      this._truncateLogBuffer(task);
      this.archive.push(task);
      this._saveTask(task, "archive");
      this._taskIndex.set(taskId, { location: "archive" });
    });
    this._pruneArchive();
  }

  private _truncateLogBuffer(task: Task): void {
    if (task.log_buffer && task.log_buffer.length > ARCHIVE_LOG_TAIL) {
      task.log_buffer = task.log_buffer.slice(-ARCHIVE_LOG_TAIL);
    }
  }

  private _pruneArchiveInMemory(): void {
    if (this.archive.length <= ARCHIVE_MAX) return;
    const sorted = [...this.archive].sort((a, b) => {
      return (a.finished_at ?? a.created_at).localeCompare(b.finished_at ?? b.created_at);
    });
    const toRemove = sorted.length - ARCHIVE_MAX;
    const evicted = sorted.slice(0, toRemove);
    const kept = new Set(sorted.slice(toRemove).map((t) => t.id));

    this.db.transaction((tx) => {
      for (const task of evicted) {
        const stripped = { ...task, log_buffer: [] };
        tx.insert(schema.tasks)
          .values({
            id: task.id, status: task.status, stub_id: task.stub_id || null,
            priority: task.priority, seq: task.seq, created_at: task.created_at,
            location: "archive", data: JSON.stringify(stripped),
          })
          .onConflictDoUpdate({
            target: schema.tasks.id,
            set: { data: JSON.stringify(stripped) },
          })
          .run();
        this._taskIndex.delete(task.id);
      }
    });

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

    this.db.transaction((tx) => {
      for (const task of evicted) {
        const stripped = { ...task, log_buffer: [] };
        tx.insert(schema.tasks)
          .values({
            id: task.id, status: task.status, stub_id: task.stub_id || null,
            priority: task.priority, seq: task.seq, created_at: task.created_at,
            location: "archive", data: JSON.stringify(stripped),
          })
          .onConflictDoUpdate({
            target: schema.tasks.id,
            set: { data: JSON.stringify(stripped) },
          })
          .run();
        this._taskIndex.delete(task.id);
      }
    });

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
      // DB fallback: task may have been evicted from memory
      try {
        const row = this.db.select({ data: schema.tasks.data })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, taskId))
          .get();
        if (!row) return undefined;
        task = JSON.parse(row.data) as Task;
        logger.info("unarchiveTask.db_fallback", { taskId, status: task.status });
      } catch { return undefined; }
    }
    if (update.status && !canTransition(task.status, update.status)) {
      logger.warn("unarchiveTask.illegal_transition", { taskId, from: task.status, to: update.status });
      if (idx !== -1) this.archive.push(task);
      return undefined;
    }
    const recovered = { ...task, ...update };

    this.db.transaction((tx) => {
      const existingIdx = stub.tasks.findIndex((t) => t.id === taskId);
      if (existingIdx !== -1) stub.tasks.splice(existingIdx, 1);
      stub.tasks.push(recovered);
      this._saveTask(recovered, "stub");
      this._saveStub(stub);
    });

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
    try {
      this._saveTask(task, "global");
    } catch (err) {
      logger.error("db.save_task_failed", { task_id: task.id, error: String(err) });
    }
    if (task.fingerprint) {
      this._indexFingerprint(task);
    }
  }

  removeFromGlobalQueue(taskId: string): Task | undefined {
    const idx = this.globalQueue.findIndex((t) => t.id === taskId);
    if (idx === -1) return undefined;
    const [task] = this.globalQueue.splice(idx, 1);
    this._taskIndex.delete(taskId);
    this._deleteTask(taskId);
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

      this.db.transaction((tx) => {
        this.archive.push(archived);
        this._saveTask(archived, "archive");
        this._taskIndex.set(taskId, { location: "archive" });
      });
      this._pruneArchive();
    } else {
      try {
        this._saveTask(updated, "global");
      } catch (err) {
        logger.error("db.save_task_failed", { task_id: updated.id, error: String(err) });
      }
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
    try {
      const row = this.db.select({ data: schema.tasks.data })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .get();
      if (row) {
        const task = JSON.parse(row.data) as Task;
        return { task, stubId: task.stub_id || null, archived: true };
      }
    } catch { /* skip */ }
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
      this._archiveTask(stubId, taskId, updated);
    } else {
      this.db.transaction((tx) => {
        this._saveTask(updated, "stub");
        this._saveStub(stub);
      });
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

    this.db.transaction((tx) => {
      stub.tasks.push(task);
      this._saveTask(task, "stub");
      this._saveStub(stub);
    });

    this._taskIndex.set(taskId, { stubId, location: "stub" });
    this._reindexTask(prev, task);
    return task;
  }

  requeueDispatchedTask(stub: Stub, recovered: Task): void {
    this.db.transaction((tx) => {
      recovered.stub_id = undefined;
      this.globalQueue.push(recovered);
      this._saveTask(recovered, "global");
      this._taskIndex.set(recovered.id, { location: "global" });
      this._saveStub(stub);
    });
    if (recovered.fingerprint) {
      this._indexFingerprint(recovered);
    }
  }

  requeueStubTasks(stubId: string): Task[] {
    const stub = this.stubs.get(stubId);
    if (!stub) return [];
    const requeued: Task[] = [];
    const remaining: Task[] = [];

    this.db.transaction((tx) => {
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

    return requeued;
  }

  // ─── Fingerprint Index ──────────────────────────────────────────────────

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

  // ─── Grids ──────────────────────────────────────────────────────────────

  getGrid(id: string): Grid | undefined {
    return this.grids.get(id);
  }

  getAllGrids(): Grid[] {
    return Array.from(this.grids.values());
  }

  setGrid(grid: Grid): void {
    this.grids.set(grid.id, grid);
    try {
      this.db.insert(schema.grids)
        .values({ id: grid.id, data: JSON.stringify(grid) })
        .onConflictDoUpdate({
          target: schema.grids.id,
          set: { data: JSON.stringify(grid) },
        })
        .run();
    } catch (err) {
      logger.error("db.save_grid_failed", { grid_id: grid.id, error: String(err) });
    }
  }

  deleteGrid(id: string): void {
    this.grids.delete(id);
    try {
      this.db.delete(schema.grids).where(eq(schema.grids.id, id)).run();
    } catch (err) {
      logger.error("db.delete_grid_failed", { grid_id: id, error: String(err) });
    }
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

    this.setGrid(grid);
  }

  // ─── Experiments ────────────────────────────────────────────────────────

  getExperiment(id: string): Experiment | undefined {
    return this.experiments.get(id);
  }

  getAllExperiments(): Experiment[] {
    return Array.from(this.experiments.values());
  }

  setExperiment(exp: Experiment): void {
    this.experiments.set(exp.id, exp);
    try {
      this.db.insert(schema.experiments)
        .values({ id: exp.id, data: JSON.stringify(exp) })
        .onConflictDoUpdate({
          target: schema.experiments.id,
          set: { data: JSON.stringify(exp) },
        })
        .run();
    } catch (err) {
      logger.error("db.save_experiment_failed", { exp_id: exp.id, error: String(err) });
    }
  }

  deleteExperiment(id: string): void {
    this.experiments.delete(id);
    try {
      this.db.delete(schema.experiments).where(eq(schema.experiments.id, id)).run();
    } catch (err) {
      logger.error("db.delete_experiment_failed", { exp_id: id, error: String(err) });
    }
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

  // ─── Persistence ────────────────────────────────────────────────────────

  startPersistence(): void {
    setInterval(() => this._autoBackup(), BACKUP_INTERVAL);
    setInterval(() => {
      try {
        this.sqlite.pragma("wal_checkpoint(PASSIVE)");
      } catch (err) {
        logger.error("state.wal_checkpoint_failed", { error: String(err) });
      }
    }, WAL_CHECKPOINT_INTERVAL);
  }

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

  save(): void {
    try {
      this.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      logger.info("state.save", { file: DB_FILE, sync: true });
    } catch (err) {
      logger.error("state.save_failed", { error: String(err) });
    }
  }

  async saveAsync(): Promise<void> {
    try {
      this.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      logger.info("state.save", { file: DB_FILE });
    } catch (err) {
      logger.error("state.save_failed", { error: String(err) });
    }
  }

  load(): void {
    // Called from constructor via _loadFromDb — no-op here.
  }

  loadFromState(state: ServerState): void {
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
    this.db.delete(schema.stubs).run();
    this.db.delete(schema.tokens).run();
    this.db.delete(schema.tasks).run();
    this.db.delete(schema.grids).run();
    this.db.delete(schema.experiments).run();
    this.db.delete(schema.meta).run();

    this._applyState(state);
    logger.info("state.restore", { stubs: this.stubs.size });
  }

  private _applyState(state: ServerState): void {
    this.db.transaction((tx) => {
      for (const stub of state.stubs || []) {
        stub.socket_id = undefined;
        stub.status = "offline";
        this.stubs.set(stub.id, stub);
        this._saveStub(stub);
      }
      for (const token of state.tokens || []) {
        this.tokens.set(token.token, token);
        tx.insert(schema.tokens)
          .values({ token: token.token, name: token.name, created_at: token.created_at })
          .onConflictDoUpdate({
            target: schema.tokens.token,
            set: { name: token.name, created_at: token.created_at },
          })
          .run();
      }
      for (const grid of state.grids || []) {
        this.grids.set(grid.id, grid);
        tx.insert(schema.grids)
          .values({ id: grid.id, data: JSON.stringify(grid) })
          .onConflictDoUpdate({ target: schema.grids.id, set: { data: JSON.stringify(grid) } })
          .run();
      }
      for (const exp of state.experiments || []) {
        this.experiments.set(exp.id, exp);
        tx.insert(schema.experiments)
          .values({ id: exp.id, data: JSON.stringify(exp) })
          .onConflictDoUpdate({ target: schema.experiments.id, set: { data: JSON.stringify(exp) } })
          .run();
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
        tx.insert(schema.meta)
          .values({ key: "seq_counter", value: String(this.seqCounter) })
          .onConflictDoUpdate({ target: schema.meta.key, set: { value: String(this.seqCounter) } })
          .run();
      }

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
        for (const t of stub.tasks) this._saveTask(t, "stub");
      }
    });

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

    this.db.delete(schema.stubs).run();
    this.db.delete(schema.tokens).run();
    this.db.delete(schema.tasks).run();
    this.db.delete(schema.grids).run();
    this.db.delete(schema.experiments).run();
    this.db.delete(schema.meta).run();
  }
}

export const store = new Store();
