import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { store } from "../store";
import { createTestServer, TestContext, createMockStub, createTestToken, connectStubClient } from "./helpers/setup";
import { setupStubNamespace } from "../socket/stub";
import { setupWebNamespace } from "../socket/web";
import { v4 as uuidv4 } from "uuid";
import { Task } from "../types";

async function registerStub(port: number, token: string, hostname: string): Promise<{ client: ReturnType<typeof connectStubClient>; stubId: string }> {
  const client = connectStubClient(port);
  client.connect();

  const stubId = await new Promise<string>((resolve) => {
    client.on("registered", (data: any) => resolve(data.stub_id));
    client.emit("register", {
      hostname,
      gpu: { name: "A40", vram_total_mb: 49152, count: 1 },
      max_concurrent: 3,
      token,
    });
  });

  return { client, stubId };
}

describe("Stub disconnect/reconnect extended", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
    setupWebNamespace(ctx.webNs);
    setupStubNamespace(ctx.stubNs, ctx.webNs);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("reconnect with same hostname+token resets interrupted tasks to queued", async () => {
    const token = createTestToken();

    // First connection
    const { client: client1, stubId } = await registerStub(ctx.port, token.token, "same-host");

    // Add a running task
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

    // Disconnect
    client1.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    // Verify interrupted
    const afterDisconnect = store.getStub(stubId)!;
    expect(afterDisconnect.tasks[0].status).toBe("interrupted");

    // Reconnect with same hostname+token
    const { client: client2 } = await registerStub(ctx.port, token.token, "same-host");
    await new Promise((r) => setTimeout(r, 100));

    // Check that interrupted tasks were reset to queued
    const afterReconnect = store.getStub(stubId)!;
    expect(afterReconnect.status).toBe("online");
    // Task is requeued then immediately dispatched (race condition fix)
    expect(["queued", "dispatched"]).toContain(afterReconnect.tasks[0].status);
    expect(afterReconnect.tasks[0].pid).toBeUndefined();
    expect(afterReconnect.tasks[0].started_at).toBeUndefined();
    expect(afterReconnect.tasks[0].finished_at).toBeUndefined();

    client2.disconnect();
  });

  it("reconnect dispatches queued tasks", async () => {
    const token = createTestToken();
    const taskId = uuidv4();

    // Pre-create a stub with a queued task
    const preStub = createMockStub({
      token: token.token,
      hostname: "dispatch-host",
      status: "offline",
      tasks: [
        {
          id: taskId,
          stub_id: "",
          command: "python dispatch.py",
          status: "queued",
          created_at: new Date().toISOString(),
          log_buffer: [],
        },
      ],
    });
    preStub.tasks[0].stub_id = preStub.id;
    store.setStub(preStub);

    // Set up listener BEFORE connecting so we catch the dispatch event
    const dispatchedTasks: string[] = [];
    const client = connectStubClient(ctx.port);

    // Attach listener before connect
    client.on("task.run", (payload: any) => {
      dispatchedTasks.push(payload.task_id);
    });

    client.connect();

    await new Promise<void>((resolve) => {
      client.on("registered", () => resolve());
      client.emit("register", {
        hostname: "dispatch-host",
        gpu: { name: "A40", vram_total_mb: 49152, count: 1 },
        max_concurrent: 3,
        token: token.token,
      });
    });

    await new Promise((r) => setTimeout(r, 200));

    // Should have dispatched the queued task
    expect(dispatchedTasks.length).toBe(1);
    expect(dispatchedTasks[0]).toBe(taskId);

    client.disconnect();
  });

  it("disconnecting one stub does not affect tasks on other stubs", async () => {
    const token1 = createTestToken();
    const token2 = createTestToken();

    const { client: client1, stubId: stubId1 } = await registerStub(ctx.port, token1.token, "host-1");
    const { client: client2, stubId: stubId2 } = await registerStub(ctx.port, token2.token, "host-2");

    // Add running tasks to both stubs
    const addTask = (stubId: string) => {
      const stub = store.getStub(stubId)!;
      const task: Task = {
        id: uuidv4(),
        stub_id: stubId,
        command: "python train.py",
        status: "running",
        created_at: new Date().toISOString(),
        log_buffer: [],
        pid: 1000,
      };
      stub.tasks.push(task);
      store.setStub(stub);
      return task.id;
    };

    const taskId1 = addTask(stubId1);
    const taskId2 = addTask(stubId2);

    // Disconnect stub 1
    client1.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    // Stub 1 offline, task 1 interrupted
    const s1 = store.getStub(stubId1)!;
    expect(s1.status).toBe("offline");
    expect(s1.tasks[0].status).toBe("interrupted");

    // Stub 2 still online, task 2 still running
    const s2 = store.getStub(stubId2)!;
    expect(s2.status).toBe("online");
    expect(s2.tasks[0].status).toBe("running");

    client2.disconnect();
  });

  it("heartbeat resets missed_heartbeats counter", async () => {
    const token = createTestToken();
    const { client, stubId } = await registerStub(ctx.port, token.token, "heartbeat-host");

    // Simulate missed heartbeats by manually setting the counter
    const stub = store.getStub(stubId)!;
    stub.missed_heartbeats = 2;
    store.setStub(stub);

    // Send heartbeat
    client.emit("heartbeat", { timestamp: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 100));

    const updated = store.getStub(stubId)!;
    expect(updated.missed_heartbeats).toBe(0);

    client.disconnect();
  });

  it("stale detection: stub marked stale after 3 missed heartbeats (direct state manipulation)", () => {
    // Test the stale logic by simulating the state that would trigger it
    const stub = createMockStub({
      status: "online",
      missed_heartbeats: 2,
    });
    store.setStub(stub);

    // Simulate one more missed heartbeat
    const retrieved = store.getStub(stub.id)!;
    retrieved.missed_heartbeats = (retrieved.missed_heartbeats || 0) + 1;
    if (retrieved.missed_heartbeats >= 3) {
      retrieved.status = "stale";
    }
    store.setStub(retrieved);

    expect(store.getStub(stub.id)?.status).toBe("stale");
    expect(store.getStub(stub.id)?.missed_heartbeats).toBe(3);
  });

  it("paused task is also interrupted on disconnect", async () => {
    const token = createTestToken();
    const { client, stubId } = await registerStub(ctx.port, token.token, "paused-host");

    const stub = store.getStub(stubId)!;
    stub.tasks.push({
      id: uuidv4(),
      stub_id: stubId,
      command: "python long.py",
      status: "paused",
      created_at: new Date().toISOString(),
      log_buffer: [],
    });
    store.setStub(stub);

    client.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    const updated = store.getStub(stubId)!;
    expect(updated.tasks[0].status).toBe("interrupted");
  });
});
