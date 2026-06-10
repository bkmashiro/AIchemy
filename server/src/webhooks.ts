import { createHmac, randomUUID } from "crypto";
import { store } from "./store";
import { Task, TaskStatus, WebhookEvent, WebhookSubscription } from "./types";
import { logger } from "./log";
import { alchemyEvents, TaskStatusChangedEvent } from "./events";

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "cancelled"]);
const VALID_EVENTS = new Set<WebhookEvent>(["task.completed", "task.failed", "task.cancelled", "task.terminal"]);

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

  const payload = buildTaskWebhookPayload(previous, task, event);

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
