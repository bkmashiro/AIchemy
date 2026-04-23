import { NotificationConfig } from "./types";

export { NotificationConfig };

// ─── Constants ────────────────────────────────────────────────────────────────

const RATE_LIMIT_MAX = 5;            // max messages per window
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute window
const MAX_CONSECUTIVE_FAILURES = 5;

// ─── Colors ──────────────────────────────────────────────────────────────────

const COLOR_GREEN = 0x2ecc71;
const COLOR_RED = 0xe74c3c;
const COLOR_YELLOW = 0xf1c40f;
const COLOR_BLUE = 0x3498db;
const COLOR_GREY = 0x95a5a6;

function eventColor(event: string): number {
  if (event.includes("completed")) return COLOR_GREEN;
  if (event.includes("failed")) return COLOR_RED;
  if (event.includes("online") || event.includes("started")) return COLOR_BLUE;
  if (event.includes("warning")) return COLOR_YELLOW;
  return COLOR_GREY;
}

function formatDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt || !finishedAt) return "—";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ─── State (module-level singletons) ─────────────────────────────────────────

/** Rate limiting: tracks # of sends in the current window, per webhook URL */
const rateLimitState: Map<string, { count: number; windowStart: number }> = new Map();

/** Messages waiting to be sent after rate limit resets */
interface QueuedMessage {
  webhookUrl: string;
  body: object;
}
const messageQueue: QueuedMessage[] = [];

/** Consecutive failure counts per webhook URL */
const failureCounts: Map<string, number> = new Map();

/** Disabled webhook URLs (auto-disabled after too many consecutive failures) */
const disabledWebhooks: Set<string> = new Set();

/** Timer for draining the queue */
let drainTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Internal helpers ─────────────────────────────────────────────────────────

function getRateState(url: string): { count: number; windowStart: number } {
  const now = Date.now();
  let state = rateLimitState.get(url);
  if (!state || now - state.windowStart >= RATE_LIMIT_WINDOW_MS) {
    state = { count: 0, windowStart: now };
    rateLimitState.set(url, state);
  }
  return state;
}

async function sendEmbed(webhookUrl: string, body: object): Promise<void> {
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[notifications] Discord webhook returned ${resp.status}: ${text}`);
      recordFailure(webhookUrl);
    } else {
      // Success: reset failure count
      failureCounts.set(webhookUrl, 0);
    }
  } catch (err) {
    console.error("[notifications] Failed to send Discord notification:", err);
    recordFailure(webhookUrl);
  }
}

function recordFailure(webhookUrl: string): void {
  const count = (failureCounts.get(webhookUrl) ?? 0) + 1;
  failureCounts.set(webhookUrl, count);
  if (count >= MAX_CONSECUTIVE_FAILURES) {
    disabledWebhooks.add(webhookUrl);
    console.error(`[notifications] Webhook disabled after ${count} consecutive failures: ${webhookUrl}`);
  }
}

function scheduleDrain(webhookUrl: string, windowStart: number): void {
  if (drainTimer !== null) return; // already scheduled
  const remaining = RATE_LIMIT_WINDOW_MS - (Date.now() - windowStart);
  drainTimer = setTimeout(async () => {
    drainTimer = null;
    // Reset rate limit state for the webhook to allow fresh sends
    rateLimitState.delete(webhookUrl);

    // Drain queued messages
    while (messageQueue.length > 0) {
      const state = getRateState(webhookUrl);
      if (state.count >= RATE_LIMIT_MAX) {
        // Still rate-limited — re-schedule
        scheduleDrain(webhookUrl, state.windowStart);
        break;
      }
      const msg = messageQueue.shift()!;
      if (!disabledWebhooks.has(msg.webhookUrl)) {
        state.count++;
        await sendEmbed(msg.webhookUrl, msg.body);
      }
    }
  }, remaining > 0 ? remaining : 0);
}

function buildEmbed(event: string, payload: any): object {
  const fields: { name: string; value: string; inline?: boolean }[] = [];

  if (payload.name) fields.push({ name: "Name", value: String(payload.name), inline: true });
  if (payload.id) fields.push({ name: "ID", value: `\`${payload.id}\``, inline: true });
  if (payload.status) fields.push({ name: "Status", value: String(payload.status), inline: true });
  if (payload.stub_id) fields.push({ name: "Stub", value: `\`${payload.stub_id}\``, inline: true });
  if (payload.gpu) fields.push({ name: "GPU", value: String(payload.gpu), inline: true });

  const duration = formatDuration(payload.started_at, payload.finished_at);
  if (duration !== "—") fields.push({ name: "Duration", value: duration, inline: true });

  if (payload.exit_code !== undefined) {
    fields.push({ name: "Exit Code", value: `${payload.exit_code}`, inline: true });
  }
  if (payload.error) {
    fields.push({ name: "Error", value: `\`\`\`${String(payload.error).slice(0, 500)}\`\`\``, inline: false });
  }

  return {
    embeds: [
      {
        title: `[Alchemy] ${event}`,
        color: eventColor(event),
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function sendDiscordNotification(
  config: NotificationConfig,
  event: string,
  payload: any,
): Promise<void> {
  if (!config.enabled) return;
  if (!config.discord_webhook_url) return;
  if (!config.events.includes(event)) return;

  const webhookUrl = config.discord_webhook_url;
  if (disabledWebhooks.has(webhookUrl)) return;

  const body = buildEmbed(event, payload);
  const state = getRateState(webhookUrl);

  if (state.count >= RATE_LIMIT_MAX) {
    // Queue for later
    messageQueue.push({ webhookUrl, body });
    scheduleDrain(webhookUrl, state.windowStart);
    return;
  }

  state.count++;
  await sendEmbed(webhookUrl, body);
}

/** Returns number of queued (rate-limited) messages. Exported for testing. */
export function getQueueLength(): number {
  return messageQueue.length;
}

/** Returns whether a specific webhook URL has been auto-disabled. Exported for testing. */
export function isWebhookDisabled(webhookUrl: string): boolean {
  return disabledWebhooks.has(webhookUrl);
}
