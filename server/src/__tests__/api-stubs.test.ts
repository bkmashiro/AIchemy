/**
 * api-stubs.test.ts — Unit tests for api/stubs.ts
 *
 * Covers:
 *   - GET /stubs, GET /stubs/:id — CRUD, socket_id stripping
 *   - PATCH /stubs/:id — name, max_concurrent validation, tags, auto_renew
 *   - POST /stubs/:id/tasks — direct submission, dedup, write-lock, idempotency, stub offline
 *   - DELETE /stubs/prune — route ordering (before /:id)
 *   - DELETE /stubs/:id — online guard, active task guard
 *   - POST /stubs/:id/release — running task guard
 *   - POST /stubs/:id/exec — command validation, timeout clamping
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../scheduler", () => ({
  triggerSchedule: vi.fn(),
  maybeDispatch: vi.fn(),
  startScheduler: vi.fn(),
}));

vi.mock("../reliable", () => ({
  reliableEmitToStub: vi.fn(),
}));

vi.mock("../discord", () => ({
  notifySubmitted: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../socket/stub", () => ({
  initiateKillChain: vi.fn(),
}));

vi.mock("../task-actions", () => ({
  killTask: vi.fn(),
  killGlobalTask: vi.fn(),
  pauseTask: vi.fn(),
  resumeTask: vi.fn(),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { store } from "../store";
import { createStubsRouter } from "../api/stubs";
import { writeLockTable, idempotencyCache } from "../dedup";
import { maybeDispatch } from "../scheduler";
import { reliableEmitToStub } from "../reliable";
import { Task, Stub } from "../types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStubNamespace(extraSockets?: Map<string, any>) {
  const sockets = extraSockets ?? new Map();
  return { emit: vi.fn(), sockets: { get: (id: string) => sockets.get(id) } } as any;
}

function makeWebNamespace() {
  return { emit: vi.fn() } as any;
}

function makeApp(stubNs?: any, webNs?: any) {
  const app = express();
  app.use(express.json());
  app.use("/stubs", createStubsRouter(stubNs ?? makeStubNamespace(), webNs ?? makeWebNamespace()));
  return app;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    seq: store.nextSeq(),
    fingerprint: `fp-${Math.random().toString(36).slice(2, 10)}`,
    display_name: "test task",
    script: "train.py",
    command: "python train.py",
    status: "pending",
    priority: 5,
    created_at: new Date().toISOString(),
    log_buffer: [],
    retry_count: 0,
    max_retries: 0,
    should_stop: false,
    should_checkpoint: false,
    ...overrides,
  };
}

function makeStub(overrides: Partial<Stub> = {}): Stub {
  return {
    id: `stub-${Math.random().toString(36).slice(2, 8)}`,
    name: "test-stub",
    hostname: "localhost",
    gpu: { name: "RTX3090", vram_total_mb: 24576, count: 1 },
    status: "online",
    type: "workstation",
    connected_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    max_concurrent: 2,
    tasks: [],
    socket_id: "socket-123",
    ...overrides,
  };
}

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
});

afterEach(() => {
  writeLockTable.clear();
});

// ─── GET /stubs ───────────────────────────────────────────────────────────────

describe("GET /stubs", () => {
  it("returns empty array when no stubs", async () => {
    const app = makeApp();
    const res = await request(app).get("/stubs");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns list of stubs without socket_id", async () => {
    const app = makeApp();
    const stub = makeStub({ socket_id: "secret-socket-id" });
    store.setStub(stub);

    const res = await request(app).get("/stubs");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].socket_id).toBeUndefined();
    expect(res.body[0].id).toBe(stub.id);
  });

  it("returns multiple stubs", async () => {
    const app = makeApp();
    store.setStub(makeStub({ id: "s1", name: "stub-1" }));
    store.setStub(makeStub({ id: "s2", name: "stub-2" }));

    const res = await request(app).get("/stubs");
    expect(res.body).toHaveLength(2);
  });
});

// ─── GET /stubs/:id ───────────────────────────────────────────────────────────

describe("GET /stubs/:id", () => {
  it("returns 404 for unknown stub", async () => {
    const app = makeApp();
    const res = await request(app).get("/stubs/nonexistent");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/stub not found/i);
  });

  it("returns stub without socket_id", async () => {
    const app = makeApp();
    const stub = makeStub({ socket_id: "private-socket" });
    store.setStub(stub);

    const res = await request(app).get(`/stubs/${stub.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(stub.id);
    expect(res.body.socket_id).toBeUndefined();
  });
});

// ─── PATCH /stubs/:id ────────────────────────────────────────────────────────

describe("PATCH /stubs/:id", () => {
  it("returns 404 for unknown stub", async () => {
    const app = makeApp();
    const res = await request(app).patch("/stubs/nonexistent").send({ name: "foo" });
    expect(res.status).toBe(404);
  });

  it("updates stub name", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const stub = makeStub();
    store.setStub(stub);

    const res = await request(app).patch(`/stubs/${stub.id}`).send({ name: "new-name" });
    expect(res.status).toBe(200);
    expect(res.body.stub.name).toBe("new-name");
    expect(store.getStub(stub.id)!.name).toBe("new-name");
    expect(webNs.emit).toHaveBeenCalledWith("stub.update", expect.objectContaining({ name: "new-name" }));
  });

  it("coerces name to string", async () => {
    const app = makeApp();
    const stub = makeStub();
    store.setStub(stub);

    const res = await request(app).patch(`/stubs/${stub.id}`).send({ name: 42 });
    expect(res.status).toBe(200);
    expect(res.body.stub.name).toBe("42");
  });

  it("updates max_concurrent and notifies stub", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const stub = makeStub();
    store.setStub(stub);

    const res = await request(app).patch(`/stubs/${stub.id}`).send({ max_concurrent: 4 });
    expect(res.status).toBe(200);
    expect(res.body.stub.max_concurrent).toBe(4);
    expect(reliableEmitToStub).toHaveBeenCalledWith(stub.id, "config.update", { max_concurrent: 4 });
    expect(maybeDispatch).toHaveBeenCalled();
  });

  it("rejects max_concurrent below 1", async () => {
    const app = makeApp();
    const stub = makeStub();
    store.setStub(stub);

    const res = await request(app).patch(`/stubs/${stub.id}`).send({ max_concurrent: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/max_concurrent/i);
  });

  it("rejects max_concurrent above 64", async () => {
    const app = makeApp();
    const stub = makeStub();
    store.setStub(stub);

    const res = await request(app).patch(`/stubs/${stub.id}`).send({ max_concurrent: 65 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/max_concurrent/i);
  });

  it("rejects non-finite max_concurrent", async () => {
    const app = makeApp();
    const stub = makeStub();
    store.setStub(stub);

    const res = await request(app)
      .patch(`/stubs/${stub.id}`)
      .send({ max_concurrent: "not-a-number" });
    expect(res.status).toBe(400);
  });

  it("updates tags without validation", async () => {
    // BUG: tags is set without array-of-strings validation
    const app = makeApp();
    const stub = makeStub();
    store.setStub(stub);

    const res = await request(app)
      .patch(`/stubs/${stub.id}`)
      .send({ tags: ["gpu", "ml"] });
    expect(res.status).toBe(200);
    expect(store.getStub(stub.id)!.tags).toEqual(["gpu", "ml"]);
  });

  it("BUG: accepts non-array tags without validation", async () => {
    const app = makeApp();
    const stub = makeStub();
    store.setStub(stub);

    // tags should be string[], but no validation is performed
    const res = await request(app)
      .patch(`/stubs/${stub.id}`)
      .send({ tags: "not-an-array" });
    // Currently accepted — no type check
    expect(res.status).toBe(200);
  });

  it("updates auto_renew flag", async () => {
    const app = makeApp();
    const stub = makeStub();
    store.setStub(stub);

    const res = await request(app)
      .patch(`/stubs/${stub.id}`)
      .send({ auto_renew: true });
    expect(res.status).toBe(200);
    expect(store.getStub(stub.id)!.auto_renew).toBe(true);
  });

  it("response does not include socket_id", async () => {
    const app = makeApp();
    const stub = makeStub({ socket_id: "hidden" });
    store.setStub(stub);

    const res = await request(app).patch(`/stubs/${stub.id}`).send({ name: "x" });
    expect(res.body.stub.socket_id).toBeUndefined();
  });
});

// ─── POST /stubs/:id/tasks (direct submission) ────────────────────────────────

describe("POST /stubs/:id/tasks", () => {
  it("returns 404 for unknown stub", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/stubs/nonexistent/tasks")
      .send({ script: "train.py" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when script is missing", async () => {
    const app = makeApp();
    const stub = makeStub();
    store.setStub(stub);

    const res = await request(app).post(`/stubs/${stub.id}/tasks`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/script required/i);
  });

  it("creates a task with queued status (not pending)", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const stub = makeStub();
    store.setStub(stub);

    const res = await request(app)
      .post(`/stubs/${stub.id}/tasks`)
      .send({ script: "train.py", args: { "--seed": "1" } });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
  });

  it("assigns stub_id to the task", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const stub = makeStub();
    store.setStub(stub);

    const res = await request(app)
      .post(`/stubs/${stub.id}/tasks`)
      .send({ script: "train.py" });
    expect(res.body.stub_id).toBe(stub.id);
  });

  it("adds task to stub.tasks", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const stub = makeStub();
    store.setStub(stub);

    await request(app).post(`/stubs/${stub.id}/tasks`).send({ script: "train.py" });

    const updatedStub = store.getStub(stub.id);
    expect(updatedStub!.tasks).toHaveLength(1);
    expect(updatedStub!.tasks[0].script).toBe("train.py");
  });

  it("calls maybeDispatch after submission", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const stub = makeStub();
    store.setStub(stub);

    await request(app).post(`/stubs/${stub.id}/tasks`).send({ script: "train.py" });
    expect(maybeDispatch).toHaveBeenCalled();
  });

  it("emits task.update via webNs", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const stub = makeStub();
    store.setStub(stub);

    await request(app).post(`/stubs/${stub.id}/tasks`).send({ script: "train.py" });
    expect(webNs.emit).toHaveBeenCalledWith("task.update", expect.objectContaining({ script: "train.py" }));
  });

  it("rejects duplicate fingerprint with 409 when task was via global queue", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const stub = makeStub();
    store.setStub(stub);

    // Add a task via global queue first so it's in the fingerprint index
    const { createTask } = await import("../api/tasks");
    const existingTask = createTask({ script: "train.py", args: { "--seed": "42" } });
    store.addToGlobalQueue(existingTask);

    // Direct stub submission with same fingerprint should be rejected
    const body = { script: "train.py", args: { "--seed": "42" } };
    const res = await request(app).post(`/stubs/${stub.id}/tasks`).send(body);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/fingerprint/i);
  });

  it("BUG: duplicate fingerprint not detected for tasks submitted directly to stubs", async () => {
    // Tasks pushed directly into stub.tasks bypass addToGlobalQueue() and
    // therefore the fingerprint index is never updated. A second submission
    // with the same script+args will succeed instead of returning 409.
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const stub = makeStub();
    store.setStub(stub);

    const body = { script: "train.py", args: { "--seed": "42" } };
    const first = await request(app).post(`/stubs/${stub.id}/tasks`).send(body);
    expect(first.status).toBe(201);

    // Same fingerprint — should be 409 but stub direct-submission doesn't index fingerprints
    const second = await request(app).post(`/stubs/${stub.id}/tasks`).send(body);
    // BUG: returns 201 instead of 409
    expect(second.status).toBe(201);
  });

  it("dedup: accepts same script on different stub after task completes", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const stub1 = makeStub({ id: "stub-aa" });
    const stub2 = makeStub({ id: "stub-bb" });
    store.setStub(stub1);
    store.setStub(stub2);

    const body = { script: "train.py", args: { "--seed": "77" } };
    const first = await request(app).post(`/stubs/stub-aa/tasks`).send(body);
    expect(first.status).toBe(201);

    // Force task to terminal
    store.updateTask(stub1.id, first.body.id, { status: "completed" });

    const second = await request(app).post(`/stubs/stub-bb/tasks`).send(body);
    expect(second.status).toBe(201);
  });

  it("rejects when run_dir is write-locked", async () => {
    const app = makeApp();
    const stub = makeStub();
    store.setStub(stub);

    // First submission acquires the lock
    await request(app).post(`/stubs/${stub.id}/tasks`).send({
      script: "train.py",
      run_dir: "/runs/locked",
    });

    // Second submission with different fingerprint but same run_dir
    const res = await request(app).post(`/stubs/${stub.id}/tasks`).send({
      script: "other.py",
      run_dir: "/runs/locked",
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/locked/i);
  });

  it("idempotency key returns same task on repeat", async () => {
    const app = makeApp();
    const stub = makeStub();
    store.setStub(stub);

    const body = { script: "train.py", idempotency_key: "direct-idem-1" };
    const first = await request(app).post(`/stubs/${stub.id}/tasks`).send(body);
    expect(first.status).toBe(201);

    const second = await request(app).post(`/stubs/${stub.id}/tasks`).send({
      script: "other.py",
      idempotency_key: "direct-idem-1",
    });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it("allows tasks to offline stubs (no status guard on submission)", async () => {
    // Direct submission allows tasks to be queued on offline stubs
    const app = makeApp();
    const stub = makeStub({ status: "offline" });
    store.setStub(stub);

    const res = await request(app)
      .post(`/stubs/${stub.id}/tasks`)
      .send({ script: "train.py" });
    // No status guard — offline stubs can receive queued tasks
    expect(res.status).toBe(201);
  });
});

// ─── DELETE /stubs/prune ─────────────────────────────────────────────────────

describe("DELETE /stubs/prune", () => {
  it("is not shadowed by DELETE /stubs/:id", async () => {
    // This test ensures the route ordering is correct: /prune must be before /:id
    const app = makeApp();
    // No stubs → pruned should be 0
    const res = await request(app).delete("/stubs/prune");
    // If route ordering is wrong, Express would try to delete stub with id="prune" → 404
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.pruned).toBe("number");
  });

  it("prunes stale offline stubs with no tasks", async () => {
    const app = makeApp();
    const oldDate = new Date(Date.now() - 48 * 3600_000 - 1000).toISOString();
    const staleStub = makeStub({
      status: "offline",
      socket_id: undefined,
      tasks: [],
      last_heartbeat: oldDate,
    });
    store.setStub(staleStub);

    const res = await request(app).delete("/stubs/prune");
    expect(res.status).toBe(200);
    expect(res.body.pruned).toBeGreaterThan(0);
    expect(store.getStub(staleStub.id)).toBeUndefined();
  });

  it("does not prune recently active stubs", async () => {
    const app = makeApp();
    const recentStub = makeStub({
      status: "offline",
      socket_id: undefined,
      tasks: [],
      last_heartbeat: new Date().toISOString(),
    });
    store.setStub(recentStub);

    const res = await request(app).delete("/stubs/prune");
    expect(res.body.pruned).toBe(0);
    expect(store.getStub(recentStub.id)).toBeDefined();
  });
});

// ─── DELETE /stubs/:id ───────────────────────────────────────────────────────

describe("DELETE /stubs/:id", () => {
  it("returns 404 for unknown stub", async () => {
    const app = makeApp();
    const res = await request(app).delete("/stubs/nonexistent");
    expect(res.status).toBe(404);
  });

  it("rejects deletion of online stub", async () => {
    const app = makeApp();
    const stub = makeStub({ status: "online" });
    store.setStub(stub);

    const res = await request(app).delete(`/stubs/${stub.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/online/i);
  });

  it("rejects deletion when stub has active tasks", async () => {
    const app = makeApp();
    const task = makeTask({ status: "queued" });
    const stub = makeStub({ status: "offline", tasks: [task] });
    store.setStub(stub);

    const res = await request(app).delete(`/stubs/${stub.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/active tasks/i);
  });

  it("deletes offline stub with no active tasks", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "completed" });
    const stub = makeStub({ status: "offline", tasks: [task] });
    store.setStub(stub);

    const res = await request(app).delete(`/stubs/${stub.id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(store.getStub(stub.id)).toBeUndefined();
    expect(webNs.emit).toHaveBeenCalledWith("stub.deleted", { stub_id: stub.id });
  });

  it("considers running/dispatched/queued/paused as active", async () => {
    const app = makeApp();
    for (const status of ["running", "dispatched", "queued", "paused"] as const) {
      store.reset();
      const task = makeTask({ status });
      const stub = makeStub({ status: "offline", tasks: [task] });
      store.setStub(stub);

      const res = await request(app).delete(`/stubs/${stub.id}`);
      expect(res.status).toBe(409);
    }
  });
});

// ─── POST /stubs/:id/release ──────────────────────────────────────────────────

describe("POST /stubs/:id/release", () => {
  it("returns 404 for unknown stub", async () => {
    const app = makeApp();
    const res = await request(app).post("/stubs/nonexistent/release").send({});
    expect(res.status).toBe(404);
  });

  it("rejects release when stub has running tasks", async () => {
    const app = makeApp();
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);

    const res = await request(app).post(`/stubs/${stub.id}/release`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/running tasks/i);
  });

  it("releases stub with no running tasks", async () => {
    const webNs = makeWebNamespace();
    const stubNs = makeStubNamespace();
    const app = makeApp(stubNs, webNs);
    const stub = makeStub({ tasks: [] });
    store.setStub(stub);

    const res = await request(app).post(`/stubs/${stub.id}/release`).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const updatedStub = store.getStub(stub.id);
    expect(updatedStub!.status).toBe("offline");
    expect(updatedStub!.socket_id).toBeUndefined();
    expect(webNs.emit).toHaveBeenCalledWith("stub.offline", { stub_id: stub.id });
  });
});

// ─── POST /stubs/:id/restart ─────────────────────────────────────────────────

describe("POST /stubs/:id/restart", () => {
  it("returns 404 for offline stub", async () => {
    const app = makeApp();
    const stub = makeStub({ status: "offline" });
    store.setStub(stub);

    const res = await request(app).post(`/stubs/${stub.id}/restart`).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not online/i);
  });

  it("emits stub.restart for online stub", async () => {
    const app = makeApp();
    const stub = makeStub({ status: "online" });
    store.setStub(stub);

    const res = await request(app).post(`/stubs/${stub.id}/restart`).send({});
    expect(res.status).toBe(200);
    expect(reliableEmitToStub).toHaveBeenCalledWith(stub.id, "stub.restart", {});
  });
});

// ─── POST /stubs/:id/exec ────────────────────────────────────────────────────

describe("POST /stubs/:id/exec", () => {
  it("returns 404 for unknown stub", async () => {
    const app = makeApp();
    const res = await request(app).post("/stubs/nonexistent/exec").send({ command: "ls" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when stub is offline", async () => {
    const app = makeApp();
    const stub = makeStub({ status: "offline" });
    store.setStub(stub);

    const res = await request(app).post(`/stubs/${stub.id}/exec`).send({ command: "ls" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/offline/i);
  });

  it("returns 400 when command is missing", async () => {
    const app = makeApp();
    const stub = makeStub({ status: "online" });
    store.setStub(stub);

    const res = await request(app).post(`/stubs/${stub.id}/exec`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/command required/i);
  });

  it("returns 400 when command is not a string", async () => {
    const app = makeApp();
    const stub = makeStub({ status: "online" });
    store.setStub(stub);

    const res = await request(app)
      .post(`/stubs/${stub.id}/exec`)
      .send({ command: 42 });
    expect(res.status).toBe(400);
  });

  it("returns request_id and emits shell.exec", async () => {
    const app = makeApp();
    const stub = makeStub({ status: "online" });
    store.setStub(stub);

    const res = await request(app)
      .post(`/stubs/${stub.id}/exec`)
      .send({ command: "nvidia-smi", timeout: 60 });
    expect(res.status).toBe(200);
    expect(res.body.request_id).toBeDefined();
    expect(reliableEmitToStub).toHaveBeenCalledWith(
      stub.id,
      "shell.exec",
      expect.objectContaining({ command: "nvidia-smi", timeout: 60 })
    );
  });

  it("clamps timeout to 120 seconds max", async () => {
    const app = makeApp();
    const stub = makeStub({ status: "online" });
    store.setStub(stub);

    await request(app)
      .post(`/stubs/${stub.id}/exec`)
      .send({ command: "sleep 999", timeout: 9999 });

    expect(reliableEmitToStub).toHaveBeenCalledWith(
      stub.id,
      "shell.exec",
      expect.objectContaining({ timeout: 120 })
    );
  });

  it("defaults timeout to 30 when not provided", async () => {
    const app = makeApp();
    const stub = makeStub({ status: "online" });
    store.setStub(stub);

    await request(app)
      .post(`/stubs/${stub.id}/exec`)
      .send({ command: "ls" });

    expect(reliableEmitToStub).toHaveBeenCalledWith(
      stub.id,
      "shell.exec",
      expect.objectContaining({ timeout: 30 })
    );
  });

  it("BUG: negative timeout passes through (not clamped to minimum)", async () => {
    // Number("-1") = -1 which is truthy so "-1 || 30" = -1 (not 30)
    // Math.min(-1, 120) = -1. No floor/minimum enforced.
    const app = makeApp();
    const stub = makeStub({ status: "online" });
    store.setStub(stub);

    await request(app)
      .post(`/stubs/${stub.id}/exec`)
      .send({ command: "ls", timeout: -1 });

    const call = vi.mocked(reliableEmitToStub).mock.calls[0];
    const payload = call[2] as any;
    // Document: negative timeout passes through
    expect(payload.timeout).toBe(-1);
  });
});

// ─── Route ordering ───────────────────────────────────────────────────────────

describe("Route ordering: /prune before /:id", () => {
  it("DELETE /stubs/prune is not intercepted by DELETE /stubs/:id", async () => {
    const app = makeApp();
    // If ordering were wrong, Express would match "prune" as a stub ID → 404
    const res = await request(app).delete("/stubs/prune");
    // Should be handled by the prune route: 200 with { ok, pruned }
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("pruned");
  });

  it("POST /stubs/:id/tasks does not conflict with other routes", async () => {
    const app = makeApp();
    const stub = makeStub();
    store.setStub(stub);

    // Ensure /tasks sub-route works correctly
    const res = await request(app)
      .post(`/stubs/${stub.id}/tasks`)
      .send({ script: "train.py" });
    expect(res.status).toBe(201);
  });
});
