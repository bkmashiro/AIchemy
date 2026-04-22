import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

import { store } from "./store";
import { setupStubNamespace } from "./socket/stub";
import { setupWebNamespace } from "./socket/web";
import { createStubsRouter } from "./api/stubs";
import { createTasksRouter, createGlobalTasksRouter } from "./api/tasks";
import { Token } from "./types";

const PORT = parseInt(process.env.PORT || "3001", 10);

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

const stubNs = io.of("/stubs");
const webNs = io.of("/web");

setupWebNamespace(webNs);
setupStubNamespace(stubNs, webNs);

// REST API
const api = express.Router();

// Tokens
api.post("/tokens", (req, res) => {
  const { label } = req.body;
  const token: Token = {
    token: uuidv4(),
    created_at: new Date().toISOString(),
    label,
  };
  store.addToken(token);
  res.status(201).json(token);
});

api.get("/tokens", (_req, res) => {
  res.json(store.getAllTokens());
});

api.delete("/tokens/:token", (req, res) => {
  const tok = store.getToken(req.params.token);
  if (!tok) {
    res.status(404).json({ error: "Token not found" });
    return;
  }
  store.deleteToken(req.params.token);
  res.json({ ok: true });
});

// SDK report
api.post("/sdk/report", (req, res) => {
  const { task_id, step, total, loss, metrics, checkpoint } = req.body;

  // Find task across all stubs
  for (const stub of store.getAllStubs()) {
    const task = stub.tasks.find((t) => t.id === task_id);
    if (task) {
      const updated = store.updateTask(stub.id, task_id, {
        progress: { step, total, loss, metrics },
      });
      if (updated) {
        webNs.emit("task.update", updated);
      }

      // Forward progress event to stub namespace
      stubNs.to(`stub:${stub.id}`).emit("task.progress", { task_id, step, total, loss, metrics });

      res.json({ ok: true, should_checkpoint: false });
      return;
    }
  }

  res.status(404).json({ error: "Task not found" });
});

// SLURM pool
api.get("/slurm/pool", (_req, res) => {
  res.json(store.getSlurmPool());
});

api.patch("/slurm/pool", (req, res) => {
  store.setSlurmPool(req.body);
  res.json(store.getSlurmPool());
});

// Mount routers
api.use("/stubs/:id/tasks", createTasksRouter(stubNs, webNs));
api.use("/stubs", createStubsRouter(stubNs, webNs));
api.use("/tasks", createGlobalTasksRouter());

app.use("/api", api);

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[server] SIGTERM received, shutting down gracefully");
  store.save();
  stubNs.emit("server.restarting", {});
  httpServer.close(() => {
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("[server] SIGINT received");
  store.save();
  process.exit(0);
});

httpServer.listen(PORT, () => {
  console.log(`[server] Alchemy v2 running on port ${PORT}`);
  // Ensure a default token exists for testing
  if (store.getAllTokens().length === 0) {
    const defaultToken: Token = {
      token: "default-dev-token",
      created_at: new Date().toISOString(),
      label: "dev",
    };
    store.addToken(defaultToken);
    console.log(`[server] Created default dev token: ${defaultToken.token}`);
  }
});

export { httpServer, io };
