/**
 * api/experiments.ts — Experiment CRUD.
 *
 * POST   /experiments           — create experiment (creates grid internally)
 * GET    /experiments           — list all experiments
 * GET    /experiments/:id       — experiment detail + task validations
 * DELETE /experiments/:id       — delete experiment (does NOT delete tasks)
 * POST   /experiments/:id/retry-failed — retry tasks that failed criteria
 */

import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { store } from "../store";
import { Experiment, Grid, Task, TaskSpec } from "../types";
import { Namespace } from "socket.io";
import { createTask } from "./tasks";
import { triggerSchedule } from "../scheduler";
import { computeFingerprint } from "../dedup";
import { evaluateCriteria } from "../criteria";
import { validateDag } from "../dag";
import { logger } from "../log";
import { initExperimentManifest, readExperimentManifest } from "../git-tracking";

// ─── Cartesian product (same as grids.ts) ────────────────────────────────────

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

// ─── Experiment status derivation ────────────────────────────────────────────

export function deriveExperimentStatus(exp: Experiment): Experiment["status"] {
  const grid = store.getGrid(exp.grid_id);
  if (!grid) return "running";

  const totalTasks = grid.task_ids.length;
  const validated = Object.values(exp.results);
  const passed = validated.filter((v) => v.passed).length;
  const failed = validated.filter((v) => !v.passed).length;

  // Check if all tasks in grid are terminal
  const tasks = store.getGridTasks(exp.grid_id);
  const allDone = tasks.every((t) =>
    ["completed", "failed", "killed", "lost"].includes(t.status)
  );

  if (passed === totalTasks && totalTasks > 0) return "passed";
  if (allDone && failed > 0) return passed > 0 ? "partial" : "failed";
  return "running";
}

// ─── Router ──────────────────────────────────────────────────────────────────

export function createExperimentsRouter(stubNs: Namespace, webNs: Namespace): Router {
  const router = Router();

  // POST /experiments
  router.post("/", (req: Request, res: Response) => {
    const {
      name, description, criteria, script,
      matrix, base_args, max_retries,
      requirements, target_tags, task_specs,
      python_env, cwd,
      config, config_diff, parent_name,
      git_tracking, git_repo_path,
    } = req.body;

    if (!name) { res.status(400).json({ error: "name required" }); return; }

    // ─── DAG task_specs path ──────────────────────────────────────────
    if (task_specs && Array.isArray(task_specs) && task_specs.length > 0) {
      const dagResult = validateDag(task_specs as TaskSpec[]);
      if (!dagResult.valid) {
        res.status(400).json({ error: `Invalid DAG: ${dagResult.error}` }); return;
      }

      const experimentId = uuidv4();
      const gridId = uuidv4();
      const refToTaskId: Record<string, string> = {};
      const taskIds: string[] = [];

      // Resolve parent_id from parent_name (best-effort)
      let parentId: string | undefined;
      if (parent_name) {
        const parentExp = store.findExperimentByName(parent_name);
        if (parentExp) parentId = parentExp.id;
      }

      // Create tasks in topological order (specs are assumed ordered, but we process roots first)
      for (const spec of task_specs as TaskSpec[]) {
        // Convert ref-based depends_on to task ID-based
        const dependsOnIds: string[] = [];
        for (const depRef of spec.depends_on || []) {
          const depId = refToTaskId[depRef];
          if (!depId) {
            res.status(400).json({ error: `ref "${spec.ref}" depends on "${depRef}" which hasn't been created yet — check task_specs order` });
            return;
          }
          dependsOnIds.push(depId);
        }

        const task = createTask({
          script: spec.script,
          args: spec.args,
          raw_args: spec.raw_args,
          args_template: spec.args_template,
          depends_on: dependsOnIds.length > 0 ? dependsOnIds : undefined,
          ref: spec.ref,
          experiment_id: experimentId,
          grid_id: gridId,
          cwd: spec.cwd ?? cwd,
          python_env: spec.python_env ?? python_env,
          env_setup: spec.env_setup,
          env: spec.env,
          env_overrides: spec.env_overrides,
          requirements: spec.requirements,
          target_tags: spec.target_tags ?? target_tags,
          max_retries: spec.max_retries ?? 0,
          priority: spec.priority,
        });

        // Attach resolved_config from SDK (experiment config + task overrides)
        if (spec.resolved_config) {
          (task as any).resolved_config = spec.resolved_config;
        }

        store.addToGlobalQueue(task);
        webNs.emit("task.update", task);
        refToTaskId[spec.ref] = task.id;
        taskIds.push(task.id);
      }

      // Create grid to hold all task_ids (compat with existing grid status tracking)
      const grid: Grid = {
        id: gridId,
        name: `exp:${name}`,
        display_name: `${name} — DAG (${taskIds.length} tasks)`,
        script: (task_specs as TaskSpec[])[0].script,
        param_space: {},
        task_ids: taskIds,
        status: "pending",
        created_at: new Date().toISOString(),
        max_retries: 0,
        target_tags,
      };
      store.setGrid(grid);

      const experiment: Experiment = {
        id: experimentId,
        name,
        description,
        criteria: criteria || {},
        grid_id: gridId,
        status: "running",
        results: {},
        created_at: new Date().toISOString(),
        task_specs: task_specs as TaskSpec[],
        task_refs: refToTaskId,
        config: config || undefined,
        config_diff: config_diff || undefined,
        parent_name: parent_name || undefined,
        parent_id: parentId,
        git_tracking: git_tracking === true ? true : undefined,
        git_repo_path: git_repo_path || undefined,
      };

      store.setExperiment(experiment);
      triggerSchedule();

      webNs.emit("grid.update", grid);
      webNs.emit("experiment.update", experiment);

      // Git tracking: init manifest fire-and-forget
      if (experiment.git_tracking && taskIds.length > 0) {
        const firstTaskStubId = store.getTask("", taskIds[0])?.stub_id;
        // Use first available online stub that matches target_tags, or any online stub
        const candidateStub = store.getAllStubs().find((s) => s.status === "online");
        if (candidateStub) {
          initExperimentManifest(experiment, candidateStub.id, stubNs).catch(() => {});
        }
      }

      logger.info("experiment.created", { id: experimentId, name, tasks: taskIds.length, dag: true, has_config: !!config, parent: parent_name || null });
      res.status(201).json(experiment);
      return;
    }

    // ─── Legacy matrix path ───────────────────────────────────────────
    if (!criteria || typeof criteria !== "object" || Object.keys(criteria).length === 0) {
      res.status(400).json({ error: "criteria required (object of metric: expression)" }); return;
    }
    if (!script) { res.status(400).json({ error: "script required" }); return; }
    if (!matrix || typeof matrix !== "object") {
      res.status(400).json({ error: "matrix required (object of arrays)" }); return;
    }
    if (Object.values(matrix).some((v: any) => !Array.isArray(v))) {
      res.status(400).json({ error: "matrix values must be arrays" }); return;
    }

    // Create grid internally
    const gridId = uuidv4();
    const combinations = cartesianProduct(matrix);
    const paramKeys = Object.keys(matrix);
    const paramSummary = paramKeys
      .map((k) => `${k}=[${(matrix as Record<string, any[]>)[k].join(",")}]`)
      .join(" ");
    const gridDisplayName = `${name} — ${path.basename(script)} ${paramSummary}`;

    const grid: Grid = {
      id: gridId,
      name: `exp:${name}`,
      display_name: gridDisplayName,
      script,
      base_args,
      param_space: matrix,
      task_ids: [],
      status: "pending",
      created_at: new Date().toISOString(),
      max_retries: max_retries ?? 0,
      requirements,
      target_tags,
    };

    store.setGrid(grid);

    // Create tasks
    const taskIds: string[] = [];
    for (const combo of combinations) {
      const mergedArgs: Record<string, string> = { ...(base_args || {}) };
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

    grid.task_ids = taskIds;
    store.setGrid(grid);

    // Create experiment
    const experiment: Experiment = {
      id: uuidv4(),
      name,
      description,
      criteria,
      grid_id: gridId,
      status: "running",
      results: {},
      created_at: new Date().toISOString(),
      git_tracking: git_tracking === true ? true : undefined,
      git_repo_path: git_repo_path || undefined,
    };

    store.setExperiment(experiment);
    triggerSchedule();

    webNs.emit("grid.update", grid);
    webNs.emit("experiment.update", experiment);

    // Git tracking: init manifest fire-and-forget
    if (experiment.git_tracking) {
      const candidateStub = store.getAllStubs().find((s) => s.status === "online");
      if (candidateStub) {
        initExperimentManifest(experiment, candidateStub.id, stubNs).catch(() => {});
      }
    }

    logger.info("experiment.created", { id: experiment.id, name, tasks: taskIds.length, criteria: Object.keys(criteria) });
    res.status(201).json(experiment);
  });

  // GET /experiments
  router.get("/", (_req: Request, res: Response) => {
    const experiments = store.getAllExperiments().map((exp) => ({
      ...exp,
      status: deriveExperimentStatus(exp),
    }));
    res.json(experiments);
  });

  // GET /experiments/:id
  router.get("/:id", (req: Request, res: Response) => {
    const exp = store.getExperiment(req.params.id);
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }

    const grid = store.getGrid(exp.grid_id);
    const tasks = grid ? store.getGridTasks(exp.grid_id) : [];
    const status = deriveExperimentStatus(exp);

    res.json({ ...exp, status, grid, tasks });
  });

  // GET /experiments/:id/diff — config diff for lineage tracking
  router.get("/:id/diff", (req: Request, res: Response) => {
    const exp = store.getExperiment(req.params.id);
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }

    const result: Record<string, any> = {
      experiment_id: exp.id,
      name: exp.name,
      config: exp.config || null,
      config_diff: exp.config_diff || null,
      parent_name: exp.parent_name || null,
      parent_id: exp.parent_id || null,
    };

    // If parent exists, include parent config for context
    if (exp.parent_id) {
      const parent = store.getExperiment(exp.parent_id);
      if (parent) {
        result.parent_config = parent.config || null;
      }
    }

    res.json(result);
  });

  // GET /experiments/:id/manifest
  router.get("/:id/manifest", async (req: Request, res: Response) => {
    const exp = store.getExperiment(req.params.id);
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }
    if (!exp.git_tracking) { res.status(400).json({ error: "git_tracking not enabled for this experiment" }); return; }
    if (!exp.git_repo_path) { res.status(400).json({ error: "git_repo_path not set on experiment" }); return; }

    // Find an online stub to exec on
    const stub = store.getAllStubs().find((s) => s.status === "online");
    if (!stub) { res.status(503).json({ error: "No online stub available" }); return; }

    try {
      const content = await readExperimentManifest(exp, stub.id, stubNs);
      res.set("Content-Type", "text/yaml").send(content);
    } catch (err: any) {
      logger.warn("experiment.manifest-read-failed", { id: exp.id, name: exp.name, error: String(err) });
      res.status(500).json({ error: `Failed to read manifest: ${err.message}` });
    }
  });

  // DELETE /experiments/:id
  router.delete("/:id", (req: Request, res: Response) => {
    const exp = store.getExperiment(req.params.id);
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }

    store.deleteExperiment(exp.id);
    logger.info("experiment.deleted", { id: exp.id, name: exp.name });
    res.json({ ok: true });
  });

  // POST /experiments/:id/retry-failed
  router.post("/:id/retry-failed", (req: Request, res: Response) => {
    const exp = store.getExperiment(req.params.id);
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }

    const grid = store.getGrid(exp.grid_id);
    if (!grid) { res.status(404).json({ error: "Grid not found" }); return; }

    const tasks = store.getGridTasks(exp.grid_id);
    let retried = 0;

    for (const task of tasks) {
      // Retry tasks that failed criteria (validation exists but !passed) or failed execution
      const validation = exp.results[task.id];
      const criteriaFailed = validation && !validation.passed;
      const execFailed = ["failed", "killed", "lost"].includes(task.status);

      if (criteriaFailed || execFailed) {
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
          eval_metrics: undefined,
          should_stop: false,
          should_checkpoint: false,
        };
        store.addToGlobalQueue(retryTask);

        // Update grid task_ids
        const idx = grid.task_ids.indexOf(task.id);
        if (idx !== -1) grid.task_ids[idx] = retryTask.id;

        // Clear old validation result, will be re-evaluated
        if (exp.results[task.id]) {
          delete exp.results[task.id];
        }

        webNs.emit("task.update", retryTask);
        retried++;
      }
    }

    if (retried > 0) {
      store.setGrid(grid);
      store.setExperiment(exp);
      triggerSchedule();
    }

    res.json({ ok: true, retried });
  });

  return router;
}
