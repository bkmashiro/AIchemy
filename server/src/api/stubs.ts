/**
 * api/stubs.ts — Stub CRUD.
 *
 * PATCH /stubs/:id — update name/max_concurrent.
 * POST /stubs/:id/tasks — direct-to-stub submission (bypasses global queue).
 */

import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { store } from "../store";
import { Task } from "../types";
import { Namespace } from "socket.io";
import { maybeDispatch } from "../scheduler";
import { reliableEmitToStub } from "../reliable";
import { computeFingerprint, writeLockTable, idempotencyCache } from "../dedup";
import { createTask } from "./tasks";
import { createExecRouter } from "./exec";

export function createStubsRouter(stubNs: Namespace, webNs: Namespace): Router {
  const router = Router();

  // GET /stubs
  router.get("/", (_req: Request, res: Response) => {
    const stubs = store.getAllStubs().map(({ socket_id, ...rest }) => rest);
    res.json(stubs);
  });

  // POST /stubs/:id/files — synchronous small file RPC via connected stub socket.
  router.post("/:id/files", async (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub) { res.status(404).json({ error: "Stub not found" }); return; }
    if (stub.status !== "online" || !stub.socket_id) { res.status(503).json({ error: "Stub offline" }); return; }

    const op = req.body.op;
    const filePath = req.body.path;
    if (!["stat", "list", "read"].includes(op)) { res.status(400).json({ error: "op must be stat, list, or read" }); return; }
    if (typeof filePath !== "string" || filePath.length === 0) { res.status(400).json({ error: "path required" }); return; }
    if (filePath.startsWith("/") || filePath.includes("..") || filePath.includes("\0")) { res.status(400).json({ error: "path must be relative and stay within stub file roots" }); return; }

    const socket = stubNs.sockets.get(stub.socket_id);
    if (!socket || !socket.connected) { res.status(503).json({ error: "Stub socket not connected" }); return; }

    const maxBytes = Math.min(Math.max(Number(req.body.max_bytes) || 64 * 1024, 1), 1024 * 1024);
    const requestId = `file_${stub.id}_${uuidv4().slice(0, 8)}`;
    const payload = { request_id: requestId, op, path: filePath, max_bytes: maxBytes };

    try {
      const result = await new Promise<Record<string, any>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 35_000);
        socket.emit("file.request", payload, (response: any) => {
          clearTimeout(timer);
          if (!response || typeof response !== "object") reject(new Error("invalid stub file ack payload"));
          else resolve(response);
        });
      });
      if (result.ok === false) {
        res.status(result.error === "not_found" ? 404 : 400).json(result);
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(err.message === "timeout" ? 504 : 500).json({ error: err.message === "timeout" ? "File RPC timed out" : "Invalid stub file ack payload" });
    }
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
      stub.name = String(req.body.name);
    }
    if (req.body.max_concurrent !== undefined) {
      const mc = Number(req.body.max_concurrent);
      // 0 = drain mode (no new tasks accepted, lets running ones finish)
      if (!Number.isFinite(mc) || mc < 0 || mc > 64) { res.status(400).json({ error: "max_concurrent must be 0-64 (0 = drain)" }); return; }
      stub.max_concurrent = mc;
      // Notify stub of config change (reliable)
      reliableEmitToStub(stub.id, "config.update", { max_concurrent: stub.max_concurrent });
      // Trigger dispatch in case new slots opened
      if (mc > 0) maybeDispatch(stub);
    }
    if (req.body.tags !== undefined) {
      stub.tags = req.body.tags;
    }
    if (req.body.idle_timeout_s !== undefined) {
      const ito = Number(req.body.idle_timeout_s);
      if (!Number.isFinite(ito) || ito < 0) { res.status(400).json({ error: "idle_timeout_s must be >= 0" }); return; }
      stub.idle_timeout_s = ito > 0 ? ito : undefined;
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
    stub.released = true;
    store.setStub(stub);
    webNs.emit("stub.offline", { stub_id: stub.id });
    res.json({ ok: true });
  });

  // POST /stubs/:id/unrelease — clear released flag so stub can reconnect
  router.post("/:id/unrelease", (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub) { res.status(404).json({ error: "Stub not found" }); return; }
    stub.released = false;
    store.setStub(stub);
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

  // POST /stubs/:id/exec2 — synchronous exec via WS exec.request/exec.response (Spec 3)
  // Distinct from the fire-and-forget /exec shell relay above.
  router.use("/:id/exec2", createExecRouter(stubNs));

  // DELETE /stubs/prune — MUST be before /:id to avoid route shadowing
  router.delete("/prune", (_req: Request, res: Response) => {
    const pruned = store.pruneStaleStubs();
    res.json({ ok: true, pruned });
  });

  // DELETE /stubs/:id — remove a specific offline stub with no active tasks
  router.delete("/:id", (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub) { res.status(404).json({ error: "Stub not found" }); return; }
    if (stub.status === "online") { res.status(409).json({ error: "Stub is online — release first" }); return; }
    const activeTasks = stub.tasks.filter((t) => ["running", "assigned", "paused"].includes(t.status));
    if (activeTasks.length > 0) { res.status(409).json({ error: "Stub has active tasks" }); return; }
    store.deleteStub(req.params.id);
    webNs.emit("stub.deleted", { stub_id: req.params.id });
    res.json({ ok: true });
  });

  // POST /stubs/:id/tasks — direct submission to stub queue
  router.post("/:id/tasks", (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub) { res.status(404).json({ error: "Stub not found" }); return; }

    const {
      script, argv, args, raw_args, name, cwd, env_setup, env, env_overrides,
      requirements, priority, max_retries, run_dir,
      idempotency_key, param_overrides, target_tags, python_env,
      submitted_by,
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
    const fingerprint = computeFingerprint({ script, argv, args, raw_args, param_overrides, cwd });
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
      script, argv, args, raw_args, name, cwd, env_setup, env, env_overrides,
      requirements, priority, max_retries, run_dir, param_overrides,
      stub_id: stub.id, target_tags, python_env, submitted_by,
    });

    // Direct to stub queue — status is assigned, not pending
    task.status = "assigned";

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
