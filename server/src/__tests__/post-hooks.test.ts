import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { store } from "../store";
import { createTestServer, TestContext, createMockStub, createTestToken, connectStubClient } from "./helpers/setup";
import { setupStubNamespace } from "../socket/stub";
import { setupWebNamespace } from "../socket/web";
import { v4 as uuidv4 } from "uuid";
import { Task } from "../types";

/**
 * Register a stub client, return { client, stubId }.
 */
async function registerStub(
  port: number,
  token: string,
  hostname = "hook-host"
): Promise<{ client: ReturnType<typeof connectStubClient>; stubId: string }> {
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

describe("Post-hooks", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
    setupWebNamespace(ctx.webNs);
    setupStubNamespace(ctx.stubNs, ctx.webNs);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("successful post-hook keeps task as 'completed'", async () => {
    const token = createTestToken();
    const { client, stubId } = await registerStub(ctx.port, token.token);

    const taskId = uuidv4();
    const stub = store.getStub(stubId)!;
    const task: Task = {
      id: taskId,
      stub_id: stubId,
      command: "python train.py",
      status: "running",
      created_at: new Date().toISOString(),
      log_buffer: [],
      run_dir: "/runs/exp1",
      post_hooks: ["echo done"],
    };
    stub.tasks.push(task);
    store.setStub(stub);

    // Respond to shell.exec from the post-hook with success
    client.on("shell.exec", (payload: any) => {
      client.emit("shell.result", {
        id: payload.id,
        stdout: "done",
        stderr: "",
        exit_code: 0,
        timed_out: false,
      });
    });

    // Signal task completion
    client.emit("task.completed", { task_id: taskId, exit_code: 0 });

    // Wait for post-hook to run
    await new Promise((r) => setTimeout(r, 500));

    const updatedTask = store.getTask(stubId, taskId);
    // Post-hook succeeded → status stays "completed"
    expect(updatedTask?.status).toBe("completed");

    client.disconnect();
  });

  it("failed post-hook sets status to 'completed_with_errors'", async () => {
    const token = createTestToken();
    const { client, stubId } = await registerStub(ctx.port, token.token, "fail-hook-host");

    const taskId = uuidv4();
    const stub = store.getStub(stubId)!;
    const task: Task = {
      id: taskId,
      stub_id: stubId,
      command: "python train.py",
      status: "running",
      created_at: new Date().toISOString(),
      log_buffer: [],
      run_dir: "/runs/exp2",
      post_hooks: ["exit 1"],
    };
    stub.tasks.push(task);
    store.setStub(stub);

    // Respond to shell.exec with failure
    client.on("shell.exec", (payload: any) => {
      client.emit("shell.result", {
        id: payload.id,
        stdout: "",
        stderr: "error",
        exit_code: 1,
        timed_out: false,
      });
    });

    client.emit("task.completed", { task_id: taskId, exit_code: 0 });

    await new Promise((r) => setTimeout(r, 500));

    const updatedTask = store.getTask(stubId, taskId);
    expect(updatedTask?.status).toBe("completed_with_errors");

    client.disconnect();
  });

  it("variable substitution in post-hooks replaces {run_dir}, {task_id}, {stub_id}", async () => {
    const token = createTestToken();
    const { client, stubId } = await registerStub(ctx.port, token.token, "var-sub-host");

    const taskId = uuidv4();
    const stub = store.getStub(stubId)!;
    const runDir = "/runs/var_test";
    const task: Task = {
      id: taskId,
      stub_id: stubId,
      command: "python train.py",
      status: "running",
      created_at: new Date().toISOString(),
      log_buffer: [],
      run_dir: runDir,
      post_hooks: ["echo {run_dir} {task_id} {stub_id}"],
    };
    stub.tasks.push(task);
    store.setStub(stub);

    const receivedCommands: string[] = [];

    client.on("shell.exec", (payload: any) => {
      receivedCommands.push(payload.command);
      client.emit("shell.result", {
        id: payload.id,
        stdout: "ok",
        stderr: "",
        exit_code: 0,
        timed_out: false,
      });
    });

    client.emit("task.completed", { task_id: taskId, exit_code: 0 });

    await new Promise((r) => setTimeout(r, 500));

    expect(receivedCommands.length).toBe(1);
    expect(receivedCommands[0]).toContain(runDir);
    expect(receivedCommands[0]).toContain(taskId);
    expect(receivedCommands[0]).toContain(stubId);

    client.disconnect();
  });

  it("task without post_hooks completes normally", async () => {
    const token = createTestToken();
    const { client, stubId } = await registerStub(ctx.port, token.token, "no-hook-host");

    const taskId = uuidv4();
    const stub = store.getStub(stubId)!;
    const task: Task = {
      id: taskId,
      stub_id: stubId,
      command: "python quick.py",
      status: "running",
      created_at: new Date().toISOString(),
      log_buffer: [],
      post_hooks: [],
    };
    stub.tasks.push(task);
    store.setStub(stub);

    let shellExecCalled = false;
    client.on("shell.exec", () => { shellExecCalled = true; });

    client.emit("task.completed", { task_id: taskId, exit_code: 0 });
    await new Promise((r) => setTimeout(r, 200));

    const updatedTask = store.getTask(stubId, taskId);
    expect(updatedTask?.status).toBe("completed");
    expect(shellExecCalled).toBe(false);

    client.disconnect();
  });

  it("multiple post-hooks run in sequence; stops at first failure", async () => {
    const token = createTestToken();
    const { client, stubId } = await registerStub(ctx.port, token.token, "multi-hook-host");

    const taskId = uuidv4();
    const stub = store.getStub(stubId)!;
    const task: Task = {
      id: taskId,
      stub_id: stubId,
      command: "python train.py",
      status: "running",
      created_at: new Date().toISOString(),
      log_buffer: [],
      post_hooks: ["hook1", "hook2", "hook3"],
    };
    stub.tasks.push(task);
    store.setStub(stub);

    const executedHooks: string[] = [];
    let callCount = 0;

    client.on("shell.exec", (payload: any) => {
      executedHooks.push(payload.command);
      callCount++;
      // Second hook fails
      const exitCode = callCount === 2 ? 1 : 0;
      client.emit("shell.result", {
        id: payload.id,
        stdout: exitCode === 0 ? "ok" : "",
        stderr: exitCode !== 0 ? "fail" : "",
        exit_code: exitCode,
        timed_out: false,
      });
    });

    client.emit("task.completed", { task_id: taskId, exit_code: 0 });
    await new Promise((r) => setTimeout(r, 700));

    // Should stop at second hook
    expect(executedHooks.length).toBe(2);
    expect(executedHooks[0]).toBe("hook1");
    expect(executedHooks[1]).toBe("hook2");
    // hook3 should NOT run

    const updatedTask = store.getTask(stubId, taskId);
    expect(updatedTask?.status).toBe("completed_with_errors");

    client.disconnect();
  });
});
