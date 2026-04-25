/**
 * index.ts — Alchemy v2.1 Server entry point.
 *
 * Wires together: Express, socket.io, store, scheduler, socket handlers, API routes.
 */

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import { store } from "./store";
import { setupStubNamespace } from "./socket/stub";
import { setupWebNamespace } from "./socket/web";
import { setupControllerNamespace } from "./socket/controller";
import { createGlobalTasksRouter } from "./api/tasks";
import { createStubsRouter } from "./api/stubs";
import { createGridsRouter } from "./api/grids";
import { createMetricsRouter } from "./api/metrics";
import { createSdkRouter } from "./api/sdk";
import { createClusterRouter } from "./api/cluster";
import { startScheduler, triggerSchedule } from "./scheduler";
import { Token } from "./types";
import { backupState, listBackups, restoreFromBackup, pruneBackups } from "./store/backup";
import { BACKUPS_DIR } from "./store";
import { logger } from "./log";
import { startAutoRenew } from "./autorenew";

const PORT = parseInt(process.env.PORT || "3002", 10);

// ─── Express + socket.io ──────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
  pingTimeout: 60_000,
  pingInterval: 25_000,
  maxHttpBufferSize: 1e6,        // 1MB max per message
  connectionStateRecovery: {},
});

const stubNs = io.of("/stubs");
const webNs = io.of("/web");
const controllerNs = io.of("/controller");

setupWebNamespace(webNs);
setupStubNamespace(stubNs, webNs);
setupControllerNamespace(controllerNs, webNs);
startScheduler(webNs, stubNs);

// ─── Auth middleware ──────────────────────────────────────────────────────────

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
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

// ─── API router ───────────────────────────────────────────────────────────────

const api = express.Router();
api.use(authMiddleware);

// Token management
api.post("/tokens", (req, res) => {
  const { name } = req.body;
  if (!name) { res.status(400).json({ error: "name required" }); return; }
  const token: Token = {
    token: `tk_${uuidv4().replace(/-/g, "").slice(0, 24)}`,
    name,
    created_at: new Date().toISOString(),
  };
  store.addToken(token);
  logger.info("token.created", { name });
  res.status(201).json({ name: token.name, token: token.token });
});

api.get("/tokens", (_req, res) => {
  // Return tokens with name but mask the token value partially
  res.json(store.getAllTokens().map((t) => ({ name: t.name, created_at: t.created_at })));
});

api.delete("/tokens/:name", (req, res) => {
  const tok = store.getTokenByName(req.params.name);
  if (!tok) { res.status(404).json({ error: "Token not found" }); return; }
  store.deleteToken(tok.token);
  logger.info("token.revoked", { name: req.params.name });
  res.json({ ok: true });
});

// Backup/restore
api.post("/admin/backup", async (_req, res) => {
  try {
    await store.saveAsync();
    const filename = await backupState(store.getStateFile(), BACKUPS_DIR);
    await pruneBackups(BACKUPS_DIR, 48);
    res.json({ ok: true, filename });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

api.get("/admin/backups", async (_req, res) => {
  try {
    const list = await listBackups(BACKUPS_DIR);
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

api.post("/admin/restore", async (req, res) => {
  const { filename } = req.body;
  if (!filename) { res.status(400).json({ error: "filename required" }); return; }
  try {
    const state = await restoreFromBackup(BACKUPS_DIR, filename);
    store.loadFromState(state);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Cleanup endpoint — prunes old archived tasks
api.post("/cleanup", (req, res) => {
  const { older_than_hours = 24 } = req.body;
  const cutoff = Date.now() - older_than_hours * 3600_000;
  const archive = store.getArchive();
  const before = archive.length;
  const kept = archive.filter((t) => {
    const finishedAt = t.finished_at
      ? new Date(t.finished_at).getTime()
      : new Date(t.created_at).getTime();
    return finishedAt > cutoff;
  });
  store.setArchive(kept);
  const purged = before - kept.length;
  res.json({ ok: true, purged, older_than_hours });
});

// Mount routers
api.use("/tasks", createGlobalTasksRouter(stubNs, webNs));
api.use("/stubs", createStubsRouter(stubNs, webNs));
api.use("/grids", createGridsRouter(stubNs, webNs));
api.use("/cluster", createClusterRouter());

// Health check — no auth required
app.get("/api/health", (_req, res) => {
  const allStubs = store.getAllStubs();
  const online = allStubs.filter(s => s.status === "online").length;
  const running = allStubs.reduce((n, s) => n + s.tasks.filter(t =>
    ["running", "dispatched"].includes(t.status)).length, 0);
  const pending = store.getGlobalQueue().length;
  res.json({
    status: "ok",
    uptime_s: Math.floor(process.uptime()),
    stubs_online: online,
    stubs_total: allStubs.length,
    tasks_running: running,
    tasks_pending: pending,
  });
});

// Public routes (no auth) — overview is read-only stats, SDK uses task_id as credential
const metricsRouter = createMetricsRouter();
app.use("/api", metricsRouter);
app.use("/api/sdk", createSdkRouter(webNs));

// Authenticated API
app.use("/api", api);

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), version: "2.1.0" });
});

// Serve dashboard static files
const dashboardDir = path.join(__dirname, "dashboard");
app.use(express.static(dashboardDir));

// SPA fallback — serve index.html for non-API, non-file routes
app.get("*", (_req, res) => {
  res.sendFile(path.join(dashboardDir, "index.html"));
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on("SIGTERM", () => {
  logger.info("server.stop", { reason: "SIGTERM" });
  store.save();
  stubNs.emit("server.restarting", {});
  httpServer.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
});

process.on("SIGINT", () => {
  logger.info("server.stop", { reason: "SIGINT" });
  store.save();
  process.exit(0);
});

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  logger.info("server.start", { port: PORT, version: "2.1.0" });
  store.startPersistence();

  // Start auto-renew checker (SLURM walltime)
  startAutoRenew();

  // Ensure a default token exists
  if (store.getAllTokens().length === 0) {
    const defaultTokenValue = process.env.ALCHEMY_TOKEN || "alchemy-v2-token";
    const defaultToken: Token = {
      token: defaultTokenValue,
      name: "default",
      created_at: new Date().toISOString(),
    };
    store.addToken(defaultToken);
    logger.info("token.created", { name: "default", token: defaultTokenValue });
  }
});

export { httpServer, io };
