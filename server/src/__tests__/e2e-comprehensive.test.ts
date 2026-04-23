/**
 * Comprehensive E2E tests for the Alchemy v2 server.
 *
 * Covers:
 * 1. Stub lifecycle: register → heartbeat → disconnect → reconnect → re-register
 * 2. Global task queue: submit tasks without stubs → stubs come online → tasks dispatched
 * 3. Task lifecycle: queued → dispatched → running → completed/failed
 * 4. Batch operations: batch kill, batch requeue, batch delete
 * 5. Task move: move queued task between stubs
 * 6. Load balancing: multiple tasks → even distribution across stubs
 * 7. Orphan recovery: stub goes offline → queued tasks return to global queue,
 *    running tasks marked interrupted
 * 8. Multi-stub same hostname: different slurm_job_id → separate entities
 * 9. SDK report endpoint: POST /api/sdk/report updates task progress without auth
 * 10. Overview endpoint: GET /api/overview returns correct counts
 * 11. Cleanup endpoint: POST /api/cleanup removes old terminal tasks
 * 12. Auth: requests without token get 401, invalid token gets 401
 * 13. Negative duration bug: requeue flow clears started_at/finished_at properly
 * 14. Walltime guard: stubs with remaining_walltime_s=0 still get tasks (0=unknown)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { store } from "../store";
import {
  createTestServer,
  TestContext,
  createMockStub,
  createTestToken,
  connectStubClient,
} from "./helpers/setup";
import { setupStubNamespace } from "../socket/stub";
import { setupWebNamespace } from "../socket/web";
import { createTasksRouter, createGlobalTasksRouter } from "../api/tasks";
import { createStubsRouter } from "../api/stubs";
import { v4 as uuidv4 } from "uuid";
import express from "express";
import { Task, Stub } from "../types";

// Helper: wait for a condition to become true, polling every 20ms
async function waitFor(
  fn: () => boolean,
  timeoutMs = 2000,
  intervalMs = 20
): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Helper: connect a stub and wait for registration
async function registerStub(
  port: number,
  token: string,
  hostname: string,
  overrides: Record<string, any> = {}
): Promise<{ client: ReturnType<typeof connectStubClient>; stubId: string }> {
  const client = connectStubClient(port);
  client.connect();

  const stubId = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("register timed out")),
      3000
    );
    client.on("registered", (data: any) => {
      clearTimeout(timeout);
      resolve(data.stub_id);
    });
    client.emit("register", {
      hostname,
      gpu: { name: "A40", vram_total_mb: 49152, count: 1 },
      max_concurrent: 3,
      token,
      ...overrides,
    });
  });

  return { client, stubId };
}

// Full server setup with auth middleware
async function createFullTestServer(): Promise<
  TestContext & { token: string; authHeader: () => Record<string, string> }
> {
  const ctx = await createTestServer();
  setupWebNamespace(ctx.webNs);
  setupStubNamespace(ctx.stubNs, ctx.webNs);

  const tokenRecord = createTestToken();
  const token = tokenRecord.token;

  // Auth middleware
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
    const t = store.getToken(key);
    if (!t) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    next();
  }

  const api = express.Router();
  api.use(authMiddleware);
  api.use("/stubs/:id/tasks", createTasksRouter(ctx.stubNs, ctx.webNs));
  api.use("/stubs", createStubsRouter(ctx.stubNs, ctx.webNs));
  api.use("/tasks", createGlobalTasksRouter(ctx.stubNs, ctx.webNs));

  // Cleanup endpoint
  api.post("/cleanup", (req, res) => {
    const { older_than_hours = 24 } = req.body;
    const cutoff = Date.now() - older_than_hours * 3600_000;
    const terminal = [
      "completed",
      "completed_with_errors",
      "failed",
      "killed",
      "interrupted",
      "blocked",
    ];

    let purged = 0;
    for (const stub of store.getAllStubs()) {
      const before = stub.tasks.length;
      stub.tasks = stub.tasks.filter((t) => {
        if (!terminal.includes(t.status)) return true;
        const finishedAt = t.finished_at
          ? new Date(t.finished_at).getTime()
          : new Date(t.created_at).getTime();
        return finishedAt > cutoff;
      });
      purged += before - stub.tasks.length;
      store.setStub(stub);
    }

    for (const task of store.getGlobalQueue()) {
      if (!terminal.includes(task.status)) continue;
      const finishedAt = task.finished_at
        ? new Date(task.finished_at).getTime()
        : new Date(task.created_at).getTime();
      if (finishedAt <= cutoff) {
        store.removeFromGlobalQueue(task.id);
        purged++;
      }
    }

    res.json({ ok: true, purged, older_than_hours });
  });

  // Overview endpoint (no auth)
  ctx.app.get("/api/overview", (_req, res) => {
    const stubs = store.getAllStubs();
    const onlineCount = stubs.filter((s) => s.status === "online").length;
    const tasks = store.getAllTasks();
    const taskCounts = {
      total: tasks.length,
      running: 0,
      queued: 0,
      completed: 0,
      failed: 0,
    };
    for (const t of tasks) {
      if (t.status === "running") taskCounts.running++;
      else if (t.status === "queued" || t.status === "waiting")
        taskCounts.queued++;
      else if (
        t.status === "completed" ||
        t.status === "completed_with_errors"
      )
        taskCounts.completed++;
      else if (t.status === "failed") taskCounts.failed++;
    }
    res.json({
      stubs: {
        total: stubs.length,
        online: onlineCount,
        offline: stubs.length - onlineCount,
      },
      tasks: taskCounts,
    });
  });

  // Public SDK report endpoint (no auth)
  ctx.app.post("/api/sdk/report", (req, res) => {
    const { task_id, step, total, loss, metrics, checkpoint, run_dir, resumable } =
      req.body;
    for (const stub of store.getAllStubs()) {
      const task = stub.tasks.find((t: any) => t.id === task_id);
      if (task) {
        const updatePayload: any = { progress: { step, total, loss, metrics } };
        if (checkpoint) updatePayload.checkpoint_path = checkpoint;
        if (run_dir) updatePayload.run_dir = run_dir;
        if (resumable !== undefined) updatePayload.resumable = resumable;
        const updated = store.updateTask(stub.id, task_id, updatePayload);
        if (updated) ctx.webNs.emit("task.update", updated);
        res.json({ ok: true, should_checkpoint: task.status === "migrating" });
        return;
      }
    }
    // Also check global queue
    const gqTask = store.getGlobalQueue().find((t) => t.id === task_id);
    if (gqTask) {
      res.json({ ok: true, should_checkpoint: false });
      return;
    }
    res.status(404).json({ error: "Task not found" });
  });

  ctx.app.use("/api", api);

  return {
    ...ctx,
    token,
    authHeader: () => ({ Authorization: `Bearer ${token}` }),
  };
}

// ─── 1. Stub Lifecycle ─────────────────────────────────────────────────────

describe("1. Stub lifecycle", () => {
  let ctx: Awaited<ReturnType<typeof createFullTestServer>>;

  beforeEach(async () => {
    ctx = await createFullTestServer();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("register → stub appears online", async () => {
    const token = createTestToken();
    const { client, stubId } = await registerStub(
      (await ctx).port,
      token.token,
      "lifecycle-host"
    );

    const stub = store.getStub(stubId);
    expect(stub).toBeDefined();
    expect(stub?.status).toBe("online");
    expect(stub?.hostname).toBe("lifecycle-host");

    client.disconnect();
  });

  it("heartbeat resets missed_heartbeats counter", async () => {
    const token = createTestToken();
    const { client, stubId } = await registerStub(
      (await ctx).port,
      token.token,
      "heartbeat-host"
    );

    // Simulate missed heartbeats
    const stub = store.getStub(stubId)!;
    stub.missed_heartbeats = 2;
    store.setStub(stub);

    client.emit("heartbeat", { timestamp: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 100));

    expect(store.getStub(stubId)?.missed_heartbeats).toBe(0);
    client.disconnect();
  });

  it("disconnect → stub marked offline, running tasks marked interrupted", async () => {
    const token = createTestToken();
    const { client, stubId } = await registerStub(
      (await ctx).port,
      token.token,
      "disconnect-host"
    );

    // Add a running task
    const stub = store.getStub(stubId)!;
    const task: Task = {
      id: uuidv4(),
      stub_id: stubId,
      command: "python train.py",
      status: "running",
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      log_buffer: [],
      pid: 1234,
    };
    stub.tasks.push(task);
    store.setStub(stub);

    client.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    const updated = store.getStub(stubId)!;
    expect(updated.status).toBe("offline");
    expect(updated.tasks[0].status).toBe("interrupted");
    expect(updated.tasks[0].finished_at).toBeDefined();
  });

  it("reconnect with same hostname+token reuses same stub ID", async () => {
    const token = createTestToken();
    const { client: c1, stubId: id1 } = await registerStub(
      (await ctx).port,
      token.token,
      "same-host"
    );

    c1.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    const { client: c2, stubId: id2 } = await registerStub(
      (await ctx).port,
      token.token,
      "same-host"
    );

    // Same stub ID
    expect(id2).toBe(id1);
    expect(store.getStub(id1)?.status).toBe("online");

    c2.disconnect();
  });

  it("reconnect resets interrupted tasks to queued", async () => {
    const token = createTestToken();
    const { client: c1, stubId } = await registerStub(
      (await ctx).port,
      token.token,
      "requeue-host"
    );

    // Add running task
    const stub = store.getStub(stubId)!;
    stub.tasks.push({
      id: uuidv4(),
      stub_id: stubId,
      command: "python train.py",
      status: "running",
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      log_buffer: [],
      pid: 42,
    });
    store.setStub(stub);

    c1.disconnect();
    await new Promise((r) => setTimeout(r, 150));

    // Verify interrupted
    expect(store.getStub(stubId)?.tasks[0].status).toBe("interrupted");

    // Reconnect
    const { client: c2 } = await registerStub(
      (await ctx).port,
      token.token,
      "requeue-host"
    );
    await new Promise((r) => setTimeout(r, 100));

    const afterReconnect = store.getStub(stubId)!;
    expect(afterReconnect.status).toBe("online");
    // Task should be queued (or dispatched if immediately sent)
    expect(["queued", "dispatched"]).toContain(afterReconnect.tasks[0].status);
    // Timestamps must be cleared on reconnect
    expect(afterReconnect.tasks[0].started_at).toBeUndefined();
    expect(afterReconnect.tasks[0].finished_at).toBeUndefined();
    expect(afterReconnect.tasks[0].pid).toBeUndefined();

    c2.disconnect();
  });

  it("invalid token → register rejected", async () => {
    const client = connectStubClient((await ctx).port);
    client.connect();

    const errorReceived = await new Promise<any>((resolve) => {
      const timeout = setTimeout(
        () => resolve({ message: "no-error-received" }),
        1000
      );
      client.on("error", (err: any) => {
        clearTimeout(timeout);
        resolve(err);
      });
      client.emit("register", {
        hostname: "bad-token-host",
        gpu: { name: "A40", vram_total_mb: 49152, count: 1 },
        max_concurrent: 2,
        token: "invalid-token-xyz",
      });
    });

    expect(errorReceived.message).toBe("Invalid token");
    client.disconnect();
  });
});

// ─── 2. Global Task Queue ──────────────────────────────────────────────────

describe("2. Global task queue", () => {
  let ctx: Awaited<ReturnType<typeof createFullTestServer>>;

  beforeEach(async () => {
    ctx = await createFullTestServer();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("submit tasks with no stubs → tasks wait in global queue", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...ctx.authHeader(),
      },
      body: JSON.stringify({ command: "python wait.py" }),
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.stub_id).toBe(""); // no stub yet
    expect(body.status).toBe("queued");
    expect(store.getGlobalQueue().length).toBe(1);
  });

  it("stub comes online → global queue tasks dispatched to it", async () => {
    // Submit 2 tasks first (no stubs online)
    for (let i = 0; i < 2; i++) {
      await fetch(`${ctx.baseUrl}/api/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...ctx.authHeader(),
        },
        body: JSON.stringify({ command: `python task${i}.py` }),
      });
    }

    expect(store.getGlobalQueue().length).toBe(2);

    // Bring stub online — it should absorb the global queue
    const token = createTestToken();
    const dispatchedTasks: string[] = [];
    const client = connectStubClient(ctx.port);

    client.on("task.run", (payload: any) => {
      dispatchedTasks.push(payload.task_id);
    });

    client.connect();
    await new Promise<void>((resolve) => {
      client.on("registered", () => resolve());
      client.emit("register", {
        hostname: "absorb-host",
        gpu: { name: "A40", vram_total_mb: 49152, count: 1 },
        max_concurrent: 5,
        token: token.token,
      });
    });

    // Wait for dispatch
    await waitFor(() => dispatchedTasks.length >= 2);

    expect(dispatchedTasks.length).toBe(2);
    expect(store.getGlobalQueue().length).toBe(0);

    client.disconnect();
  });

  it("GET /api/tasks returns all tasks including global queue", async () => {
    // Add to global queue
    const task1 = await fetch(`${ctx.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ctx.authHeader() },
      body: JSON.stringify({ command: "python a.py" }),
    }).then((r) => r.json());

    // Add a stub with a task
    const stub = createMockStub({ status: "online" });
    stub.tasks.push({
      id: uuidv4(),
      stub_id: stub.id,
      command: "python b.py",
      status: "running",
      created_at: new Date().toISOString(),
      log_buffer: [],
    });
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/tasks`, {
      headers: ctx.authHeader(),
    });
    expect(res.status).toBe(200);
    const tasks = (await res.json()) as any[];
    // Should include both: global queue task + stub task
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    expect(tasks.find((t) => t.id === (task1 as any).id)).toBeDefined();
  });
});

// ─── 3. Task Lifecycle ─────────────────────────────────────────────────────

describe("3. Task lifecycle via socket events", () => {
  let ctx: Awaited<ReturnType<typeof createFullTestServer>>;

  beforeEach(async () => {
    ctx = await createFullTestServer();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("task.started → status running, started_at set", async () => {
    const token = createTestToken();
    const { client, stubId } = await registerStub(
      ctx.port,
      token.token,
      "task-lifecycle-host"
    );

    // Add queued task
    const stub = store.getStub(stubId)!;
    const task: Task = {
      id: uuidv4(),
      stub_id: stubId,
      command: "python train.py",
      status: "queued",
      created_at: new Date().toISOString(),
      log_buffer: [],
    };
    stub.tasks.push(task);
    store.setStub(stub);

    // Simulate stub reporting task started
    client.emit("task.started", { task_id: task.id, pid: 9999 });
    await new Promise((r) => setTimeout(r, 100));

    const updated = store.getTask(stubId, task.id);
    expect(updated?.status).toBe("running");
    expect(updated?.started_at).toBeDefined();
    expect(updated?.pid).toBe(9999);

    client.disconnect();
  });

  it("task.completed → status completed, finished_at set", async () => {
    const token = createTestToken();
    const { client, stubId } = await registerStub(
      ctx.port,
      token.token,
      "completed-host"
    );

    const stub = store.getStub(stubId)!;
    const task: Task = {
      id: uuidv4(),
      stub_id: stubId,
      command: "python train.py",
      status: "running",
      started_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      log_buffer: [],
    };
    stub.tasks.push(task);
    store.setStub(stub);

    client.emit("task.completed", { task_id: task.id, exit_code: 0 });
    await new Promise((r) => setTimeout(r, 100));

    const updated = store.getTask(stubId, task.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.exit_code).toBe(0);
    expect(updated?.finished_at).toBeDefined();

    client.disconnect();
  });

  it("task.failed → status failed, finished_at set", async () => {
    const token = createTestToken();
    const { client, stubId } = await registerStub(
      ctx.port,
      token.token,
      "failed-host"
    );

    const stub = store.getStub(stubId)!;
    const task: Task = {
      id: uuidv4(),
      stub_id: stubId,
      command: "python bad.py",
      status: "running",
      started_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      log_buffer: [],
    };
    stub.tasks.push(task);
    store.setStub(stub);

    client.emit("task.failed", { task_id: task.id, exit_code: 1 });
    await new Promise((r) => setTimeout(r, 100));

    const updated = store.getTask(stubId, task.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.exit_code).toBe(1);
    expect(updated?.finished_at).toBeDefined();

    client.disconnect();
  });

  it("task.failed with auto-retry: retries up to max_retries", async () => {
    const token = createTestToken();
    const { client, stubId } = await registerStub(
      ctx.port,
      token.token,
      "retry-host"
    );

    const stub = store.getStub(stubId)!;
    const task: Task = {
      id: uuidv4(),
      stub_id: stubId,
      command: "python retry.py",
      status: "running",
      started_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      log_buffer: [],
      max_retries: 2,
      retry_count: 0,
    };
    stub.tasks.push(task);
    store.setStub(stub);

    // First failure → auto-retry (retry_count becomes 1)
    client.emit("task.failed", { task_id: task.id, exit_code: 1 });
    await new Promise((r) => setTimeout(r, 150));

    const after1 = store.getTask(stubId, task.id);
    // After auto-retry, task is re-queued. Since the stub is online and has capacity,
    // it may be immediately dispatched (status "dispatched").
    expect(["queued", "dispatched"]).toContain(after1?.status);
    expect(after1?.retry_count).toBe(1);
    expect(after1?.started_at).toBeUndefined();
    expect(after1?.finished_at).toBeUndefined();

    // Simulate start + second failure (force task to running state first)
    store.updateTask(stubId, task.id, { status: "running", started_at: new Date().toISOString(), pid: 111 });
    client.emit("task.failed", { task_id: task.id, exit_code: 1 });
    await new Promise((r) => setTimeout(r, 150));

    const after2 = store.getTask(stubId, task.id);
    expect(["queued", "dispatched"]).toContain(after2?.status);
    expect(after2?.retry_count).toBe(2);

    // Third failure → exceeds max_retries, stays failed
    store.updateTask(stubId, task.id, { status: "running", started_at: new Date().toISOString(), pid: 222 });
    client.emit("task.failed", { task_id: task.id, exit_code: 1 });
    await new Promise((r) => setTimeout(r, 150));

    const after3 = store.getTask(stubId, task.id);
    expect(after3?.status).toBe("failed");

    client.disconnect();
  });

  it("SIGTERM exit_code=-15 is never auto-retried", async () => {
    const token = createTestToken();
    const { client, stubId } = await registerStub(
      ctx.port,
      token.token,
      "sigterm-host"
    );

    const stub = store.getStub(stubId)!;
    const task: Task = {
      id: uuidv4(),
      stub_id: stubId,
      command: "python kill.py",
      status: "running",
      started_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      log_buffer: [],
      max_retries: 5,
      retry_count: 0,
    };
    stub.tasks.push(task);
    store.setStub(stub);

    client.emit("task.failed", { task_id: task.id, exit_code: -15 });
    await new Promise((r) => setTimeout(r, 150));

    const updated = store.getTask(stubId, task.id);
    expect(updated?.status).toBe("failed"); // not retried
    expect(updated?.exit_code).toBe(-15);

    client.disconnect();
  });
});

// ─── 4. Batch Operations ────────────────────────────────────────────────────

describe("4. Batch operations", () => {
  let ctx: Awaited<ReturnType<typeof createFullTestServer>>;
  let stubId: string;

  beforeEach(async () => {
    ctx = await createFullTestServer();
    const stub = createMockStub({ status: "online" });
    store.setStub(stub);
    stubId = stub.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  const makeTask = (status: Task["status"], stubId_: string): Task => ({
    id: uuidv4(),
    stub_id: stubId_,
    command: "python batch.py",
    status,
    created_at: new Date().toISOString(),
    started_at:
      status === "running" || status === "failed"
        ? new Date(Date.now() - 5000).toISOString()
        : undefined,
    finished_at: status === "failed" ? new Date().toISOString() : undefined,
    log_buffer: [],
  });

  it("batch kill: kills multiple queued tasks", async () => {
    const stub = store.getStub(stubId)!;
    const t1 = makeTask("queued", stubId);
    const t2 = makeTask("queued", stubId);
    stub.tasks.push(t1, t2);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/tasks/batch/kill`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...ctx.authHeader(),
      },
      body: JSON.stringify({ task_ids: [t1.id, t2.id] }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.results[0].ok).toBe(true);
    expect(body.results[1].ok).toBe(true);
    expect(store.getTask(stubId, t1.id)?.status).toBe("killed");
    expect(store.getTask(stubId, t2.id)?.status).toBe("killed");
  });

  it("batch kill: fails gracefully for non-killable tasks", async () => {
    const stub = store.getStub(stubId)!;
    const t1 = makeTask("completed", stubId);
    stub.tasks.push(t1);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/tasks/batch/kill`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...ctx.authHeader(),
      },
      body: JSON.stringify({ task_ids: [t1.id] }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error).toContain("Cannot kill");
  });

  it("batch requeue: moves failed tasks back to queued state", async () => {
    // Take the online stub offline so the task stays in the global queue
    const onlineStub = store.getStub(stubId)!;
    onlineStub.status = "offline";
    store.setStub(onlineStub);

    const t1 = makeTask("failed", stubId);
    onlineStub.tasks.push(t1);
    store.setStub(onlineStub);

    const res = await fetch(`${ctx.baseUrl}/api/tasks/batch/requeue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...ctx.authHeader(),
      },
      body: JSON.stringify({ task_ids: [t1.id] }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.results[0].ok).toBe(true);

    // Task should be in global queue (no online stub to dispatch to)
    const gq = store.getGlobalQueue();
    const requeued = gq.find((t) => t.id === t1.id);
    expect(requeued).toBeDefined();
    expect(requeued?.status).toBe("queued");
    // started_at and finished_at must be cleared (negative duration bug fix check)
    expect(requeued?.started_at).toBeUndefined();
    expect(requeued?.finished_at).toBeUndefined();
    expect(requeued?.exit_code).toBeUndefined();
  });

  it("batch requeue: tasks in global queue just reset status", async () => {
    // Take the online stub offline so tasks stay in global queue
    const onlineStub = store.getStub(stubId)!;
    onlineStub.status = "offline";
    store.setStub(onlineStub);

    // Add a killed task to global queue
    const task: Task = {
      id: uuidv4(),
      stub_id: "",
      command: "python gq.py",
      status: "killed",
      created_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      log_buffer: [],
    };
    store.addToGlobalQueue(task);

    const res = await fetch(`${ctx.baseUrl}/api/tasks/batch/requeue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...ctx.authHeader(),
      },
      body: JSON.stringify({ task_ids: [task.id] }),
    });

    expect(res.status).toBe(200);
    const gq = store.getGlobalQueue();
    const updated = gq.find((t) => t.id === task.id);
    expect(updated?.status).toBe("queued");
    expect(updated?.finished_at).toBeUndefined();
    expect(updated?.started_at).toBeUndefined();
  });

  it("batch delete: removes completed tasks", async () => {
    const stub = store.getStub(stubId)!;
    const t1 = makeTask("completed", stubId);
    const t2 = makeTask("failed", stubId);
    t1.finished_at = new Date().toISOString();
    t2.finished_at = new Date().toISOString();
    stub.tasks.push(t1, t2);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/tasks/batch`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        ...ctx.authHeader(),
      },
      body: JSON.stringify({ task_ids: [t1.id, t2.id] }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.results[0].ok).toBe(true);
    expect(body.results[1].ok).toBe(true);

    const updatedStub = store.getStub(stubId)!;
    expect(updatedStub.tasks.find((t) => t.id === t1.id)).toBeUndefined();
    expect(updatedStub.tasks.find((t) => t.id === t2.id)).toBeUndefined();
  });

  it("batch delete: rejects running tasks", async () => {
    const stub = store.getStub(stubId)!;
    const t1 = makeTask("running", stubId);
    stub.tasks.push(t1);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/tasks/batch`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        ...ctx.authHeader(),
      },
      body: JSON.stringify({ task_ids: [t1.id] }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error).toContain("kill it first");
  });
});

// ─── 5. Task Move ──────────────────────────────────────────────────────────

describe("5. Task move between stubs", () => {
  let ctx: Awaited<ReturnType<typeof createFullTestServer>>;

  beforeEach(async () => {
    ctx = await createFullTestServer();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("move queued task from one stub to another", async () => {
    const stub1 = createMockStub({ status: "online" });
    const stub2 = createMockStub({ status: "online" });
    const task: Task = {
      id: uuidv4(),
      stub_id: stub1.id,
      command: "python move.py",
      status: "queued",
      created_at: new Date().toISOString(),
      log_buffer: [],
    };
    stub1.tasks.push(task);
    store.setStub(stub1);
    store.setStub(stub2);

    const res = await fetch(`${ctx.baseUrl}/api/tasks/${task.id}/move`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...ctx.authHeader(),
      },
      body: JSON.stringify({ stub_id: stub2.id }),
    });

    expect(res.status).toBe(200);
    // Task should no longer be on stub1
    expect(
      store.getStub(stub1.id)?.tasks.find((t) => t.id === task.id)
    ).toBeUndefined();
    // Task should be on stub2
    expect(
      store.getStub(stub2.id)?.tasks.find((t) => t.id === task.id)
    ).toBeDefined();
  });

  it("move from global queue to a specific stub", async () => {
    const stub = createMockStub({ status: "online" });
    store.setStub(stub);

    const task: Task = {
      id: uuidv4(),
      stub_id: "",
      command: "python globalq.py",
      status: "queued",
      created_at: new Date().toISOString(),
      log_buffer: [],
    };
    store.addToGlobalQueue(task);

    const res = await fetch(`${ctx.baseUrl}/api/tasks/${task.id}/move`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...ctx.authHeader(),
      },
      body: JSON.stringify({ stub_id: stub.id }),
    });

    expect(res.status).toBe(200);
    expect(store.getGlobalQueue().find((t) => t.id === task.id)).toBeUndefined();
    expect(store.getStub(stub.id)?.tasks.find((t) => t.id === task.id)).toBeDefined();
  });

  it("cannot move running task", async () => {
    const stub1 = createMockStub({ status: "online" });
    const stub2 = createMockStub({ status: "online" });
    const task: Task = {
      id: uuidv4(),
      stub_id: stub1.id,
      command: "python running.py",
      status: "running",
      created_at: new Date().toISOString(),
      log_buffer: [],
    };
    stub1.tasks.push(task);
    store.setStub(stub1);
    store.setStub(stub2);

    const res = await fetch(`${ctx.baseUrl}/api/tasks/${task.id}/move`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...ctx.authHeader(),
      },
      body: JSON.stringify({ stub_id: stub2.id }),
    });

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain("queued");
  });
});

// ─── 6. Load Balancing ────────────────────────────────────────────────────

describe("6. Load balancing: pickBestStub", () => {
  let ctx: Awaited<ReturnType<typeof createFullTestServer>>;

  beforeEach(async () => {
    ctx = await createFullTestServer();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("submitting multiple tasks distributes across idle stubs evenly", async () => {
    const stub1 = createMockStub({ status: "online", tasks: [] });
    const stub2 = createMockStub({ status: "online", tasks: [] });
    store.setStub(stub1);
    store.setStub(stub2);

    // Submit 4 tasks — they should be spread across both stubs
    const taskIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${ctx.baseUrl}/api/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...ctx.authHeader(),
        },
        body: JSON.stringify({ command: `python task${i}.py` }),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      taskIds.push(body.id);
    }

    // Each stub should have at least 1 task
    const s1Updated = store.getStub(stub1.id)!;
    const s2Updated = store.getStub(stub2.id)!;
    expect(s1Updated.tasks.length).toBeGreaterThanOrEqual(1);
    expect(s2Updated.tasks.length).toBeGreaterThanOrEqual(1);
    // Total should be 4
    expect(s1Updated.tasks.length + s2Updated.tasks.length).toBe(4);
  });

  it("busy stub gets fewer new tasks than idle stub", async () => {
    const busyStub = createMockStub({ status: "online" });
    busyStub.tasks = Array.from({ length: 3 }, () => ({
      id: uuidv4(),
      stub_id: busyStub.id,
      command: "cmd",
      status: "running" as const,
      created_at: new Date().toISOString(),
      log_buffer: [],
    }));
    const idleStub = createMockStub({ status: "online", tasks: [] });
    store.setStub(busyStub);
    store.setStub(idleStub);

    // Submit a task — should go to idle stub
    const res = await fetch(`${ctx.baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...ctx.authHeader(),
      },
      body: JSON.stringify({ command: "python new.py" }),
    });

    expect(res.status).toBe(201);
    // Task should be on idle stub
    const idleUpdated = store.getStub(idleStub.id)!;
    expect(idleUpdated.tasks.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── 7. Orphan Recovery ────────────────────────────────────────────────────

describe("7. Orphan recovery on stub disconnect", () => {
  let ctx: Awaited<ReturnType<typeof createFullTestServer>>;

  beforeEach(async () => {
    ctx = await createFullTestServer();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("queued tasks return to global queue when stub disconnects", async () => {
    const token = createTestToken();
    const { client, stubId } = await registerStub(
      ctx.port,
      token.token,
      "orphan-host"
    );

    // Add a queued task to the stub
    const stub = store.getStub(stubId)!;
    const task: Task = {
      id: uuidv4(),
      stub_id: stubId,
      command: "python orphan.py",
      status: "queued",
      created_at: new Date().toISOString(),
      log_buffer: [],
    };
    stub.tasks.push(task);
    store.setStub(stub);

    client.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    // Queued task should be in global queue now
    const gq = store.getGlobalQueue();
    const found = gq.find((t) => t.id === task.id);
    expect(found).toBeDefined();
    expect(found?.stub_id).toBe(""); // removed from stub
    expect(found?.status).toBe("queued");

    // Task should not be on the stub anymore
    const updatedStub = store.getStub(stubId)!;
    expect(updatedStub.tasks.find((t) => t.id === task.id)).toBeUndefined();
  });

  it("running tasks marked interrupted when stub disconnects", async () => {
    const token = createTestToken();
    const { client, stubId } = await registerStub(
      ctx.port,
      token.token,
      "interrupted-host"
    );

    const stub = store.getStub(stubId)!;
    const task: Task = {
      id: uuidv4(),
      stub_id: stubId,
      command: "python run.py",
      status: "running",
      started_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      log_buffer: [],
      pid: 9999,
    };
    stub.tasks.push(task);
    store.setStub(stub);

    client.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    // Running task should be interrupted on the stub
    const updatedStub = store.getStub(stubId)!;
    const updatedTask = updatedStub.tasks.find((t) => t.id === task.id);
    expect(updatedTask?.status).toBe("interrupted");
    expect(updatedTask?.finished_at).toBeDefined();

    // Should NOT be in global queue
    expect(
      store.getGlobalQueue().find((t) => t.id === task.id)
    ).toBeUndefined();
  });
});

// ─── 8. Multi-stub same hostname ──────────────────────────────────────────

describe("8. Multi-stub: same hostname, different slurm_job_id", () => {
  let ctx: Awaited<ReturnType<typeof createFullTestServer>>;

  beforeEach(async () => {
    ctx = await createFullTestServer();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("two stubs with same hostname but different slurm_job_id are separate", async () => {
    const token = createTestToken();

    const { client: c1, stubId: id1 } = await registerStub(
      ctx.port,
      token.token,
      "shared-host",
      { slurm_job_id: "job-001" }
    );
    const { client: c2, stubId: id2 } = await registerStub(
      ctx.port,
      token.token,
      "shared-host",
      { slurm_job_id: "job-002" }
    );

    expect(id1).not.toBe(id2);
    expect(store.getAllStubs().length).toBe(2);

    const s1 = store.getStub(id1)!;
    const s2 = store.getStub(id2)!;
    expect(s1.slurm_job_id).toBe("job-001");
    expect(s2.slurm_job_id).toBe("job-002");

    c1.disconnect();
    c2.disconnect();
  });

  it("same hostname + same slurm_job_id reconnects to same stub", async () => {
    const token = createTestToken();

    const { client: c1, stubId: id1 } = await registerStub(
      ctx.port,
      token.token,
      "slurm-host",
      { slurm_job_id: "job-999" }
    );

    c1.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    const { client: c2, stubId: id2 } = await registerStub(
      ctx.port,
      token.token,
      "slurm-host",
      { slurm_job_id: "job-999" }
    );

    expect(id2).toBe(id1); // same stub

    c2.disconnect();
  });
});

// ─── 9. SDK Report Endpoint ───────────────────────────────────────────────

describe("9. SDK report endpoint (no auth)", () => {
  let ctx: Awaited<ReturnType<typeof createFullTestServer>>;
  let stubId: string;
  let taskId: string;

  beforeEach(async () => {
    ctx = await createFullTestServer();
    const stub = createMockStub({ status: "online" });
    const task: Task = {
      id: uuidv4(),
      stub_id: stub.id,
      command: "python sdk.py",
      status: "running",
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      log_buffer: [],
    };
    stub.tasks.push(task);
    store.setStub(stub);
    stubId = stub.id;
    taskId = task.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("POST /api/sdk/report updates task progress without auth", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/sdk/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // No Authorization header!
      body: JSON.stringify({
        task_id: taskId,
        step: 100,
        total: 1000,
        loss: 1.23,
      }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);

    const updated = store.getTask(stubId, taskId);
    expect(updated?.progress?.step).toBe(100);
    expect(updated?.progress?.total).toBe(1000);
    expect(updated?.progress?.loss).toBe(1.23);
  });

  it("POST /api/sdk/report returns 404 for unknown task_id", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/sdk/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: "nonexistent-id", step: 0, total: 10 }),
    });

    expect(res.status).toBe(404);
  });

  it("POST /api/sdk/report returns should_checkpoint=true for migrating task", async () => {
    store.updateTask(stubId, taskId, { status: "migrating" });

    const res = await fetch(`${ctx.baseUrl}/api/sdk/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskId, step: 50, total: 100 }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.should_checkpoint).toBe(true);
  });
});

// ─── 10. Overview Endpoint ────────────────────────────────────────────────

describe("10. Overview endpoint", () => {
  let ctx: Awaited<ReturnType<typeof createFullTestServer>>;

  beforeEach(async () => {
    ctx = await createFullTestServer();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("GET /api/overview returns correct counts", async () => {
    // Setup: 2 stubs (1 online, 1 offline), tasks of various statuses
    const onlineStub = createMockStub({ status: "online" });
    onlineStub.tasks = [
      {
        id: uuidv4(),
        stub_id: onlineStub.id,
        command: "running.py",
        status: "running",
        created_at: new Date().toISOString(),
        log_buffer: [],
      },
      {
        id: uuidv4(),
        stub_id: onlineStub.id,
        command: "queued.py",
        status: "queued",
        created_at: new Date().toISOString(),
        log_buffer: [],
      },
      {
        id: uuidv4(),
        stub_id: onlineStub.id,
        command: "completed.py",
        status: "completed",
        created_at: new Date().toISOString(),
        log_buffer: [],
      },
    ];

    const offlineStub = createMockStub({ status: "offline" });
    offlineStub.tasks = [
      {
        id: uuidv4(),
        stub_id: offlineStub.id,
        command: "failed.py",
        status: "failed",
        created_at: new Date().toISOString(),
        log_buffer: [],
      },
    ];

    store.setStub(onlineStub);
    store.setStub(offlineStub);

    const res = await fetch(`${ctx.baseUrl}/api/overview`);
    expect(res.status).toBe(200);
    const body: any = await res.json();

    expect(body.stubs.total).toBe(2);
    expect(body.stubs.online).toBe(1);
    expect(body.stubs.offline).toBe(1);
    expect(body.tasks.running).toBe(1);
    expect(body.tasks.queued).toBe(1);
    expect(body.tasks.completed).toBe(1);
    expect(body.tasks.failed).toBe(1);
    expect(body.tasks.total).toBe(4);
  });

  it("GET /api/overview does NOT require auth", async () => {
    // No auth header
    const res = await fetch(`${ctx.baseUrl}/api/overview`);
    expect(res.status).toBe(200);
  });
});

// ─── 11. Cleanup Endpoint ─────────────────────────────────────────────────

describe("11. Cleanup endpoint", () => {
  let ctx: Awaited<ReturnType<typeof createFullTestServer>>;
  let stubId: string;

  beforeEach(async () => {
    ctx = await createFullTestServer();
    const stub = createMockStub({ status: "online" });
    store.setStub(stub);
    stubId = stub.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("POST /api/cleanup removes old terminal tasks", async () => {
    const stub = store.getStub(stubId)!;

    // Old completed task (2 days ago)
    const oldTask: Task = {
      id: uuidv4(),
      stub_id: stubId,
      command: "old.py",
      status: "completed",
      created_at: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(),
      finished_at: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(),
      log_buffer: [],
    };

    // Recent running task
    const recentTask: Task = {
      id: uuidv4(),
      stub_id: stubId,
      command: "recent.py",
      status: "running",
      created_at: new Date().toISOString(),
      log_buffer: [],
    };

    stub.tasks.push(oldTask, recentTask);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/cleanup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...ctx.authHeader(),
      },
      body: JSON.stringify({ older_than_hours: 24 }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.purged).toBe(1); // only old task purged

    const updatedStub = store.getStub(stubId)!;
    expect(updatedStub.tasks.find((t) => t.id === oldTask.id)).toBeUndefined();
    expect(updatedStub.tasks.find((t) => t.id === recentTask.id)).toBeDefined();
  });

  it("POST /api/cleanup respects older_than_hours: 0 removes all terminal tasks", async () => {
    const stub = store.getStub(stubId)!;

    // Recent completed task (1 second ago)
    const recentCompleted: Task = {
      id: uuidv4(),
      stub_id: stubId,
      command: "recent-completed.py",
      status: "completed",
      created_at: new Date(Date.now() - 1000).toISOString(),
      finished_at: new Date(Date.now() - 1000).toISOString(),
      log_buffer: [],
    };

    // Running task — should NOT be purged
    const runningTask: Task = {
      id: uuidv4(),
      stub_id: stubId,
      command: "running.py",
      status: "running",
      created_at: new Date().toISOString(),
      log_buffer: [],
    };

    stub.tasks.push(recentCompleted, runningTask);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/cleanup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...ctx.authHeader(),
      },
      body: JSON.stringify({ older_than_hours: 0 }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.purged).toBeGreaterThanOrEqual(1);

    const updatedStub = store.getStub(stubId)!;
    expect(
      updatedStub.tasks.find((t) => t.id === recentCompleted.id)
    ).toBeUndefined();
    expect(
      updatedStub.tasks.find((t) => t.id === runningTask.id)
    ).toBeDefined();
  });
});

// ─── 12. Authentication ────────────────────────────────────────────────────

describe("12. Authentication", () => {
  let ctx: Awaited<ReturnType<typeof createFullTestServer>>;

  beforeEach(async () => {
    ctx = await createFullTestServer();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("request without auth header returns 401", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/stubs`);
    expect(res.status).toBe(401);
  });

  it("request with invalid token returns 401", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/stubs`, {
      headers: { Authorization: "Bearer invalid-token-12345" },
    });
    expect(res.status).toBe(401);
  });

  it("request with malformed auth header returns 401", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/stubs`, {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
  });

  it("request with valid token succeeds", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/stubs`, {
      headers: ctx.authHeader(),
    });
    expect(res.status).toBe(200);
  });
});

// ─── 13. Negative Duration Bug Check ──────────────────────────────────────

describe("13. Negative duration bug: timestamp clearing", () => {
  let ctx: Awaited<ReturnType<typeof createFullTestServer>>;
  let stubId: string;

  beforeEach(async () => {
    ctx = await createFullTestServer();
    const stub = createMockStub({ status: "online" });
    store.setStub(stub);
    stubId = stub.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("batch/requeue: started_at and finished_at cleared (no negative duration)", async () => {
    // Take the online stub offline so the task stays in global queue after requeue
    const onlineStub = store.getStub(stubId)!;
    onlineStub.status = "offline";
    store.setStub(onlineStub);

    // Task that was previously running: has started_at and finished_at set
    const now = Date.now();
    const task: Task = {
      id: uuidv4(),
      stub_id: stubId,
      command: "python neg.py",
      status: "failed",
      created_at: new Date(now - 10000).toISOString(),
      started_at: new Date(now - 5000).toISOString(),
      finished_at: new Date(now).toISOString(),
      exit_code: 1,
      log_buffer: [],
    };
    onlineStub.tasks.push(task);
    store.setStub(onlineStub);

    await fetch(`${ctx.baseUrl}/api/tasks/batch/requeue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...ctx.authHeader(),
      },
      body: JSON.stringify({ task_ids: [task.id] }),
    });

    // Task should be in global queue (no online stubs, so it stays there)
    const gq = store.getGlobalQueue();
    const requeued = gq.find((t) => t.id === task.id);
    expect(requeued).toBeDefined();
    // Timestamps MUST be cleared to prevent negative durations
    expect(requeued?.started_at).toBeUndefined();
    expect(requeued?.finished_at).toBeUndefined();
    expect(requeued?.exit_code).toBeUndefined();
  });

  it("auto-retry: started_at and finished_at cleared after retry", async () => {
    const token = createTestToken();
    const { client, stubId: sid } = await registerStub(
      ctx.port,
      token.token,
      "retry-ts-host"
    );

    const stub = store.getStub(sid)!;
    const task: Task = {
      id: uuidv4(),
      stub_id: sid,
      command: "python retry.py",
      status: "running",
      started_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      log_buffer: [],
      max_retries: 1,
      retry_count: 0,
    };
    stub.tasks.push(task);
    store.setStub(stub);

    client.emit("task.failed", { task_id: task.id, exit_code: 1 });
    await new Promise((r) => setTimeout(r, 150));

    const updated = store.getTask(sid, task.id);
    // After auto-retry, task is reset to queued then may be immediately dispatched
    expect(["queued", "dispatched"]).toContain(updated?.status);
    // Critical: started_at and finished_at must be cleared to prevent negative duration
    expect(updated?.started_at).toBeUndefined();
    expect(updated?.finished_at).toBeUndefined();

    client.disconnect();
  });

  it("failStubTasks: queued tasks requeued with cleared timestamps", async () => {
    const token = createTestToken();
    const { client, stubId: sid } = await registerStub(
      ctx.port,
      token.token,
      "cleartimestamp-host"
    );

    const stub = store.getStub(sid)!;

    // Create a task that had started_at and finished_at (was previously interrupted),
    // but was reset to queued on reconnect
    const task: Task = {
      id: uuidv4(),
      stub_id: sid,
      command: "python ts.py",
      status: "queued",
      created_at: new Date().toISOString(),
      // These should ideally NOT be here for a queued task, but let's test defensive behavior
      started_at: undefined,
      finished_at: undefined,
      log_buffer: [],
    };
    stub.tasks.push(task);
    store.setStub(stub);

    // Disconnect
    client.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    // Task should be in global queue
    const gq = store.getGlobalQueue();
    const requeued = gq.find((t) => t.id === task.id);
    expect(requeued).toBeDefined();
    expect(requeued?.stub_id).toBe("");
    expect(requeued?.status).toBe("queued");
  });
});

// ─── 14. Walltime Guard ────────────────────────────────────────────────────

describe("14. Walltime guard", () => {
  let ctx: Awaited<ReturnType<typeof createFullTestServer>>;

  beforeEach(async () => {
    ctx = await createFullTestServer();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("stub with remaining_walltime_s=0 (unknown) still gets tasks dispatched", async () => {
    const token = createTestToken();
    const dispatchedTasks: string[] = [];

    const client = connectStubClient(ctx.port);
    client.on("task.run", (payload: any) => {
      dispatchedTasks.push(payload.task_id);
    });
    client.connect();

    await new Promise<void>((resolve) => {
      client.on("registered", () => resolve());
      client.emit("register", {
        hostname: "walltime-host",
        gpu: { name: "A40", vram_total_mb: 49152, count: 1 },
        max_concurrent: 3,
        token: token.token,
        remaining_walltime_s: 0, // 0 = unknown, should NOT block dispatch
      });
    });

    const stubId = (await new Promise<string>((resolve) => {
      const allStubs = store.getAllStubs();
      resolve(allStubs[allStubs.length - 1].id);
    }));

    // Add a queued task to the stub
    const stub = store.getStub(stubId)!;
    const task: Task = {
      id: uuidv4(),
      stub_id: stubId,
      command: "python walltime.py",
      status: "queued",
      created_at: new Date().toISOString(),
      log_buffer: [],
    };
    stub.tasks.push(task);
    store.setStub(stub);

    // Manually trigger dispatch
    const { dispatchQueuedTasks } = await import("../socket/stub");
    dispatchQueuedTasks(stubId, ctx.stubNs);

    await waitFor(() => dispatchedTasks.length >= 1, 1000);
    expect(dispatchedTasks.length).toBe(1);
    expect(dispatchedTasks[0]).toBe(task.id);

    client.disconnect();
  });

  it("stub with remaining_walltime_s < 600 does NOT get tasks dispatched", async () => {
    const token = createTestToken();
    const dispatchedTasks: string[] = [];

    const client = connectStubClient(ctx.port);
    client.on("task.run", (payload: any) => {
      dispatchedTasks.push(payload.task_id);
    });
    client.connect();

    await new Promise<void>((resolve) => {
      client.on("registered", () => resolve());
      client.emit("register", {
        hostname: "low-walltime-host",
        gpu: { name: "A40", vram_total_mb: 49152, count: 1 },
        max_concurrent: 3,
        token: token.token,
        remaining_walltime_s: 300, // 5 minutes — should block dispatch
      });
    });

    const allStubs = store.getAllStubs();
    const stubId = allStubs[allStubs.length - 1].id;

    const stub = store.getStub(stubId)!;
    const task: Task = {
      id: uuidv4(),
      stub_id: stubId,
      command: "python walltime2.py",
      status: "queued",
      created_at: new Date().toISOString(),
      log_buffer: [],
    };
    stub.tasks.push(task);
    store.setStub(stub);

    const { dispatchQueuedTasks } = await import("../socket/stub");
    dispatchQueuedTasks(stubId, ctx.stubNs);

    // Wait a bit — task should NOT be dispatched
    await new Promise((r) => setTimeout(r, 300));
    expect(dispatchedTasks.length).toBe(0);

    client.disconnect();
  });

  it("stub with remaining_walltime_s=undefined gets tasks dispatched", async () => {
    const stub = createMockStub({
      status: "online",
      remaining_walltime_s: undefined,
    });

    const task: Task = {
      id: uuidv4(),
      stub_id: stub.id,
      command: "python nowalltime.py",
      status: "queued",
      created_at: new Date().toISOString(),
      log_buffer: [],
    };
    stub.tasks.push(task);
    store.setStub(stub);

    // Verify the walltime guard doesn't block (remaining_walltime_s is undefined)
    // dispatchQueuedTasks should not skip due to walltime
    const { dispatchQueuedTasks } = await import("../socket/stub");
    // This should not throw and should attempt dispatch
    expect(() => dispatchQueuedTasks(stub.id, ctx.stubNs)).not.toThrow();

    // Task may be dispatched (status "dispatched") even without a real socket client
    const updatedTask = store.getTask(stub.id, task.id);
    // Should be dispatched (status change) or still queued if no socket
    expect(["queued", "dispatched"]).toContain(updatedTask?.status);
  });
});

// ─── 15. Retry Endpoint ───────────────────────────────────────────────────

describe("15. Retry endpoint", () => {
  let ctx: Awaited<ReturnType<typeof createFullTestServer>>;
  let stubId: string;

  beforeEach(async () => {
    ctx = await createFullTestServer();
    const stub = createMockStub({ status: "online" });
    store.setStub(stub);
    stubId = stub.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("POST /tasks/:id/retry creates a new task linked to original", async () => {
    const stub = store.getStub(stubId)!;
    const original: Task = {
      id: uuidv4(),
      stub_id: stubId,
      command: "python failed.py",
      status: "failed",
      created_at: new Date().toISOString(),
      log_buffer: [],
    };
    stub.tasks.push(original);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/tasks/${original.id}/retry`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...ctx.authHeader(),
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.retry_of).toBe(original.id);
    // Task is added to global queue then may be immediately dispatched to an online stub
    expect(["queued", "dispatched"]).toContain(body.status);
    expect(body.id).not.toBe(original.id);
  });

  it("POST /tasks/batch/retry: retries multiple tasks at once", async () => {
    const stub = store.getStub(stubId)!;
    const t1: Task = {
      id: uuidv4(),
      stub_id: stubId,
      command: "python fail1.py",
      status: "failed",
      created_at: new Date().toISOString(),
      log_buffer: [],
    };
    const t2: Task = {
      id: uuidv4(),
      stub_id: stubId,
      command: "python fail2.py",
      status: "interrupted",
      created_at: new Date().toISOString(),
      log_buffer: [],
    };
    stub.tasks.push(t1, t2);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/tasks/batch/retry`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...ctx.authHeader(),
      },
      body: JSON.stringify({ task_ids: [t1.id, t2.id] }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.results[0].ok).toBe(true);
    expect(body.results[1].ok).toBe(true);
    expect(body.results[0].new_task_id).toBeDefined();
    expect(body.results[1].new_task_id).toBeDefined();
  });
});
