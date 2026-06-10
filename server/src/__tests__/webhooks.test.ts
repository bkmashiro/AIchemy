import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { store } from "../store";
import { Task } from "../types";
import { createWebhooksRouter } from "../api/webhooks";
import { completeTask } from "../task-actions";
import { deliverTaskStatusWebhooks, processWebhookOutbox, startWebhookDispatcher } from "../webhooks";

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

  it("records successful webhook deliveries for later inspection", async () => {
    const sub = store.addWebhookSubscription({
      name: "hermes-terminal",
      url: "https://hermes.example/webhook/alchemy",
      events: ["task.completed"],
    });

    await deliverTaskStatusWebhooks(
      makeTask({ status: "running" }),
      makeTask({ status: "completed", exit_code: 0 }),
    );

    const deliveries = store.listWebhookDeliveries(sub.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      subscription_id: sub.id,
      subscription_name: "hermes-terminal",
      event: "task.completed",
      task_id: "task-1",
      status: "success",
      http_status: 200,
    });
    expect(deliveries[0].error).toBeUndefined();
    expect(deliveries[0].delivery_id).toMatch(new RegExp(`^${sub.id}:task-1:task.completed:`));
    expect(deliveries[0].delivered_at).toBe("2026-06-08T12:00:00.000Z");
  });

  it("records failed webhook deliveries without leaking payloads", async () => {
    const leakedBody = "bad token secret-ish body";
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue(leakedBody),
    } as any);
    const sub = store.addWebhookSubscription({
      name: "broken",
      url: "https://hermes.example/webhook/alchemy",
      events: ["task.failed"],
    });

    await deliverTaskStatusWebhooks(
      makeTask({ status: "running" }),
      makeTask({ status: "failed", exit_code: 1, log_buffer: ["Traceback"] }),
    );

    const deliveries = store.listWebhookDeliveries(sub.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      subscription_id: sub.id,
      event: "task.failed",
      task_id: "task-1",
      status: "failed",
      http_status: 500,
    });
    expect(deliveries[0].error).toBe("HTTP 500");
    expect(JSON.stringify(deliveries[0])).not.toContain("Traceback");
    expect(JSON.stringify(deliveries[0])).not.toContain(leakedBody);

    const outboxEntries = store.listWebhookDeliveryOutbox();
    expect(outboxEntries).toHaveLength(1);
    expect(outboxEntries[0]).toMatchObject({
      subscription_id: sub.id,
      event: "task.failed",
      task_id: "task-1",
      attempt_count: 1,
      status: "pending",
    });
    expect(outboxEntries[0].last_error).toBe("HTTP 500");
    expect(JSON.stringify(outboxEntries[0])).not.toContain("Traceback");
    expect(JSON.stringify(outboxEntries[0])).not.toContain(leakedBody);
  });

  it("enqueues failed webhook deliveries for retry and clears on success", async () => {
    startWebhookDispatcher();
    vi.mocked(global.fetch)
      .mockResolvedValueOnce({ ok: false, status: 503, text: vi.fn().mockResolvedValue("temporary outage") } as any)
      .mockResolvedValueOnce({ ok: true, status: 200, text: vi.fn().mockResolvedValue("ok") } as any);

    const sub = store.addWebhookSubscription({
      name: "flaky",
      url: "https://hermes.example/webhook/alchemy",
      events: ["task.failed"],
    });

    const failedTask = makeTask({ status: "failed", exit_code: 1, stub_id: "stub-1" });
    store.setStub({ ...makeStub(), tasks: [failedTask] });

    await deliverTaskStatusWebhooks(
      makeTask({ status: "running" }),
      failedTask,
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const queued = store.listWebhookDeliveryOutbox();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      subscription_id: sub.id,
      event: "task.failed",
      task_id: "task-1",
      status: "pending",
      attempt_count: 1,
    });

    vi.advanceTimersByTime(700);
    await processWebhookOutbox();

    expect(global.fetch).toHaveBeenCalledTimes(2);

    const deliveries = store.listWebhookDeliveries(sub.id);
    expect(deliveries).toHaveLength(2);
    const latest = deliveries.find((delivery) => delivery.status === "success");
    expect(latest).toMatchObject({ status: "success", event: "task.failed", task_id: "task-1" });

    await vi.waitFor(() => expect(store.listWebhookDeliveryOutbox()).toHaveLength(0));
  });

  it("does not post for non-terminal or disabled subscriptions", async () => {
    store.addWebhookSubscription({ name: "done", url: "https://example.test/hook", events: ["task.completed"] });
    store.addWebhookSubscription({ name: "disabled", url: "https://example.test/hook2", events: ["task.failed"], enabled: false });

    await deliverTaskStatusWebhooks(makeTask({ status: "pending" }), makeTask({ status: "running" }));
    await deliverTaskStatusWebhooks(makeTask({ status: "running" }), makeTask({ status: "failed" }));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("includes human-readable summary, commands, and diagnosis for completed terminal task webhooks", async () => {
    store.addWebhookSubscription({
      name: "hermes-terminal",
      url: "https://hermes.example/webhook/alchemy",
      events: ["task.completed"],
    });

    await deliverTaskStatusWebhooks(
      makeTask({ status: "running" }),
      makeTask({
        status: "completed",
        exit_code: 0,
        log_buffer: ["training step 1", "training step 2", "done"],
      }),
    );

    const fetchMock = vi.mocked(global.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));

    expect(body.summary).toBe("✅ Alchemy task completed: train.py (task-1)");
    expect(body.diagnosis).toEqual({
      category: "success",
      severity: "info",
      reason: expect.any(String),
    });
    expect(body.commands).toEqual([
      "alch tasks get 'task-1'",
      "alch tasks logs 'task-1' --tail 200",
    ]);
    expect(body.task.log_tail).toEqual(["training step 1", "training step 2", "done"]);
  });

  it("includes code_error diagnosis and useful commands when tracebacks appear", async () => {
    store.addWebhookSubscription({
      name: "hermes-terminal",
      url: "https://hermes.example/webhook/alchemy",
      events: ["task.failed"],
    });

    await deliverTaskStatusWebhooks(
      makeTask({ status: "running" }),
      makeTask({
        status: "failed",
        exit_code: 1,
        run_dir: "/cluster/results/task-1",
        log_buffer: [
          "Traceback (most recent call last):",
          "  File \"train.py\", line 10, in <module>",
          "    raise RuntimeError('bad')",
        ],
      }),
    );

    const fetchMock = vi.mocked(global.fetch);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));

    expect(body.summary).toBe("❌ Alchemy task failed: train.py (task-1) exit_code=1");
    expect(body.diagnosis).toMatchObject({
      category: "code_error",
      severity: "error",
      reason: expect.stringContaining("traceback"),
    });
    expect(body.commands).toEqual([
      "alch tasks get 'task-1'",
      "alch tasks logs 'task-1' --tail 200",
      "ls -la '/cluster/results/task-1'",
    ]);
  });

  it("shell-quotes task ids and run directories in suggested commands", async () => {
    store.addWebhookSubscription({
      name: "hermes-terminal",
      url: "https://hermes.example/webhook/alchemy",
      events: ["task.failed"],
    });

    await deliverTaskStatusWebhooks(
      makeTask({ status: "running" }),
      makeTask({
        id: "task'$(bad)",
        status: "failed",
        exit_code: -15,
        run_dir: "/cluster/results/a'$(rm -rf x)",
        log_buffer: ["received SIGTERM"],
      }),
    );

    const fetchMock = vi.mocked(global.fetch);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));

    expect(body.diagnosis.category).toBe("slurm_or_termination");
    expect(body.commands).toEqual([
      "alch tasks get 'task'\"'\"'$(bad)'",
      "alch tasks logs 'task'\"'\"'$(bad)' --tail 200",
      "ls -la '/cluster/results/a'\"'\"'$(rm -rf x)'",
    ]);
  });

  it("includes summary, commands, and diagnosis in webhook test endpoint deliveries", async () => {
    const app = makeApp();

    const created = await request(app)
      .post("/webhooks")
      .send({ name: "test-delivery", url: "https://hermes.example/webhook/alchemy", events: ["task.completed", "task.failed"], secret: "shh" })
      .expect(201);

    await request(app)
      .post(`/webhooks/${created.body.id}/test`)
      .send({
        event: "task.failed",
        task: makeTask({
          id: "task-1",
          status: "failed",
          exit_code: 42,
          log_buffer: ["Traceback (most recent call last):", "Oops"],
        }),
      })
      .expect(200);

    const fetchMock = vi.mocked(global.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));

    expect(body.summary).toBe("❌ Alchemy task failed: train.py (task-1) exit_code=42");
    expect(body.diagnosis).toMatchObject({
      category: "code_error",
      severity: "error",
      reason: expect.stringContaining("traceback"),
    });
    expect(body.commands).toEqual([
      "alch tasks get 'task-1'",
      "alch tasks logs 'task-1' --tail 200",
    ]);
  });

  it("lists delivery history through the API", async () => {
    const app = makeApp();
    const created = await request(app)
      .post("/webhooks")
      .send({ name: "history", url: "https://hermes.example/webhook/alchemy", events: ["task.completed"] })
      .expect(201);

    await deliverTaskStatusWebhooks(makeTask({ status: "running" }), makeTask({ status: "completed", exit_code: 0 }));

    const res = await request(app)
      .get(`/webhooks/${created.body.id}/deliveries?limit=5`)
      .expect(200);

    expect(res.body.deliveries).toHaveLength(1);
    expect(res.body.deliveries[0]).toMatchObject({
      subscription_id: created.body.id,
      subscription_name: "history",
      event: "task.completed",
      task_id: "task-1",
      status: "success",
    });
  });

  it("normalizes task.terminal test deliveries to a concrete failed event", async () => {
    const app = makeApp();

    const created = await request(app)
      .post("/webhooks")
      .send({ name: "terminal-test", url: "https://hermes.example/webhook/alchemy", events: ["task.terminal"] })
      .expect(201);

    await request(app).post(`/webhooks/${created.body.id}/test`).send({}).expect(200);

    const fetchMock = vi.mocked(global.fetch);
    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(String(init?.body));

    expect(headers["X-Alchemy-Event"]).toBe("task.failed");
    expect(body.event).toBe("task.failed");
    expect(body.task.status).toBe("failed");
    expect(body.summary).toBe("❌ Alchemy task failed: webhook test (test-task)");
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
