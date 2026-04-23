import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { store } from "../store";
import { createTestServer, TestContext, createMockStub, createTestToken } from "./helpers/setup";
import { createGridsRouter } from "../api/grids";
import { setupStubNamespace } from "../socket/stub";
import { setupWebNamespace } from "../socket/web";
import { v4 as uuidv4 } from "uuid";
import express from "express";

describe("Grid edge cases", () => {
  let ctx: TestContext;
  let stubId: string;

  beforeEach(async () => {
    ctx = await createTestServer();
    setupWebNamespace(ctx.webNs);
    setupStubNamespace(ctx.stubNs, ctx.webNs);

    const api = express.Router();
    api.use("/grids", createGridsRouter(ctx.stubNs, ctx.webNs));
    ctx.app.use("/api", api);

    createTestToken();
    const stub = createMockStub({ status: "online" });
    store.setStub(stub);
    stubId = stub.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("grid with single parameter creates correct number of cells", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/grids`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "single-param-grid",
        command_template: "python train.py --lr {lr}",
        parameters: { lr: [0.001, 0.01, 0.1] },
        stub_id: stubId,
      }),
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.cells.length).toBe(3);
    expect(body.status).toBe("pending");
    // Verify command interpolation
    const storeGrid = store.getGrid(body.id);
    const stub = store.getStub(stubId)!;
    expect(stub.tasks.length).toBe(3);
    expect(stub.tasks.some((t) => t.command.includes("--lr 0.001"))).toBe(true);
    expect(stub.tasks.some((t) => t.command.includes("--lr 0.01"))).toBe(true);
    expect(stub.tasks.some((t) => t.command.includes("--lr 0.1"))).toBe(true);
  });

  it("grid with 3+ parameters creates cartesian product", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/grids`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "multi-param-grid",
        command_template: "python train.py --lr {lr} --bs {bs} --layers {layers}",
        parameters: {
          lr: [0.001, 0.01],
          bs: [32, 64],
          layers: [2, 4, 8],
        },
        stub_id: stubId,
      }),
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    // 2 × 2 × 3 = 12 cells
    expect(body.cells.length).toBe(12);
    const stub = store.getStub(stubId)!;
    expect(stub.tasks.length).toBe(12);
  });

  it("grid cells start as pending and have task_id linked", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/grids`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "link-test-grid",
        command_template: "echo {val}",
        parameters: { val: [1, 2] },
        stub_id: stubId,
      }),
    });

    const body: any = await res.json();
    const grid = store.getGrid(body.id)!;
    for (const cell of grid.cells) {
      expect(cell.task_id).toBeDefined();
    }
  });

  it("grid status transitions: pending → running when a cell is running", () => {
    const gridId = uuidv4();
    const cellId1 = uuidv4();
    const cellId2 = uuidv4();

    store.setGrid({
      id: gridId,
      name: "status-transition",
      command_template: "echo {x}",
      parameters: { x: [1, 2] },
      cells: [
        { id: cellId1, grid_id: gridId, params: { x: 1 }, status: "pending" },
        { id: cellId2, grid_id: gridId, params: { x: 2 }, status: "pending" },
      ],
      status: "pending",
      created_at: new Date().toISOString(),
    });

    store.updateGridCell(gridId, cellId1, { status: "running" });
    const grid = store.getGrid(gridId)!;
    expect(grid.status).toBe("running");
  });

  it("grid status transitions: all completed → completed", () => {
    const gridId = uuidv4();
    const cellId1 = uuidv4();
    const cellId2 = uuidv4();

    store.setGrid({
      id: gridId,
      name: "all-completed",
      command_template: "echo {x}",
      parameters: { x: [1, 2] },
      cells: [
        { id: cellId1, grid_id: gridId, params: { x: 1 }, status: "running" },
        { id: cellId2, grid_id: gridId, params: { x: 2 }, status: "running" },
      ],
      status: "running",
      created_at: new Date().toISOString(),
    });

    store.updateGridCell(gridId, cellId1, { status: "completed" });
    store.updateGridCell(gridId, cellId2, { status: "completed" });
    const grid = store.getGrid(gridId)!;
    expect(grid.status).toBe("completed");
  });

  it("grid status transitions: some failed, some completed → partial", () => {
    const gridId = uuidv4();
    const cellId1 = uuidv4();
    const cellId2 = uuidv4();

    store.setGrid({
      id: gridId,
      name: "partial-status",
      command_template: "echo {x}",
      parameters: { x: [1, 2] },
      cells: [
        { id: cellId1, grid_id: gridId, params: { x: 1 }, status: "running" },
        { id: cellId2, grid_id: gridId, params: { x: 2 }, status: "running" },
      ],
      status: "running",
      created_at: new Date().toISOString(),
    });

    store.updateGridCell(gridId, cellId1, { status: "completed" });
    store.updateGridCell(gridId, cellId2, { status: "failed" });
    const grid = store.getGrid(gridId)!;
    expect(grid.status).toBe("partial");
  });

  it("grid with stub_id assigns all tasks to that stub", async () => {
    // Create a second stub
    const stub2 = createMockStub({ status: "online" });
    store.setStub(stub2);

    const res = await fetch(`${ctx.baseUrl}/api/grids`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "stub-assigned-grid",
        command_template: "echo {x}",
        parameters: { x: [1, 2, 3] },
        stub_id: stub2.id,
      }),
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.stub_id).toBe(stub2.id);

    const targetStub = store.getStub(stub2.id)!;
    expect(targetStub.tasks.length).toBe(3);

    // Original stub should have no tasks from this grid
    const origStub = store.getStub(stubId)!;
    expect(origStub.tasks.length).toBe(0);
  });

  it("GET /grids/:id returns enriched cells with task status", async () => {
    const gridId = uuidv4();
    const cellId = uuidv4();
    const taskId = uuidv4();

    // Set up a stub with a running task
    const stub = store.getStub(stubId)!;
    stub.tasks.push({
      id: taskId,
      stub_id: stubId,
      command: "echo 1",
      status: "running",
      created_at: new Date().toISOString(),
      log_buffer: [],
      grid_id: gridId,
      grid_cell_id: cellId,
    });
    store.setStub(stub);

    store.setGrid({
      id: gridId,
      name: "enriched-grid",
      command_template: "echo {x}",
      parameters: { x: [1] },
      cells: [{ id: cellId, grid_id: gridId, params: { x: 1 }, status: "pending", task_id: taskId }],
      status: "running",
      created_at: new Date().toISOString(),
    });

    const res = await fetch(`${ctx.baseUrl}/api/grids/${gridId}`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.cells[0].status).toBe("running");
  });

  it("GET /grids returns all grids", async () => {
    store.setGrid({
      id: uuidv4(),
      name: "g1",
      command_template: "echo {x}",
      parameters: { x: [1] },
      cells: [],
      status: "pending",
      created_at: new Date().toISOString(),
    });
    store.setGrid({
      id: uuidv4(),
      name: "g2",
      command_template: "echo {y}",
      parameters: { y: [2] },
      cells: [],
      status: "pending",
      created_at: new Date().toISOString(),
    });

    const res = await fetch(`${ctx.baseUrl}/api/grids`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.length).toBe(2);
  });

  it("missing required fields returns 400", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/grids`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "incomplete-grid",
        // missing command_template and parameters
      }),
    });

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain("required");
  });

  it("parameters not object of arrays returns 400", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/grids`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "bad-params",
        command_template: "echo {x}",
        parameters: { x: 5 }, // not an array
      }),
    });

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain("arrays");
  });

  it("DELETE grid kills running tasks and removes grid", async () => {
    const gridId = uuidv4();
    const cellId = uuidv4();
    const taskId = uuidv4();

    const stub = store.getStub(stubId)!;
    stub.tasks.push({
      id: taskId,
      stub_id: stubId,
      command: "python long.py",
      status: "running",
      created_at: new Date().toISOString(),
      log_buffer: [],
      grid_id: gridId,
      grid_cell_id: cellId,
    });
    store.setStub(stub);

    store.setGrid({
      id: gridId,
      name: "deletable-grid",
      command_template: "python long.py",
      parameters: { x: [1] },
      cells: [{ id: cellId, grid_id: gridId, params: { x: 1 }, status: "running", task_id: taskId }],
      status: "running",
      created_at: new Date().toISOString(),
    });

    const res = await fetch(`${ctx.baseUrl}/api/grids/${gridId}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(store.getGrid(gridId)).toBeUndefined();
    // Task should be marked killed
    const updatedStub = store.getStub(stubId)!;
    const task = updatedStub.tasks.find((t) => t.id === taskId);
    expect(task?.status).toBe("killed");
  });

  it("POST retry-failed resubmits failed cells", async () => {
    const gridId = uuidv4();
    const cellId = uuidv4();
    const taskId = uuidv4();

    const stub = store.getStub(stubId)!;
    stub.tasks.push({
      id: taskId,
      stub_id: stubId,
      command: "python fail.py",
      status: "failed",
      created_at: new Date().toISOString(),
      log_buffer: [],
      grid_id: gridId,
      grid_cell_id: cellId,
    });
    store.setStub(stub);

    store.setGrid({
      id: gridId,
      name: "retry-grid",
      command_template: "python fail.py",
      parameters: { x: [1] },
      cells: [{ id: cellId, grid_id: gridId, params: { x: 1 }, status: "failed", task_id: taskId }],
      status: "partial",
      created_at: new Date().toISOString(),
      stub_id: stubId,
    });

    const res = await fetch(`${ctx.baseUrl}/api/grids/${gridId}/retry-failed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.retried).toBe(1);

    // A new task should have been created
    const updatedStub = store.getStub(stubId)!;
    expect(updatedStub.tasks.length).toBe(2); // old failed + new queued
  });
});
