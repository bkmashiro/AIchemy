/**
 * store/index.ts — Drizzle ORM + SQLite state management.
 *
 * SQLite is the single source of truth for tasks.
 * In-memory: stubs (with running tasks), tokens, grids, experiments.
 * All task reads/writes for archive + globalQueue go through the DB.
 *
 * Tables: stubs, tokens, tasks, grids, experiments, meta
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq, sql, and, desc, asc, not, inArray, lte, or, type SQLWrapper } from "drizzle-orm";
import * as schema from "./schema";
import {
  Stub,
  Task,
  Grid,
  Token,
  Experiment,
  ExperimentEvent,
  ServerState,
  TaskStatus,
  WebhookSubscription,
  WebhookEvent,
  WebhookDelivery,
  WebhookDeliveryOutbox,
  WebhookOutboxStatus,
  TaskMark,
} from "../types";
import { alchemyEvents } from "../events";
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
  private grids: Map<string, Grid> = new Map();
  private experiments: Map<string, Experiment> = new Map();
  private webhookSubscriptions: Map<string, WebhookSubscription> = new Map();
  private seqCounter: number = 0;
  private fingerprintIndex: FingerprintIndex = new Map();
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
      CREATE TABLE IF NOT EXISTS task_marks (
        task_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        watched INTEGER NOT NULL DEFAULT 0,
        read_at TEXT,
        acked_at TEXT,
        note TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(task_id, actor)
      );
      CREATE INDEX IF NOT EXISTS idx_task_marks_actor ON task_marks(actor);
      CREATE TABLE IF NOT EXISTS grids (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiments (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiment_events (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL,
        task_id TEXT,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        actor TEXT,
        data_json TEXT,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_experiment_events_experiment_time
        ON experiment_events(experiment_id, created_at);
      CREATE TABLE IF NOT EXISTS webhook_subscriptions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_name
        ON webhook_subscriptions(name);
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        event TEXT NOT NULL,
        task_id TEXT,
        status TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription_time
        ON webhook_deliveries(subscription_id, delivered_at);
      CREATE TABLE IF NOT EXISTS webhook_delivery_outbox (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        event TEXT NOT NULL,
        task_id TEXT NOT NULL,
        previous_status TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_delivery_outbox_status_next_retry
        ON webhook_delivery_outbox(status, next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_webhook_delivery_outbox_subscription
        ON webhook_delivery_outbox(subscription_id);
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

      // webhook subscriptions
      for (const row of this.db.select({ data: schema.webhookSubscriptions.data }).from(schema.webhookSubscriptions).all()) {
        const sub: WebhookSubscription = JSON.parse(row.data);
        this.webhookSubscriptions.set(sub.id, sub);
      }

      // seq counter
      const seqRow = this.db.select({ value: schema.meta.value })
        .from(schema.meta)
        .where(eq(schema.meta.key, "seq_counter"))
        .get();
      this.seqCounter = seqRow ? parseInt(seqRow.value, 10) : 0;

      // tasks with location='stub' — load onto stubs or move to archive
      const stubTaskRows = this.db.select({ data: schema.tasks.data })
        .from(schema.tasks)
        .where(eq(schema.tasks.location, "stub"))
        .all();
      for (const row of stubTaskRows) {
        const task: Task = JSON.parse(row.data);
        if (task.stub_id) {
          const stub = this.stubs.get(task.stub_id);
          if (stub && this._isActive(task.status)) {
            stub.tasks.push(task);
          } else {
            // Stub gone or task terminal — move to archive in DB
            this._truncateLogBuffer(task);
            this._saveTask(task, "archive");
          }
        } else {
          this._truncateLogBuffer(task);
          this._saveTask(task, "archive");
        }
      }

      // Prune archive in DB
      this._pruneArchive();

      this.rebuildFingerprintIndex();
      this._rebuildTaskIndex();

      const archiveCount = this._getArchiveCount();
      const queueCount = this._getGlobalQueueCount();

      logger.info("state.load", {
        stubs: this.stubs.size,
        tokens: this.tokens.size,
        grids: this.grids.size,
        experiments: this.experiments.size,
        seq: this.seqCounter,
        archive: archiveCount,
        queue: queueCount,
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

  // ─── DB query helpers ──────────────────────────────────────────────────

  private _getArchiveCount(): number {
    const row = this.db.select({ count: sql<number>`count(*)` })
      .from(schema.tasks)
      .where(eq(schema.tasks.location, "archive"))
      .get();
    return row?.count ?? 0;
  }

  private _getGlobalQueueCount(): number {
    const row = this.db.select({ count: sql<number>`count(*)` })
      .from(schema.tasks)
      .where(eq(schema.tasks.location, "global"))
      .get();
    return row?.count ?? 0;
  }

  private _queryArchiveTasks(): Task[] {
    const rows = this.db.select({ data: schema.tasks.data })
      .from(schema.tasks)
      .where(eq(schema.tasks.location, "archive"))
      .all();
    const tasks: Task[] = [];
    for (const row of rows) {
      try { tasks.push(JSON.parse(row.data) as Task); } catch { /* skip corrupt */ }
    }
    return tasks;
  }

  private _queryGlobalQueueTasks(): Task[] {
    const rows = this.db.select({ data: schema.tasks.data })
      .from(schema.tasks)
      .where(eq(schema.tasks.location, "global"))
      .all();
    const tasks: Task[] = [];
    for (const row of rows) {
      try { tasks.push(JSON.parse(row.data) as Task); } catch { /* skip corrupt */ }
    }
    return tasks;
  }

  private _findTaskInDb(taskId: string): Task | undefined {
    const row = this.db.select({ data: schema.tasks.data })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    if (!row) return undefined;
    try { return JSON.parse(row.data) as Task; } catch { return undefined; }
  }

  private _findGlobalQueueTaskInDb(taskId: string): Task | undefined {
    const row = this.db.select({ data: schema.tasks.data })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.location, "global")))
      .get();
    if (!row) return undefined;
    try { return JSON.parse(row.data) as Task; } catch { return undefined; }
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
          this._saveTask(task, "archive");
          this._taskIndex.set(task.id, { location: "archive" });
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

  // ─── Webhook Subscriptions ──────────────────────────────────────────────

  listWebhookSubscriptions(): WebhookSubscription[] {
    return Array.from(this.webhookSubscriptions.values()).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  getWebhookSubscription(idOrName: string): WebhookSubscription | undefined {
    return this.webhookSubscriptions.get(idOrName)
      ?? Array.from(this.webhookSubscriptions.values()).find((s) => s.name === idOrName);
  }

  addWebhookSubscription(input: {
    id?: string;
    name: string;
    url: string;
    events: WebhookEvent[];
    enabled?: boolean;
    secret?: string;
  }): WebhookSubscription {
    const timestamp = new Date().toISOString();
    const sub: WebhookSubscription = {
      id: input.id ?? randomUUID(),
      name: input.name,
      url: input.url,
      events: input.events,
      enabled: input.enabled ?? true,
      secret: input.secret,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.webhookSubscriptions.set(sub.id, sub);
    this._saveWebhookSubscription(sub);
    return sub;
  }

  deleteWebhookSubscription(idOrName: string): boolean {
    const sub = this.getWebhookSubscription(idOrName);
    if (!sub) return false;
    this.webhookSubscriptions.delete(sub.id);
    this.db.delete(schema.webhookSubscriptions).where(eq(schema.webhookSubscriptions.id, sub.id)).run();
    return true;
  }

  private _saveWebhookSubscription(sub: WebhookSubscription): void {
    this.db.insert(schema.webhookSubscriptions)
      .values({ id: sub.id, name: sub.name, url: sub.url, enabled: sub.enabled ? 1 : 0, data: JSON.stringify(sub) })
      .onConflictDoUpdate({
        target: schema.webhookSubscriptions.id,
        set: { name: sub.name, url: sub.url, enabled: sub.enabled ? 1 : 0, data: JSON.stringify(sub) },
      })
      .run();
  }

  recordWebhookDelivery(input: Omit<WebhookDelivery, "id" | "delivered_at"> & { id?: string; delivered_at?: string }): WebhookDelivery {
    const delivery: WebhookDelivery = {
      ...input,
      id: input.id ?? randomUUID(),
      delivered_at: input.delivered_at ?? new Date().toISOString(),
    };
    this.db.insert(schema.webhookDeliveries)
      .values({
        id: delivery.id,
        subscription_id: delivery.subscription_id,
        event: delivery.event,
        task_id: delivery.task_id,
        status: delivery.status,
        delivered_at: delivery.delivered_at,
        data: JSON.stringify(delivery),
      })
      .run();
    return delivery;
  }

  listWebhookDeliveries(subscriptionIdOrName?: string, limit = 20): WebhookDelivery[] {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const sub = subscriptionIdOrName ? this.getWebhookSubscription(subscriptionIdOrName) : undefined;
    const rows = sub
      ? this.db.select({ data: schema.webhookDeliveries.data })
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.subscription_id, sub.id))
        .orderBy(desc(schema.webhookDeliveries.delivered_at))
        .limit(safeLimit)
        .all()
      : this.db.select({ data: schema.webhookDeliveries.data })
        .from(schema.webhookDeliveries)
        .orderBy(desc(schema.webhookDeliveries.delivered_at))
        .limit(safeLimit)
        .all();
    return rows.map((row) => JSON.parse(row.data) as WebhookDelivery);
  }

  private _coerceOutboxStatus(value: string): WebhookOutboxStatus {
    if (value === "pending" || value === "in_flight" || value === "succeeded" || value === "exhausted") {
      return value;
    }
    return "exhausted";
  }

  private _rowToWebhookOutbox(row: typeof schema.webhookDeliveryOutbox.$inferSelect): WebhookDeliveryOutbox {
    return {
      id: row.id,
      delivery_id: row.delivery_id,
      subscription_id: row.subscription_id,
      event: row.event as WebhookEvent,
      task_id: row.task_id,
      previous_status: row.previous_status as TaskStatus,
      status: this._coerceOutboxStatus(row.status),
      attempt_count: row.attempt_count,
      max_attempts: row.max_attempts,
      next_retry_at: row.next_retry_at,
      last_error: row.last_error ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private _parseOutboxRows(rows: Array<typeof schema.webhookDeliveryOutbox.$inferSelect>): WebhookDeliveryOutbox[] {
    return rows.map((row) => this._rowToWebhookOutbox(row));
  }

  getWebhookDeliveryOutboxById(id: string): WebhookDeliveryOutbox | undefined {
    const row = this.db
      .select()
      .from(schema.webhookDeliveryOutbox)
      .where(eq(schema.webhookDeliveryOutbox.id, id))
      .get();
    if (!row) return undefined;
    return this._rowToWebhookOutbox(row);
  }

  listWebhookDeliveryOutbox(options: {
    subscriptionId?: string;
    status?: WebhookOutboxStatus | WebhookOutboxStatus[];
    dueBefore?: string;
    limit?: number;
  } = {}): WebhookDeliveryOutbox[] {
    const safeLimit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const predicates: SQLWrapper[] = [];
    if (options.subscriptionId) {
      predicates.push(eq(schema.webhookDeliveryOutbox.subscription_id, options.subscriptionId));
    }
    if (options.dueBefore) {
      predicates.push(lte(schema.webhookDeliveryOutbox.next_retry_at, options.dueBefore));
    }
    if (options.status) {
      if (Array.isArray(options.status)) {
        const statusPredicates = options.status.map((status) => eq(schema.webhookDeliveryOutbox.status, status));
        const statusFilter = or(...statusPredicates);
        if (statusFilter) predicates.push(statusFilter);
      } else {
        predicates.push(eq(schema.webhookDeliveryOutbox.status, options.status));
      }
    }

    const whereClause = and(...predicates);
    const rows = !whereClause
      ? this.db
        .select()
        .from(schema.webhookDeliveryOutbox)
        .orderBy(asc(schema.webhookDeliveryOutbox.next_retry_at))
        .limit(safeLimit)
        .all()
      : this.db
        .select()
        .from(schema.webhookDeliveryOutbox)
        .where(whereClause)
        .orderBy(asc(schema.webhookDeliveryOutbox.next_retry_at))
        .limit(safeLimit)
        .all();
    return this._parseOutboxRows(rows);
  }

  createWebhookDeliveryOutbox(input: Omit<WebhookDeliveryOutbox, "id" | "created_at" | "updated_at"> & { id?: string }): WebhookDeliveryOutbox {
    const now = new Date().toISOString();
    const outbox: WebhookDeliveryOutbox = {
      ...input,
      id: input.id ?? randomUUID(),
      created_at: now,
      updated_at: now,
    };

    this.db.insert(schema.webhookDeliveryOutbox)
      .values({
        id: outbox.id,
        delivery_id: outbox.delivery_id,
        subscription_id: outbox.subscription_id,
        event: outbox.event,
        task_id: outbox.task_id,
        previous_status: outbox.previous_status,
        status: outbox.status,
        attempt_count: outbox.attempt_count,
        max_attempts: outbox.max_attempts,
        next_retry_at: outbox.next_retry_at,
        last_error: outbox.last_error ?? null,
        created_at: outbox.created_at,
        updated_at: outbox.updated_at,
      })
      .onConflictDoUpdate({
        target: schema.webhookDeliveryOutbox.id,
        set: {
          delivery_id: outbox.delivery_id,
          subscription_id: outbox.subscription_id,
          event: outbox.event,
          task_id: outbox.task_id,
          previous_status: outbox.previous_status,
          status: outbox.status,
          attempt_count: outbox.attempt_count,
          max_attempts: outbox.max_attempts,
          next_retry_at: outbox.next_retry_at,
          last_error: outbox.last_error ?? null,
          updated_at: outbox.updated_at,
        },
      })
      .run();

    return outbox;
  }

  updateWebhookDeliveryOutbox(
    id: string,
    updates: Partial<Pick<WebhookDeliveryOutbox, "status" | "attempt_count" | "next_retry_at" | "last_error">>,
  ): WebhookDeliveryOutbox | undefined {
    const now = new Date().toISOString();
    const values: Record<string, unknown> = { updated_at: now };
    if (updates.status !== undefined) values.status = updates.status;
    if (updates.attempt_count !== undefined) values.attempt_count = updates.attempt_count;
    if (updates.next_retry_at !== undefined) values.next_retry_at = updates.next_retry_at;
    if (updates.last_error !== undefined) values.last_error = updates.last_error;

    if (Object.keys(values).length > 1) {
      this.db.update(schema.webhookDeliveryOutbox)
        .set(values)
        .where(eq(schema.webhookDeliveryOutbox.id, id))
        .run();
    }

    return this.getWebhookDeliveryOutboxById(id);
  }

  deleteWebhookDeliveryOutbox(id: string): void {
    this.db.delete(schema.webhookDeliveryOutbox).where(eq(schema.webhookDeliveryOutbox.id, id)).run();
  }

  // ─── Task Marks ────────────────────────────────────────────────────────

  private _rowToTaskMark(row: typeof schema.taskMarks.$inferSelect): TaskMark {
    return {
      task_id: row.task_id,
      actor: row.actor,
      pinned: row.pinned === 1,
      watched: row.watched === 1,
      read_at: row.read_at ?? undefined,
      acked_at: row.acked_at ?? undefined,
      note: row.note ?? undefined,
      updated_at: row.updated_at,
    };
  }

  private _findTaskMark(taskId: string, actor: string): TaskMark | undefined {
    const row = this.db.select()
      .from(schema.taskMarks)
      .where(and(eq(schema.taskMarks.task_id, taskId), eq(schema.taskMarks.actor, actor)))
      .get();
    if (!row) return undefined;
    return this._rowToTaskMark(row);
  }

  getTaskMark(taskId: string, actor: string): TaskMark | undefined {
    const normalizedActor = this._normalizeTaskMarkActor(actor);
    this._validateTaskMarkInputs(taskId, normalizedActor);
    return this._findTaskMark(taskId, normalizedActor);
  }

  listTaskMarks(actor?: string): TaskMark[] {
    const rows: Array<typeof schema.taskMarks.$inferSelect> = actor
      ? this.db
        .select()
        .from(schema.taskMarks)
        .where(eq(schema.taskMarks.actor, this._normalizeTaskMarkActor(actor)))
        .all()
      : this.db.select().from(schema.taskMarks).all();

    return rows.map((row) => this._rowToTaskMark(row));
  }

  setTaskMark(taskId: string, actor: string, patch: Partial<Omit<TaskMark, "task_id" | "actor" | "updated_at">> & { updated_at?: string }): TaskMark {
    const normalizedActor = this._normalizeTaskMarkActor(actor);
    this._validateTaskMarkInputs(taskId, normalizedActor);

    const now = patch.updated_at ?? new Date().toISOString();
    const existing = this._findTaskMark(taskId, normalizedActor);
    const next: TaskMark = {
      task_id: taskId,
      actor: normalizedActor,
      pinned: existing?.pinned ?? false,
      watched: existing?.watched ?? false,
      read_at: existing?.read_at,
      acked_at: existing?.acked_at,
      note: existing?.note,
      updated_at: now,
    };

    if (patch.pinned !== undefined) next.pinned = patch.pinned;
    if (patch.watched !== undefined) next.watched = patch.watched;
    if (patch.read_at !== undefined) next.read_at = patch.read_at;
    if (patch.acked_at !== undefined) next.acked_at = patch.acked_at;

    if (Object.prototype.hasOwnProperty.call(patch, "note")) {
      const patchAny = patch as { note?: string | null | undefined };
      if (patchAny.note === null) {
        next.note = undefined;
      } else if (patchAny.note !== undefined) {
        next.note = patchAny.note;
      }
    }

    this.db.insert(schema.taskMarks)
      .values({
        task_id: next.task_id,
        actor: next.actor,
        pinned: next.pinned ? 1 : 0,
        watched: next.watched ? 1 : 0,
        read_at: next.read_at ?? null,
        acked_at: next.acked_at ?? null,
        note: next.note ?? null,
        updated_at: next.updated_at,
      })
      .onConflictDoUpdate({
        target: [schema.taskMarks.task_id, schema.taskMarks.actor],
        set: {
          pinned: next.pinned ? 1 : 0,
          watched: next.watched ? 1 : 0,
          read_at: next.read_at ?? null,
          acked_at: next.acked_at ?? null,
          note: next.note ?? null,
          updated_at: next.updated_at,
        },
      })
      .run();

    return next;
  }

  private _normalizeTaskMarkActor(actor: string): string {
    if (typeof actor !== "string") {
      throw new Error("Invalid task mark actor");
    }
    const normalized = actor.trim();
    if (!normalized) {
      throw new Error("Invalid task mark actor");
    }
    return normalized;
  }

  private _validateTaskMarkInputs(taskId: string, actor: string): void {
    if (typeof taskId !== "string" || taskId.trim() === "") {
      throw new Error("Invalid task mark task_id");
    }
    if (!actor) {
      throw new Error("Invalid task mark actor");
    }
  }

  // ─── Tasks ──────────────────────────────────────────────────────────────

  getAllTasks(): Task[] {
    const tasks: Task[] = [];
    const seenIds = new Set<string>();

    // Stub tasks (in-memory, transient)
    for (const stub of this.stubs.values()) {
      for (const t of stub.tasks) {
        tasks.push(t);
        seenIds.add(t.id);
      }
    }

    // All DB tasks (global + archive)
    try {
      const dbRows = this.db.select({ data: schema.tasks.data })
        .from(schema.tasks)
        .where(not(eq(schema.tasks.location, "stub")))
        .all();
      for (const row of dbRows) {
        try {
          const task = JSON.parse(row.data) as Task;
          if (!seenIds.has(task.id)) {
            tasks.push(task);
            seenIds.add(task.id);
          }
        } catch { /* skip corrupt rows */ }
      }
    } catch (err) {
      logger.error("db.get_all_tasks_failed", { error: String(err) });
    }
    return tasks;
  }

  getActiveTasks(): Task[] {
    const tasks: Task[] = [...this._queryGlobalQueueTasks()];
    for (const stub of this.stubs.values()) {
      tasks.push(...stub.tasks);
    }
    return tasks;
  }

  getArchive(): Task[] {
    return this._queryArchiveTasks();
  }

  setArchive(tasks: Task[]): void {
    this.db.transaction((tx) => {
      // Delete all current archive tasks
      tx.delete(schema.tasks).where(eq(schema.tasks.location, "archive")).run();
      // Insert the new set
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
    // Remove from _taskIndex any archive tasks that were deleted
    for (const [id, entry] of this._taskIndex) {
      if (entry.location === "archive" && !tasks.some((t) => t.id === id)) {
        this._taskIndex.delete(id);
      }
    }
  }

  removeFromArchive(taskId: string): Task | undefined {
    const task = this._findTaskInDb(taskId);
    if (!task) return undefined;
    // Verify it's in archive
    const row = this.db.select({ location: schema.tasks.location })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    if (!row || row.location !== "archive") return undefined;
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

  private _pruneArchive(): void {
    const count = this._getArchiveCount();
    if (count <= ARCHIVE_MAX) return;

    // Preserve historical task rows. For archive entries beyond the hot window,
    // strip log buffers only; API/query limits decide how much history to show.
    const coldCount = count - ARCHIVE_MAX;
    const coldRows = this.db.all(
      sql`SELECT id, data FROM tasks WHERE location = 'archive' ORDER BY COALESCE(json_extract(data, '$.finished_at'), created_at) ASC LIMIT ${coldCount}`
    ) as { id: string; data: string }[];

    let trimmed = 0;
    for (const row of coldRows) {
      try {
        const task = JSON.parse(row.data) as Task;
        if (!task.log_buffer || task.log_buffer.length === 0) continue;
        task.log_buffer = [];
        this._saveTask(task, "archive");
        trimmed++;
      } catch {
        // Keep corrupt rows for manual inspection rather than silently deleting them.
      }
    }
    if (trimmed > 0) logger.info("archive.prune_logs", { trimmed, archive_count: count });
  }

  unarchiveTask(stubId: string, taskId: string, update: Partial<Task>): Task | undefined {
    const stub = this.stubs.get(stubId);
    if (!stub) return undefined;

    // Find task in DB (archive)
    const task = this._findTaskInDb(taskId);
    if (!task) return undefined;

    if (update.status && !canTransition(task.status, update.status)) {
      logger.warn("unarchiveTask.illegal_transition", { taskId, from: task.status, to: update.status });
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
    return this._queryGlobalQueueTasks().sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.created_at.localeCompare(b.created_at);
    });
  }

  addToGlobalQueue(task: Task): void {
    task.stub_id = undefined;
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
    const task = this._findGlobalQueueTaskInDb(taskId);
    if (!task) return undefined;
    this._taskIndex.delete(taskId);
    this._deleteTask(taskId);
    return task;
  }

  updateGlobalQueueTask(taskId: string, update: Partial<Task>): Task | undefined {
    const prev = this._findGlobalQueueTaskInDb(taskId);
    if (!prev) return undefined;

    if (update.status && update.status !== prev.status) {
      if (!canTransition(prev.status, update.status)) {
        logger.error("state.illegal_transition", { task_id: taskId, from: prev.status, to: update.status });
        return undefined;
      }
    }
    const updated = { ...prev, ...update };

    if (this._isActive(prev.status) && !this._isActive(updated.status)) {
      // Move to archive
      const archived = { ...updated };
      this._truncateLogBuffer(archived);
      this._saveTask(archived, "archive");
      this._taskIndex.set(taskId, { location: "archive" });
      this._pruneArchive();
    } else {
      try {
        this._saveTask(updated, "global");
      } catch (err) {
        logger.error("db.save_task_failed", { task_id: updated.id, error: String(err) });
      }
    }

    this._reindexTask(prev, updated);
    this._emitTaskStatusChange(prev, updated);
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
        const task = this._findGlobalQueueTaskInDb(taskId);
        if (task) return { task, stubId: null };
      } else if (entry.location === "archive") {
        const task = this._findTaskInDb(taskId);
        if (task) return { task, stubId: task.stub_id || null, archived: true };
      }
    }
    // Slow fallback: check stubs
    for (const stub of this.stubs.values()) {
      const task = stub.tasks.find((t) => t.id === taskId);
      if (task) {
        this._taskIndex.set(taskId, { stubId: stub.id, location: "stub" });
        return { task, stubId: stub.id };
      }
    }
    // DB fallback
    try {
      const row = this.db.select({ data: schema.tasks.data, location: schema.tasks.location })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .get();
      if (row) {
        const task = JSON.parse(row.data) as Task;
        if (row.location === "global") {
          this._taskIndex.set(taskId, { location: "global" });
          return { task, stubId: null };
        } else {
          this._taskIndex.set(taskId, { location: "archive" });
          return { task, stubId: task.stub_id || null, archived: true };
        }
      }
    } catch { /* skip */ }
    return undefined;
  }

  updateArchivedTask(taskId: string, update: Partial<Task>): Task | undefined {
    const located = this.findTask(taskId);
    if (!located?.archived) return undefined;
    const updated = { ...located.task, ...update };
    this._saveTask(updated, "archive");
    this._taskIndex.set(taskId, { location: "archive" });
    this._reindexTask(located.task, updated);
    return updated;
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
    this._emitTaskStatusChange(prev, updated);
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

  private _emitTaskStatusChange(prev: Task, updated: Task): void {
    if (prev.status !== updated.status) {
      alchemyEvents.emitTaskStatusChanged(prev, updated);
    }
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
    if (found.task.kill_requested) return undefined;
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
    // Global queue from DB
    const globalTasks = this._queryGlobalQueueTasks();
    for (const task of globalTasks) {
      this._taskIndex.set(task.id, { location: "global" });
    }
    // Stubs (in-memory)
    for (const stub of this.stubs.values()) {
      for (const task of stub.tasks) {
        this._taskIndex.set(task.id, { stubId: stub.id, location: "stub" });
      }
    }
    // Archive from DB
    const archiveTasks = this._queryArchiveTasks();
    for (const task of archiveTasks) {
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
    const seenIds = new Set(active.map((t) => t.id));

    // Query archived tasks with this grid_id from DB
    const archiveRows = this.db.select({ data: schema.tasks.data })
      .from(schema.tasks)
      .where(eq(schema.tasks.location, "archive"))
      .all();
    const archived: Task[] = [];
    for (const row of archiveRows) {
      try {
        const t = JSON.parse(row.data) as Task;
        if (t.grid_id === gridId && !seenIds.has(t.id)) {
          archived.push(t);
        }
      } catch { /* skip */ }
    }
    return [...active, ...archived];
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
      // Intentionally do not delete experiment_events. Timeline events are
      // append-only audit history and must survive experiment soft deletion.
      this.db.delete(schema.experiments).where(eq(schema.experiments.id, id)).run();
    } catch (err) {
      logger.error("db.delete_experiment_failed", { exp_id: id, error: String(err) });
    }
  }

  addExperimentEvent(event: ExperimentEvent): void {
    this.db.insert(schema.experimentEvents)
      .values({
        id: event.id,
        experiment_id: event.experiment_id,
        task_id: event.task_id ?? null,
        kind: event.kind,
        message: event.message,
        actor: event.actor ?? null,
        data_json: event.data ? JSON.stringify(event.data) : null,
        created_at: event.created_at,
        deleted_at: event.deleted_at ?? null,
      })
      .run();
  }

  getExperimentEvents(experimentId: string): ExperimentEvent[] {
    const rows = this.db.select().from(schema.experimentEvents)
      .where(eq(schema.experimentEvents.experiment_id, experimentId))
      .orderBy(asc(schema.experimentEvents.created_at))
      .all();
    return rows.map((row) => ({
      id: row.id,
      experiment_id: row.experiment_id,
      task_id: row.task_id ?? undefined,
      kind: row.kind as ExperimentEvent["kind"],
      message: row.message,
      actor: row.actor ?? undefined,
      data: row.data_json ? JSON.parse(row.data_json) : undefined,
      created_at: row.created_at,
      deleted_at: row.deleted_at ?? undefined,
    }));
  }

  softDeleteExperimentEvent(eventId: string, deletedAt: string = new Date().toISOString()): void {
    this.db.update(schema.experimentEvents)
      .set({ deleted_at: deletedAt })
      .where(eq(schema.experimentEvents.id, eventId))
      .run();
  }

  getBlockedTasksDependingOn(taskId: string): Task[] {
    // Query global queue for blocked tasks depending on taskId
    const globalTasks = this._queryGlobalQueueTasks();
    return globalTasks.filter(
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
      archive: this._queryArchiveTasks(),
      global_queue: this._queryGlobalQueueTasks(),
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
    this.grids.clear();
    this.experiments.clear();
    this.webhookSubscriptions.clear();
    this.fingerprintIndex.clear();
    this._taskIndex.clear();
    this.seqCounter = 0;

    // Clear DB
    this.db.delete(schema.stubs).run();
    this.db.delete(schema.tokens).run();
    this.db.delete(schema.tasks).run();
    this.db.delete(schema.grids).run();
    this.db.delete(schema.experiments).run();
    this.db.delete(schema.webhookSubscriptions).run();
    this.db.delete(schema.webhookDeliveries).run();
    this.db.delete(schema.webhookDeliveryOutbox).run();
    this.db.delete(schema.experimentEvents).run();
    this.db.delete(schema.meta).run();
    this.db.delete(schema.taskMarks).run();

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
        for (const t of state.archive) {
          this._truncateLogBuffer(t);
          this._saveTask(t, "archive");
        }
      }
      if (state.global_queue) {
        for (const t of state.global_queue) this._saveTask(t, "global");
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
            this._saveTask(t, "archive");
          }
          this._saveStub(stub);
        }
        for (const t of stub.tasks) this._saveTask(t, "stub");
      }
    });

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
    this.grids.clear();
    this.experiments.clear();
    this.webhookSubscriptions.clear();
    this.fingerprintIndex.clear();
    this._taskIndex.clear();
    this.seqCounter = 0;
    writeLockTable.clear();

    this.db.delete(schema.stubs).run();
    this.db.delete(schema.tokens).run();
    this.db.delete(schema.tasks).run();
    this.db.delete(schema.grids).run();
    this.db.delete(schema.experiments).run();
    this.db.delete(schema.webhookSubscriptions).run();
    this.db.delete(schema.webhookDeliveries).run();
    this.db.delete(schema.webhookDeliveryOutbox).run();
    this.db.delete(schema.experimentEvents).run();
    this.db.delete(schema.meta).run();
    this.db.delete(schema.taskMarks).run();
  }
}

export const store = new Store();
