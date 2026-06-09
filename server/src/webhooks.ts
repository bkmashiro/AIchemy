import { createHmac, randomUUID } from "crypto";
import { store } from "./store";
import { Task, TaskStatus, WebhookEvent, WebhookSubscription } from "./types";
import { logger } from "./log";
import { alchemyEvents, TaskStatusChangedEvent } from "./events";

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "cancelled"]);
const VALID_EVENTS = new Set<WebhookEvent>(["task.completed", "task.failed", "task.cancelled", "task.terminal"]);

export function isWebhookEvent(value: string): value is WebhookEvent {
  return VALID_EVENTS.has(value as WebhookEvent);
}

export function eventForTaskStatus(status: TaskStatus): WebhookEvent | undefined {
  if (!TERMINAL_STATUSES.has(status)) return undefined;
  return `task.${status}` as WebhookEvent;
}

function sanitizeTask(task: Task): Omit<Task, "log_buffer" | "metrics_buffer"> & { log_tail?: string[] } {
  const { log_buffer, metrics_buffer: _metricsBuffer, ...rest } = task;
  return { ...rest, log_tail: log_buffer?.slice(-10) };
}

function subscriptionMatches(sub: WebhookSubscription, event: WebhookEvent): boolean {
  return sub.enabled && (sub.events.includes(event) || sub.events.includes("task.terminal"));
}

function signedHeaders(sub: WebhookSubscription, payload: string, event: WebhookEvent, deliveryId: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Alchemy-Webhooks/1",
    "X-Alchemy-Event": event,
    "X-Alchemy-Delivery": deliveryId,
  };
  if (sub.secret) {
    const digest = createHmac("sha256", sub.secret).update(payload).digest("hex");
    headers["X-Alchemy-Signature-256"] = `sha256=${digest}`;
    headers["X-Hub-Signature-256"] = `sha256=${digest}`;
  }
  return headers;
}

export async function postWebhook(sub: WebhookSubscription, payload: unknown, event: WebhookEvent): Promise<void> {
  const body = JSON.stringify(payload);
  const deliveryId = `${sub.id}:${(payload as any).task?.id ?? "manual"}:${event}:${randomUUID()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(sub.url, {
      method: "POST",
      headers: signedHeaders(sub, body, event, deliveryId),
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    logger.info("webhook.delivered", { subscription_id: sub.id, webhook_event: event });
  } finally {
    clearTimeout(timeout);
  }
}

export async function deliverTaskStatusWebhooks(previous: Task, task: Task): Promise<void> {
  if (previous.status === task.status) return;
  const event = eventForTaskStatus(task.status);
  if (!event) return;

  const payload = {
    event,
    previous_status: previous.status,
    occurred_at: new Date().toISOString(),
    task: sanitizeTask(task),
    subscription: undefined as { id: string; name: string } | undefined,
  };

  const deliveries = store.listWebhookSubscriptions()
    .filter((sub) => subscriptionMatches(sub, event))
    .map(async (sub) => {
      try {
        await postWebhook(sub, { ...payload, subscription: { id: sub.id, name: sub.name } }, event);
      } catch (err) {
        logger.warn("webhook.delivery_failed", { subscription_id: sub.id, event, task_id: task.id, error: String(err) });
      }
    });

  await Promise.all(deliveries);
}

let dispatcherStarted = false;
export function startWebhookDispatcher(): void {
  if (dispatcherStarted) return;
  dispatcherStarted = true;
  alchemyEvents.onTaskStatusChanged((event: TaskStatusChangedEvent) => {
    void deliverTaskStatusWebhooks(event.previous, event.task);
  });
}
