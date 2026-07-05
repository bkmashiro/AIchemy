/**
 * api/tasks.ts — Global task CRUD.
 *
 * POST /tasks — submit to global queue with fingerprint dedup + write lock check.
 * PATCH /tasks/:id — status/priority/name/should_stop.
 * POST /tasks/batch — batch kill/retry/requeue/delete.
 * POST /tasks/:id/retry — manual retry.
 */

import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { store } from "../store";
import { Task, TaskMark } from "../types";
import { Namespace } from "socket.io";
import {
  computeFingerprint, writeLockTable, idempotencyCache,
} from "../dedup";
import { triggerSchedule, maybeDispatch } from "../scheduler";
import { notifySubmitted } from "../discord";
import { initiateKillChain } from "../socket/stub";
import { cancelTask, cancelGlobalTask, pauseTask, resumeTask, createRetryTask } from "../task-actions";
import { reliableEmitToStub } from "../reliable";
import { logger } from "../log";
import { assembleCommand } from "../command";
export { assembleCommand, buildCommandArgv } from "../command";

// ─── Display name generation ──────────────────────────────────────────────────

export function generateDisplayName(task: Partial<Task>): string {
  if (task.name) return task.name;
  if (task.script) {
    const base = path.basename(task.script);
    if (task.args) {
      if (typeof task.args === "string") {
        const trimmed = task.args.trim();
        if (trimmed) return `${base} ${trimmed}`;
      } else if (Object.keys(task.args).length > 0) {
        const argsSummary = Object.entries(task.args)
          .map(([k, v]) => {
            // Remove leading dashes from key
            const shortKey = k.replace(/^-+/, "");
            return `${shortKey}=${v}`;
          })
          .join(" ");
        return `${base} ${argsSummary}`;
      }
    }
    return base;
  }
  if (task.command) {
    // Extract last meaningful segment
    const parts = task.command.trim().split(/\s+/);
    const lastPart = parts[parts.length - 1];
    return path.basename(lastPart) || task.command.slice(0, 60);
  }
  return "task";
}

// ─── Task creation helper ─────────────────────────────────────────────────────

export interface TaskInput {
  script: string;
  argv?: string[];
  args?: Record<string, string> | string;
  raw_args?: string;
  name?: string;
  cwd?: string;
  env_setup?: string;
  env?: Record<string, string>;
  env_overrides?: Record<string, string>;
  requirements?: Task["requirements"];
  priority?: number;
  max_retries?: number;
  run_dir?: string;
  grid_id?: string;
  param_overrides?: Record<string, any>;
  idempotency_key?: string;
  stub_id?: string;
  target_stub_id?: string;
  target_tags?: string[];
  python_env?: string;
  submitted_by?: string;
  depends_on?: string[];
  ref?: string;
  args_template?: Record<string, string>;
  experiment_id?: string;
  outputs?: string[];
  metric_schema?: Record<string, string>;
  result_schema?: Record<string, string>;
  ref_template?: string;
  param_point?: Record<string, any>;
  resolved_config?: Record<string, any>;
  auto_retry_on?: number[];
}

export function createTask(input: TaskInput): Task {
  const fingerprint = computeFingerprint({
    script: input.script,
    argv: input.argv,
    args: input.args,
    raw_args: input.raw_args,
    param_overrides: input.param_overrides,
    cwd: input.cwd,
  });

  const seq = store.nextSeq();

  const partial: Partial<Task> = {
    script: input.script,
    argv: input.argv,
    args: input.args,
    raw_args: input.raw_args,
    name: input.name,
    cwd: input.cwd,
    env_setup: input.env_setup,
    env: input.env,
  };

  const command = assembleCommand(partial);
  const display_name = generateDisplayName({ ...partial, command });

  const task: Task = {
    id: uuidv4(),
    seq,
    fingerprint,
    name: input.name,
    display_name,
    script: input.script,
    argv: input.argv,
    args: input.args,
    raw_args: input.raw_args,
    cwd: input.cwd,
    env_setup: input.env_setup,
    env: input.env,
    env_overrides: input.env_overrides,
    command,
    requirements: input.requirements,
    status: input.depends_on && input.depends_on.length > 0 ? "blocked" : "pending",
    priority: input.priority ?? 5,
    stub_id: input.stub_id,
    target_stub_id: input.target_stub_id,
    target_tags: input.target_tags,
    grid_id: input.grid_id,
    param_overrides: input.param_overrides,
    created_at: new Date().toISOString(),
    log_buffer: [],
    retry_count: 0,
    max_retries: input.max_retries ?? 0,
    auto_retry_on: input.auto_retry_on,
    should_stop: false,
    should_checkpoint: false,
    run_dir: input.run_dir,
    python_env: input.python_env,
    submitted_by: input.submitted_by,
    depends_on: input.depends_on,
    ref: input.ref,
    args_template: input.args_template,
    experiment_id: input.experiment_id,
    outputs: input.outputs,
    metric_schema: input.metric_schema,
    result_schema: input.result_schema,
    ref_template: input.ref_template,
    param_point: input.param_point,
    resolved_config: input.resolved_config,
  };

  return task;
}

// ─── Surgical task update/replace helpers ────────────────────────────────────

const TASK_SPEC_UPDATE_FIELDS = [
  "script", "argv", "args", "raw_args", "name", "cwd", "env_setup", "env", "env_overrides",
  "requirements", "priority", "max_retries", "target_stub_id", "target_tags", "python_env",
  "submitted_by", "outputs", "metric_schema", "result_schema", "resolved_config", "auto_retry_on",
] as const;

function pickTaskSpecUpdates(body: any): Partial<Task> {
  const update: Partial<Task> = {};
  for (const field of TASK_SPEC_UPDATE_FIELDS) {
    if (body[field] !== undefined) {
      (update as any)[field] = body[field];
    }
  }
  return update;
}

function hasTaskSpecUpdates(update: Partial<Task>): boolean {
  return Object.keys(update).length > 0;
}

function validateTaskSpecUpdate(update: Partial<Task>): string | undefined {
  if (update.env && typeof update.env === "object") {
    const invalidKey = Object.keys(update.env).find((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
    if (invalidKey) return `Invalid env key: "${invalidKey}"`;
  }
  if (update.script !== undefined && !String(update.script).startsWith("/")) {
    return `Script must be an absolute path, got: "${update.script}"`;
  }
  if (update.cwd !== undefined && update.cwd && !String(update.cwd).startsWith("/")) {
    return `cwd must be an absolute path, got: "${update.cwd}"`;
  }
  return undefined;
}

function reassembleTaskSpec(task: Task): Partial<Task> {
  const command = assembleCommand({
    script: task.script,
    argv: task.argv,
    args: task.args,
    raw_args: task.raw_args,
    cwd: task.cwd,
    env_setup: task.env_setup,
    env: task.env,
  });
  const display_name = generateDisplayName({
    script: task.script,
    args: task.args,
    raw_args: task.raw_args,
    name: task.name,
    command,
  });
  return { command, display_name };
}

function dependenciesAreCompleted(dependsOn?: string[]): boolean {
  if (!dependsOn || dependsOn.length === 0) return true;
  return dependsOn.every((depId) => store.findTask(depId)?.task.status === "completed");
}

function createReplacementTask(task: Task, overrides: Partial<Task>): Task {
  const merged: Task = { ...task, ...overrides };
  const replacement = createTask({
    script: merged.script,
    argv: merged.argv,
    args: merged.args,
    raw_args: merged.raw_args,
    name: merged.name,
    cwd: merged.cwd,
    env_setup: merged.env_setup,
    env: merged.env,
    env_overrides: merged.env_overrides,
    requirements: merged.requirements,
    priority: merged.priority,
    max_retries: merged.max_retries,
    grid_id: merged.grid_id,
    param_overrides: merged.param_overrides,
    target_stub_id: merged.target_stub_id,
    target_tags: merged.target_tags,
    python_env: merged.python_env,
    submitted_by: merged.submitted_by,
    depends_on: merged.depends_on,
    ref: merged.ref,
    args_template: merged.args_template,
    experiment_id: merged.experiment_id,
    outputs: merged.outputs,
    metric_schema: merged.metric_schema,
    result_schema: merged.result_schema,
    resolved_config: merged.resolved_config,
    auto_retry_on: merged.auto_retry_on,
  });
  replacement.retry_count = task.retry_count;
  replacement.status = dependenciesAreCompleted(replacement.depends_on) ? "pending" : "blocked";
  replacement.replaces_task_id = task.id;
  replacement.attempt = (task.attempt ?? 1) + 1;
  return replacement;
}

function rewireDownstreamBlockedDeps(oldTaskId: string, newTaskId: string, webNs?: Namespace): Task[] {
  const updated: Task[] = [];
  for (const task of store.getAllTasks()) {
    if (task.status !== "blocked" || !task.depends_on?.includes(oldTaskId)) continue;
    const nextDeps = task.depends_on.map((depId) => depId === oldTaskId ? newTaskId : depId);
    const next = store.updateGlobalQueueTask(task.id, { depends_on: nextDeps });
    if (next) {
      updated.push(next);
      webNs?.emit("task.update", next);
    }
  }
  return updated;
}

function updateExperimentCanonicalRef(task: Task, newTaskId: string): void {
  if (!task.experiment_id || !task.ref) return;
  const exp = store.getExperiment(task.experiment_id);
  if (!exp?.task_refs) return;
  if (exp.task_refs[task.ref] !== task.id) return;
  store.setExperiment({ ...exp, task_refs: { ...exp.task_refs, [task.ref]: newTaskId } });
}

// ─── Terminal statuses ────────────────────────────────────────────────────────
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];

const ACTIVE_STATUS_FOR_INBOX_ATTENTION: Task["status"][] = ["pending", "assigned", "running", "paused", "blocked"];

function shellQuoteForCommands(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

function buildInboxCommands(taskId: string, runDir?: string): string[] {
  const quotedTaskId = shellQuoteForCommands(taskId);
  const commands = [
    `alch tasks get ${quotedTaskId}`,
    `alch tasks logs ${quotedTaskId} --tail 200`,
  ];
  if (runDir) {
    commands.push(`ls -la ${shellQuoteForCommands(runDir)}`);
  }
  return commands;
}

function normalizeActor(rawActor: unknown): string {
  const actor = typeof rawActor === "string" ? rawActor.trim() : "akashi";
  return actor || "akashi";
}

function buildSuggestedNextAction(status: Task["status"], reasons: string[]): string {
  if (reasons.includes("blocked")) return "Inspect dependency / unblock";
  if (reasons.includes("disconnected")) return "Check stub and resume/inspect task";
  if (reasons.includes("failed")) return "Inspect failure logs and decide retry";
  if (reasons.includes("pinned")) return "Review when convenient";
  if (reasons.includes("watched")) return "Keep this task in follow-up queue";
  if (reasons.includes("terminal_unread")) return "Read task result";
  if (status === "failed") return "Investigate failure";
  return "Monitor progress";
}

function buildInboxBuckets(task: Task, mark: TaskMark | undefined): { buckets: string[]; reasons: string[] } {
  const buckets: string[] = [];
  const reasons: string[] = [];

  if (TERMINAL_STATUSES.includes(task.status) && !mark?.read_at) {
    buckets.push("unread_terminal");
    reasons.push("terminal_unread");
  }

  if (mark?.pinned) {
    buckets.push("pinned");
    reasons.push("pinned");
  }

  if (mark?.watched) {
    buckets.push("watched");
    reasons.push("watched");
  }

  if (task.status === "blocked") {
    buckets.push("blocked_needs_decision");
    reasons.push("blocked");
  }

  if (task.status === "failed") {
    buckets.push("failed_recent");
    reasons.push("failed");
  }

  if (ACTIVE_STATUS_FOR_INBOX_ATTENTION.includes(task.status) && !!task.disconnected_at) {
    buckets.push("active_attention");
    reasons.push("disconnected");
  }

  return { buckets: Array.from(new Set(buckets)), reasons: Array.from(new Set(reasons)) };
}

function getActorFromBody(req: Request): string {
  return normalizeActor((req.body as { actor?: unknown }).actor);
}

function getActorFromQuery(req: Request): string {
  return normalizeActor(req.query.actor);
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createGlobalTasksRouter(stubNs?: Namespace, webNs?: Namespace): Router {
  const router = Router();

  // GET /tasks — paginated:
  //   ?page=1&limit=50          (page-based, legacy)
  //   ?offset=0&limit=100       (offset-based, preferred)
  //   &status=running           (single status filter)
  //   &status_group=active|terminal
  //   &sort=seq|created_at      (default: seq)
  //   &order=asc|desc           (default: desc)
  router.get("/", (req: Request, res: Response) => {
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || "100"), 10) || 100));
    const statusFilter = req.query.status ? String(req.query.status) : undefined;
    const statusGroup = req.query.status_group ? String(req.query.status_group) : undefined;
    const includeLogs = req.query.logs === "true";
    const sortField = req.query.sort === "created_at" ? "created_at" : "seq";
    const sortOrder = req.query.order === "asc" ? "asc" : "desc";

    // Offset-based pagination (takes precedence over page-based)
    let offset: number;
    if (req.query.offset !== undefined) {
      offset = Math.max(0, parseInt(String(req.query.offset), 10) || 0);
    } else {
      const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
      offset = (page - 1) * limit;
    }

    const ACTIVE_STATUSES = ["running", "assigned", "pending", "paused", "blocked"];

    let tasks = store.getAllTasks();

    // Compute counts across ALL tasks before filtering
    const counts: Record<string, number> = {};
    for (const t of tasks) {
      counts[t.status] = (counts[t.status] ?? 0) + 1;
    }

    if (statusFilter) {
      tasks = tasks.filter((t) => t.status === statusFilter);
    } else if (statusGroup === "active") {
      tasks = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
    } else if (statusGroup === "terminal") {
      tasks = tasks.filter((t) => TERMINAL_STATUSES.includes(t.status));
    }

    // Sort by requested field and order
    tasks = tasks.sort((a, b) => {
      let cmp: number;
      if (sortField === "created_at") {
        cmp = (a.created_at || "").localeCompare(b.created_at || "");
      } else {
        cmp = (a.seq ?? 0) - (b.seq ?? 0);
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });

    const total = tasks.length;
    const paginated = tasks.slice(offset, offset + limit);

    const enriched = paginated.map((t) => {
      const stub = t.stub_id ? store.getStub(t.stub_id) : undefined;
      const stub_name = stub ? (stub.name || stub.hostname) : undefined;
      if (includeLogs) {
        return stub_name ? { ...t, stub_name } : t;
      }
      const { log_buffer, ...rest } = t;
      return stub_name ? { ...rest, stub_name } : rest;
    });

    // Compute current page for backward compat
    const page = Math.floor(offset / limit) + 1;
    res.json({ tasks: enriched, total, page, limit, offset, counts });
  });

  // GET /tasks/inbox — actor-scoped inbox with bucket/attention grouping
  router.get("/inbox", (req: Request, res: Response) => {
    const actor = getActorFromQuery(req);
    const limit = Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50);
    const requestedBucket = req.query.bucket ? String(req.query.bucket) : undefined;

    const allTasks = store.getAllTasks();
    type InboxItemWithSort = {
      task_id: string;
      seq: number;
      name: string;
      status: string;
      buckets: string[];
      why_interesting: string[];
      run_dir?: string;
      stub_id?: string;
      stub_name?: string;
      created_at?: string;
      started_at?: string;
      finished_at?: string;
      commands: string[];
      suggested_next_action: string;
      _sortSeq: number;
      _sortCreatedAt: string;
    };

    const deduped = new Map<string, InboxItemWithSort>();

    for (const task of allTasks) {
      const mark = store.getTaskMark(task.id, actor);
      const { buckets, reasons } = buildInboxBuckets(task, mark);
      if (requestedBucket) {
        if (!buckets.includes(requestedBucket)) continue;
      } else if (buckets.length === 0) {
        continue;
      }

      const stub = task.stub_id ? store.getStub(task.stub_id) : undefined;
      const stub_name = stub ? (stub.name || stub.hostname) : undefined;
      const item = {
        task_id: task.id,
        seq: task.seq,
        name: task.display_name || task.name || task.script,
        status: task.status,
        buckets,
        why_interesting: reasons,
        run_dir: task.run_dir,
        stub_id: task.stub_id,
        stub_name,
        created_at: task.created_at,
        started_at: task.started_at,
        finished_at: task.finished_at,
        commands: buildInboxCommands(task.id, task.run_dir),
        suggested_next_action: buildSuggestedNextAction(task.status, reasons),
        _sortSeq: task.seq ?? 0,
        _sortCreatedAt: task.created_at,
      };

      if (!deduped.has(task.id)) {
        deduped.set(task.id, item);
      }
    }

    type InboxItem = Omit<InboxItemWithSort, "_sortSeq" | "_sortCreatedAt">;

    let itemsWithSort = Array.from(deduped.values());
    itemsWithSort = itemsWithSort.sort((a, b) => {
      const diff = (b._sortSeq ?? 0) - (a._sortSeq ?? 0);
      if (diff !== 0) return diff;
      return (b._sortCreatedAt || "").localeCompare(a._sortCreatedAt || "");
    }).slice(0, limit);

    const items: InboxItem[] = itemsWithSort.map(({ _sortSeq, _sortCreatedAt, ...rest }) => rest);

    const summary: Record<string, number> = {};
    for (const item of items) {
      for (const bucket of item.buckets) {
        summary[bucket] = (summary[bucket] ?? 0) + 1;
      }
    }

    res.json({
      actor,
      generated_at: new Date().toISOString(),
      summary,
      items,
    });
  });

  // POST /tasks/batch — must be before /:id routes
  router.post("/batch", (req: Request, res: Response) => {
    if (!stubNs || !webNs) { res.status(503).json({ error: "Not ready" }); return; }
    const { action, task_ids } = req.body;
    if (!Array.isArray(task_ids)) {
      res.status(400).json({ error: "task_ids required" }); return;
    }

    const results: Array<{ id: string; ok: boolean; new_task_id?: string; error?: string }> = [];

    for (const taskId of task_ids) {
      const found = store.findTask(taskId);
      if (!found) { results.push({ id: taskId, ok: false, error: "Not found" }); continue; }
      const { task, stubId } = found;

      switch (action) {
        case "kill": {
          if (!["running", "paused", "assigned", "pending", "blocked"].includes(task.status)) {
            results.push({ id: taskId, ok: false, error: `Cannot kill in status '${task.status}'` }); break;
          }
          if (stubId && (task.status === "running" || task.status === "assigned")) {
            initiateKillChain(stubId, taskId);
          } else if (stubId) {
            const updated = cancelTask(stubId, taskId);
            if (updated) webNs.emit("task.update", updated);
          } else {
            cancelGlobalTask(taskId);
            const updated = store.findTask(taskId)?.task;
            if (updated) webNs.emit("task.update", updated);
          }
          results.push({ id: taskId, ok: true }); break;
        }
        case "retry": {
          if (!TERMINAL_STATUSES.includes(task.status)) {
            results.push({ id: taskId, ok: false, error: `Cannot retry in status '${task.status}'` }); break;
          }
          const retryTask = createRetryTask(task);
          store.addToGlobalQueue(retryTask);
          webNs.emit("task.update", retryTask);
          triggerSchedule();
          results.push({ id: taskId, ok: true, new_task_id: retryTask.id }); break;
        }
        case "requeue": {
          const requeueable = [...TERMINAL_STATUSES, "assigned", "pending"];
          if (!requeueable.includes(task.status)) {
            results.push({ id: taskId, ok: false, error: `Cannot requeue in status '${task.status}'` }); break;
          }
          if (found.archived) {
            store.removeFromArchive(taskId);
          } else if (stubId) {
            const stub = store.getStub(stubId);
            if (stub) {
              stub.tasks = stub.tasks.filter((t) => t.id !== taskId);
              store.setStub(stub);
            }
          } else {
            store.removeFromGlobalQueue(taskId);
          }
          const requeuedTask: Task = {
            ...task,
            stub_id: undefined,
            status: "pending",
            exit_code: undefined,
            finished_at: undefined,
            started_at: undefined,
            pid: undefined,
          };
          store.addToGlobalQueue(requeuedTask);
          webNs.emit("task.update", requeuedTask);
          triggerSchedule();
          results.push({ id: taskId, ok: true }); break;
        }
        case "cancel": {
          if (!["pending", "blocked", "assigned"].includes(task.status)) {
            results.push({ id: taskId, ok: false, error: `Cannot cancel in status '${task.status}'` }); break;
          }
          const now = new Date().toISOString();
          let cancelled: Task | undefined;
          if (stubId) {
            cancelled = store.updateTask(stubId, taskId, { status: "cancelled" as any, finished_at: now });
          } else {
            cancelled = store.updateGlobalQueueTask(taskId, { status: "cancelled" as any, finished_at: now });
          }
          if (cancelled) webNs.emit("task.update", cancelled);
          results.push({ id: taskId, ok: true }); break;
        }
        case "delete": {
          if (!TERMINAL_STATUSES.includes(task.status)) {
            results.push({ id: taskId, ok: false, error: `Cannot delete in status '${task.status}'` }); break;
          }
          if (found.archived) {
            store.removeFromArchive(taskId);
          } else if (stubId) {
            const stub = store.getStub(stubId);
            if (stub) {
              stub.tasks = stub.tasks.filter((t) => t.id !== taskId);
              store.setStub(stub);
            }
          } else {
            store.removeFromGlobalQueue(taskId);
          }
          webNs.emit("task.deleted", { task_id: taskId });
          results.push({ id: taskId, ok: true }); break;
        }
        default:
          results.push({ id: taskId, ok: false, error: `Unknown action '${action}'` });
      }
    }

    res.json({ results });
  });

  // POST /tasks
  router.post("/", (req: Request, res: Response) => {
    const {
      script, argv, args, raw_args, name, cwd, env_setup, env, env_overrides,
      requirements, priority, max_retries, run_dir,
      idempotency_key, param_overrides, python_env,
      submitted_by, depends_on, ref, args_template, experiment_id, outputs, metric_schema,
      auto_retry_on, stub_id,
      target_stub_id: _target_stub_id,
      target_tags: _target_tags,
      tags: _tags,
    } = req.body;
    // target_stub_id pins the task to a specific stub; stub_id is accepted as an alias
    const target_stub_id: string | undefined = _target_stub_id ?? stub_id;
    // target_tags filters stubs by tag; tags is accepted as an alias
    const target_tags: string[] | undefined = _target_tags ?? _tags;

    if (!script) {
      res.status(400).json({ error: "script required" }); return;
    }

    // Validate env variable keys to prevent shell injection
    if (env && typeof env === "object") {
      const invalidKey = Object.keys(env).find((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
      if (invalidKey) {
        res.status(400).json({ error: `Invalid env key: "${invalidKey}"` }); return;
      }
    }

    // Validate script is an absolute path
    if (!script.startsWith("/")) {
      res.status(400).json({ error: `Script must be an absolute path, got: "${script}"` }); return;
    }

    // Validate cwd is absolute if provided
    if (cwd && !cwd.startsWith("/")) {
      res.status(400).json({ error: `cwd must be an absolute path, got: "${cwd}"` }); return;
    }

    // Validate run_dir is absolute if provided
    if (run_dir && !run_dir.startsWith("/")) {
      res.status(400).json({ error: `run_dir must be an absolute path, got: "${run_dir}"` }); return;
    }

    // Validate target_stub_id references a known online stub
    if (target_stub_id) {
      const stub = store.getStub(target_stub_id);
      if (!stub) {
        res.status(400).json({ error: `Unknown stub_id: "${target_stub_id}"` }); return;
      }
      if (stub.status !== "online") {
        res.status(400).json({ error: `Stub "${target_stub_id}" (${stub.name}) is offline` }); return;
      }
    }

    // Idempotency check
    if (idempotency_key) {
      const existing = idempotencyCache.get(idempotency_key);
      if (existing) {
        const found = store.findTask(existing);
        if (found) { res.status(200).json(found.task); return; }
      }
    }

    // Fingerprint dedup
    const fingerprint = computeFingerprint({ script, argv, args, raw_args, param_overrides, cwd });
    const existingId = store.findActiveByFingerprint(fingerprint);
    if (existingId) {
      const found = store.findTask(existingId);
      if (found) {
        logger.info("task.dedup_reject", { fingerprint, existing_task_id: existingId });
        res.status(409).json({
          error: "Task with same fingerprint is already active",
          existing_task_id: existingId,
          task: found.task,
        });
        return;
      }
    }

    // Write lock check
    if (run_dir) {
      const conflict = writeLockTable.getTaskId(run_dir);
      if (conflict) {
        res.status(409).json({
          error: `run_dir "${run_dir}" is locked by task ${conflict}`,
          conflicting_task_id: conflict,
        });
        return;
      }
    }

    const task = createTask({
      script, argv, args, raw_args, name, cwd, env_setup, env, env_overrides,
      requirements, priority, max_retries, run_dir, param_overrides, target_tags, python_env,
      submitted_by, depends_on, ref, args_template, experiment_id, outputs, metric_schema, auto_retry_on,
      stub_id, target_stub_id,
    });

    // Acquire write lock now so subsequent submits with the same run_dir are rejected
    if (run_dir) {
      writeLockTable.acquire(run_dir, task.id);
    }

    try {
      store.addToGlobalQueue(task);
    } catch (e) {
      if (run_dir) writeLockTable.release(run_dir);
      throw e;
    }
    if (webNs) webNs.emit("task.update", task);
    logger.info("task.submit", { task_seq: task.seq, fingerprint: task.fingerprint, display_name: task.display_name });
    notifySubmitted(task).catch(() => {});

    if (idempotency_key) {
      idempotencyCache.set(idempotency_key, task.id);
    }

    triggerSchedule();

    const waitForResult = req.query.wait === "true";
    const waitTimeout = Math.min(Number(req.query.wait_timeout) || 15, 30); // max 30s

    if (waitForResult) {
      // Poll for task state change: wait until task is running, failed, or completed.
      // Uses setTimeout to avoid blocking the Node.js event loop.
      const deadline = Date.now() + waitTimeout * 1000;
      const pollInterval = 200; // ms

      const poll = () => {
        const found = store.findTask(task.id);
        if (!found) {
          res.status(201).json({ ...task, _wait: "task_lost" });
          return;
        }
        const t = found.task;
        // Terminal or running = we have a result
        if (["running", "completed", "failed", "cancelled"].includes(t.status)) {
          res.status(t.status === "failed" ? 422 : 201).json({
            ...t,
            _wait: t.status === "failed" ? "preflight_or_start_failed" : "started",
          });
          return;
        }
        if (Date.now() >= deadline) {
          // Timeout — return current state
          res.status(202).json({
            ...t,
            _wait: "timeout",
            _wait_message: `Task still in ${t.status} after ${waitTimeout}s`,
          });
          return;
        }
        setTimeout(poll, pollInterval);
      };

      // Start polling after a short initial delay (give scheduler time to assign)
      setTimeout(poll, 100);
      return;
    }

    res.status(201).json(task);
  });

  // POST /tasks/:id/read — mark task as read for actor
  router.post("/:id/read", (req: Request, res: Response) => {
    const actor = getActorFromBody(req);
    const found = store.findTask(req.params.id);
    if (!found) { res.status(404).json({ error: "Task not found" }); return; }

    const mark = store.setTaskMark(req.params.id, actor, { read_at: new Date().toISOString() });
    res.json(mark);
  });

  // POST /tasks/:id/ack — acknowledge terminal task for actor
  router.post("/:id/ack", (req: Request, res: Response) => {
    const actor = getActorFromBody(req);
    const found = store.findTask(req.params.id);
    if (!found) { res.status(404).json({ error: "Task not found" }); return; }

    const mark = store.setTaskMark(req.params.id, actor, { acked_at: new Date().toISOString() });
    res.json(mark);
  });

  // POST /tasks/:id/pin — pin/unpin task for actor
  router.post("/:id/pin", (req: Request, res: Response) => {
    const actor = getActorFromBody(req);
    const found = store.findTask(req.params.id);
    if (!found) { res.status(404).json({ error: "Task not found" }); return; }

    const body = req.body as { pinned?: unknown; note?: unknown };
    const patch: Partial<Pick<TaskMark, "pinned" | "note">> = {};

    if (typeof body.pinned === "boolean") {
      patch.pinned = body.pinned;
    } else {
      patch.pinned = true;
    }
    if (typeof body.note === "string") {
      patch.note = body.note;
    }

    const mark = store.setTaskMark(req.params.id, actor, patch);
    res.json(mark);
  });

  // POST /tasks/:id/watch — watch/unwatch task for actor
  router.post("/:id/watch", (req: Request, res: Response) => {
    const actor = getActorFromBody(req);
    const found = store.findTask(req.params.id);
    if (!found) { res.status(404).json({ error: "Task not found" }); return; }

    const body = req.body as { watched?: unknown; note?: unknown };
    const patch: Partial<Pick<TaskMark, "watched" | "note">> = {};

    if (typeof body.watched === "boolean") {
      patch.watched = body.watched;
    } else {
      patch.watched = true;
    }
    if (typeof body.note === "string") {
      patch.note = body.note;
    }

    const mark = store.setTaskMark(req.params.id, actor, patch);
    res.json(mark);
  });

  // GET /tasks/:id
  router.get("/:id", (req: Request, res: Response) => {
    const found = store.findTask(req.params.id);
    if (!found) { res.status(404).json({ error: "Task not found" }); return; }
    res.json(found.task);
  });

  // PATCH /tasks/:id
  router.patch("/:id", (req: Request, res: Response) => {
    if (!webNs) { res.status(503).json({ error: "Not ready" }); return; }
    const found = store.findTask(req.params.id);
    if (!found) { res.status(404).json({ error: "Task not found" }); return; }
    const { task, stubId } = found;

    const { status, priority, name, should_stop, should_checkpoint } = req.body;
    const update: Partial<Task> = {};

    if (priority !== undefined) {
      update.priority = priority;
    }
    if (name !== undefined) {
      update.name = name;
      update.display_name = name; // user-set name takes over display_name
    }
    if (should_stop !== undefined) {
      update.should_stop = should_stop;
      if (should_stop && stubId && (task.status === "running" || task.status === "assigned")) {
        // Initiate kill chain
        initiateKillChain(stubId, task.id);
      }
    }
    if (should_checkpoint !== undefined) {
      update.should_checkpoint = should_checkpoint;
      if (should_checkpoint && stubId) {
        reliableEmitToStub(stubId, "task.signal", { task_id: task.id, signal: "should_checkpoint" });
      }
    }
    if (status !== undefined) {
      // Status override — limited transitions
      if (status === "cancelled" && ["pending", "blocked", "assigned"].includes(task.status)) {
        // pending/blocked/assigned → cancelled (no stub interaction needed)
        const now = new Date().toISOString();
        let cancelled: Task | undefined;
        if (stubId) {
          cancelled = store.updateTask(stubId, task.id, { status: "cancelled" as any, finished_at: now });
        } else {
          cancelled = store.updateGlobalQueueTask(task.id, { status: "cancelled" as any, finished_at: now });
        }
        if (cancelled) webNs.emit("task.update", cancelled);
        res.json(cancelled || task);
        return;
      } else if ((status === "killed" || status === "cancelled") && ["running", "assigned", "pending", "paused", "blocked"].includes(task.status)) {
        if (stubId && (task.status === "running" || task.status === "assigned")) {
          initiateKillChain(stubId, task.id);
          // Return the updated task with should_stop=true (set by initiateKillChain)
          const updated = store.getTask(stubId, task.id);
          return res.json(updated || task);
        } else if (stubId) {
          const cancelled = cancelTask(stubId, task.id);
          if (cancelled) webNs.emit("task.update", cancelled);
          res.json(cancelled || task);
          return;
        } else {
          cancelGlobalTask(task.id);
          const cancelled = store.findTask(task.id)?.task;
          if (cancelled) webNs.emit("task.update", cancelled);
          res.json(cancelled || task);
          return;
        }
      } else if (status === "paused" && stubId) {
        const paused = pauseTask(stubId, task.id);
        if (paused) webNs.emit("task.update", paused);
        res.json(paused || task);
        return;
      } else if (status === "running" && task.status === "paused" && stubId) {
        const resumed = resumeTask(stubId, task.id);
        if (resumed) webNs.emit("task.update", resumed);
        res.json(resumed || task);
        return;
      } else {
        res.status(400).json({ error: `Unsupported status transition: ${task.status} → ${status}` });
        return;
      }
    }

    const specUpdate = pickTaskSpecUpdates(req.body);
    if (hasTaskSpecUpdates(specUpdate)) {
      if (!["pending", "blocked"].includes(task.status)) {
        res.status(400).json({ error: `Cannot update task spec in status '${task.status}'` });
        return;
      }
      const validationError = validateTaskSpecUpdate(specUpdate);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }
      Object.assign(update, specUpdate);
      Object.assign(update, reassembleTaskSpec({ ...task, ...update }));
    }

    let updated: Task | undefined;
    if (stubId) {
      updated = store.updateTask(stubId, task.id, update);
    } else {
      updated = store.updateGlobalQueueTask(task.id, update);
    }

    if (updated) webNs.emit("task.update", updated);
    res.json(updated || task);
  });

  // POST /tasks/:id/reschedule — kill + requeue with optional new target_tags
  router.post("/:id/reschedule", (req: Request, res: Response) => {
    if (!webNs || !stubNs) { res.status(503).json({ error: "Not ready" }); return; }
    const found = store.findTask(req.params.id);
    if (!found) { res.status(404).json({ error: "Task not found" }); return; }
    const { task, stubId } = found;

    // Only active tasks can be rescheduled
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      res.status(400).json({ error: `Cannot reschedule in terminal status '${task.status}'` }); return;
    }

    const { target_tags, priority } = req.body;

    // Cancel the current execution if running/assigned
    if (stubId && (task.status === "running" || task.status === "assigned")) {
      initiateKillChain(stubId, task.id);
    } else if (stubId) {
      const cancelled = cancelTask(stubId, task.id);
      if (cancelled) webNs.emit("task.update", cancelled);
    } else {
      cancelGlobalTask(task.id);
      const cancelled = store.findTask(task.id)?.task;
      if (cancelled) webNs.emit("task.update", cancelled);
    }

    // Create a new task preserving original config, with optional overrides
    const newTask = createTask({
      script: task.script,
      argv: task.argv,
      args: task.args,
      raw_args: task.raw_args,
      name: task.name,
      cwd: task.cwd,
      env_setup: task.env_setup,
      env: task.env,
      env_overrides: task.env_overrides,
      requirements: task.requirements,
      priority: priority ?? task.priority,
      max_retries: task.max_retries,
      target_tags: target_tags ?? task.target_tags,
      python_env: task.python_env,
      submitted_by: task.submitted_by,
      grid_id: task.grid_id,
      param_overrides: task.param_overrides,
      ref: task.ref,
      args_template: task.args_template,
      experiment_id: task.experiment_id,
      outputs: task.outputs,
    });

    store.addToGlobalQueue(newTask);
    webNs.emit("task.update", newTask);
    logger.info("task.reschedule", { old_seq: task.seq, new_seq: newTask.seq, target_tags: newTask.target_tags });
    triggerSchedule();
    res.status(201).json(newTask);
  });

  // POST /tasks/:id/replace — create a new canonical attempt and rewire blocked downstream deps
  router.post("/:id/replace", (req: Request, res: Response) => {
    if (!webNs) { res.status(503).json({ error: "Not ready" }); return; }
    const found = store.findTask(req.params.id);
    if (!found) { res.status(404).json({ error: "Task not found" }); return; }
    const { task, stubId, archived } = found;
    const overrides = pickTaskSpecUpdates(req.body?.overrides ?? req.body ?? {});
    const validationError = validateTaskSpecUpdate(overrides);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const replacement = createReplacementTask(task, overrides);
    store.addToGlobalQueue(replacement);

    const replacedByUpdate = { replaced_by_task_id: replacement.id } as Partial<Task>;
    if (req.body?.cancel_old === true && !TERMINAL_STATUSES.includes(task.status)) {
      if (stubId && (task.status === "running" || task.status === "assigned")) {
        initiateKillChain(stubId, task.id);
        const marked = store.updateTask(stubId, task.id, replacedByUpdate);
        if (marked) webNs.emit("task.update", marked);
      } else if (stubId) {
        const cancelled = store.updateTask(stubId, task.id, {
          ...replacedByUpdate,
          status: "cancelled" as any,
          finished_at: new Date().toISOString(),
        });
        if (cancelled) webNs.emit("task.update", cancelled);
      } else {
        const cancelled = store.updateGlobalQueueTask(task.id, {
          ...replacedByUpdate,
          status: "cancelled" as any,
          finished_at: new Date().toISOString(),
        });
        if (cancelled) webNs.emit("task.update", cancelled);
      }
    } else if (archived) {
      const marked = store.updateArchivedTask(task.id, replacedByUpdate);
      if (marked) webNs.emit("task.update", marked);
    } else if (stubId) {
      const marked = store.updateTask(stubId, task.id, replacedByUpdate);
      if (marked) webNs.emit("task.update", marked);
    } else {
      const marked = store.updateGlobalQueueTask(task.id, replacedByUpdate);
      if (marked) webNs.emit("task.update", marked);
    }

    const rewired = rewireDownstreamBlockedDeps(task.id, replacement.id, webNs);
    updateExperimentCanonicalRef(task, replacement.id);
    webNs.emit("task.update", replacement);
    logger.info("task.replace", {
      old_task_id: task.id,
      new_task_id: replacement.id,
      attempt: replacement.attempt,
      rewired_downstream: rewired.length,
      cancel_old: req.body?.cancel_old === true,
    });
    triggerSchedule();
    res.status(201).json({ task: replacement, replaced_task_id: task.id, rewired_downstream: rewired.map((t) => t.id) });
  });

  // POST /tasks/:id/retry
  router.post("/:id/retry", (req: Request, res: Response) => {
    if (!webNs) { res.status(503).json({ error: "Not ready" }); return; }
    const found = store.findTask(req.params.id);
    if (!found) { res.status(404).json({ error: "Task not found" }); return; }
    const { task } = found;

    if (!TERMINAL_STATUSES.includes(task.status)) {
      res.status(400).json({ error: `Cannot retry in status '${task.status}'` }); return;
    }

    const force = req.query.force === "true";
    if (!force) {
      // Dedup: reject if a pending/running copy already exists for the same fingerprint root
      const retryRoot = task.retry_of || task.id;
      const existingActive = store.getAllTasks().find(
        (t) =>
          t.id !== task.id &&
          (t.retry_of === retryRoot || t.retry_of === task.id || t.id === retryRoot) &&
          ["pending", "assigned", "running"].includes(t.status),
      );
      if (existingActive) {
        res.status(409).json({
          error: "Active retry already exists for this task",
          existing_task_id: existingActive.id,
          task: existingActive,
        });
        return;
      }
    }

    let retryTask: Task;
    try {
      retryTask = createRetryTask(task);
    } catch (e: any) {
      logger.error("retry.create_failed", { error: e.message, stack: e.stack });
      res.status(500).json({ error: e.message }); return;
    }
    store.addToGlobalQueue(retryTask);
    webNs.emit("task.update", retryTask);
    triggerSchedule();
    res.status(201).json(retryTask);
  });

  return router;
}

