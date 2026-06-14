import { createHmac, randomUUID } from "crypto";
import { store } from "./store";
import { Task, TaskStatus, WebhookEvent, WebhookSubscription, WebhookDeliveryOutbox } from "./types";
import { logger } from "./log";
import { alchemyEvents, TaskStatusChangedEvent } from "./events";

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "cancelled"]);
const VALID_EVENTS = new Set<WebhookEvent>(["task.completed", "task.failed", "task.cancelled", "task.terminal"]);
const OUTBOX_MAX_ATTEMPTS = 5;
const OUTBOX_RETRY_BASE_MS = 500;
const OUTBOX_MAX_DELAY_MS = 8_000;
const OUTBOX_RETRY_POLL_MS = 250;

const SUMMARY_TEMPLATES = {
  completed: (taskName: string, taskId: string) => `✅ Alchemy task completed: ${taskName} (${taskId})`,
  failed: (taskName: string, taskId: string, exitCode?: number) => `❌ Alchemy task failed: ${taskName} (${taskId})${exitCode !== undefined ? ` exit_code=${exitCode}` : ""}`,
  cancelled: (taskName: string, taskId: string) => `⚪ Alchemy task cancelled: ${taskName} (${taskId})`,
} as const;

export type NotificationSeverity = "info" | "warning" | "error";

export interface NotificationDiagnosis {
  category: string;
  severity: NotificationSeverity;
  reason: string;
}

export interface TaskNotification {
  summary: string;
  diagnosis: NotificationDiagnosis;
  commands: string[];
}

export function isWebhookEvent(value: string): value is WebhookEvent {
  return VALID_EVENTS.has(value as WebhookEvent);
}

export function eventForTaskStatus(status: TaskStatus): WebhookEvent | undefined {
  if (!TERMINAL_STATUSES.has(status)) return undefined;
  return `task.${status}` as WebhookEvent;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function formatTaskNotification(task: { id?: string; status: TaskStatus; display_name?: string; name?: string; script?: string; exit_code?: number; run_dir?: string; log_tail?: string[] }): TaskNotification {
  const taskId = task.id ?? "unknown";
  const taskName = task.display_name ?? task.name ?? task.script ?? "unknown";
  const status = task.status;
  const logTail = task.log_tail?.map((line) => String(line)) ?? [];
  const logs = logTail.join("\n");

  const baseTaskName = taskName;
  const commandTaskId = shellQuote(taskId);
  const commands = [
    `alch tasks get ${commandTaskId}`,
    `alch tasks logs ${commandTaskId} --tail 200`,
  ];

  if (task.run_dir) {
    commands.push(`ls -la ${shellQuote(task.run_dir)}`);
  }

  const diagnosis: NotificationDiagnosis = deriveDiagnosis(status, task.exit_code, logs);

  let summary = "";
  if (status === "completed") {
    summary = SUMMARY_TEMPLATES.completed(baseTaskName, taskId);
  } else if (status === "failed") {
    summary = SUMMARY_TEMPLATES.failed(baseTaskName, taskId, task.exit_code);
  } else if (status === "cancelled") {
    summary = SUMMARY_TEMPLATES.cancelled(baseTaskName, taskId);
  } else {
    summary = `⚪ Alchemy task ${status}: ${baseTaskName} (${taskId})`;
  }

  return {
    summary,
    diagnosis,
    commands,
  };
}

function deriveDiagnosis(status: TaskStatus, exitCode: number | undefined, logText: string): NotificationDiagnosis {
  const hasTerminationSignal = /SIGTERM|terminated/i.test(logText);

  if (status === "completed") {
    return {
      category: "success",
      severity: "info",
      reason: `Task completed with exit_code=${exitCode ?? 0}`,
    };
  }

  if (status === "cancelled") {
    return {
      category: "cancelled",
      severity: "warning",
      reason: "Task was cancelled by user or dependency failure.",
    };
  }

  if (status === "failed") {
    if (exitCode === -15 || hasTerminationSignal) {
      return {
        category: "slurm_or_termination",
        severity: "warning",
        reason: exitCode === -15
          ? "Task exit code indicates SIGTERM termination."
          : "Log output indicates task received SIGTERM/termination signal.",
      };
    }

    if (/out of memory|oom|cuda out of memory/i.test(logText)) {
      return {
        category: "oom",
        severity: "error",
        reason: "Log output indicates an out-of-memory condition.",
      };
    }

    if (/ModuleNotFoundError|ImportError/.test(logText)) {
      return {
        category: "environment",
        severity: "error",
        reason: "Task failed due to missing Python module or import error.",
      };
    }

    if (/Traceback/.test(logText)) {
      return {
        category: "code_error",
        severity: "error",
        reason: "Task produced a Python traceback, indicating a runtime error.",
      };
    }

    return {
      category: "failed",
      severity: "error",
      reason: `Task failed with exit_code=${exitCode ?? "unknown"}.`,
    };
  }

  return {
    category: "failed",
    severity: "error",
    reason: `Task ended with status ${status}.`,
  };
}

export function buildTaskWebhookPayload(previous: Pick<Task, "status">, task: Task, event: WebhookEvent): {
  event: WebhookEvent;
  previous_status: TaskStatus;
  occurred_at: string;
  task: Omit<Task, "log_buffer" | "metrics_buffer"> & { log_tail: string[] };
  subscription: undefined | { id: string; name: string };
  summary: string;
  diagnosis: NotificationDiagnosis;
  commands: string[];
} {
  const sanitizedTask = sanitizeTask(task);
  const notification = formatTaskNotification(sanitizedTask);

  return {
    event,
    previous_status: previous.status,
    occurred_at: new Date().toISOString(),
    task: sanitizedTask,
    subscription: undefined,
    ...notification,
  };
}

function isDiscordWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ["discord.com", "discordapp.com"].includes(parsed.hostname) && parsed.pathname.startsWith("/api/webhooks/");
  } catch {
    return false;
  }
}

function truncateDiscord(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function discordColorForSeverity(severity: NotificationSeverity): number {
  if (severity === "error") return 0xed4245;
  if (severity === "warning") return 0xfee75c;
  return 0x57f287;
}

function formatDiscordWebhookPayload(payload: any): unknown {
  const summary = String(payload?.summary ?? `Alchemy event: ${payload?.event ?? "unknown"}`);
  const diagnosis = payload?.diagnosis as NotificationDiagnosis | undefined;
  const task = payload?.task ?? {};
  const commands = Array.isArray(payload?.commands) ? payload.commands.map((command: unknown) => String(command)) : [];
  const commandBlock = commands.length > 0 ? `\`\`\`bash\n${commands.join("\n")}\n\`\`\`` : "n/a";

  return {
    content: truncateDiscord(summary, 2000),
    embeds: [
      {
        title: truncateDiscord(summary, 256),
        color: discordColorForSeverity(diagnosis?.severity ?? "info"),
        timestamp: payload?.occurred_at ?? new Date().toISOString(),
        fields: [
          { name: "Event", value: truncateDiscord(String(payload?.event ?? "unknown"), 1024), inline: true },
          { name: "Status", value: truncateDiscord(String(task?.status ?? "unknown"), 1024), inline: true },
          { name: "Task", value: truncateDiscord(String(task?.id ?? "unknown"), 1024), inline: true },
          { name: "Name", value: truncateDiscord(String(task?.display_name ?? task?.name ?? task?.script ?? "unknown"), 1024), inline: false },
          { name: "Diagnosis", value: truncateDiscord(diagnosis?.reason ?? "n/a", 1024), inline: false },
          { name: "Commands", value: truncateDiscord(commandBlock, 1024), inline: false },
        ],
      },
    ],
  };
}

function formatWebhookRequestBody(sub: WebhookSubscription, payload: unknown): unknown {
  if (isDiscordWebhookUrl(sub.url)) return formatDiscordWebhookPayload(payload);
  return payload;
}

function sanitizeTask(task: Task): Omit<Task, "log_buffer" | "metrics_buffer"> & { log_tail: string[] } {
  const { log_buffer, metrics_buffer: _metricsBuffer, ...rest } = task;
  return { ...rest, log_tail: log_buffer?.slice(-10) ?? [] };
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

export async function postWebhook(
  sub: WebhookSubscription,
  payload: unknown,
  event: WebhookEvent,
  deliveryId = `${sub.id}:${(payload as any).task?.id ?? "manual"}:${event}:${randomUUID()}`,
): Promise<{ deliveryId: string; httpStatus: number }> {
  const body = JSON.stringify(formatWebhookRequestBody(sub, payload));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let httpStatus = 0;
  try {
    const response = await fetch(sub.url, {
      method: "POST",
      headers: signedHeaders(sub, body, event, deliveryId),
      body,
      signal: controller.signal,
    });
    httpStatus = response.status;
    if (!response.ok) {
      const err = new Error(`HTTP ${response.status}`) as Error & { http_status?: number };
      err.http_status = response.status;
      throw err;
    }
    logger.info("webhook.delivered", { subscription_id: sub.id, webhook_event: event });
    return { deliveryId, httpStatus };
  } finally {
    clearTimeout(timeout);
  }
}

function webhookErrorMessage(error: unknown): string {
  const maybeHttp = error as { http_status?: number };
  if (typeof maybeHttp.http_status === "number") {
    return `HTTP ${maybeHttp.http_status}`;
  }
  return String(error).slice(0, 300);
}

function webhookRetryDelayMs(attempt: number): number {
  const safeAttempt = Math.max(attempt, 1);
  const delay = OUTBOX_RETRY_BASE_MS * Math.pow(2, Math.min(safeAttempt - 1, 8));
  return Math.min(delay, OUTBOX_MAX_DELAY_MS);
}

async function retryOutboxDelivery(entry: WebhookDeliveryOutbox): Promise<void> {
  const sub = store.getWebhookSubscription(entry.subscription_id);
  if (!sub) {
    await store.updateWebhookDeliveryOutbox(entry.id, {
      status: "exhausted",
      attempt_count: entry.attempt_count,
      last_error: "subscription_deleted",
      next_retry_at: new Date().toISOString(),
    });
    return;
  }

  const located = store.findTask(entry.task_id);
  if (!located?.task) {
    await store.updateWebhookDeliveryOutbox(entry.id, {
      status: "exhausted",
      attempt_count: entry.attempt_count,
      last_error: "task_missing",
      next_retry_at: new Date().toISOString(),
    });
    return;
  }

  const payload = {
    ...buildTaskWebhookPayload(
      { status: entry.previous_status },
      located.task,
      entry.event,
    ),
    subscription: { id: sub.id, name: sub.name },
  };

  await store.updateWebhookDeliveryOutbox(entry.id, {
    status: "in_flight",
    attempt_count: entry.attempt_count,
    next_retry_at: entry.next_retry_at,
  });

  const nextAttempt = entry.attempt_count + 1;
  try {
    const result = await postWebhook(sub, payload, entry.event, entry.delivery_id);
    store.recordWebhookDelivery({
      delivery_id: result.deliveryId,
      subscription_id: sub.id,
      subscription_name: sub.name,
      event: entry.event,
      task_id: located.task.id,
      status: "success",
      http_status: result.httpStatus,
    });
    await store.deleteWebhookDeliveryOutbox(entry.id);
  } catch (err) {
    const errorMessage = webhookErrorMessage(err);
    if (nextAttempt >= entry.max_attempts) {
      await store.updateWebhookDeliveryOutbox(entry.id, {
        status: "exhausted",
        attempt_count: nextAttempt,
        next_retry_at: new Date().toISOString(),
        last_error: errorMessage,
      });
    } else {
      const nextRetryAt = new Date(Date.now() + webhookRetryDelayMs(nextAttempt)).toISOString();
      await store.updateWebhookDeliveryOutbox(entry.id, {
        status: "pending",
        attempt_count: nextAttempt,
        next_retry_at: nextRetryAt,
        last_error: errorMessage,
      });
    }

    store.recordWebhookDelivery({
      delivery_id: entry.delivery_id,
      subscription_id: sub.id,
      subscription_name: sub.name,
      event: entry.event,
      task_id: located.task.id,
      status: "failed",
      error: errorMessage,
    });

    logger.warn("webhook.delivery_failed", {
      subscription_id: sub.id,
      event: entry.event,
      task_id: located.task.id,
      error: errorMessage,
      attempt: nextAttempt,
    });
  }
}

let outboxProcessorRunning = false;
export async function processWebhookOutbox(): Promise<void> {
  if (outboxProcessorRunning) return;
  outboxProcessorRunning = true;
  try {
    const now = new Date().toISOString();
    const outbox = store.listWebhookDeliveryOutbox({
      status: ["pending", "in_flight"],
      dueBefore: now,
      limit: 100,
    });
    for (const entry of outbox) {
      try {
        await retryOutboxDelivery(entry);
      } catch (err) {
        logger.error("webhook.outbox_retry_failed", { outbox_id: entry.id, error: String(err) });
      }
    }
  } finally {
    outboxProcessorRunning = false;
  }
}

export async function deliverTaskStatusWebhooks(previous: Task, task: Task): Promise<void> {
  if (previous.status === task.status) return;
  const event = eventForTaskStatus(task.status);
  if (!event) return;

  const payload = buildTaskWebhookPayload(previous, task, event);

  const deliveries = store.listWebhookSubscriptions()
    .filter((sub) => subscriptionMatches(sub, event))
    .map(async (sub) => {
      const deliveryPayload = { ...payload, subscription: { id: sub.id, name: sub.name } };
      const deliveryId = `${sub.id}:${task.id}:${event}:${randomUUID()}`;
      try {
        const result = await postWebhook(sub, deliveryPayload, event, deliveryId);
        store.recordWebhookDelivery({
          delivery_id: result.deliveryId,
          subscription_id: sub.id,
          subscription_name: sub.name,
          event,
          task_id: task.id,
          status: "success",
          http_status: result.httpStatus,
        });
      } catch (err) {
        const errorMessage = webhookErrorMessage(err);
        const status = (err as { http_status?: number }).http_status;

        store.recordWebhookDelivery({
          delivery_id: deliveryId,
          subscription_id: sub.id,
          subscription_name: sub.name,
          event,
          task_id: task.id,
          status: "failed",
          error: errorMessage,
          http_status: status,
        });

        const nextRetryAt = new Date(Date.now() + webhookRetryDelayMs(1)).toISOString();
        store.createWebhookDeliveryOutbox({
          delivery_id: deliveryId,
          subscription_id: sub.id,
          event,
          task_id: task.id,
          previous_status: previous.status,
          status: "pending",
          attempt_count: 1,
          max_attempts: OUTBOX_MAX_ATTEMPTS,
          next_retry_at: nextRetryAt,
          last_error: errorMessage,
        });

        logger.warn("webhook.delivery_failed", { subscription_id: sub.id, event, task_id: task.id, error: errorMessage });
      }
    });

  await Promise.all(deliveries);
}

let dispatcherStarted = false;
let outboxIntervalStarted = false;
export function startWebhookDispatcher(): void {
  if (!dispatcherStarted) {
    dispatcherStarted = true;
    alchemyEvents.onTaskStatusChanged((event: TaskStatusChangedEvent) => {
      void deliverTaskStatusWebhooks(event.previous, event.task);
    });
  }

  if (!outboxIntervalStarted) {
    outboxIntervalStarted = true;
    setInterval(() => {
      void processWebhookOutbox();
    }, OUTBOX_RETRY_POLL_MS);
    void processWebhookOutbox();
  }
}
