import { Router, Request, Response } from "express";
import { store } from "../store";
import { WebhookEvent, WebhookSubscription } from "../types";
import { isWebhookEvent, postWebhook } from "../webhooks";

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

  router.delete("/:id", (req: Request, res: Response) => {
    const ok = store.deleteWebhookSubscription(req.params.id);
    if (!ok) { res.status(404).json({ error: "subscription not found" }); return; }
    res.json({ ok: true });
  });

  router.post("/:id/test", async (req: Request, res: Response) => {
    const sub = store.getWebhookSubscription(req.params.id);
    if (!sub) { res.status(404).json({ error: "subscription not found" }); return; }
    const task = req.body?.task;
    const event = parseEvents(req.body?.event ? [req.body.event] : sub.events)?.[0] ?? "task.failed";
    const payload = {
      event,
      previous_status: "running",
      occurred_at: new Date().toISOString(),
      task: task ?? { id: "test-task", status: event.replace("task.", ""), display_name: "webhook test" },
      subscription: { id: sub.id, name: sub.name },
      test: true,
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
