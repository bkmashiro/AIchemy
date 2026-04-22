import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { store } from "../store";
import { dispatchQueuedTasks } from "../socket/stub";
import { Task } from "../types";
import { Namespace } from "socket.io";
import { pickBestStub } from "../scheduler";

/**
 * Detect cycle in DAG: returns true if adding edges from newTaskId → depends_on would create a cycle.
 */
function hasCycle(newTaskId: string, dependsOn: string[], allTasks: Task[]): boolean {
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));
  const visited = new Set<string>();

  function dfs(id: string): boolean {
    if (id === newTaskId) return true; // cycle detected
    if (visited.has(id)) return false;
    visited.add(id);
    const task = taskMap.get(id);
    if (!task?.depends_on) return false;
    return task.depends_on.some(dfs);
  }

  return dependsOn.some(dfs);
}

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
            estimated_vram_mb, auto_estimate, force } = req.body;
    if (!command) {
      res.status(400).json({ error: "command required" });
      return;
    }

    // run_dir conflict detection
    if (run_dir && !force) {
      const conflict = store.getAllTasks().find(
        (t) => t.run_dir === run_dir && ["completed", "completed_with_errors"].includes(t.status)
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
      if (hasCycle(newId, depends_on, allTasks)) {
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
    };

    stub.tasks.push(task);
    store.setStub(stub);
    webNs.emit("task.update", task);

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
        break;

      case "resume":
        if (task.status !== "paused") {
          res.status(400).json({ error: "Task not paused" });
          return;
        }
        stubNs.to(`stub:${stub.id}`).emit("task.resume", { task_id: task.id });
        store.updateTask(stub.id, task.id, { status: "running" });
        webNs.emit("task.update", { ...task, status: "running" });
        break;

      case "kill":
        if (!["running", "paused", "queued"].includes(task.status)) {
          res.status(400).json({ error: "Task cannot be killed in current state" });
          return;
        }
        if (task.status === "queued") {
          store.updateTask(stub.id, task.id, { status: "killed", finished_at: new Date().toISOString() });
          webNs.emit("task.update", { ...task, status: "killed" });
        } else {
          stubNs.to(`stub:${stub.id}`).emit("task.kill", { task_id: task.id, signal: signal || "SIGTERM" });
          store.updateTask(stub.id, task.id, { status: "killed", finished_at: new Date().toISOString() });
          webNs.emit("task.update", { ...task, status: "killed" });
        }
        break;

      default:
        res.status(400).json({ error: "Unknown action" });
        return;
    }

    const updated = store.getTask(req.params.id, req.params.tid);
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

// GET /tasks — global task list, POST /tasks — auto-assign
export function createGlobalTasksRouter(stubNs?: Namespace, webNs?: Namespace): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    res.json(store.getAllTasks());
  });

  // POST /tasks — auto-assign to best stub
  router.post("/", (req: Request, res: Response) => {
    const { command, cwd, env, env_setup, depends_on, post_hooks, run_dir, resumable,
            estimated_vram_mb, auto_estimate, force } = req.body;
    if (!command) {
      res.status(400).json({ error: "command required" });
      return;
    }

    // run_dir conflict detection
    if (run_dir && !force) {
      const conflict = store.getAllTasks().find(
        (t) => t.run_dir === run_dir && ["completed", "completed_with_errors"].includes(t.status)
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

    const targetStub = pickBestStub(estimated_vram_mb);
    if (!targetStub) {
      res.status(503).json({ error: "No online stubs available" });
      return;
    }

    const allTasks = store.getAllTasks();
    const hasUnmetDeps = depends_on && depends_on.length > 0 && depends_on.some((depId: string) => {
      const dep = allTasks.find((t) => t.id === depId);
      return dep && !["completed", "completed_with_errors"].includes(dep.status);
    });

    const task: Task = {
      id: uuidv4(),
      stub_id: targetStub.id,
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
    };

    targetStub.tasks.push(task);
    store.setStub(targetStub);
    if (webNs) webNs.emit("task.update", task);
    if (task.status === "queued" && stubNs) {
      dispatchQueuedTasks(targetStub.id, stubNs);
    }

    res.status(201).json(task);
  });

  return router;
}
