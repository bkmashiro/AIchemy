import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { store } from "../store";
import { Task } from "../types";
import { createWebhooksRouter } from "../api/webhooks";
import { completeTask } from "../task-actions";
import { deliverTaskStatusWebhooks, startWebhookDispatcher } from "../webhooks";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    seq: 1,
    fingerprint: "fp-1",
    display_name: "train.py",
    script: "train.py",
    command: "python train.py",
    status: "running",
    priority: 5,
    created_at: "2026-06-08T00:00:00.000Z",
    log_buffer: ["line"],
    retry_count: 0,
    max_retries: 0,
    should_stop: false,
    should_checkpoint: false,
    ...overrides,
  };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/webhooks", createWebhooksRouter());
  return app;
}

function makeStub() {
  return {
    id: "stub-1",
    name: "stub-1",
    hostname: "node-1",
    gpu: { name: "A30", vram_total_mb: 24576, count: 1 },
    status: "online" as const,
    type: "slurm" as const,
    connected_at: "2026-06-08T00:00:00.000Z",
    last_heartbeat: "2026-06-08T00:00:00.000Z",
    max_concurrent: 1,
    tasks: [makeTask({ status: "running", stub_id: "stub-1" })],
  };
}

beforeEach(() => {
  store.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-08T12:00:00.000Z"));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: vi.fn().mockResolvedValue("ok") }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("webhook subscriptions", () => {
  it("dispatches from real store task terminal transitions", async () => {
    startWebhookDispatcher();
    store.addWebhookSubscription({ name: "done", url: "https://example.test/hook", events: ["task.completed"] });
    store.setStub(makeStub());

    completeTask("stub-1", "task-1", 0);
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(vi.mocked(global.fetch).mock.calls[0][1]?.body));
    expect(body.event).toBe("task.completed");
    expect(body.task.id).toBe("task-1");
  });

  it("posts task.completed payload to matching enabled subscriptions", async () => {
    const sub = store.addWebhookSubscription({
      name: "hermes-terminal",
      url: "https://hermes.example/webhook/alchemy",
      events: ["task.completed"],
      secret: "shh",
    });

    await deliverTaskStatusWebhooks(makeTask({ status: "running" }), makeTask({ status: "completed", exit_code: 0, finished_at: "2026-06-08T12:00:00.000Z" }));

    const fetchMock = vi.mocked(global.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hermes.example/webhook/alchemy");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Alchemy-Event"]).toBe("task.completed");
    expect(headers["X-Alchemy-Delivery"]).toMatch(new RegExp(`^${sub.id}:task-1:task.completed:`));
    expect(headers["X-Alchemy-Signature-256"]).toMatch(/^sha256=/);
    expect(headers["X-Hub-Signature-256"]).toBe(headers["X-Alchemy-Signature-256"]);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      event: "task.completed",
      previous_status: "running",
      task: { id: "task-1", status: "completed", exit_code: 0 },
      subscription: { id: sub.id, name: "hermes-terminal" },
    });
    expect(body.task.log_buffer).toBeUndefined();
  });

  it("posts task.terminal subscriptions for failed and cancelled tasks", async () => {
    store.addWebhookSubscription({ name: "terminal", url: "https://example.test/hook", events: ["task.terminal"] });

    await deliverTaskStatusWebhooks(makeTask({ status: "running" }), makeTask({ status: "failed", exit_code: 2 }));
    await deliverTaskStatusWebhooks(makeTask({ status: "running" }), makeTask({ status: "cancelled" }));

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not post for non-terminal or disabled subscriptions", async () => {
    store.addWebhookSubscription({ name: "done", url: "https://example.test/hook", events: ["task.completed"] });
    store.addWebhookSubscription({ name: "disabled", url: "https://example.test/hook2", events: ["task.failed"], enabled: false });

    await deliverTaskStatusWebhooks(makeTask({ status: "pending" }), makeTask({ status: "running" }));
    await deliverTaskStatusWebhooks(makeTask({ status: "running" }), makeTask({ status: "failed" }));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("provides CRUD API for subscriptions", async () => {
    const app = makeApp();

    const created = await request(app)
      .post("/webhooks")
      .send({ name: "hermes-terminal", url: "https://hermes.example/webhook/alchemy", events: ["task.failed", "task.completed"], secret: "shh" })
      .expect(201);

    expect(created.body).toMatchObject({ name: "hermes-terminal", url: "https://hermes.example/webhook/alchemy", events: ["task.failed", "task.completed"], enabled: true });
    expect(created.body.secret).toBeUndefined();

    const listed = await request(app).get("/webhooks").expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].secret).toBeUndefined();

    await request(app).post(`/webhooks/${created.body.id}/test`).send({ task: makeTask({ status: "failed" }) }).expect(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await request(app).delete(`/webhooks/${created.body.id}`).expect(200);
    expect(store.listWebhookSubscriptions()).toHaveLength(0);
  });

  it("rejects invalid webhook events and urls", async () => {
    const app = makeApp();
    await request(app).post("/webhooks").send({ name: "bad", url: "file:///tmp/hook", events: ["task.failed"] }).expect(400);
    await request(app).post("/webhooks").send({ name: "bad", url: "https://example.test", events: ["task.started"] }).expect(400);
  });
});
