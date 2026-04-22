import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { store } from "../store";
import { createTestServer, TestContext, createMockStub, createTestToken } from "./helpers/setup";
import { createTasksRouter, createGlobalTasksRouter } from "../api/tasks";
import { createGridsRouter } from "../api/grids";
import { setupStubNamespace } from "../socket/stub";
import { setupWebNamespace } from "../socket/web";
import { v4 as uuidv4 } from "uuid";
import express from "express";

describe("Conflict detection", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
    setupWebNamespace(ctx.webNs);
    setupStubNamespace(ctx.stubNs, ctx.webNs);

    // Mount API routers
    const api = express.Router();
    api.use("/stubs/:id/tasks", createTasksRouter(ctx.stubNs, ctx.webNs));
    api.use("/tasks", createGlobalTasksRouter(ctx.stubNs, ctx.webNs));
    api.use("/grids", createGridsRouter(ctx.stubNs, ctx.webNs));
    ctx.app.use("/api", api);

    // Create a token and stub
    createTestToken();
    const stub = createMockStub();
    store.setStub(stub);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  describe("Task run_dir conflict", () => {
    it("should reject task with same run_dir as completed task", async () => {
      const stub = store.getAllStubs()[0];

      // Add a completed task with run_dir
      stub.tasks.push({
        id: uuidv4(),
        stub_id: stub.id,
        command: "python train.py",
        status: "completed",
        created_at: new Date().toISOString(),
        log_buffer: [],
        run_dir: "/runs/experiment_1",
      });
      store.setStub(stub);

      // Try to create another task with same run_dir
      const res = await fetch(`${ctx.baseUrl}/api/stubs/${stub.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "python train.py --v2",
          run_dir: "/runs/experiment_1",
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain("completed task already exists");
      expect(body.hint).toBe("Use force: true to override");
    });

    it("should allow task with force: true", async () => {
      const stub = store.getAllStubs()[0];

      stub.tasks.push({
        id: uuidv4(),
        stub_id: stub.id,
        command: "python train.py",
        status: "completed",
        created_at: new Date().toISOString(),
        log_buffer: [],
        run_dir: "/runs/experiment_1",
      });
      store.setStub(stub);

      const res = await fetch(`${ctx.baseUrl}/api/stubs/${stub.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "python train.py --v2",
          run_dir: "/runs/experiment_1",
          force: true,
        }),
      });

      expect(res.status).toBe(201);
    });

    it("should allow task when run_dir doesn't conflict", async () => {
      const stub = store.getAllStubs()[0];

      const res = await fetch(`${ctx.baseUrl}/api/stubs/${stub.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "python train.py",
          run_dir: "/runs/new_experiment",
        }),
      });

      expect(res.status).toBe(201);
    });

    it("should also check in global POST /tasks", async () => {
      const stub = store.getAllStubs()[0];

      stub.tasks.push({
        id: uuidv4(),
        stub_id: stub.id,
        command: "python train.py",
        status: "completed",
        created_at: new Date().toISOString(),
        log_buffer: [],
        run_dir: "/runs/exp_global",
      });
      store.setStub(stub);

      const res = await fetch(`${ctx.baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "python train.py --v2",
          run_dir: "/runs/exp_global",
        }),
      });

      expect(res.status).toBe(409);
    });
  });

  describe("Grid name conflict", () => {
    it("should reject grid with same name as existing grid with completed cells", async () => {
      // Create an existing grid with a completed cell
      store.setGrid({
        id: uuidv4(),
        name: "ctx_ablation",
        command_template: "python train.py --ctx {ctx}",
        parameters: { ctx: [8, 16] },
        cells: [
          { id: uuidv4(), grid_id: "", params: { ctx: 8 }, status: "completed" },
          { id: uuidv4(), grid_id: "", params: { ctx: 16 }, status: "pending" },
        ],
        status: "partial",
        created_at: new Date().toISOString(),
      });

      const res = await fetch(`${ctx.baseUrl}/api/grids`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "ctx_ablation",
          command_template: "python train.py --ctx {ctx}",
          parameters: { ctx: [8, 16, 32] },
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.completed_count).toBe(1);
    });

    it("should allow grid with force: true", async () => {
      store.setGrid({
        id: uuidv4(),
        name: "ctx_ablation_force",
        command_template: "python train.py --ctx {ctx}",
        parameters: { ctx: [8] },
        cells: [
          { id: uuidv4(), grid_id: "", params: { ctx: 8 }, status: "completed" },
        ],
        status: "completed",
        created_at: new Date().toISOString(),
      });

      const res = await fetch(`${ctx.baseUrl}/api/grids`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "ctx_ablation_force",
          command_template: "python train.py --ctx {ctx}",
          parameters: { ctx: [8, 16] },
          force: true,
        }),
      });

      expect(res.status).toBe(201);
    });

    it("should allow grid with different name", async () => {
      const res = await fetch(`${ctx.baseUrl}/api/grids`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "new_grid",
          command_template: "python train.py --lr {lr}",
          parameters: { lr: [0.01, 0.001] },
        }),
      });

      expect(res.status).toBe(201);
    });
  });
});
