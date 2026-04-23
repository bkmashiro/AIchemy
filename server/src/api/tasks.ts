import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { store } from "../store";
import { dispatchQueuedTasks } from "../socket/stub";
import { Task } from "../types";
import { Namespace } from "socket.io";
import { pickBestStub } from "../scheduler";
import { hasCycleInTaskDag } from "../utils/graph";
import { logAudit } from "../audit";
import { TERMINAL_STATUSES } from "../constants";

export function createTasksRouter(stubNs: Namespace, webNs: Namespace): Router {
  const router = Router({ mergeParams: true });

  // GET /stubs/:id/tasks
  router.get("/", (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub) {
      res.status(404).json({ error: "Stub not found" });
      return;
    }
    res.json(stub.tasks);
  });

  // POST /stubs/:id/tasks
  router.post("/", (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub) {
      res.status(404).json({ error: "Stub not found" });
      return;
    }

    const { command, cwd, env, env_setup, depends_on, post_hooks, run_dir, resumable,
            estimated_vram_mb, auto_estimate, force, max_retries, priority, timeout_s } = req.body;
    if (!command) {
      res.status(400).json({ error: "command required" });
      return;
    }

    // run_dir conflict detection
    if (run_dir && !force) {
      const COMPLETED_STATUSES: string[] = ["completed", "completed_with_errors"];
      const conflict = store.getAllTasks().find(
        (t) => t.run_dir === run_dir && COMPLETED_STATUSES.includes(t.status)
      );
      if (conflict) {
        res.status(409).json({
          error: `A completed task already exists with run_dir "${run_dir}"`,
          conflicting_task_id: conflict.id,
          hint: "Use force: true to override",
        });
        return;
      }
    }

    // Validate dependencies
    if (depends_on && !Array.isArray(depends_on)) {
      res.status(400).json({ error: "depends_on must be an array of task IDs" });
      return;
    }

    // Cycle detection
    const allTasks = store.getAllTasks();
    if (depends_on && depends_on.length > 0) {
      const newId = uuidv4(); // temp ID for cycle check — we'll reuse below
      if (hasCycleInTaskDag(newId, depends_on, allTasks)) {
        res.status(400).json({ error: "Circular dependency detected" });
        return;
      }
    }

    const hasUnmetDeps = depends_on && depends_on.length > 0 && depends_on.some((depId: string) => {
      const dep = allTasks.find((t) => t.id === depId);
      return dep && !["completed", "completed_with_errors"].includes(dep.status);
    });

    const task: Task = {
      id: uuidv4(),
      stub_id: stub.id,
      command,
      cwd,
      env,
      env_setup,
      status: hasUnmetDeps ? "waiting" : "queued",
      created_at: new Date().toISOString(),
      log_buffer: [],
      depends_on: depends_on || [],
      post_hooks: post_hooks || [],
      run_dir,
      resumable: resumable || false,
      estimated_vram_mb,
      auto_estimate,
      max_retries: max_retries ?? 0,
      retry_count: 0,
      priority: priority ?? 5,
      timeout_s,
    };

    stub.tasks.push(task);
    store.setStub(stub);
    webNs.emit("task.update", task);
    logAudit("task.create", { task_id: task.id, stub_id: stub.id, command: task.command, priority: task.priority });

    // Try to dispatch immediately (only if not waiting)
    if (task.status === "queued") {
      dispatchQueuedTasks(stub.id, stubNs);
    }

    res.status(201).json(task);
  });

  // GET /stubs/:id/tasks/:tid
  router.get("/:tid", (req: Request, res: Response) => {
    const task = store.getTask(req.params.id, req.params.tid);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(task);
  });

  // PATCH /stubs/:id/tasks/:tid
  router.patch("/:tid", (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub) {
      res.status(404).json({ error: "Stub not found" });
      return;
    }
    const task = store.getTask(req.params.id, req.params.tid);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const { action, signal } = req.body;

    switch (action) {
      case "pause":
        if (task.status !== "running") {
          res.status(400).json({ error: "Task not running" });
          return;
        }
        stubNs.to(`stub:${stub.id}`).emit("task.pause", { task_id: task.id });
        store.updateTask(stub.id, task.id, { status: "paused" });
        webNs.emit("task.update", { ...task, status: "paused" });
        logAudit("task.pause", { task_id: task.id, stub_id: stub.id });
        break;

      case "resume":
        if (task.status !== "paused") {
          res.status(400).json({ error: "Task not paused" });
          return;
        }
        stubNs.to(`stub:${stub.id}`).emit("task.resume", { task_id: task.id });
        store.updateTask(stub.id, task.id, { status: "running" });
        webNs.emit("task.update", { ...task, status: "running" });
        logAudit("task.resume", { task_id: task.id, stub_id: stub.id });
        break;

      case "kill":
        if (!["running", "paused", "queued", "dispatched"].includes(task.status)) {
          res.status(400).json({ error: "Task cannot be killed in current state" });
          return;
        }
        if (task.status === "queued" || task.status === "dispatched") {
          store.updateTask(stub.id, task.id, { status: "killed", finished_at: new Date().toISOString() });
          webNs.emit("task.update", { ...task, status: "killed" });
        } else {
          stubNs.to(`stub:${stub.id}`).emit("task.kill", { task_id: task.id, signal: signal || "SIGTERM" });
          store.updateTask(stub.id, task.id, { status: "killed", finished_at: new Date().toISOString() });
          webNs.emit("task.update", { ...task, status: "killed" });
        }
        logAudit("task.kill", { task_id: task.id, stub_id: stub.id, signal: signal || "SIGTERM" });
        break;

      default:
        res.status(400).json({ error: "Unknown action" });
        return;
    }

    const updated = store.getTask(req.params.id, req.params.tid);
    res.json(updated);
  });

  // POST /stubs/:id/tasks/:tid/kill — convenience endpoint
  router.post("/:tid/kill", (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub) {
      res.status(404).json({ error: "Stub not found" });
      return;
    }
    const task = store.getTask(req.params.id, req.params.tid);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (!["running", "paused", "queued"].includes(task.status)) {
      res.status(400).json({ error: "Task cannot be killed in current state" });
      return;
    }
    const signal = req.body?.signal || "SIGTERM";
    if (task.status === "queued") {
      store.updateTask(stub.id, task.id, { status: "killed", finished_at: new Date().toISOString() });
    } else {
      stubNs.to(`stub:${stub.id}`).emit("task.kill", { task_id: task.id, signal });
      store.updateTask(stub.id, task.id, { status: "killed", finished_at: new Date().toISOString() });
    }
    const updated = store.getTask(req.params.id, req.params.tid);
    webNs.emit("task.update", updated);
    res.json(updated);
  });

  // POST /stubs/:id/tasks/:tid/stop — set should_stop flag
  router.post("/:tid/stop", (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub) {
      res.status(404).json({ error: "Stub not found" });
      return;
    }
    const task = store.getTask(req.params.id, req.params.tid);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    store.updateTask(stub.id, task.id, { should_stop: true });
    const updated = store.getTask(req.params.id, req.params.tid);
    logAudit("task.stop", { task_id: task.id, stub_id: stub.id });
    res.json(updated);
  });

  // DELETE /stubs/:id/tasks/:tid
  router.delete("/:tid", (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub) {
      res.status(404).json({ error: "Stub not found" });
      return;
    }
    const task = store.getTask(req.params.id, req.params.tid);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    // Kill if running
    if (task.status === "running" || task.status === "paused") {
      stubNs.to(`stub:${stub.id}`).emit("task.kill", { task_id: task.id, signal: "SIGKILL" });
    }

    stub.tasks = stub.tasks.filter((t) => t.id !== task.id);
    store.setStub(stub);
    webNs.emit("task.update", { ...task, status: "killed" });

    res.json({ ok: true });
  });

  // GET /stubs/:id/tasks/:tid/logs
  router.get("/:tid/logs", (req: Request, res: Response) => {
    const task = store.getTask(req.params.id, req.params.tid);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json({ task_id: task.id, lines: task.log_buffer });
  });

  return router;
}

// GET /tasks — global task list (includes global queue)
// POST /tasks — add to global queue, dispatch to best stub if available
export function createGlobalTasksRouter(stubNs?: Namespace, webNs?: Namespace): Router {
  const router = Router();

  // GET /tasks — all tasks including global queue
  router.get("/", (_req: Request, res: Response) => {
    res.json(store.getAllTasks());
  });

  // POST /tasks — add to global queue, dispatch immediately if a stub is available
  router.post("/", (req: Request, res: Response) => {
    const { command, cwd, env, env_setup, depends_on, post_hooks, run_dir, resumable,
            estimated_vram_mb, auto_estimate, force, max_retries, priority, timeout_s } = req.body;
    if (!command) {
      res.status(400).json({ error: "command required" });
      return;
    }

    // run_dir conflict detection
    if (run_dir && !force) {
      const COMPLETED_STATUSES_GLOBAL: string[] = ["completed", "completed_with_errors"];
      const conflict = store.getAllTasks().find(
        (t) => t.run_dir === run_dir && COMPLETED_STATUSES_GLOBAL.includes(t.status)
      );
      if (conflict) {
        res.status(409).json({
          error: `A completed task already exists with run_dir "${run_dir}"`,
          conflicting_task_id: conflict.id,
          hint: "Use force: true to override",
        });
        return;
      }
    }

    const allTasks = store.getAllTasks();
    const hasUnmetDeps = depends_on && depends_on.length > 0 && depends_on.some((depId: string) => {
      const dep = allTasks.find((t) => t.id === depId);
      return dep && !["completed", "completed_with_errors"].includes(dep.status);
    });

    const task: Task = {
      id: uuidv4(),
      stub_id: "",   // no stub yet — lives in global queue
      command,
      cwd,
      env,
      env_setup,
      status: hasUnmetDeps ? "waiting" : "queued",
      created_at: new Date().toISOString(),
      log_buffer: [],
      depends_on: depends_on || [],
      post_hooks: post_hooks || [],
      run_dir,
      resumable: resumable || false,
      estimated_vram_mb,
      auto_estimate,
      max_retries: max_retries ?? 0,
      retry_count: 0,
      priority: priority ?? 5,
      timeout_s,
    };

    // Add to global queue
    store.addToGlobalQueue(task);
    if (webNs) webNs.emit("task.update", task);
    logAudit("task.create", { task_id: task.id, stub_id: "", command: task.command, priority: task.priority });

    // Try to dispatch immediately to a stub if one is available
    if (task.status === "queued" && stubNs) {
      const targetStub = pickBestStub(estimated_vram_mb);
      if (targetStub) {
        dispatchQueuedTasks(targetStub.id, stubNs);
      }
    }

    res.status(201).json(task);
  });

  // POST /tasks/batch/retry — retry multiple failed tasks
  router.post("/batch/retry", (req: Request, res: Response) => {
    if (!stubNs || !webNs) {
      res.status(503).json({ error: "Service not ready" });
      return;
    }

    const { task_ids } = req.body;
    if (!Array.isArray(task_ids)) {
      res.status(400).json({ error: "task_ids must be an array" });
      return;
    }

    const results: Array<{ id: string; ok: boolean; new_task_id?: string; error?: string }> = [];

    for (const taskId of task_ids) {
      const found = store.findTask(taskId);
      if (!found) {
        results.push({ id: taskId, ok: false, error: "Not found" });
        continue;
      }

      const { task } = found;
      const retryTask: Task = {
        id: uuidv4(),
        stub_id: "",
        command: task.command,
        cwd: task.cwd,
        env: task.env,
        env_setup: task.env_setup,
        status: "queued",
        created_at: new Date().toISOString(),
        log_buffer: [],
        depends_on: [],
        post_hooks: task.post_hooks || [],
        run_dir: task.run_dir,
        resumable: task.resumable,
        estimated_vram_mb: task.estimated_vram_mb,
        auto_estimate: task.auto_estimate,
        retry_of: task.id,
        retry_count: 0,
        max_retries: task.max_retries ?? 0,
      };

      store.addToGlobalQueue(retryTask);
      webNs.emit("task.update", retryTask);

      const targetStub = pickBestStub(retryTask.estimated_vram_mb);
      if (targetStub) {
        dispatchQueuedTasks(targetStub.id, stubNs);
      }

      results.push({ id: taskId, ok: true, new_task_id: retryTask.id });
    }

    res.json({ results });
  });

  // GET /tasks/:id — find task anywhere (stub or global queue)
  router.get("/:id", (req: Request, res: Response) => {
    const found = store.findTask(req.params.id);
    if (!found) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(found.task);
  });

  // POST /tasks/:id/retry — create a new task with same command/cwd/env, linked via retry_of
  router.post("/:id/retry", (req: Request, res: Response) => {
    if (!stubNs || !webNs) {
      res.status(503).json({ error: "Service not ready" });
      return;
    }

    const found = store.findTask(req.params.id);
    if (!found) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const { task } = found;
    const retryTask: Task = {
      id: uuidv4(),
      stub_id: "",
      command: task.command,
      cwd: task.cwd,
      env: task.env,
      env_setup: task.env_setup,
      status: "queued",
      created_at: new Date().toISOString(),
      log_buffer: [],
      depends_on: [],
      post_hooks: task.post_hooks || [],
      run_dir: task.run_dir,
      resumable: task.resumable,
      estimated_vram_mb: task.estimated_vram_mb,
      auto_estimate: task.auto_estimate,
      retry_of: task.id,
      retry_count: 0,
      max_retries: task.max_retries ?? 0,
    };

    store.addToGlobalQueue(retryTask);
    if (webNs) webNs.emit("task.update", retryTask);

    const targetStub = pickBestStub(retryTask.estimated_vram_mb);
    if (targetStub && stubNs) {
      dispatchQueuedTasks(targetStub.id, stubNs);
    }

    res.status(201).json(retryTask);
  });

  // POST /tasks/:id/move — move a queued task to a specific stub
  router.post("/:id/move", (req: Request, res: Response) => {
    if (!stubNs || !webNs) {
      res.status(503).json({ error: "Service not ready" });
      return;
    }

    const { stub_id } = req.body;
    if (!stub_id) {
      res.status(400).json({ error: "stub_id required" });
      return;
    }

    const targetStub = store.getStub(stub_id);
    if (!targetStub) {
      res.status(404).json({ error: "Target stub not found" });
      return;
    }

    const found = store.findTask(req.params.id);
    if (!found) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const { task, stubId: currentStubId } = found;

    if (task.status !== "queued") {
      res.status(400).json({ error: "Only queued tasks can be moved" });
      return;
    }

    if (currentStubId === stub_id) {
      res.json(task); // already there
      return;
    }

    // Remove from current location
    if (currentStubId === null) {
      // From global queue
      store.removeFromGlobalQueue(task.id);
    } else {
      // From a stub
      const currentStub = store.getStub(currentStubId);
      if (currentStub) {
        currentStub.tasks = currentStub.tasks.filter((t) => t.id !== task.id);
        store.setStub(currentStub);
      }
    }

    // Assign to target stub
    task.stub_id = stub_id;
    targetStub.tasks.push(task);
    store.setStub(targetStub);
    webNs.emit("task.update", task);

    // Trigger dispatch on target
    dispatchQueuedTasks(stub_id, stubNs);

    res.json(task);
  });

  // POST /tasks/batch/kill — kill multiple tasks
  router.post("/batch/kill", (req: Request, res: Response) => {
    if (!stubNs || !webNs) {
      res.status(503).json({ error: "Service not ready" });
      return;
    }

    const { task_ids } = req.body;
    if (!Array.isArray(task_ids)) {
      res.status(400).json({ error: "task_ids must be an array" });
      return;
    }

    const results: Array<{ id: string; ok: boolean; error?: string }> = [];

    for (const taskId of task_ids) {
      const found = store.findTask(taskId);
      if (!found) {
        results.push({ id: taskId, ok: false, error: "Not found" });
        continue;
      }

      const { task, stubId } = found;

      if (!["running", "paused", "queued", "dispatched"].includes(task.status)) {
        results.push({ id: taskId, ok: false, error: `Cannot kill task in status '${task.status}'` });
        continue;
      }

      const now = new Date().toISOString();

      if (stubId === null) {
        // In global queue
        store.updateGlobalQueueTask(taskId, { status: "killed", finished_at: now });
        const updated = store.findTask(taskId)?.task;
        if (updated) webNs.emit("task.update", updated);
      } else {
        if (task.status === "running" || task.status === "paused") {
          stubNs.to(`stub:${stubId}`).emit("task.kill", { task_id: taskId, signal: "SIGTERM" });
        }
        store.updateTask(stubId, taskId, { status: "killed", finished_at: now });
        const updated = store.getTask(stubId, taskId);
        if (updated) webNs.emit("task.update", updated);
      }

      results.push({ id: taskId, ok: true });
    }

    res.json({ results });
  });

  // POST /tasks/batch/requeue — requeue multiple tasks back to global queue
  router.post("/batch/requeue", (req: Request, res: Response) => {
    if (!stubNs || !webNs) {
      res.status(503).json({ error: "Service not ready" });
      return;
    }

    const { task_ids } = req.body;
    if (!Array.isArray(task_ids)) {
      res.status(400).json({ error: "task_ids must be an array" });
      return;
    }

    const results: Array<{ id: string; ok: boolean; error?: string }> = [];

    for (const taskId of task_ids) {
      const found = store.findTask(taskId);
      if (!found) {
        results.push({ id: taskId, ok: false, error: "Not found" });
        continue;
      }

      const { task, stubId } = found;

      // Only requeue terminal or queued tasks
      const requeueable: string[] = [...TERMINAL_STATUSES, "queued"];
      if (!requeueable.includes(task.status)) {
        results.push({ id: taskId, ok: false, error: `Cannot requeue task in status '${task.status}'` });
        continue;
      }

      // Remove from current location
      if (stubId === null) {
        // Already in global queue — just reset status
        store.updateGlobalQueueTask(taskId, {
          status: "queued",
          exit_code: undefined,
          finished_at: undefined,
          started_at: undefined,
          pid: undefined,
          requeued_at: new Date().toISOString(),
        });
        const updated = store.findTask(taskId)?.task;
        if (updated) webNs.emit("task.update", updated);
      } else {
        // Remove from stub
        const stub = store.getStub(stubId);
        if (stub) {
          stub.tasks = stub.tasks.filter((t) => t.id !== taskId);
          store.setStub(stub);
        }
        // Add fresh to global queue
        const requeuedTask: Task = {
          ...task,
          stub_id: "",
          status: "queued",
          exit_code: undefined,
          finished_at: undefined,
          started_at: undefined,
          pid: undefined,
          requeued_at: new Date().toISOString(),
        };
        store.addToGlobalQueue(requeuedTask);
        webNs.emit("task.update", requeuedTask);
      }

      // Try to dispatch to an available stub
      const targetStub = pickBestStub(task.estimated_vram_mb);
      if (targetStub && stubNs) {
        dispatchQueuedTasks(targetStub.id, stubNs);
      }

      results.push({ id: taskId, ok: true });
    }

    res.json({ results });
  });

  // DELETE /tasks/batch — delete/clean up completed/killed/failed tasks
  router.delete("/batch", (req: Request, res: Response) => {
    if (!webNs) {
      res.status(503).json({ error: "Service not ready" });
      return;
    }

    const { task_ids } = req.body;
    if (!Array.isArray(task_ids)) {
      res.status(400).json({ error: "task_ids must be an array" });
      return;
    }

    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    const deletable: string[] = [...TERMINAL_STATUSES];

    for (const taskId of task_ids) {
      const found = store.findTask(taskId);
      if (!found) {
        results.push({ id: taskId, ok: false, error: "Not found" });
        continue;
      }

      const { task, stubId } = found;

      if (!deletable.includes(task.status)) {
        results.push({ id: taskId, ok: false, error: `Cannot delete task in status '${task.status}' — kill it first` });
        continue;
      }

      if (stubId === null) {
        store.removeFromGlobalQueue(taskId);
      } else {
        const stub = store.getStub(stubId);
        if (stub) {
          stub.tasks = stub.tasks.filter((t) => t.id !== taskId);
          store.setStub(stub);
        }
      }

      webNs.emit("task.deleted", { task_id: taskId });
      results.push({ id: taskId, ok: true });
    }

    res.json({ results });
  });

  return router;
}
