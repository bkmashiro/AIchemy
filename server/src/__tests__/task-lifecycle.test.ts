import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { store } from "../store";
import { createTestServer, TestContext, createMockStub, createTestToken, connectStubClient } from "./helpers/setup";
import { createTasksRouter } from "../api/tasks";
import { setupStubNamespace } from "../socket/stub";
import { setupWebNamespace } from "../socket/web";
import { v4 as uuidv4 } from "uuid";
import express from "express";
import { Task } from "../types";

describe("Task lifecycle", () => {
  let ctx: TestContext;
  let stubId: string;

  function makeTask(overrides: Partial<Task> = {}): Task {
    return {
      id: uuidv4(),
      stub_id: stubId,
      command: "python train.py",
      status: "queued",
      created_at: new Date().toISOString(),
      log_buffer: [],
      ...overrides,
    };
  }

  beforeEach(async () => {
    ctx = await createTestServer();
    setupWebNamespace(ctx.webNs);
    setupStubNamespace(ctx.stubNs, ctx.webNs);

    const api = express.Router();
    api.use("/stubs/:id/tasks", createTasksRouter(ctx.stubNs, ctx.webNs));
    ctx.app.use("/api", api);

    createTestToken();
    const stub = createMockStub({ max_concurrent: 3 });
    store.setStub(stub);
    stubId = stub.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // --- Pause / Resume ---

  it("PATCH pause: running task → paused", async () => {
    const task = makeTask({ status: "running" });
    const stub = store.getStub(stubId)!;
    stub.tasks.push(task);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/stubs/${stubId}/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.status).toBe("paused");
    expect(store.getTask(stubId, task.id)?.status).toBe("paused");
  });

  it("PATCH pause: non-running task returns 400", async () => {
    const task = makeTask({ status: "queued" });
    const stub = store.getStub(stubId)!;
    stub.tasks.push(task);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/stubs/${stubId}/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    });

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain("not running");
  });

  it("PATCH resume: paused task → running", async () => {
    const task = makeTask({ status: "paused" });
    const stub = store.getStub(stubId)!;
    stub.tasks.push(task);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/stubs/${stubId}/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume" }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.status).toBe("running");
  });

  it("PATCH resume: non-paused task returns 400", async () => {
    const task = makeTask({ status: "queued" });
    const stub = store.getStub(stubId)!;
    stub.tasks.push(task);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/stubs/${stubId}/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume" }),
    });

    expect(res.status).toBe(400);
  });

  // --- Kill ---

  it("PATCH kill: queued task → killed immediately, no stub signal needed", async () => {
    const task = makeTask({ status: "queued" });
    const stub = store.getStub(stubId)!;
    stub.tasks.push(task);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/stubs/${stubId}/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "kill" }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.status).toBe("killed");
    expect(body.finished_at).toBeDefined();
    expect(store.getTask(stubId, task.id)?.status).toBe("killed");
  });

  it("PATCH kill: running task → killed", async () => {
    const task = makeTask({ status: "running", pid: 99999 });
    const stub = store.getStub(stubId)!;
    stub.tasks.push(task);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/stubs/${stubId}/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "kill" }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.status).toBe("killed");
    expect(body.finished_at).toBeDefined();
  });

  it("PATCH kill: completed task returns 400", async () => {
    const task = makeTask({ status: "completed" });
    const stub = store.getStub(stubId)!;
    stub.tasks.push(task);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/stubs/${stubId}/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "kill" }),
    });

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain("cannot be killed");
  });

  it("PATCH unknown action returns 400", async () => {
    const task = makeTask({ status: "running" });
    const stub = store.getStub(stubId)!;
    stub.tasks.push(task);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/stubs/${stubId}/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "teleport" }),
    });

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain("Unknown action");
  });

  // --- POST kill convenience endpoint ---

  it("POST /:tid/kill kills queued task", async () => {
    const task = makeTask({ status: "queued" });
    const stub = store.getStub(stubId)!;
    stub.tasks.push(task);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/stubs/${stubId}/tasks/${task.id}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.status).toBe("killed");
  });

  it("POST /:tid/kill fails if task already completed", async () => {
    const task = makeTask({ status: "completed" });
    const stub = store.getStub(stubId)!;
    stub.tasks.push(task);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/stubs/${stubId}/tasks/${task.id}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  // --- DELETE ---

  it("DELETE queued task removes it from stub", async () => {
    const task = makeTask({ status: "queued" });
    const stub = store.getStub(stubId)!;
    stub.tasks.push(task);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/stubs/${stubId}/tasks/${task.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);

    const updatedStub = store.getStub(stubId)!;
    expect(updatedStub.tasks.find((t) => t.id === task.id)).toBeUndefined();
  });

  it("DELETE running task sends kill signal and removes it", async () => {
    const task = makeTask({ status: "running", pid: 11111 });
    const stub = store.getStub(stubId)!;
    stub.tasks.push(task);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/stubs/${stubId}/tasks/${task.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const updatedStub = store.getStub(stubId)!;
    expect(updatedStub.tasks.find((t) => t.id === task.id)).toBeUndefined();
  });

  it("DELETE non-existent task returns 404", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/stubs/${stubId}/tasks/${uuidv4()}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
  });

  // --- estimated_vram_mb ---

  it("task created with estimated_vram_mb stores the field", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/stubs/${stubId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "python train.py",
        estimated_vram_mb: 16384,
      }),
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.estimated_vram_mb).toBe(16384);
  });

  // --- Error cases ---

  it("POST task without command returns 400", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/stubs/${stubId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp" }),
    });

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain("command required");
  });

  it("GET tasks returns task list", async () => {
    const task = makeTask({ status: "queued" });
    const stub = store.getStub(stubId)!;
    stub.tasks.push(task);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/stubs/${stubId}/tasks`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].id).toBe(task.id);
  });

  it("GET task logs returns log_buffer", async () => {
    const task = makeTask({ status: "running", log_buffer: ["line 1", "line 2"] });
    const stub = store.getStub(stubId)!;
    stub.tasks.push(task);
    store.setStub(stub);

    const res = await fetch(`${ctx.baseUrl}/api/stubs/${stubId}/tasks/${task.id}/logs`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.lines).toEqual(["line 1", "line 2"]);
    expect(body.task_id).toBe(task.id);
  });
});
