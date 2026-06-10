import { Router, Request, Response } from "express";
import { store } from "../store";
import { Task, TaskStatus, WebhookEvent, WebhookSubscription } from "../types";
import { buildTaskWebhookPayload, isWebhookEvent, postWebhook } from "../webhooks";

function publicSubscription(sub: WebhookSubscription): Omit<WebhookSubscription, "secret"> & { has_secret: boolean } {
  const { secret: _secret, ...rest } = sub;
  return { ...rest, has_secret: Boolean(_secret) };
}

function parseEvents(value: unknown): WebhookEvent[] | undefined {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",").map((v) => v.trim()).filter(Boolean)
      : undefined;
  if (!raw || raw.length === 0) return undefined;
  const events: WebhookEvent[] = [];
  for (const event of raw) {
    if (typeof event !== "string" || !isWebhookEvent(event)) return undefined;
    events.push(event);
  }
  return [...new Set(events)];
}

function validateUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function buildTestTask(event: WebhookEvent, taskPayload: unknown): Task {
  const bodyTask = typeof taskPayload === "object" && taskPayload !== null ? taskPayload as Partial<Task> : {};
  const safeLogBuffer = Array.isArray(bodyTask.log_buffer)
    ? bodyTask.log_buffer.filter((line): line is string => typeof line === "string")
    : [];

  const now = new Date().toISOString();
  const defaultTask: Task = {
    id: "test-task",
    seq: 1,
    fingerprint: "test-fingerprint",
    display_name: "webhook test",
    script: "",
    command: "",
    status: "running",
    priority: 0,
    created_at: now,
    log_buffer: safeLogBuffer,
    retry_count: 0,
    max_retries: 0,
    should_stop: false,
    should_checkpoint: false,
    exit_code: undefined,
    name: undefined,
  };

  const baseTask = {
    ...defaultTask,
    ...bodyTask,
    status: event.replace("task.", "") as TaskStatus,
    log_buffer: safeLogBuffer,
  };

  return {
    ...baseTask,
    id: typeof baseTask.id === "string" ? baseTask.id : "test-task",
    seq: typeof baseTask.seq === "number" ? baseTask.seq : 1,
    fingerprint: typeof baseTask.fingerprint === "string" ? baseTask.fingerprint : "test-fingerprint",
    display_name: typeof baseTask.display_name === "string" && baseTask.display_name.trim().length > 0
      ? baseTask.display_name
      : "webhook test",
    script: typeof baseTask.script === "string" ? baseTask.script : "",
    command: typeof baseTask.command === "string" ? baseTask.command : "",
    priority: typeof baseTask.priority === "number" ? baseTask.priority : 0,
    created_at: typeof baseTask.created_at === "string" && baseTask.created_at.trim().length > 0
      ? baseTask.created_at
      : now,
    retry_count: typeof baseTask.retry_count === "number" ? baseTask.retry_count : 0,
    max_retries: typeof baseTask.max_retries === "number" ? baseTask.max_retries : 0,
    should_stop: Boolean(baseTask.should_stop),
    should_checkpoint: Boolean(baseTask.should_checkpoint),
    exit_code: typeof baseTask.exit_code === "number" ? baseTask.exit_code : undefined,
    run_dir: typeof baseTask.run_dir === "string" ? baseTask.run_dir : undefined,
  };
}

function concreteTestEvent(event: WebhookEvent): WebhookEvent {
  return event === "task.terminal" ? "task.failed" : event;
}

export function createWebhooksRouter(): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    res.json(store.listWebhookSubscriptions().map(publicSubscription));
  });

  router.post("/", (req: Request, res: Response) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const url = validateUrl(req.body?.url);
    const events = parseEvents(req.body?.events);
    if (!name) { res.status(400).json({ error: "name required" }); return; }
    if (!url) { res.status(400).json({ error: "http(s) url required" }); return; }
    if (!events) { res.status(400).json({ error: "events must be one or more of task.completed,task.failed,task.cancelled,task.terminal" }); return; }

    const existing = store.getWebhookSubscription(name);
    if (existing) { res.status(409).json({ error: "subscription name already exists" }); return; }

    const sub = store.addWebhookSubscription({
      name,
      url,
      events,
      enabled: req.body?.enabled !== false,
      secret: typeof req.body?.secret === "string" && req.body.secret ? req.body.secret : undefined,
    });
    res.status(201).json(publicSubscription(sub));
  });

  router.get("/:id/deliveries", (req: Request, res: Response) => {
    const sub = store.getWebhookSubscription(req.params.id);
    if (!sub) { res.status(404).json({ error: "subscription not found" }); return; }
    const rawLimit = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 20;
    res.json({ deliveries: store.listWebhookDeliveries(sub.id, limit) });
  });

  router.delete("/:id", (req: Request, res: Response) => {
    const ok = store.deleteWebhookSubscription(req.params.id);
    if (!ok) { res.status(404).json({ error: "subscription not found" }); return; }
    res.json({ ok: true });
  });

  router.post("/:id/test", async (req: Request, res: Response) => {
    const sub = store.getWebhookSubscription(req.params.id);
    if (!sub) { res.status(404).json({ error: "subscription not found" }); return; }
    const taskBody = req.body?.task;
    const event = concreteTestEvent(parseEvents(req.body?.event ? [req.body.event] : sub.events)?.[0] ?? "task.failed");
    const task = buildTestTask(event, taskBody);
    const payload = {
      ...buildTaskWebhookPayload({ status: "running" as TaskStatus }, task, event),
      event,
      test: true,
      subscription: { id: sub.id, name: sub.name },
    };
    try {
      await postWebhook(sub, payload, event);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  return router;
}
