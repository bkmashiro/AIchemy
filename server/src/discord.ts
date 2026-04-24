/**
 * discord.ts — Discord webhook notifications for task events.
 *
 * Plain text only (no embeds — embeds render as empty messages in this setup).
 * Fire and forget — callers should .catch(() => {}) and not await.
 */

import { Task } from "./types";
import { store } from "./store";
import { logger } from "./log";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

function formatDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt || !finishedAt) return "";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
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

export type TaskEvent = "running" | "completed" | "failed" | "killed";

export async function notifyTaskEvent(task: Task, event: TaskEvent): Promise<void> {
  const stubName = task.stub_id ? (store.getStub(task.stub_id)?.name ?? task.stub_id) : null;
  const stubStr = stubName ? ` on stub ${stubName}` : "";
  const tag = `[alchemy] Task #${task.seq} "${task.display_name}"`;

  let msg: string;
  switch (event) {
    case "running":
      msg = `🟢 ${tag} started${stubStr}`;
      break;
    case "completed": {
      const dur = formatDuration(task.started_at, task.finished_at);
      const durStr = dur ? ` — took ${dur}` : "";
      msg = `✅ ${tag} completed (exit ${task.exit_code ?? 0})${stubStr}${durStr}`;
      break;
    }
    case "failed": {
      const dur = formatDuration(task.started_at, task.finished_at);
      const durStr = dur ? ` — took ${dur}` : "";
      msg = `❌ ${tag} failed (exit ${task.exit_code ?? "??"})${stubStr}${durStr}`;
      break;
    }
    case "killed":
      msg = `🛑 ${tag} killed${stubStr}`;
      break;
  }

  await sendPlainText(msg);
}
