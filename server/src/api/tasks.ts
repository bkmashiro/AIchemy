import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { store } from "../store";
import { dispatchQueuedTasks } from "../socket/stub";
import { Task } from "../types";
import { Namespace } from "socket.io";

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

    const { command, cwd, env, env_setup } = req.body;
    if (!command) {
      res.status(400).json({ error: "command required" });
      return;
    }

    const task: Task = {
      id: uuidv4(),
      stub_id: stub.id,
      command,
      cwd,
      env,
      env_setup,
      status: "queued",
      created_at: new Date().toISOString(),
      log_buffer: [],
    };

    stub.tasks.push(task);
    store.setStub(stub);
    webNs.emit("task.update", task);

    // Try to dispatch immediately
    dispatchQueuedTasks(stub.id, stubNs);

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

// GET /tasks — global task list
export function createGlobalTasksRouter(): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    res.json(store.getAllTasks());
  });

  return router;
}
