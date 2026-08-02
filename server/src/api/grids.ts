/**
 * api/grids.ts — Grid CRUD.
 *
 * POST /grids — create grid, generate tasks from cartesian product of param_space.
 * GET /grids/:id — grid detail + all tasks.
 * POST /grids/:id/cancel — cancel all running tasks.
 * POST /grids/:id/retry-failed — retry all failed tasks.
 */

import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { store } from "../store";
import { Grid, Task } from "../types";
import { Namespace } from "socket.io";
import { createTask, generateDisplayName } from "./tasks";
import { triggerSchedule } from "../scheduler";
import { maybeDispatch } from "../scheduler";
import { initiateKillChain } from "../socket/stub";
import { computeFingerprint } from "../dedup";
import { cancelTask, cancelGlobalTask } from "../task-actions";
import { validateTaskExecutionSpec } from "../task-spec-validation";

// ─── Cartesian product ────────────────────────────────────────────────────────

function cartesianProduct(params: Record<string, any[]>): Record<string, any>[] {
  const keys = Object.keys(params);
  if (keys.length === 0) return [{}];

  return keys.reduce((results: Record<string, any>[], key) => {
    const values = params[key];
    const expanded: Record<string, any>[] = [];
    for (const result of results) {
      for (const value of values) {
        expanded.push({ ...result, [key]: value });
      }
    }
    return expanded;
  }, [{}]);
}

// ─── Grid display name ────────────────────────────────────────────────────────

function gridDisplayName(name: string | undefined, script: string, paramSpace: Record<string, any[]>): string {
  if (name) return name;
  const base = path.basename(script);
  const paramSummary = Object.keys(paramSpace)
    .map((k) => `${k}=[${paramSpace[k].join(",")}]`)
    .join(" ");
  return `${base} ${paramSummary}`;
}

// ─── Grid status derivation ───────────────────────────────────────────────────

function deriveGridStatus(tasks: Task[]): Grid["status"] {
  if (tasks.length === 0) return "pending";
  const statuses = tasks.map((t) => t.status);
  if (statuses.every((s) => s === "completed")) return "completed";
  if (statuses.some((s) => ["running", "assigned"].includes(s))) return "running";
  if (statuses.some((s) => ["failed", "cancelled"].includes(s)) &&
      statuses.some((s) => s === "completed")) return "partial";
  if (statuses.every((s) => ["failed", "cancelled"].includes(s))) return "failed";
  return "pending";
}

function deriveGridStatusFromCounts(counts: Record<string, number>): Grid["status"] {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (total === 0) return "pending";
  const completed = counts.completed ?? 0;
  const failed = (counts.failed ?? 0) + (counts.cancelled ?? 0);
  const running = (counts.running ?? 0) + (counts.assigned ?? 0);
  if (completed === total) return "completed";
  if (running > 0) return "running";
  if (failed > 0 && completed > 0) return "partial";
  if (failed === total) return "failed";
  return "pending";
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createGridsRouter(_stubNs: Namespace, webNs: Namespace): Router {
  const router = Router();

  // POST /grids
  router.post("/", (req: Request, res: Response) => {
    const {
      name, script, base_args, param_space,
      max_retries, requirements, target_tags,
    } = req.body;

    if (!script) { res.status(400).json({ error: "script required" }); return; }
    if (!param_space || typeof param_space !== "object") {
      res.status(400).json({ error: "param_space required (object of arrays)" }); return;
    }
    if (Object.values(param_space).some((v) => !Array.isArray(v))) {
      res.status(400).json({ error: "param_space values must be arrays" }); return;
    }
    const executionSpecError = validateTaskExecutionSpec({ requirements });
    if (executionSpecError) {
      res.status(400).json({ error: executionSpecError }); return;
    }

    const gridId = uuidv4();
    const display_name = gridDisplayName(name, script, param_space);
    const combinations = cartesianProduct(param_space);

    // M10: Guard against combinatorial explosion
    if (combinations.length > 1000) {
      res.status(400).json({ error: `param_space produces ${combinations.length} combinations (max 1000)` }); return;
    }

    const grid: Grid = {
      id: gridId,
      name,
      display_name,
      script,
      base_args,
      param_space,
      task_ids: [],
      status: "pending",
      created_at: new Date().toISOString(),
      max_retries: max_retries ?? 0,
      requirements,
      target_tags,
    };

    store.setGrid(grid);

    // Create one task per combination
    const taskIds: string[] = [];
    for (const combo of combinations) {
      // Merge base_args with param_space params (as string args)
      const mergedArgs: Record<string, string> = { ...(base_args || {}) };
      // Add param_space values as args (e.g. --seed 42)
      for (const [k, v] of Object.entries(combo)) {
        mergedArgs[`--${k}`] = String(v);
      }

      const task = createTask({
        script,
        args: mergedArgs,
        requirements,
        max_retries: max_retries ?? 0,
        grid_id: gridId,
        param_overrides: combo,
        target_tags,
      });
      store.addToGlobalQueue(task);
      webNs.emit("task.update", task);
      taskIds.push(task.id);
    }

    // Update grid with task IDs
    grid.task_ids = taskIds;
    store.setGrid(grid);

    triggerSchedule();

    webNs.emit("grid.update", grid);
    res.status(201).json(grid);
  });

  // GET /grids
  router.get("/", (req: Request, res: Response) => {
    const aggregate = store.getTaskStatusCountsByGrid();
    const grids = store.getAllGrids().map((g) => ({
      ...g,
      status: deriveGridStatusFromCounts(aggregate.get(g.id) ?? {}),
    }));
    const paginated = req.query.limit !== undefined || req.query.offset !== undefined;
    if (!paginated) { res.json(grids); return; }
    const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit ?? "50"), 10) || 50));
    const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? "0"), 10) || 0);
    const items = grids
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
      .slice(offset, offset + limit);
    res.json({ items, total: grids.length, limit, offset });
  });

  // GET /grids/:id
  router.get("/:id", (req: Request, res: Response) => {
    const grid = store.getGrid(req.params.id);
    if (!grid) { res.status(404).json({ error: "Grid not found" }); return; }

    const tasks = store.getGridTasks(grid.id);
    const status = deriveGridStatus(tasks);

    res.json({ ...grid, status, tasks });
  });

  // POST /grids/:id/cancel
  router.post("/:id/cancel", (req: Request, res: Response) => {
    const grid = store.getGrid(req.params.id);
    if (!grid) { res.status(404).json({ error: "Grid not found" }); return; }

    const tasks = store.getGridTasks(grid.id);
    let cancelled = 0;

    for (const task of tasks) {
      if (["running", "assigned", "pending"].includes(task.status)) {
        if (task.stub_id && (task.status === "running" || task.status === "assigned")) {
          initiateKillChain(task.stub_id, task.id);
        } else if (task.stub_id) {
          const updated = cancelTask(task.stub_id!, task.id);
          if (updated) webNs.emit("task.update", updated);
        } else {
          const updated = cancelGlobalTask(task.id);
          if (updated) webNs.emit("task.update", updated);
        }
        cancelled++;
      }
    }

    res.json({ ok: true, cancelled });
  });

  // POST /grids/:id/retry-failed
  router.post("/:id/retry-failed", (req: Request, res: Response) => {
    const grid = store.getGrid(req.params.id);
    if (!grid) { res.status(404).json({ error: "Grid not found" }); return; }

    const tasks = store.getGridTasks(grid.id);
    let retried = 0;

    for (const task of tasks) {
      if (["failed", "cancelled"].includes(task.status)) {
        const seq = store.nextSeq();
        const retryTask: Task = {
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
        store.addToGlobalQueue(retryTask);
        // Update grid task_ids
        const idx = grid.task_ids.indexOf(task.id);
        if (idx !== -1) grid.task_ids[idx] = retryTask.id;
        webNs.emit("task.update", retryTask);
        retried++;
      }
    }

    if (retried > 0) {
      store.setGrid(grid);
      triggerSchedule();
    }

    res.json({ ok: true, retried });
  });

  return router;
}
