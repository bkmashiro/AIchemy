import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../discord", () => ({
  notifySubmitted: vi.fn().mockResolvedValue(undefined),
  notifyTaskMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../scheduler", () => ({
  triggerSchedule: vi.fn(),
  maybeDispatch: vi.fn(),
  startScheduler: vi.fn(),
}));

vi.mock("../socket/stub", () => ({
  initiateKillChain: vi.fn(),
}));

vi.mock("../reliable", () => ({
  reliableEmitToStub: vi.fn(),
}));

import { store } from "../store";
import { createGlobalTasksRouter } from "../api/tasks";
import { createMetricsRouter } from "../api/metrics";
import { createSdkRouter } from "../api/sdk";
import type { Task } from "../types";

const TEST_TOKEN = "test-token";

function makeNamespace() {
  return { emit: vi.fn(), sockets: { get: vi.fn() } } as any;
}

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }
  if (!store.getToken(authHeader.slice(7))) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }
  next();
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-sensitive",
    seq: store.nextSeq(),
    fingerprint: "fp-sensitive",
    display_name: "sensitive task",
    script: "/workspace/train.py",
    command: "python /workspace/train.py",
    status: "pending",
    priority: 5,
    created_at: new Date().toISOString(),
    log_buffer: ["export API_KEY=secret-value"],
    retry_count: 0,
    max_retries: 0,
    should_stop: false,
    should_checkpoint: false,
    env: { API_KEY: "secret-value" },
    ...overrides,
  };
}

function makeApp() {
  const app = express();
  app.use(express.json());

  const webNs = makeNamespace();
  const stubNs = makeNamespace();

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api", createMetricsRouter({ publicOnly: true }));
  app.use("/api/sdk", createSdkRouter(webNs));

  const api = express.Router();
  api.use(authMiddleware);
  api.use("/tasks", createGlobalTasksRouter(stubNs, webNs));
  api.use(createMetricsRouter());
  app.use("/api", api);

  return app;
}

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
  store.addToken({ token: TEST_TOKEN, name: "test", created_at: new Date().toISOString() });
});

describe("API auth coverage", () => {
  it("keeps documented public endpoints available without auth", async () => {
    const app = makeApp();
    const task = makeTask();
    store.addToGlobalQueue(task);

    await expect(request(app).get("/api/health")).resolves.toMatchObject({ status: 200 });
    await expect(request(app).get("/api/overview")).resolves.toMatchObject({ status: 200 });
    await expect(request(app).post("/api/sdk/report").send({ task_id: task.id, type: "heartbeat" }))
      .resolves.toMatchObject({ status: 200 });
  });

  it("requires auth for task logs, metrics, and cost metadata routes", async () => {
    const app = makeApp();
    const task = makeTask();
    store.addToGlobalQueue(task);

    for (const path of [
      `/api/tasks/${task.id}/logs`,
      `/api/tasks/${task.id}/metrics`,
      `/api/tasks/${task.id}/cost`,
      "/api/metrics/cost",
    ]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain("secret-value");
    }
  });
});
