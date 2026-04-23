import { Router, Request, Response } from "express";
import { store } from "../store";
import { execShell, dispatchQueuedTasks } from "../socket/stub";
import { Namespace } from "socket.io";

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
    if (!stub) {
      res.status(404).json({ error: "Stub not found" });
      return;
    }
    const { socket_id, ...rest } = stub;
    res.json(rest);
  });

  // DELETE /stubs/:id
  router.delete("/:id", (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub) {
      res.status(404).json({ error: "Stub not found" });
      return;
    }
    if (stub.socket_id) {
      stubNs.to(`stub:${stub.id}`).emit("shutdown", {});
    }
    stub.status = "offline";
    store.setStub(stub);
    webNs.emit("stub.offline", { stub_id: stub.id });
    res.json({ ok: true });
  });

  // PATCH /stubs/:id
  router.patch("/:id", (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub) {
      res.status(404).json({ error: "Stub not found" });
      return;
    }
    if (req.body.max_concurrent !== undefined) {
      stub.max_concurrent = req.body.max_concurrent;
      stubNs.to(`stub:${stub.id}`).emit("config.update", { max_concurrent: stub.max_concurrent });
    }
    if (req.body.name !== undefined) {
      stub.name = req.body.name;
    }
    if (req.body.auto_release !== undefined) {
      stub.auto_release = req.body.auto_release;
    }
    if (req.body.idle_timeout_s !== undefined) {
      stub.idle_timeout_s = req.body.idle_timeout_s;
      stubNs.to(`stub:${stub.id}`).emit("config.update", { idle_timeout: stub.idle_timeout_s });
    }
    store.setStub(stub);
    webNs.emit("stub.online", stub);
    dispatchQueuedTasks(stub.id, stubNs);
    res.json({ ok: true });
  });

  // POST /stubs/:id/shell
  router.post("/:id/shell", async (req: Request, res: Response) => {
    const stub = store.getStub(req.params.id);
    if (!stub) {
      res.status(404).json({ error: "Stub not found" });
      return;
    }
    if (stub.status !== "online") {
      res.status(400).json({ error: "Stub not online" });
      return;
    }
    const { command, timeout = 30 } = req.body;
    if (!command) {
      res.status(400).json({ error: "command required" });
      return;
    }
    try {
      const result = await execShell(stub.id, command, timeout, stubNs);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
