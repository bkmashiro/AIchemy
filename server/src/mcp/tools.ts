/**
 * mcp/tools.ts — MCP tool definitions and handlers for Alchemy v2.
 *
 * Thin adapter: each tool maps to one or more REST API calls.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const BASE_URL = process.env.ALCHEMY_SERVER_URL || "http://localhost:3002";
const TOKEN = process.env.ALCHEMY_TOKEN || "";

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function api(path: string, opts: RequestInit = {}): Promise<any> {
  const url = `${BASE_URL}/api${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      ...(opts.headers as Record<string, string> | undefined),
    },
  });
  const body = await res.text();
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    json = body;
  }
  if (!res.ok) {
    const msg = typeof json === "object" && json?.error ? json.error : body;
    throw new Error(`API ${res.status}: ${msg}`);
  }
  return json;
}

function text(content: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: content }] };
}

function errorResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function fmtTask(t: any): string {
  const lines: string[] = [];
  lines.push(`[${t.status?.toUpperCase()}] #${t.seq ?? "?"} ${t.display_name || t.name || t.id}`);
  lines.push(`  id: ${t.id}`);
  if (t.stub_name) lines.push(`  node: ${t.stub_name}`);
  if (t.priority !== undefined) lines.push(`  priority: ${t.priority}`);
  if (t.created_at) lines.push(`  created: ${t.created_at}`);
  if (t.started_at) lines.push(`  started: ${t.started_at}`);
  if (t.finished_at) lines.push(`  finished: ${t.finished_at}`);
  if (t.exit_code !== undefined && t.exit_code !== null) lines.push(`  exit_code: ${t.exit_code}`);
  if (t.error_message) lines.push(`  error: ${t.error_message}`);
  if (t.progress) {
    const p = t.progress;
    lines.push(`  progress: ${p.step}/${p.total}${p.loss !== undefined ? ` loss=${p.loss}` : ""}`);
  }
  if (t.retry_count) lines.push(`  retries: ${t.retry_count}/${t.max_retries}`);
  if (t.script) lines.push(`  script: ${t.script}`);
  if (t.tags?.length) lines.push(`  tags: ${t.tags.join(", ")}`);
  return lines.join("\n");
}

function fmtStub(s: any): string {
  const running = (s.tasks || []).filter((t: any) => t.status === "running").length;
  const queued = (s.tasks || []).filter((t: any) => t.status === "queued" || t.status === "dispatched").length;
  const gpu = s.gpu ? `${s.gpu.count}x ${s.gpu.name} (${s.gpu.vram_total_mb}MB)` : "unknown";
  const tags = s.tags?.length ? ` [${s.tags.join(",")}]` : "";
  return `${s.status === "online" ? "●" : "○"} ${s.name || s.hostname} (${s.id.slice(0, 8)})${tags}\n  GPU: ${gpu} | slots: ${running}/${s.max_concurrent} running, ${queued} queued`;
}

// ─── Register all tools ──────────────────────────────────────────────────────

export function registerTools(server: McpServer): void {

  // 1. submit_task
  server.tool(
    "alchemy.submit_task",
    "Submit a GPU task to the Alchemy scheduler",
    {
      script: z.string().describe("Script path to execute (absolute path)"),
      name: z.optional(z.string().describe("Human-readable task name")),
      args: z.optional(z.record(z.string(), z.string()).describe("Key-value args (e.g. {\"--lr\": \"0.001\"})")),
      raw_args: z.optional(z.string().describe("Raw argument string appended after script")),
      env: z.optional(z.record(z.string(), z.string()).describe("Environment variables")),
      cwd: z.optional(z.string().describe("Working directory (absolute path)")),
      target_tags: z.optional(z.array(z.string()).describe("Route to stubs with these tags")),
      priority: z.optional(z.number().describe("Priority 1-10, lower = higher priority")),
      max_retries: z.optional(z.number().describe("Max auto-retries on failure")),
    },
    async (params) => {
      try {
        const task = await api("/tasks", {
          method: "POST",
          body: JSON.stringify({
            script: params.script,
            name: params.name,
            args: params.args,
            raw_args: params.raw_args,
            env: params.env,
            cwd: params.cwd,
            target_tags: params.target_tags,
            priority: params.priority,
            max_retries: params.max_retries,
          }),
        });
        return text(`Task submitted:\n${fmtTask(task)}`);
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // 2. list_tasks
  server.tool(
    "alchemy.list_tasks",
    "List tasks with optional status filter",
    {
      status: z.optional(z.string().describe("Filter by status: pending, queued, running, completed, failed, killed, lost")),
      limit: z.optional(z.number().describe("Max results (default 20)")),
      offset: z.optional(z.number().describe("Page offset")),
    },
    async (params) => {
      try {
        const qs = new URLSearchParams();
        if (params.status) qs.set("status", params.status);
        const limit = params.limit ?? 20;
        qs.set("limit", String(limit));
        // Always compute page from offset; offset=0 maps to page 1. Sub-page granularity is lost (rounded to boundary).
        qs.set("page", String(Math.floor((params.offset ?? 0) / limit) + 1));
        const data = await api(`/tasks?${qs.toString()}`);
        const tasks: any[] = data.tasks || [];
        if (tasks.length === 0) return text("No tasks found.");
        const header = `Tasks (${data.total} total, showing ${tasks.length}):`;
        const body = tasks.map(fmtTask).join("\n\n");
        return text(`${header}\n\n${body}`);
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // 3. get_task
  server.tool(
    "alchemy.get_task",
    "Get detailed info about a specific task",
    {
      task_id: z.string().describe("Task UUID"),
    },
    async (params) => {
      try {
        const task = await api(`/tasks/${params.task_id}`);
        return text(fmtTask(task));
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // 4. kill_task
  server.tool(
    "alchemy.kill_task",
    "Kill a running or queued task",
    {
      task_id: z.string().describe("Task UUID to kill"),
    },
    async (params) => {
      try {
        const data = await api("/tasks/batch", {
          method: "POST",
          body: JSON.stringify({ action: "kill", task_ids: [params.task_id] }),
        });
        const r = data.results?.[0];
        if (r?.ok) return text(`Task ${params.task_id} killed.`);
        return errorResult(`Kill failed: ${r?.error || "unknown error"}`);
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // 5. retry_task
  server.tool(
    "alchemy.retry_task",
    "Retry a failed/killed/completed task",
    {
      task_id: z.string().describe("Task UUID to retry"),
    },
    async (params) => {
      try {
        const task = await api(`/tasks/${params.task_id}/retry`, { method: "POST" });
        return text(`Retry submitted:\n${fmtTask(task)}`);
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // 6. list_stubs
  server.tool(
    "alchemy.list_stubs",
    "List all GPU stubs (nodes) and their status",
    {},
    async () => {
      try {
        const stubs: any[] = await api("/stubs");
        if (stubs.length === 0) return text("No stubs registered.");
        const body = stubs.map(fmtStub).join("\n\n");
        return text(`Stubs (${stubs.length}):\n\n${body}`);
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // 7. cluster_status
  server.tool(
    "alchemy.cluster_status",
    "GPU cluster availability snapshot — total GPUs, slots, breakdown by type",
    {},
    async () => {
      try {
        const stubs: any[] = await api("/stubs");
        const online = stubs.filter((s) => s.status === "online");
        const offline = stubs.filter((s) => s.status === "offline");

        let totalGpus = 0;
        let totalSlots = 0;
        let usedSlots = 0;
        const byType: Record<string, { gpus: number; slots: number; used: number }> = {};

        for (const s of online) {
          const gpuCount = s.gpu?.count || 0;
          const gpuName = s.gpu?.name || "unknown";
          totalGpus += gpuCount;
          totalSlots += s.max_concurrent || 0;
          const running = (s.tasks || []).filter((t: any) =>
            t.status === "running" || t.status === "dispatched",
          ).length;
          usedSlots += running;

          if (!byType[gpuName]) byType[gpuName] = { gpus: 0, slots: 0, used: 0 };
          byType[gpuName].gpus += gpuCount;
          byType[gpuName].slots += s.max_concurrent || 0;
          byType[gpuName].used += running;
        }

        const lines: string[] = [];
        lines.push(`Cluster: ${online.length} online, ${offline.length} offline`);
        lines.push(`GPUs: ${totalGpus} total`);
        lines.push(`Slots: ${usedSlots}/${totalSlots} used (${totalSlots - usedSlots} available)`);
        lines.push("");
        lines.push("By GPU type:");
        for (const [name, info] of Object.entries(byType)) {
          lines.push(`  ${name}: ${info.gpus} GPUs, ${info.used}/${info.slots} slots used`);
        }

        return text(lines.join("\n"));
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // 8. task_logs
  server.tool(
    "alchemy.task_logs",
    "Get recent log output from a task",
    {
      task_id: z.string().describe("Task UUID"),
      tail: z.optional(z.number().describe("Number of recent lines (default 50)")),
    },
    async (params) => {
      try {
        const tail = params.tail ?? 50;
        const data = await api(`/tasks/${params.task_id}/logs?tail=${tail}`);
        const lines: string[] = data.lines || [];
        if (lines.length === 0) return text("No log output.");
        return text(lines.join("\n"));
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );
}
