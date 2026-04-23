import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { store } from "../store";
import { createTestServer, TestContext, createMockStub } from "./helpers/setup";
import { setupWebNamespace } from "../socket/web";
import { logAudit, getAuditLog, resetAuditLog } from "../audit";
import { v4 as uuidv4 } from "uuid";
import { Task } from "../types";

describe("Audit log", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    resetAuditLog();
    ctx = await createTestServer();
    setupWebNamespace(ctx.webNs);
  });

  afterEach(async () => {
    await ctx.cleanup();
    resetAuditLog();
  });

  it("logAudit records an entry", () => {
    logAudit("task.create", { task_id: "abc", command: "python train.py" });
    const log = getAuditLog();
    expect(log.length).toBe(1);
    expect(log[0].action).toBe("task.create");
    expect(log[0].details.task_id).toBe("abc");
    expect(log[0].timestamp).toBeDefined();
  });

  it("getAuditLog returns all entries by default", () => {
    logAudit("task.create", { task_id: "1" });
    logAudit("task.kill", { task_id: "2" });
    logAudit("stub.purge", { stub_id: "3" });

    const log = getAuditLog();
    expect(log.length).toBe(3);
  });

  it("getAuditLog respects limit", () => {
    logAudit("event.a", {});
    logAudit("event.b", {});
    logAudit("event.c", {});

    const log = getAuditLog(2);
    expect(log.length).toBe(2);
    // should return the last 2 entries
    expect(log[0].action).toBe("event.b");
    expect(log[1].action).toBe("event.c");
  });

  it("ring buffer caps at 1000 entries", () => {
    for (let i = 0; i < 1100; i++) {
      logAudit("event", { i });
    }
    const log = getAuditLog();
    expect(log.length).toBe(1000);
    // oldest entries should have been evicted
    expect(log[0].details.i).toBe(100);
    expect(log[999].details.i).toBe(1099);
  });

  it("task creation via router logs audit entry", () => {
    const stub = createMockStub({ status: "online" });
    store.setStub(stub);

    // Simulate what the tasks router does: create a task and call logAudit
    const task: Task = {
      id: uuidv4(),
      stub_id: stub.id,
      command: "python train.py",
      status: "queued",
      created_at: new Date().toISOString(),
      log_buffer: [],
      priority: 5,
    };
    stub.tasks.push(task);
    store.setStub(stub);

    logAudit("task.create", { task_id: task.id, stub_id: stub.id, command: task.command, priority: task.priority });

    const log = getAuditLog();
    const createEntry = log.find((e) => e.action === "task.create");
    expect(createEntry).toBeDefined();
    expect(createEntry?.details.stub_id).toBe(stub.id);
    expect(createEntry?.details.command).toBe("python train.py");
    expect(createEntry?.details.priority).toBe(5);
  });

  it("task kill logs audit entry", () => {
    const stub = createMockStub({ status: "online" });
    const task: Task = {
      id: uuidv4(),
      stub_id: stub.id,
      command: "python train.py",
      status: "running",
      created_at: new Date().toISOString(),
      log_buffer: [],
    };
    stub.tasks.push(task);
    store.setStub(stub);

    // Simulate the kill action in tasks router
    store.updateTask(stub.id, task.id, { status: "killed", finished_at: new Date().toISOString() });
    logAudit("task.kill", { task_id: task.id, stub_id: stub.id, signal: "SIGTERM" });

    const log = getAuditLog();
    const killEntry = log.find((e) => e.action === "task.kill");
    expect(killEntry).toBeDefined();
    expect(killEntry?.details.task_id).toBe(task.id);
    expect(killEntry?.details.signal).toBe("SIGTERM");
  });

  it("stub purge logs audit entry", () => {
    const stub = createMockStub({ status: "offline" });
    store.setStub(stub);

    // Simulate purge
    store.deleteStub(stub.id);
    logAudit("stub.purge", { stub_id: stub.id, name: stub.name });

    const log = getAuditLog();
    const purgeEntry = log.find((e) => e.action === "stub.purge");
    expect(purgeEntry).toBeDefined();
    expect(purgeEntry?.details.stub_id).toBe(stub.id);
  });

  it("global queue task creation logs audit entry", () => {
    const task: Task = {
      id: uuidv4(),
      stub_id: "",
      command: "python global.py",
      status: "queued",
      created_at: new Date().toISOString(),
      log_buffer: [],
      priority: 3,
    };
    store.addToGlobalQueue(task);
    logAudit("task.create", { task_id: task.id, stub_id: "", command: task.command, priority: task.priority });

    const log = getAuditLog();
    const entry = log.find((e) => e.action === "task.create" && e.details.command === "python global.py");
    expect(entry).toBeDefined();
    expect(entry?.details.priority).toBe(3);
  });

  it("resetAuditLog clears all entries", () => {
    logAudit("event.a", {});
    logAudit("event.b", {});
    resetAuditLog();
    expect(getAuditLog().length).toBe(0);
  });

  it("audit entries have valid ISO timestamp", () => {
    logAudit("test.event", { key: "value" });
    const log = getAuditLog();
    expect(log.length).toBe(1);
    const ts = new Date(log[0].timestamp);
    expect(isNaN(ts.getTime())).toBe(false);
  });

  it("store.reset() clears audit log", () => {
    logAudit("event.a", {});
    logAudit("event.b", {});
    store.reset();
    expect(getAuditLog().length).toBe(0);
  });
});
