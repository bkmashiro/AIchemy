/**
 * notifications.ts — Discord webhook notifications.
 *
 * Plain text only (no embeds — rich format causes empty messages in some Discord clients).
 * Three events: completed, failed, lost.
 * Grid summary when all tasks finish.
 */

import { logger } from "./log";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

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

async function sendPlainText(text: string): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const resp = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      logger.warn("discord.error", { status: resp.status, body });
    }
  } catch (err) {
    logger.warn("discord.send_failed", { error: String(err) });
  }
}

export interface TaskNotifyPayload {
  seq: number;
  display_name: string;
  stub_name?: string;
  started_at?: string;
  finished_at?: string;
  exit_code?: number;
  loss?: number;
}

export async function notifyTaskCompleted(payload: TaskNotifyPayload): Promise<void> {
  const dur = formatDuration(payload.started_at, payload.finished_at);
  const loss = payload.loss !== undefined ? ` loss=${payload.loss.toFixed(4)}` : "";
  const durStr = dur ? ` (${dur}${loss})` : "";
  await sendPlainText(`✅ #${payload.seq} ${payload.display_name} completed${durStr}`);
}

export async function notifyTaskFailed(payload: TaskNotifyPayload): Promise<void> {
  const exitStr = payload.exit_code !== undefined
    ? `, exit ${payload.exit_code}${payload.exit_code === 137 ? " OOM" : ""}`
    : "";
  await sendPlainText(`❌ #${payload.seq} ${payload.display_name} failed${exitStr}`);
}

export async function notifyTaskLost(payload: TaskNotifyPayload): Promise<void> {
  const stubStr = payload.stub_name ? ` (stub ${payload.stub_name} disconnected)` : "";
  await sendPlainText(`⚠️ #${payload.seq} ${payload.display_name} lost${stubStr}`);
}

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
    msg += ` Best loss: ${payload.best_loss.toFixed(4)} (${paramsStr})`;
  }
  await sendPlainText(msg);
}
