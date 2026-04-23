import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import { store } from "./store";
import { metricsStore } from "./metrics";
import { backupState, listBackups, restoreFromBackup, pruneBackups } from "./store/backup";
import { setupStubNamespace } from "./socket/stub";
import { setupWebNamespace } from "./socket/web";
import { createStubsRouter } from "./api/stubs";
import { createTasksRouter, createGlobalTasksRouter } from "./api/tasks";
import { createGridsRouter } from "./api/grids";
import { createSlurmAccountsRouter } from "./api/slurm-accounts";
import { createWorkflowsRouter } from "./api/workflows";
import { createNotificationsRouter } from "./api/notifications";
import { startScheduler } from "./scheduler";
import { startAutoQueueLoop } from "./slurm-autoqueue";
import { Token } from "./types";
import { TERMINAL_STATUSES } from "./constants";
import { logAudit, getAuditLog } from "./audit";

const PORT = parseInt(process.env.PORT || "3002", 10);

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
startScheduler(webNs, stubNs);
startAutoQueueLoop(webNs);

// Bearer token auth middleware for API routes
function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }
  const key = authHeader.slice(7);
  const token = store.getToken(key);
  if (!token) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }
  next();
}

// REST API
const api = express.Router();
api.use(authMiddleware);

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

// SDK report (moved to public route below)
// Legacy path kept for backwards compat
api.post("/sdk/report", (req, res) => {
  const { task_id, step, total, loss, metrics, checkpoint, run_dir, resumable } = req.body;

  // Find task across all stubs
  for (const stub of store.getAllStubs()) {
    const task = stub.tasks.find((t) => t.id === task_id);
    if (task) {
      const updatePayload: any = {
        progress: { step, total, loss, metrics },
      };
      if (checkpoint) updatePayload.checkpoint_path = checkpoint;
      if (run_dir) updatePayload.run_dir = run_dir;
      if (resumable !== undefined) updatePayload.resumable = resumable;

      const updated = store.updateTask(stub.id, task_id, updatePayload);
      if (updated) {
        webNs.emit("task.update", updated);
        // Check loss anomalies
        const { checkLossAnomaly, updateTaskProgressTime } = require("./scheduler");
        updateTaskProgressTime(task_id);
        checkLossAnomaly(stub.id, task_id, loss, task.progress?.loss, webNs, stubNs);
        // Record to metrics ring buffer
        metricsStore.pushTaskMetrics(task_id, step, loss, metrics);
      }

      // Forward progress event to stub namespace
      stubNs.to(`stub:${stub.id}`).emit("task.progress", { task_id, step, total, loss, metrics });

      // Check should_checkpoint flag, and should_stop flag
      const shouldCheckpoint = task.status === "migrating" || false;
      // Re-read task to get latest should_stop value
      const latestTask = store.getTask(stub.id, task_id);
      res.json({ ok: true, should_checkpoint: shouldCheckpoint, should_stop: latestTask?.should_stop || false });
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

// Purge offline stubs with no active tasks (must be before /stubs router to avoid :id capture)
api.delete("/stubs/offline", (_req, res) => {
  const stubs = store.getAllStubs();
  let purged = 0;
  for (const stub of stubs) {
    if (stub.status !== "offline") continue;
    const hasActive = stub.tasks.some((t) => !(TERMINAL_STATUSES as readonly string[]).includes(t.status));
    if (hasActive) continue;
    store.deleteStub(stub.id);
    logAudit("stub.purge", { stub_id: stub.id, name: stub.name });
    purged++;
  }
  webNs.emit("stubs.update", store.getAllStubs());
  res.json({ ok: true, purged });
});

// Mount routers
api.use("/stubs/:id/tasks", createTasksRouter(stubNs, webNs));
api.use("/stubs", createStubsRouter(stubNs, webNs));
api.use("/tasks", createGlobalTasksRouter(stubNs, webNs));
api.use("/grids", createGridsRouter(stubNs, webNs));
api.use("/slurm/accounts", createSlurmAccountsRouter());
api.use("/workflows", createWorkflowsRouter(stubNs, webNs));
api.use("/notifications", createNotificationsRouter());

// Cleanup: purge old completed/killed/failed tasks
api.post("/cleanup", (req, res) => {
  const { older_than_hours = 24 } = req.body;
  const cutoff = Date.now() - older_than_hours * 3600_000;

  let purged = 0;

  // Clean stub tasks
  for (const stub of store.getAllStubs()) {
    const before = stub.tasks.length;
    stub.tasks = stub.tasks.filter((t) => {
      if (!(TERMINAL_STATUSES as readonly string[]).includes(t.status)) return true;
      const finishedAt = t.finished_at ? new Date(t.finished_at).getTime() : new Date(t.created_at).getTime();
      return finishedAt > cutoff;
    });
    purged += before - stub.tasks.length;
    store.setStub(stub);
  }

  // Clean global queue (terminal tasks shouldn't be there, but just in case)
  for (const task of store.getGlobalQueue()) {
    if (!(TERMINAL_STATUSES as readonly string[]).includes(task.status)) continue;
    const finishedAt = task.finished_at ? new Date(task.finished_at).getTime() : new Date(task.created_at).getTime();
    if (finishedAt <= cutoff) {
      store.removeFromGlobalQueue(task.id);
      purged++;
    }
  }

  res.json({ ok: true, purged, older_than_hours });
});

// Alerts
api.get("/alerts", (_req, res) => {
  res.json(store.getAllAlerts());
});

api.patch("/alerts/:id/resolve", (req, res) => {
  store.resolveAlert(req.params.id);
  res.json({ ok: true });
});

// Migration suggestions
api.get("/migrations/suggestions", (_req, res) => {
  res.json(store.getAllMigrationSuggestions());
});

api.delete("/migrations/suggestions/:id", (req, res) => {
  store.deleteMigrationSuggestion(req.params.id);
  res.json({ ok: true });
});

// Audit log
api.get("/audit", (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  res.json(getAuditLog(limit));
});

// Stall config
api.get("/config/stall", (_req, res) => {
  res.json(store.getStallConfig());
});

api.patch("/config/stall", (req, res) => {
  store.setStallConfig(req.body);
  logAudit("config.stall.update", req.body);
  res.json(store.getStallConfig());
});

// Task checkpoint and pause (ManagedTraining migration)
api.post("/stubs/:stub_id/tasks/:task_id/checkpoint-and-pause", (req, res) => {
  const stub = store.getStub(req.params.stub_id);
  if (!stub) { res.status(404).json({ error: "Stub not found" }); return; }
  const task = store.getTask(req.params.stub_id, req.params.task_id);
  if (!task) { res.status(404).json({ error: "Task not found" }); return; }
  stubNs.to(`stub:${stub.id}`).emit("task.checkpoint_and_pause", { task_id: task.id });
  res.json({ ok: true });
});

// --- Metrics endpoints ---

api.get("/stubs/:id/metrics", (req, res) => {
  const hours = req.query.hours !== undefined ? parseFloat(req.query.hours as string) : 1;
  const points = metricsStore.getStubMetrics(req.params.id, hours);
  res.json({ stub_id: req.params.id, hours, points });
});

api.get("/tasks/:id/metrics", (req, res) => {
  const points = metricsStore.getTaskMetrics(req.params.id);
  res.json({ task_id: req.params.id, points });
});

// Metrics summary: latest point for all tracked stubs (cached 30s)
let metricsSummaryCache: { data: any; ts: number } | null = null;

api.get("/metrics/summary", (_req, res) => {
  const now = Date.now();
  if (metricsSummaryCache && now - metricsSummaryCache.ts < 30_000) {
    res.json(metricsSummaryCache.data);
    return;
  }
  const latest = metricsStore.getLatestStubMetrics();
  const data = { stubs: latest, cached_at: new Date().toISOString() };
  metricsSummaryCache = { data, ts: now };
  res.json(data);
});

// --- Admin backup endpoints ---

api.post("/admin/backup", async (_req, res) => {
  try {
    const stateFile = store.getStateFile();
    const backupsDir = store.getBackupsDir();
    // Flush current state first
    await store.saveAsync();
    const filename = await backupState(stateFile, backupsDir);
    await pruneBackups(backupsDir, 48);
    res.json({ ok: true, filename });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

api.get("/admin/backups", async (_req, res) => {
  try {
    const backupsDir = store.getBackupsDir();
    const list = await listBackups(backupsDir);
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

api.post("/admin/restore", async (req, res) => {
  const { filename } = req.body;
  if (!filename) {
    res.status(400).json({ error: "filename required" });
    return;
  }
  try {
    const backupsDir = store.getBackupsDir();
    const state = await restoreFromBackup(backupsDir, filename);
    store.loadFromState(state);
    res.json({ ok: true, stubs: state.stubs?.length ?? 0 });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Overview endpoint (no auth, cached 30s) ---
let overviewCache: { data: any; cached_at: string; ts: number } | null = null;

app.get("/api/overview", (_req, res) => {
  const now = Date.now();
  if (overviewCache && now - overviewCache.ts < 30_000) {
    res.json(overviewCache.data);
    return;
  }

  const stubs = store.getAllStubs();
  const onlineCount = stubs.filter((s) => s.status === "online").length;

  const tasks = store.getAllTasks();
  const taskCounts = { total: tasks.length, running: 0, queued: 0, completed: 0, failed: 0 };
  for (const t of tasks) {
    if (t.status === "running") taskCounts.running++;
    else if (t.status === "queued" || t.status === "waiting") taskCounts.queued++;
    else if (t.status === "completed" || t.status === "completed_with_errors") taskCounts.completed++;
    else if (t.status === "failed") taskCounts.failed++;
  }

  let totalVram = 0;
  let usedVram = 0;
  for (const s of stubs) {
    if (s.status !== "online") continue;
    totalVram += s.gpu.vram_total_mb * s.gpu.count;
    if (s.gpu_stats?.gpus) {
      for (const g of s.gpu_stats.gpus) {
        usedVram += g.memory_used_mb;
      }
    }
  }

  const grids = store.getAllGrids();
  const gridCounts = { total: grids.length, running: 0, completed: 0 };
  for (const g of grids) {
    if (g.status === "running") gridCounts.running++;
    else if (g.status === "completed") gridCounts.completed++;
  }

  const cached_at = new Date().toISOString();
  const data = {
    stubs: { total: stubs.length, online: onlineCount, offline: stubs.length - onlineCount },
    tasks: taskCounts,
    gpus: { total_vram_mb: totalVram, used_vram_mb: usedVram },
    grids: gridCounts,
    cached_at,
  };

  overviewCache = { data, cached_at, ts: now };
  res.json(data);
});

// Public SDK report endpoint (no auth — task_id is the credential)
app.post("/api/sdk/report", (req, res) => {
  const { task_id, step, total, loss, metrics, checkpoint, run_dir, resumable } = req.body;
  for (const stub of store.getAllStubs()) {
    const task = stub.tasks.find((t: any) => t.id === task_id);
    if (task) {
      const updatePayload: any = { progress: { step, total, loss, metrics } };
      if (checkpoint) updatePayload.checkpoint_path = checkpoint;
      if (run_dir) updatePayload.run_dir = run_dir;
      if (resumable !== undefined) updatePayload.resumable = resumable;
      const updated = store.updateTask(stub.id, task_id, updatePayload);
      if (updated) {
        const webNs = io.of("/web");
        webNs.emit("task.update", updated);
        // Record to metrics ring buffer
        metricsStore.pushTaskMetrics(task_id, step, loss, metrics);
      }
      // Re-read task to get latest should_stop value
      const latestTask2 = store.getTask(stub.id, task_id);
      res.json({ ok: true, should_checkpoint: task.status === "migrating", should_stop: latestTask2?.should_stop || false });
      return;
    }
  }
  res.status(404).json({ error: "Task not found" });
});

app.use("/api", api);

// Serve dashboard static files
app.use(express.static(path.join(__dirname, "dashboard")));

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
  // Ensure a default token exists
  if (store.getAllTokens().length === 0) {
    const defaultToken: Token = {
      token: process.env.ALCHEMY_TOKEN || "alchemy-v2-token",
      created_at: new Date().toISOString(),
      label: "default",
    };
    store.addToken(defaultToken);
    console.log(`[server] Created default ${defaultToken.label} token: ${defaultToken.token}`);
  }
});

export { httpServer, io };
