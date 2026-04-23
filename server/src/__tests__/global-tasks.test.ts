import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { store } from "../store";
import { createTestServer, TestContext, createMockStub, createTestToken } from "./helpers/setup";
import { createGlobalTasksRouter } from "../api/tasks";
import { setupStubNamespace } from "../socket/stub";
import { setupWebNamespace } from "../socket/web";
import { v4 as uuidv4 } from "uuid";
import express from "express";
import { Task } from "../types";

describe("Global tasks API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
    setupWebNamespace(ctx.webNs);
    setupStubNamespace(ctx.stubNs, ctx.webNs);

    const api = express.Router();
    api.use("/tasks", createGlobalTasksRouter(ctx.stubNs, ctx.webNs));
    ctx.app.use("/api", api);

    createTestToken();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("GET /tasks returns empty array when no tasks", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/tasks`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  it("GET /tasks returns all tasks across all stubs", async () => {
    const stub1 = createMockStub({ status: "online" });
    const stub2 = createMockStub({ status: "online" });

    stub1.tasks.push({
      id: uuidv4(),
      stub_id: stub1.id,
      command: "python A.py",
      status: "running",
      created_at: new Date().toISOString(),
      log_buffer: [],
    });

    stub2.tasks.push({
      id: uuidv4(),
      stub_id: stub2.id,
      command: "python B.py",
      status: "queued",
      created_at: new Date().toISOString(),
      log_buffer: [],
    });
    stub2.tasks.push({
      id: uuidv4(),
      stub_id: stub2.id,
      command: "python C.py",
      status: "completed",
      created_at: new Date().toISOString(),
      log_buffer: [],
    });

    store.setStub(stub1);
    store.setStub(stub2);

    const res = await fetch(`${ctx.baseUrl}/api/tasks`);
    const body: any = await res.json();
    expect(body.length).toBe(3);
  });

  it("POST /tasks dispatches to online stub when available", async () => {
    const stub = createMockStub({ status: "online" });
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "python train.py" }),
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    // Task is immediately dispatched to the online stub
    expect(body.stub_id).toBe(stub.id);
    // Status is dispatched or queued depending on timing
    expect(["queued", "dispatched"]).toContain(body.status);

    // Verify it was added to the stub
    const updatedStub = store.getStub(stub.id)!;
    expect(updatedStub.tasks.length).toBe(1);
  });

  it("POST /tasks queues globally when no online stubs available", async () => {
    // Only offline stub — task should go to global queue
    const stub = createMockStub({ status: "offline" });
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "python train.py" }),
    });

    // Task is added to global queue (not 503)
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.stub_id).toBe(""); // no stub assigned yet
    expect(body.status).toBe("queued");
  });

  it("POST /tasks queues globally when no stubs at all", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "python train.py" }),
    });

    // Task goes to global queue, returns 201
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.stub_id).toBe("");
    expect(body.status).toBe("queued");
  });

  it("POST /tasks returns 400 when command missing", async () => {
    const stub = createMockStub({ status: "online" });
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp" }),
    });

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain("command required");
  });

  it("POST /tasks auto-selects stub with most free slots", async () => {
    const busyStub = createMockStub({ status: "online" });
    busyStub.tasks.push(
      { id: uuidv4(), stub_id: busyStub.id, command: "cmd", status: "running", created_at: new Date().toISOString(), log_buffer: [] },
      { id: uuidv4(), stub_id: busyStub.id, command: "cmd", status: "running", created_at: new Date().toISOString(), log_buffer: [] },
    );

    const idleStub = createMockStub({ status: "online" });
    store.setStub(busyStub);
    store.setStub(idleStub);

    const res = await fetch(`${ctx.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "python new.py" }),
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.stub_id).toBe(idleStub.id);
  });

  it("POST /tasks: run_dir conflict returns 409", async () => {
    const stub = createMockStub({ status: "online" });
    stub.tasks.push({
      id: uuidv4(),
      stub_id: stub.id,
      command: "python old.py",
      status: "completed",
      created_at: new Date().toISOString(),
      log_buffer: [],
      run_dir: "/runs/conflict",
    });
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "python new.py",
        run_dir: "/runs/conflict",
      }),
    });

    expect(res.status).toBe(409);
  });

  it("POST /tasks: waiting status when depends_on unmet", async () => {
    const stub = createMockStub({ status: "online" });
    const depTask: Task = {
      id: uuidv4(),
      stub_id: stub.id,
      command: "python dep.py",
      status: "running",
      created_at: new Date().toISOString(),
      log_buffer: [],
    };
    stub.tasks.push(depTask);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "python downstream.py",
        depends_on: [depTask.id],
      }),
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.status).toBe("waiting");
  });
});
