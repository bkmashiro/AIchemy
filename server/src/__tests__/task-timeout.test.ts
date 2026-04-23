import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { store } from "../store";
import { createTestServer, TestContext, createMockStub } from "./helpers/setup";
import { setupWebNamespace } from "../socket/web";
import { checkTaskTimeouts } from "../scheduler";
import { v4 as uuidv4 } from "uuid";
import { Task } from "../types";

describe("Task timeout enforcement", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
    setupWebNamespace(ctx.webNs);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("kills a running task that has exceeded its timeout", () => {
    const stub = createMockStub({ status: "online" });
    const task: Task = {
      id: uuidv4(),
      stub_id: stub.id,
      command: "python slow_train.py",
      status: "running",
      created_at: new Date(Date.now() - 120_000).toISOString(),
      started_at: new Date(Date.now() - 120_000).toISOString(), // started 120s ago
      log_buffer: [],
      timeout_s: 60, // 60s timeout — should be exceeded
    };
    stub.tasks.push(task);
    store.setStub(stub);

    checkTaskTimeouts(ctx.stubNs, ctx.webNs);

    const updated = store.getTask(stub.id, task.id);
    expect(updated?.status).toBe("killed");
    expect(updated?.finished_at).toBeDefined();
  });

  it("does not kill a task that has not exceeded its timeout", () => {
    const stub = createMockStub({ status: "online" });
    const task: Task = {
      id: uuidv4(),
      stub_id: stub.id,
      command: "python fast_train.py",
      status: "running",
      created_at: new Date(Date.now() - 10_000).toISOString(),
      started_at: new Date(Date.now() - 10_000).toISOString(), // started 10s ago
      log_buffer: [],
      timeout_s: 60, // 60s timeout — not exceeded
    };
    stub.tasks.push(task);
    store.setStub(stub);

    checkTaskTimeouts(ctx.stubNs, ctx.webNs);

    const updated = store.getTask(stub.id, task.id);
    expect(updated?.status).toBe("running");
  });

  it("does not kill a task without a timeout_s set", () => {
    const stub = createMockStub({ status: "online" });
    const task: Task = {
      id: uuidv4(),
      stub_id: stub.id,
      command: "python no_timeout.py",
      status: "running",
      created_at: new Date(Date.now() - 99999_000).toISOString(),
      started_at: new Date(Date.now() - 99999_000).toISOString(), // running for days
      log_buffer: [],
      // no timeout_s
    };
    stub.tasks.push(task);
    store.setStub(stub);

    checkTaskTimeouts(ctx.stubNs, ctx.webNs);

    const updated = store.getTask(stub.id, task.id);
    expect(updated?.status).toBe("running");
  });

  it("creates an alert when a task is killed due to timeout", () => {
    const stub = createMockStub({ status: "online" });
    const task: Task = {
      id: uuidv4(),
      stub_id: stub.id,
      command: "python timeout_task.py",
      status: "running",
      created_at: new Date(Date.now() - 200_000).toISOString(),
      started_at: new Date(Date.now() - 200_000).toISOString(),
      log_buffer: [],
      timeout_s: 30,
    };
    stub.tasks.push(task);
    store.setStub(stub);

    checkTaskTimeouts(ctx.stubNs, ctx.webNs);

    const alerts = store.getAllAlerts();
    const timeoutAlert = alerts.find((a) => a.task_id === task.id);
    expect(timeoutAlert).toBeDefined();
    expect(timeoutAlert?.message).toContain("exceeded timeout");
  });

  it("does not kill a non-running task even if timeout exceeded", () => {
    const stub = createMockStub({ status: "online" });
    const task: Task = {
      id: uuidv4(),
      stub_id: stub.id,
      command: "python queued.py",
      status: "queued", // not running
      created_at: new Date(Date.now() - 200_000).toISOString(),
      log_buffer: [],
      timeout_s: 10,
    };
    stub.tasks.push(task);
    store.setStub(stub);

    checkTaskTimeouts(ctx.stubNs, ctx.webNs);

    const updated = store.getTask(stub.id, task.id);
    expect(updated?.status).toBe("queued");
  });
});
