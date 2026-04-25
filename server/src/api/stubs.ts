/**
 * api/stubs.ts — Stub CRUD.
 *
 * PATCH /stubs/:id — update name/max_concurrent.
 * POST /stubs/:id/tasks — direct-to-stub submission (bypasses global queue).
 */

import { Router, Request, Response } from "express";
import { store } from "../store";
import { Task } from "../types";
import { Namespace } from "socket.io";
import { maybeDispatch } from "../scheduler";
import { reliableEmitToStub } from "../reliable";
import { computeFingerprint, writeLockTable, idempotencyCache } from "../dedup";
import { createTask } from "./tasks";

export function createStubsRouter(stubNs: Namespace, webNs: Namespace): Router {
  const router = Router();

  // GET /stubs
  router.get("/", (_req: Request, res: Response) => {
    const stubs = store.getAllStubs().map(({ socket_id, ...rest }) => rest);
    res.json(stubs);
  });

  // GET /stubs/:id
  router.get("/:id", (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub) { res.status(404).json({ error: "Stub not found" }); return; }
    const { socket_id, ...rest } = stub;
    res.json(rest);
  });

  // PATCH /stubs/:id — update name or max_concurrent
  router.patch("/:id", (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub) { res.status(404).json({ error: "Stub not found" }); return; }

    if (req.body.name !== undefined) {
      stub.name = req.body.name;
    }
    if (req.body.max_concurrent !== undefined) {
      stub.max_concurrent = req.body.max_concurrent;
      // Notify stub of config change (reliable)
      reliableEmitToStub(stub.id, "config.update", { max_concurrent: stub.max_concurrent });
      // Trigger dispatch in case new slots opened
      maybeDispatch(stub);
    }
    if (req.body.tags !== undefined) {
      stub.tags = req.body.tags;
    }
    if (req.body.auto_renew !== undefined) {
      stub.auto_renew = req.body.auto_renew;
    }
    if (req.body.deploy_config !== undefined) {
      stub.deploy_config = req.body.deploy_config;
    }

    store.setStub(stub);
    webNs.emit("stub.update", (() => { const { socket_id, ...rest } = stub; return rest; })());
    res.json({ ok: true, stub: (() => { const { socket_id, ...rest } = stub; return rest; })() });
  });

  // POST /stubs/:id/release — forcibly mark stub offline and lose its active tasks
  router.post("/:id/release", (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub) { res.status(404).json({ error: "Stub not found" }); return; }

    const hasRunning = stub.tasks.some((t) => t.status === "running");
    if (hasRunning) { res.status(409).json({ error: "Stub has running tasks — drain first" }); return; }

    // Disconnect socket if online
    if (stub.socket_id) {
      const socket = stubNs.sockets.get(stub.socket_id);
      if (socket) socket.disconnect(true);
    }

    stub.status = "offline";
    stub.socket_id = undefined;
    store.setStub(stub);
    webNs.emit("stub.offline", { stub_id: stub.id });
    res.json({ ok: true });
  });

  // POST /stubs/:id/restart — ask stub to exit cleanly (wrapper will restart it)
  router.post("/:id/restart", (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub || stub.status !== "online") { res.status(404).json({ error: "Stub not online" }); return; }
    reliableEmitToStub(stub.id, "stub.restart", {});
    res.json({ ok: true });
  });

  // POST /stubs/:id/sync — trigger immediate status sync and return result
  router.post("/:id/sync", (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub || stub.status !== "online" || !stub.socket_id) { res.status(404).json({ error: "Stub not online" }); return; }
    const socket = stubNs.sockets.get(stub.socket_id);
    if (!socket) { res.status(500).json({ error: "Socket not found" }); return; }
    socket.emit("status.sync", {}, (response: any) => {
      res.json(response ?? { error: "No response from stub" });
    });
  });

  // POST /stubs/:id/exec — fire a shell command on the stub
  // Returns { request_id } immediately; output arrives via WebSocket shell.output / shell.done
  router.post("/:id/exec", (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub) { res.status(404).json({ error: "Stub not found" }); return; }
    if (stub.status !== "online") { res.status(409).json({ error: "Stub offline" }); return; }

    const { command, timeout } = req.body;
    if (!command || typeof command !== "string") {
      res.status(400).json({ error: "command required" });
      return;
    }

    const requestId = `api_${stub.id}_${Date.now()}`;
    reliableEmitToStub(stub.id, "shell.exec", {
      request_id: requestId,
      command,
      timeout: Math.min(Number(timeout) || 30, 120),
    });

    res.json({ request_id: requestId });
  });

  // POST /stubs/:id/tasks — direct submission to stub queue
  router.post("/:id/tasks", (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub) { res.status(404).json({ error: "Stub not found" }); return; }

    const {
      script, args, raw_args, name, cwd, env_setup, env,
      requirements, priority, max_retries, run_dir,
      idempotency_key, param_overrides, target_tags, python_env,
    } = req.body;

    if (!script) { res.status(400).json({ error: "script required" }); return; }

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
      requirements, priority, max_retries, run_dir, param_overrides,
      stub_id: stub.id, target_tags, python_env,
    });

    // Direct to stub queue — status is queued, not pending
    task.status = "queued";

    // Acquire write lock now so subsequent submits with the same run_dir are rejected
    if (run_dir) {
      writeLockTable.acquire(run_dir, task.id);
    }

    stub.tasks.push(task);
    store.setStub(stub);
    webNs.emit("task.update", task);

    if (idempotency_key) {
      idempotencyCache.set(idempotency_key, task.id);
    }

    // Dispatch immediately
    maybeDispatch(stub);

    res.status(201).json(task);
  });

  return router;
}
