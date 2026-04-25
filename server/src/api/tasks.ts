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
import { Task } from "../types";
import { Namespace } from "socket.io";
import {
  computeFingerprint, writeLockTable, idempotencyCache,
  isActiveStatus,
} from "../dedup";
import { triggerSchedule, maybeDispatch } from "../scheduler";
import { notifySubmitted } from "../discord";
import { initiateKillChain } from "../socket/stub";
import { killTask, killGlobalTask, pauseTask, resumeTask } from "../task-actions";
import { reliableEmitToStub } from "../reliable";
import { logger } from "../log";

// ─── Display name generation ──────────────────────────────────────────────────

export function generateDisplayName(task: Partial<Task>): string {
  if (task.name) return task.name;
  if (task.script) {
    const base = path.basename(task.script);
    if (task.args && Object.keys(task.args).length > 0) {
      const argsSummary = Object.entries(task.args)
        .map(([k, v]) => {
          // Remove leading dashes from key
          const shortKey = k.replace(/^-+/, "");
          return `${shortKey}=${v}`;
        })
        .join(" ");
      return `${base} ${argsSummary}`;
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

// ─── Command assembly ─────────────────────────────────────────────────────────

export function assembleCommand(task: Partial<Task>): string {
  const parts: string[] = [];
  const envSetup = task.env_setup;
  const cwd = task.cwd;
  const env = task.env;
  const script = task.script || "";
  const args = task.args;
  const rawArgs = task.raw_args;

  if (envSetup) {
    parts.push(`${envSetup} &&`);
  }
  if (cwd) {
    parts.push(`cd ${cwd} &&`);
  }
  if (env && Object.keys(env).length > 0) {
    const envStr = Object.entries(env)
      .filter(([k]) => !k.startsWith("ALCHEMY_"))
      .map(([k, v]) => `export ${k}='${v}'`)
      .join(" && ");
    if (envStr) parts.push(`${envStr} &&`);
  }
  parts.push(script);
  if (args && Object.keys(args).length > 0) {
    const argsStr = Object.entries(args)
      .map(([k, v]) => `${k} ${v}`)
      .join(" ");
    parts.push(argsStr);
  }
  if (rawArgs) {
    parts.push(rawArgs);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// ─── Task creation helper ─────────────────────────────────────────────────────

export interface TaskInput {
  script: string;
  args?: Record<string, string>;
  raw_args?: string;
  name?: string;
  cwd?: string;
  env_setup?: string;
  env?: Record<string, string>;
  requirements?: Task["requirements"];
  priority?: number;
  max_retries?: number;
  run_dir?: string;
  grid_id?: string;
  param_overrides?: Record<string, any>;
  idempotency_key?: string;
  stub_id?: string;
  target_tags?: string[];
  python_env?: string;
}

export function createTask(input: TaskInput): Task {
  const fingerprint = computeFingerprint({
    script: input.script,
    args: input.args,
    raw_args: input.raw_args,
    param_overrides: input.param_overrides,
    cwd: input.cwd,
  });

  const seq = store.nextSeq();

  const partial: Partial<Task> = {
    script: input.script,
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
    args: input.args,
    raw_args: input.raw_args,
    cwd: input.cwd,
    env_setup: input.env_setup,
    env: input.env,
    command,
    requirements: input.requirements,
    status: "pending",
    priority: input.priority ?? 5,
    stub_id: input.stub_id,
    target_tags: input.target_tags,
    grid_id: input.grid_id,
    param_overrides: input.param_overrides,
    created_at: new Date().toISOString(),
    log_buffer: [],
    retry_count: 0,
    max_retries: input.max_retries ?? 0,
    should_stop: false,
    should_checkpoint: false,
    run_dir: input.run_dir,
    python_env: input.python_env,
  };

  return task;
}

// ─── Terminal statuses ────────────────────────────────────────────────────────

const TERMINAL_STATUSES = ["completed", "failed", "killed", "lost"];

// ─── Router ───────────────────────────────────────────────────────────────────

export function createGlobalTasksRouter(stubNs?: Namespace, webNs?: Namespace): Router {
  const router = Router();

  // GET /tasks — paginated: ?page=1&limit=50&status=running
  router.get("/", (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const statusFilter = req.query.status ? String(req.query.status) : undefined;
    const includeLogs = req.query.logs === "true";

    let tasks = store.getAllTasks();

    if (statusFilter) {
      tasks = tasks.filter((t) => t.status === statusFilter);
    }

    // Sort: newest first by seq
    tasks = tasks.sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));

    const total = tasks.length;
    const start = (page - 1) * limit;
    const paginated = tasks.slice(start, start + limit);

    const enriched = paginated.map((t) => {
      const stub = t.stub_id ? store.getStub(t.stub_id) : undefined;
      const stub_name = stub ? (stub.name || stub.hostname) : undefined;
      if (includeLogs) {
        return stub_name ? { ...t, stub_name } : t;
      }
      const { log_buffer, ...rest } = t;
      return stub_name ? { ...rest, stub_name } : rest;
    });

    res.json({ tasks: enriched, total, page, limit });
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
          if (!["running", "paused", "queued", "dispatched", "pending"].includes(task.status)) {
            results.push({ id: taskId, ok: false, error: `Cannot kill in status '${task.status}'` }); break;
          }
          if (stubId && (task.status === "running" || task.status === "dispatched")) {
            initiateKillChain(stubId, taskId);
          } else if (stubId) {
            const updated = killTask(stubId, taskId);
            if (updated) webNs.emit("task.update", updated);
          } else {
            killGlobalTask(taskId);
            const updated = store.findTask(taskId)?.task;
            if (updated) webNs.emit("task.update", updated);
          }
          results.push({ id: taskId, ok: true }); break;
        }
        case "retry": {
          const retryTask = _createRetryTask(task);
          store.addToGlobalQueue(retryTask);
          webNs.emit("task.update", retryTask);
          triggerSchedule();
          results.push({ id: taskId, ok: true, new_task_id: retryTask.id }); break;
        }
        case "requeue": {
          const requeueable = [...TERMINAL_STATUSES, "queued", "pending"];
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
      script, args, raw_args, name, cwd, env_setup, env,
      requirements, priority, max_retries, run_dir,
      idempotency_key, param_overrides, target_tags, python_env,
    } = req.body;

    if (!script) {
      res.status(400).json({ error: "script required" }); return;
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
    const fingerprint = computeFingerprint({ script, args, raw_args, param_overrides, cwd });
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
      script, args, raw_args, name, cwd, env_setup, env,
      requirements, priority, max_retries, run_dir, param_overrides, target_tags, python_env,
    });

    // Acquire write lock now so subsequent submits with the same run_dir are rejected
    if (run_dir) {
      writeLockTable.acquire(run_dir, task.id);
    }

    store.addToGlobalQueue(task);
    if (webNs) webNs.emit("task.update", task);
    logger.info("task.submit", { task_seq: task.seq, fingerprint: task.fingerprint, display_name: task.display_name });
    notifySubmitted(task).catch(() => {});

    if (idempotency_key) {
      idempotencyCache.set(idempotency_key, task.id);
    }

    triggerSchedule();
    res.status(201).json(task);
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
      if (should_stop && stubId && (task.status === "running" || task.status === "dispatched")) {
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
      if (status === "killed" && ["running", "dispatched", "queued", "pending", "paused"].includes(task.status)) {
        if (stubId && (task.status === "running" || task.status === "dispatched")) {
          initiateKillChain(stubId, task.id);
        } else if (stubId) {
          const killed = killTask(stubId, task.id);
          if (killed) webNs.emit("task.update", killed);
          res.json(killed || task);
          return;
        } else {
          killGlobalTask(task.id);
          const killed = store.findTask(task.id)?.task;
          if (killed) webNs.emit("task.update", killed);
          res.json(killed || task);
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

    let updated: Task | undefined;
    if (stubId) {
      updated = store.updateTask(stubId, task.id, update);
    } else {
      updated = store.updateGlobalQueueTask(task.id, update);
    }

    if (updated) webNs.emit("task.update", updated);
    res.json(updated || task);
  });

  // POST /tasks/:id/retry
  router.post("/:id/retry", (req: Request, res: Response) => {
    if (!webNs) { res.status(503).json({ error: "Not ready" }); return; }
    const found = store.findTask(req.params.id);
    if (!found) { res.status(404).json({ error: "Task not found" }); return; }
    const { task } = found;

    const retryTask = _createRetryTask(task);
    store.addToGlobalQueue(retryTask);
    webNs.emit("task.update", retryTask);
    triggerSchedule();
    res.status(201).json(retryTask);
  });

  return router;
}

function _createRetryTask(task: Task): Task {
  const seq = store.nextSeq();
  return {
    ...task,
    id: uuidv4(),
    seq,
    status: "pending",
    stub_id: undefined,
    retry_count: task.retry_count + 1,
    retry_of: task.retry_of || task.id,
    created_at: new Date().toISOString(),
    started_at: undefined,
    finished_at: undefined,
    exit_code: undefined,
    pid: undefined,
    log_buffer: [],
    progress: undefined,
    should_stop: false,
    should_checkpoint: false,
  };
}
