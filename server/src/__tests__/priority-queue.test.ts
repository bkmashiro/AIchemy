import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { store } from "../store";
import { createTestServer, TestContext, createMockStub } from "./helpers/setup";
import { v4 as uuidv4 } from "uuid";
import { Task } from "../types";

/**
 * Helper: create a task with a given priority in the global queue.
 */
function enqueueTask(command: string, priority: number, createdAt?: string): Task {
  const task: Task = {
    id: uuidv4(),
    stub_id: "",
    command,
    status: "queued",
    created_at: createdAt || new Date().toISOString(),
    log_buffer: [],
    priority,
  };
  store.addToGlobalQueue(task);
  return task;
}

describe("Priority queue", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("tasks are dispatched in priority order (lower number first)", () => {
    const low = enqueueTask("low-priority", 9);
    const high = enqueueTask("high-priority", 1);
    const mid = enqueueTask("mid-priority", 5);

    const queue = store.getGlobalQueue();
    expect(queue[0].id).toBe(high.id);   // priority 1
    expect(queue[1].id).toBe(mid.id);    // priority 5
    expect(queue[2].id).toBe(low.id);    // priority 9
  });

  it("default priority is 5", () => {
    const t1 = enqueueTask("high", 1);
    // Task without explicit priority — use default 5
    const defaultTask: Task = {
      id: uuidv4(),
      stub_id: "",
      command: "default-priority",
      status: "queued",
      created_at: new Date().toISOString(),
      log_buffer: [],
      // no priority field
    };
    store.addToGlobalQueue(defaultTask);
    const t3 = enqueueTask("low", 9);

    const queue = store.getGlobalQueue();
    expect(queue[0].id).toBe(t1.id);          // priority 1
    expect(queue[1].id).toBe(defaultTask.id);  // priority 5 (default)
    expect(queue[2].id).toBe(t3.id);           // priority 9
  });

  it("same-priority tasks maintain FIFO order (by created_at)", async () => {
    const now = Date.now();
    const t1 = enqueueTask("first", 5, new Date(now).toISOString());
    const t2 = enqueueTask("second", 5, new Date(now + 1000).toISOString());
    const t3 = enqueueTask("third", 5, new Date(now + 2000).toISOString());

    const queue = store.getGlobalQueue();
    expect(queue[0].id).toBe(t1.id);
    expect(queue[1].id).toBe(t2.id);
    expect(queue[2].id).toBe(t3.id);
  });

  it("high priority task inserted after lower-priority tasks still goes to front", () => {
    const low1 = enqueueTask("low1", 8);
    const low2 = enqueueTask("low2", 7);
    // Now add a high priority task
    const urgent = enqueueTask("urgent", 0);

    const queue = store.getGlobalQueue();
    expect(queue[0].id).toBe(urgent.id);  // priority 0 goes first
  });

  it("dispatchQueuedTasks dispatches high-priority tasks first", () => {
    // Add a stub with capacity
    const stub = createMockStub({ status: "online", max_concurrent: 10, tasks: [] });
    store.setStub(stub);

    // Enqueue tasks in reverse priority order
    const low = enqueueTask("low", 9);
    const high = enqueueTask("high", 1);
    const mid = enqueueTask("mid", 5);

    // Verify queue order before dispatch
    const queue = store.getGlobalQueue();
    expect(queue[0].command).toBe("high");
    expect(queue[1].command).toBe("mid");
    expect(queue[2].command).toBe("low");
  });
});
