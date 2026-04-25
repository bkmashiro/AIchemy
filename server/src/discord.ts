/**
 * discord.ts — Dual Discord webhook notifications.
 *
 * Two channels:
 *   DISCORD_WEBHOOK_HUMAN — rich embeds (submitted, dispatched, completed, failed, lost)
 *   DISCORD_WEBHOOK_AI    — plain text (completed, failed only)
 *
 * Fire and forget — callers should .catch(() => {}).
 */

import { Task } from "./types";
import { store } from "./store";
import { logger } from "./log";

const WEBHOOK_HUMAN = process.env.DISCORD_WEBHOOK_HUMAN || "";
const WEBHOOK_AI = process.env.DISCORD_WEBHOOK_AI || process.env.DISCORD_WEBHOOK_URL || "";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt || !finishedAt) return "";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function stubName(task: Task): string | null {
  if (!task.stub_id) return null;
  const stub = store.getStub(task.stub_id);
  if (!stub) return task.stub_id.slice(0, 8);
  return stub.name || stub.hostname || task.stub_id.slice(0, 8);
}

// ─── Low-level send ──────────────────────────────────────────────────────────

async function sendToWebhook(url: string, body: Record<string, any>): Promise<void> {
  if (!url) return;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      logger.warn("discord.error", { status: resp.status, body: text });
    }
  } catch (err) {
    logger.warn("discord.send_failed", { error: String(err) });
  }
}

function sendPlainText(url: string, text: string): Promise<void> {
  return sendToWebhook(url, { content: text });
}

function sendEmbed(url: string, embed: Record<string, any>): Promise<void> {
  return sendToWebhook(url, { embeds: [embed] });
}

// ─── Embed colors ────────────────────────────────────────────────────────────

const COLOR = {
  submitted:  0x5865f2, // blurple
  dispatched: 0xfee75c, // yellow
  running:    0x57f287, // green
  completed:  0x2ecc71, // dark green
  failed:     0xed4245, // red
  killed:     0xe67e22, // orange
  lost:       0x95a5a6, // grey
} as const;

// ─── Human channel (embeds) ──────────────────────────────────────────────────

function humanEmbed(task: Task, title: string, color: number, fields?: Array<{name: string; value: string; inline?: boolean}>): Promise<void> {
  const embed: Record<string, any> = {
    title,
    color,
    fields: [
      { name: "Task", value: `#${task.seq} ${task.display_name}`, inline: false },
      ...(fields ?? []),
    ],
    timestamp: new Date().toISOString(),
  };
  const stub = stubName(task);
  if (stub) {
    embed.fields.push({ name: "Stub", value: stub, inline: true });
  }
  return sendEmbed(WEBHOOK_HUMAN, embed);
}

export async function notifySubmitted(task: Task): Promise<void> {
  await humanEmbed(task, "📥 Task Submitted", COLOR.submitted, [
    { name: "Priority", value: String(task.priority), inline: true },
  ]);
}

export async function notifyDispatched(task: Task): Promise<void> {
  await humanEmbed(task, "📤 Task Dispatched", COLOR.dispatched);
}

export async function notifyRunning(task: Task): Promise<void> {
  await humanEmbed(task, "🟢 Task Started", COLOR.running);
}

export async function notifyCompleted(task: Task): Promise<void> {
  const dur = formatDuration(task.started_at, task.finished_at);
  const fields: Array<{name: string; value: string; inline?: boolean}> = [];
  if (dur) fields.push({ name: "Duration", value: dur, inline: true });
  if (task.exit_code !== undefined) fields.push({ name: "Exit", value: String(task.exit_code), inline: true });
  if (task.progress?.loss !== undefined) fields.push({ name: "Loss", value: task.progress.loss.toFixed(4), inline: true });

  // Human: embed
  await humanEmbed(task, "✅ Task Completed", COLOR.completed, fields);

  // AI: plain text
  const durStr = dur ? ` (${dur})` : "";
  const lossStr = task.progress?.loss !== undefined ? ` loss=${task.progress.loss.toFixed(4)}` : "";
  await sendPlainText(WEBHOOK_AI, `✅ #${task.seq} ${task.display_name} completed${durStr}${lossStr}`);
}

export async function notifyFailed(task: Task, exitCode?: number): Promise<void> {
  const code = exitCode ?? task.exit_code;
  const dur = formatDuration(task.started_at, task.finished_at);
  const fields: Array<{name: string; value: string; inline?: boolean}> = [];
  if (code !== undefined) {
    const oom = code === 137 ? " (OOM)" : "";
    fields.push({ name: "Exit", value: `${code}${oom}`, inline: true });
  }
  if (dur) fields.push({ name: "Duration", value: dur, inline: true });

  // Human: embed
  await humanEmbed(task, "❌ Task Failed", COLOR.failed, fields);

  // AI: plain text
  const exitStr = code !== undefined ? ` exit=${code}${code === 137 ? " OOM" : ""}` : "";
  await sendPlainText(WEBHOOK_AI, `❌ #${task.seq} ${task.display_name} failed${exitStr}`);
}

export async function notifyKilled(task: Task): Promise<void> {
  await humanEmbed(task, "🛑 Task Killed", COLOR.killed);

  // AI: treat as failed
  await sendPlainText(WEBHOOK_AI, `🛑 #${task.seq} ${task.display_name} killed`);
}

export async function notifyLost(task: Task): Promise<void> {
  const stub = stubName(task);
  const stubStr = stub ? ` (stub ${stub} disconnected)` : "";
  await humanEmbed(task, "⚠️ Task Lost", COLOR.lost);

  // AI: plain text
  await sendPlainText(WEBHOOK_AI, `⚠️ #${task.seq} ${task.display_name} lost${stubStr}`);
}

// ─── Task notify (user-defined) ──────────────────────────────────────────────

export async function notifyTaskMessage(task: Task, message: string, level: "warning" | "critical"): Promise<void> {
  const color = level === "critical" ? 0xed4245 : 0xfee75c; // red : yellow
  const title = level === "critical" ? "🚨 Critical Alert" : "⚠️ Warning";
  const mention = level === "critical" ? "<@472218073261277186> " : "";

  await humanEmbed(task, title, color, [
    { name: "Message", value: message.slice(0, 1024), inline: false },
  ]);

  await sendPlainText(WEBHOOK_AI, `${mention}${title} #${task.seq} ${task.display_name}: ${message}`);
}

// ─── Grid summary (both channels) ───────────────────────────────────────────

export interface GridNotifyPayload {
  name: string;
  total: number;
  completed: number;
  failed: number;
  best_loss?: number;
  best_params?: Record<string, any>;
}

export async function notifyGridDone(payload: GridNotifyPayload): Promise<void> {
  let msg = `📊 Grid "${payload.name}" done: ${payload.completed}/${payload.total} completed, ${payload.failed} failed.`;
  if (payload.best_loss !== undefined && payload.best_params) {
    const paramsStr = Object.entries(payload.best_params)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    msg += ` Best: ${payload.best_loss.toFixed(4)} (${paramsStr})`;
  }

  // Human: embed
  const fields: Array<{name: string; value: string; inline?: boolean}> = [
    { name: "Completed", value: `${payload.completed}/${payload.total}`, inline: true },
    { name: "Failed", value: String(payload.failed), inline: true },
  ];
  if (payload.best_loss !== undefined) {
    fields.push({ name: "Best Loss", value: payload.best_loss.toFixed(4), inline: true });
  }
  await sendEmbed(WEBHOOK_HUMAN, {
    title: `📊 Grid "${payload.name}" Complete`,
    color: payload.failed > 0 ? COLOR.failed : COLOR.completed,
    fields,
    timestamp: new Date().toISOString(),
  });

  // AI: plain text
  await sendPlainText(WEBHOOK_AI, msg);
}
