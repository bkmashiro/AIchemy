import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { store } from "../store";
import { createGlobalTasksRouter } from "../api/tasks";
import { Task } from "../types";

function makeApp(): ReturnType<typeof express> {
  const app = express();
  app.use(express.json());
  app.use("/tasks", createGlobalTasksRouter());
  return app;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Math.random().toString(36).slice(2, 10)}`,
    seq: store.nextSeq(),
    fingerprint: `fp-${Math.random().toString(36).slice(2, 10)}`,
    display_name: "test task",
    script: "train.py",
    command: "python train.py",
    status: "pending",
    priority: 5,
    created_at: new Date().toISOString(),
    log_buffer: [],
    retry_count: 0,
    max_retries: 0,
    should_stop: false,
    should_checkpoint: false,
    ...overrides,
  };
}

beforeEach(() => {
  store.reset();
});

describe("GET /tasks/inbox", () => {
  it("marks completed terminal task as unread_terminal", async () => {
    const app = makeApp();

    const task = makeTask({
      id: "task-completed-1",
      status: "completed",
      seq: 2,
      created_at: "2026-06-14T00:00:10.000Z",
    });
    store.addToGlobalQueue(task);

    const res = await request(app).get("/tasks/inbox");

    expect(res.status).toBe(200);
    expect(res.body.actor).toBe("akashi");
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      task_id: "task-completed-1",
      status: "completed",
      buckets: ["unread_terminal"],
      why_interesting: ["terminal_unread"],
    });
  });

  it("removes unread_terminal after POST /tasks/:id/read", async () => {
    const app = makeApp();

    const task = makeTask({ id: "task-completed-2", status: "completed", seq: 1 });
    store.addToGlobalQueue(task);

    const readRes = await request(app).post("/tasks/task-completed-2/read").send({});
    expect(readRes.status).toBe(200);

    const res = await request(app).get("/tasks/inbox");
    expect(res.status).toBe(200);
    const item = res.body.items.find((it: any) => it.task_id === "task-completed-2");
    expect(item).toBeUndefined();
  });

  it("keeps pinned bucket even after read", async () => {
    const app = makeApp();

    const task = makeTask({ id: "task-completed-3", status: "completed" });
    store.addToGlobalQueue(task);

    await request(app).post("/tasks/task-completed-3/read").send({});
    const pinRes = await request(app)
      .post("/tasks/task-completed-3/pin")
      .send({ pinned: true, note: "focus" });

    expect(pinRes.status).toBe(200);
    expect(pinRes.body.pinned).toBe(true);

    const res = await request(app).get("/tasks/inbox");
    const item = res.body.items.find((it: any) => it.task_id === "task-completed-3");
    expect(item).toBeDefined();
    expect(item.buckets).toContain("pinned");
    expect(item.why_interesting).toContain("pinned");
  });

  it("keeps actor-specific unread state", async () => {
    const app = makeApp();

    const task = makeTask({ id: "task-completed-4", status: "completed" });
    store.addToGlobalQueue(task);

    const readAkashi = await request(app).post("/tasks/task-completed-4/read").send({});
    expect(readAkashi.status).toBe(200);

    const akashiRes = await request(app).get("/tasks/inbox").query({ actor: "akashi" });
    const akashiItem = akashiRes.body.items.find((it: any) => it.task_id === "task-completed-4");
    expect(akashiItem).toBeUndefined();

    const yuzheRes = await request(app).get("/tasks/inbox").query({ actor: "yuzhe" });
    const yuzheItem = yuzheRes.body.items.find((it: any) => it.task_id === "task-completed-4");
    expect(yuzheItem).toBeDefined();
    expect(yuzheItem.buckets).toContain("unread_terminal");
  });

  it("includes blocked tasks in blocked_needs_decision bucket", async () => {
    const app = makeApp();

    const blocked = makeTask({
      id: "task-blocked-1",
      status: "blocked",
      name: "blocked-job",
      seq: 5,
    });
    store.addToGlobalQueue(blocked);

    const res = await request(app).get("/tasks/inbox").query({ bucket: "blocked_needs_decision" });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item.task_id).toBe("task-blocked-1");
    expect(item.buckets).toContain("blocked_needs_decision");
    expect(item.why_interesting).toContain("blocked");
  });

  it("includes quoted command shortcuts for run_dir tasks", async () => {
    const app = makeApp();

    const runTask = makeTask({
      id: "task-run-dir-1",
      status: "completed",
      run_dir: "/cluster/results/task-run-dir-1",
    });
    store.addToGlobalQueue(runTask);

    const res = await request(app).get("/tasks/inbox");
    const item = res.body.items.find((it: any) => it.task_id === "task-run-dir-1");

    expect(item.commands).toEqual([
      "alch tasks get 'task-run-dir-1'",
      "alch tasks logs 'task-run-dir-1' --tail 200",
      "ls -la '/cluster/results/task-run-dir-1'",
    ]);
  });

  it("does not include non-interesting pending/running tasks in default inbox", async () => {
    const app = makeApp();

    const interesting = makeTask({
      id: "task-completed-5",
      status: "completed",
      seq: 2,
      created_at: "2026-06-14T00:00:20.000Z",
    });
    const ordinary = makeTask({
      id: "task-running-ordinary",
      status: "running",
      seq: 1,
      created_at: "2026-06-14T00:00:10.000Z",
      disconnected_at: undefined,
    });

    store.addToGlobalQueue(interesting);
    store.addToGlobalQueue(ordinary);

    const res = await request(app).get("/tasks/inbox");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const ordinaryItem = res.body.items.find((it: any) => it.task_id === "task-running-ordinary");
    expect(ordinaryItem).toBeUndefined();
    const interestingItem = res.body.items.find((it: any) => it.task_id === "task-completed-5");
    expect(interestingItem).toBeDefined();
    expect(interestingItem.buckets).toContain("unread_terminal");
  });

  it("returns 404 for read on missing task", async () => {
    const app = makeApp();

    const res = await request(app).post("/tasks/missing-task/read").send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Task not found");
  });

  it("returns 404 for pin on missing task", async () => {
    const app = makeApp();

    const res = await request(app).post("/tasks/missing-task/pin").send({ pinned: true });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Task not found");
  });

  it("returns 404 for ack on missing task", async () => {
    const app = makeApp();

    const res = await request(app).post("/tasks/missing-task/ack").send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Task not found");
  });

  it("returns 404 for watch on missing task", async () => {
    const app = makeApp();

    const res = await request(app).post("/tasks/missing-task/watch").send({ watched: true });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Task not found");
  });
});
