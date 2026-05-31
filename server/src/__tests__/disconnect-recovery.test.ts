/**
 * disconnect-recovery.test.ts — Tests for stub disconnect/reconnect behavior.
 *
 * Covers:
 *   - markDisconnected: sets disconnected_at + stub_offline, keeps status "running"
 *   - clearDisconnected: clears the flags
 *   - failTask: transitions running+disconnected tasks to "failed" after timeout
 *   - Resume reconciliation: stub reconnects, server clears flags for reported tasks
 *     and fails tasks not reported by stub
 */

import { describe, it, expect, beforeEach } from "vitest";
import { store } from "../store";
import { markDisconnected, clearDisconnected, failTask, cancelTask } from "../task-actions";
import { Task, Stub, TaskStatus } from "../types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _taskSeq = 1;
function makeTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? "task-1";
  return {
    id,
    seq: _taskSeq++,
    fingerprint: `fp-${id}`,
    display_name: `Task ${id}`,
    script: "train.py",
    command: "python train.py",
    status: "pending" as TaskStatus,
    priority: 0,
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
    id: "stub-1",
    name: "test-stub",
    hostname: "gpu01",
    gpu: { name: "A100", vram_total_mb: 81920, count: 1 },
    status: "online",
    tasks: [],
    max_concurrent: 4,
    connected_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    type: "workstation",
    tags: [],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("markDisconnected", () => {
  beforeEach(() => {
    store.reset();
  });

  it("sets disconnected_at and stub_offline without changing status", () => {
    const stub = makeStub();
    const task = makeTask({ status: "running" });
    stub.tasks = [task];
    store.setStub(stub);

    const updated = markDisconnected("stub-1", "task-1");

    expect(updated).toBeDefined();
    expect(updated!.status).toBe("running");
    expect(updated!.stub_offline).toBe(true);
    expect(updated!.disconnected_at).toBeDefined();
  });

  it("does not affect non-running tasks", () => {
    const stub = makeStub();
    const task = makeTask({ status: "completed" });
    stub.tasks = [task];
    store.setStub(stub);

    const updated = markDisconnected("stub-1", "task-1");
    // completed tasks should not be marked
    expect(updated).toBeUndefined();
  });

  it("returns undefined for unknown task", () => {
    const stub = makeStub();
    store.setStub(stub);

    const updated = markDisconnected("stub-1", "nonexistent");
    expect(updated).toBeUndefined();
  });
});

describe("clearDisconnected", () => {
  beforeEach(() => {
    store.reset();
  });

  it("clears disconnected_at and stub_offline", () => {
    const stub = makeStub();
    const task = makeTask({
      status: "running",
      disconnected_at: new Date().toISOString(),
      stub_offline: true,
    });
    stub.tasks = [task];
    store.setStub(stub);

    const updated = clearDisconnected("stub-1", "task-1");

    expect(updated).toBeDefined();
    expect(updated!.stub_offline).toBeFalsy();
    expect(updated!.disconnected_at).toBeUndefined();
    expect(updated!.status).toBe("running");
  });

  it("returns undefined for unknown task", () => {
    const stub = makeStub();
    store.setStub(stub);

    const updated = clearDisconnected("stub-1", "nonexistent");
    expect(updated).toBeUndefined();
  });
});

describe("disconnect → timeout → failed", () => {
  beforeEach(() => {
    store.reset();
  });

  it("failTask transitions running task to failed", () => {
    const stub = makeStub();
    const task = makeTask({
      status: "running",
      disconnected_at: new Date().toISOString(),
      stub_offline: true,
    });
    stub.tasks = [task];
    store.setStub(stub);

    const failed = failTask("stub-1", "task-1", undefined, { death_cause: "disappeared" });

    expect(failed).toBeDefined();
    expect(failed!.status).toBe("failed");
    expect(failed!.death_cause).toBe("disappeared");
  });

  it("task stays running with disconnect flag before timeout fires", () => {
    const stub = makeStub();
    const task = makeTask({ status: "running" });
    stub.tasks = [task];
    store.setStub(stub);

    markDisconnected("stub-1", "task-1");

    // Task should still be running
    const found = store.findTask("task-1");
    expect(found).toBeDefined();
    expect(found!.task.status).toBe("running");
    expect(found!.task.stub_offline).toBe(true);
  });
});

describe("reconnect reconciliation", () => {
  beforeEach(() => {
    store.reset();
  });

  it("clearDisconnected restores task to normal running state on reconnect", () => {
    const stub = makeStub();
    const task = makeTask({
      status: "running",
      disconnected_at: new Date().toISOString(),
      stub_offline: true,
    });
    stub.tasks = [task];
    store.setStub(stub);

    // Stub reconnects and reports task still running
    const updated = clearDisconnected("stub-1", "task-1");

    expect(updated!.status).toBe("running");
    expect(updated!.stub_offline).toBeFalsy();
    expect(updated!.disconnected_at).toBeUndefined();
  });

  it("tasks not reported by stub on reconnect get failed with disappeared cause", () => {
    const stub = makeStub();
    const task = makeTask({
      id: "task-orphan",
      status: "running",
      disconnected_at: new Date().toISOString(),
      stub_offline: true,
    });
    stub.tasks = [task];
    store.setStub(stub);

    // Stub reconnects but does NOT report this task → fail it
    const failed = failTask("stub-1", "task-orphan", undefined, { death_cause: "disappeared" });

    expect(failed!.status).toBe("failed");
    expect(failed!.death_cause).toBe("disappeared");
  });

  it("cancelTask works for tasks with should_stop set", () => {
    const stub = makeStub();
    const task = makeTask({
      status: "running",
      should_stop: true,
      disconnected_at: new Date().toISOString(),
      stub_offline: true,
    });
    stub.tasks = [task];
    store.setStub(stub);

    const cancelled = cancelTask("stub-1", "task-1");
    expect(cancelled).toBeDefined();
    expect(cancelled!.status).toBe("cancelled");
  });
});
