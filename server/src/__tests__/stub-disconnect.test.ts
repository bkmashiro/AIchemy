import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { store } from "../store";
import { createMockStub, createTestToken, createTestServer, TestContext, connectStubClient } from "./helpers/setup";
import { setupStubNamespace } from "../socket/stub";
import { setupWebNamespace } from "../socket/web";
import { v4 as uuidv4 } from "uuid";
import { Task } from "../types";

describe("Stub disconnect → task cleanup", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
    setupWebNamespace(ctx.webNs);
    setupStubNamespace(ctx.stubNs, ctx.webNs);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("should mark running tasks as interrupted when stub disconnects", async () => {
    const token = createTestToken();

    // Connect a stub
    const client = connectStubClient(ctx.port);
    client.connect();

    await new Promise<void>((resolve) => {
      client.on("registered", () => resolve());
      client.emit("register", {
        hostname: "test-gpu",
        gpu: { name: "A40", vram_total_mb: 49152, count: 1 },
        max_concurrent: 3,
        token: token.token,
      });
    });

    // Find the registered stub
    const stubs = store.getAllStubs();
    expect(stubs.length).toBe(1);
    const stub = stubs[0];

    // Add a running task
    const task: Task = {
      id: uuidv4(),
      stub_id: stub.id,
      command: "python train.py",
      status: "running",
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      log_buffer: [],
      pid: 12345,
    };
    stub.tasks.push(task);
    store.setStub(stub);

    // Disconnect
    client.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    // Check task status
    const updated = store.getStub(stub.id);
    expect(updated?.status).toBe("offline");
    expect(updated?.tasks[0].status).toBe("interrupted");
    expect(updated?.tasks[0].finished_at).toBeDefined();
  });

  it("should reset interrupted tasks to queued on reconnect", async () => {
    const token = createTestToken();

    // Create a stub with interrupted tasks
    const stub = createMockStub({
      token: token.token,
      hostname: "reconnect-host",
      status: "offline",
      tasks: [
        {
          id: uuidv4(),
          stub_id: "", // will be set
          command: "python train.py",
          status: "interrupted",
          created_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          log_buffer: [],
        },
      ],
    });
    stub.tasks[0].stub_id = stub.id;
    store.setStub(stub);

    // Reconnect
    const client = connectStubClient(ctx.port);
    client.connect();

    await new Promise<void>((resolve) => {
      client.on("registered", () => resolve());
      client.emit("register", {
        hostname: "reconnect-host",
        gpu: { name: "A40", vram_total_mb: 49152, count: 1 },
        max_concurrent: 3,
        token: token.token,
      });
    });

    await new Promise((r) => setTimeout(r, 100));

    const updated = store.getStub(stub.id);
    expect(updated?.status).toBe("online");
    // Task is requeued then immediately dispatched (race condition fix)
    expect(["queued", "dispatched"]).toContain(updated?.tasks[0].status);
    expect(updated?.tasks[0].finished_at).toBeUndefined();

    client.disconnect();
  });

  it("should update grid cells when stub disconnects with grid tasks", async () => {
    const token = createTestToken();

    // Create grid
    const gridId = uuidv4();
    const cellId = uuidv4();
    store.setGrid({
      id: gridId,
      name: "test-grid",
      command_template: "python train.py",
      parameters: { lr: [0.01] },
      cells: [{ id: cellId, grid_id: gridId, params: { lr: 0.01 }, status: "running" }],
      status: "running",
      created_at: new Date().toISOString(),
    });

    // Connect stub
    const client = connectStubClient(ctx.port);
    client.connect();

    await new Promise<void>((resolve) => {
      client.on("registered", () => resolve());
      client.emit("register", {
        hostname: "grid-host",
        gpu: { name: "A40", vram_total_mb: 49152, count: 1 },
        max_concurrent: 3,
        token: token.token,
      });
    });

    const stub = store.getAllStubs()[0];
    const task: Task = {
      id: uuidv4(),
      stub_id: stub.id,
      command: "python train.py",
      status: "running",
      created_at: new Date().toISOString(),
      log_buffer: [],
      grid_id: gridId,
      grid_cell_id: cellId,
    };
    stub.tasks.push(task);
    store.setStub(stub);
    store.updateGridCell(gridId, cellId, { task_id: task.id });

    // Disconnect
    client.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    // Check grid cell
    const grid = store.getGrid(gridId);
    expect(grid?.cells[0].status).toBe("failed");
  });
});
