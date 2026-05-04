#!/usr/bin/env node
/**
 * Alchemy v2 MCP Server — standalone process, stdio transport.
 *
 * Wraps the Alchemy REST API so Claude agents can submit and manage
 * GPU tasks, monitor cluster status, and control deployment.
 *
 * Env vars:
 *   ALCHEMY_URL   — server base URL (default http://localhost:3002)
 *   ALCHEMY_TOKEN — bearer auth token (default alchemy-v2-token)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ALCHEMY_URL = process.env.ALCHEMY_URL || "http://localhost:3002";
const ALCHEMY_TOKEN = process.env.ALCHEMY_TOKEN || "alchemy-v2-token";

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function alchemyFetch(
  path: string,
  opts: { method?: string; body?: unknown; noAuth?: boolean } = {},
): Promise<unknown> {
  const url = `${ALCHEMY_URL}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!opts.noAuth) {
    headers["Authorization"] = `Bearer ${ALCHEMY_TOKEN}`;
  }
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    const msg =
      json && typeof json === "object" && "error" in (json as object)
        ? (json as Record<string, unknown>).error
        : text;
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return json;
}

// ─── Result helpers ───────────────────────────────────────────────────────────

function ok(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function err(msg: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text" as const, text: msg }], isError: true as const };
}

function wrap(fn: () => Promise<unknown>): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
  return fn()
    .then(ok)
    .catch((e: Error) => err(e.message));
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: "alchemy", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// ═══════════════════════════════════════════════════════════════
// TASK MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// 1. list_tasks
server.tool(
  "alchemy_list_tasks",
  "List tasks with optional pagination and status filtering. Returns task summary with counts by status.",
  {
    page: z.number().optional().describe("Page number (default 1)"),
    limit: z.number().optional().describe("Items per page (default 50, max 500)"),
    status: z.string().optional().describe(
      "Filter by exact status: pending, queued, running, dispatched, paused, completed, failed, killed, lost, cancelled, blocked",
    ),
    status_group: z
      .enum(["active", "terminal"])
      .optional()
      .describe("Filter by group: active (running/queued/pending/paused/dispatched) or terminal (completed/failed/killed/lost/cancelled)"),
  },
  (params) =>
    wrap(async () => {
      const qs = new URLSearchParams();
      if (params.page) qs.set("page", String(params.page));
      if (params.limit) qs.set("limit", String(params.limit));
      if (params.status) qs.set("status", params.status);
      if (params.status_group) qs.set("status_group", params.status_group);
      return alchemyFetch(`/api/tasks?${qs}`);
    }),
);

// 2. submit_task
server.tool(
  "alchemy_submit_task",
  "Submit a new GPU task to the Alchemy scheduler. Use absolute paths for script and cwd. target_tags routes the task to matching stub nodes. By default waits up to 15s to confirm the task started (or failed with a preflight error).",
  {
    script: z.string().describe("Absolute path to the script to run (e.g. /home/user/train.py)"),
    args: z
      .record(z.string(), z.string())
      .optional()
      .describe("Key-value CLI args (e.g. {\"--lr\": \"0.001\", \"--epochs\": \"100\"})"),
    raw_args: z.string().optional().describe("Raw argument string appended verbatim after the script path"),
    name: z.string().optional().describe("Human-readable task name"),
    cwd: z.string().optional().describe("Absolute working directory for the task"),
    env_setup: z.string().optional().describe("Shell commands run before the script (e.g. 'conda activate myenv')"),
    env: z.record(z.string(), z.string()).optional().describe("Environment variables to set"),
    target_tags: z.array(z.string()).optional().describe("Route to stubs with ALL these tags"),
    target_stub_id: z.string().optional().describe("Pin task to a specific stub by its ID"),
    priority: z.number().optional().describe("Priority 1-10, lower = higher priority (default 5)"),
    max_retries: z.number().optional().describe("Max automatic retries on failure (default 0)"),
    requirements: z
      .object({
        gpu_type: z.string().optional().describe("Required GPU type (e.g. 'A40')"),
        gpu_mem_mb: z.number().optional().describe("Minimum GPU VRAM in MB"),
        gpus: z.number().optional().describe("Number of GPUs required"),
      })
      .optional()
      .describe("Hardware requirements"),
    wait: z
      .boolean()
      .optional()
      .describe("Wait for task to start or fail before returning (default true). Set false for fire-and-forget."),
  },
  (params) => {
    const { wait = true, ...taskBody } = params;
    const url = wait ? "/api/tasks?wait=true&wait_timeout=15" : "/api/tasks";
    return wrap(() =>
      alchemyFetch(url, {
        method: "POST",
        body: taskBody,
      }),
    );
  },
);

// 3. get_task
server.tool(
  "alchemy_get_task",
  "Get full details of a specific task by ID, including status, logs reference, progress, timing, and error info.",
  {
    task_id: z.string().describe("Task UUID"),
  },
  ({ task_id }) => wrap(() => alchemyFetch(`/api/tasks/${task_id}`)),
);

// 4. kill_task
server.tool(
  "alchemy_kill_task",
  "Kill a running, queued, or pending task. Initiates graceful kill chain for running tasks.",
  {
    task_id: z.string().describe("Task UUID to kill"),
  },
  ({ task_id }) =>
    wrap(() =>
      alchemyFetch("/api/tasks/batch", {
        method: "POST",
        body: { action: "kill", task_ids: [task_id] },
      }),
    ),
);

// 5. retry_task
server.tool(
  "alchemy_retry_task",
  "Manually retry a task in a terminal state (completed, failed, killed, lost). Creates a new task preserving original config.",
  {
    task_id: z.string().describe("Task UUID to retry"),
    force: z.boolean().optional().describe("Skip dedup check for active retries (default false)"),
  },
  ({ task_id, force }) =>
    wrap(() =>
      alchemyFetch(`/api/tasks/${task_id}/retry${force ? "?force=true" : ""}`, {
        method: "POST",
      }),
    ),
);

// 6. batch_action
server.tool(
  "alchemy_batch_action",
  "Apply an action to multiple tasks at once. Actions: kill (active tasks), retry (terminal tasks), requeue (any → pending), cancel (pending/queued), delete (terminal tasks).",
  {
    action: z
      .enum(["kill", "retry", "requeue", "cancel", "delete"])
      .describe("Action to apply to all specified tasks"),
    task_ids: z.array(z.string()).describe("List of task UUIDs"),
  },
  ({ action, task_ids }) =>
    wrap(() =>
      alchemyFetch("/api/tasks/batch", {
        method: "POST",
        body: { action, task_ids },
      }),
    ),
);

// ═══════════════════════════════════════════════════════════════
// STUB MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// 7. list_stubs
server.tool(
  "alchemy_list_stubs",
  "List all registered GPU stubs (worker nodes) with online/offline status, GPU info, and current task counts.",
  {},
  () => wrap(() => alchemyFetch("/api/stubs")),
);

// 8. get_stub
server.tool(
  "alchemy_get_stub",
  "Get full details of a specific stub node including GPU specs, tasks, tags, and config.",
  {
    stub_id: z.string().describe("Stub UUID"),
  },
  ({ stub_id }) => wrap(() => alchemyFetch(`/api/stubs/${stub_id}`)),
);

// 9. update_stub
server.tool(
  "alchemy_update_stub",
  "Update stub configuration: rename it, change max concurrent task slots, or update routing tags.",
  {
    stub_id: z.string().describe("Stub UUID"),
    name: z.string().optional().describe("New display name for the stub"),
    max_concurrent: z.number().optional().describe("Maximum concurrent tasks (1-64)"),
    tags: z.array(z.string()).optional().describe("Routing tags (replaces existing tags)"),
  },
  ({ stub_id, ...body }) =>
    wrap(() =>
      alchemyFetch(`/api/stubs/${stub_id}`, {
        method: "PATCH",
        body,
      }),
    ),
);

// ═══════════════════════════════════════════════════════════════
// DEPLOYMENT
// ═══════════════════════════════════════════════════════════════

// 10. deploy_stub
server.tool(
  "alchemy_deploy_stub",
  "Deploy (sync code + restart) a single stub by its configured name. Requires deploy-config.yaml on the server.",
  {
    name: z.string().describe("Stub target name as defined in deploy-config.yaml"),
    server_url: z
      .string()
      .optional()
      .describe("Override server URL the stub should connect to (useful for dynamic tunnel URLs)"),
  },
  ({ name, server_url }) =>
    wrap(() =>
      alchemyFetch(`/api/deploy/stubs/${name}`, {
        method: "POST",
        body: server_url ? { server_url } : {},
      }),
    ),
);

// 11. deploy_all
server.tool(
  "alchemy_deploy_all",
  "Deploy all configured stubs in parallel batches of 3. Optionally filter by names or skip specific stubs.",
  {
    names: z.array(z.string()).optional().describe("Only deploy these stub names"),
    skip: z.array(z.string()).optional().describe("Skip these stub names"),
    server_url: z.string().optional().describe("Override server URL for all stubs"),
  },
  (params) =>
    wrap(() =>
      alchemyFetch("/api/deploy/stubs", {
        method: "POST",
        body: params,
      }),
    ),
);

// 12. deploy_targets
server.tool(
  "alchemy_deploy_targets",
  "List all stub deployment targets configured in deploy-config.yaml (host, user, tags, max_concurrent).",
  {},
  () => wrap(() => alchemyFetch("/api/deploy/targets")),
);

// ═══════════════════════════════════════════════════════════════
// MONITORING
// ═══════════════════════════════════════════════════════════════

// 13. overview
server.tool(
  "alchemy_overview",
  "Get dashboard overview stats: task counts by status, stub counts, GPU utilization. No auth required.",
  {},
  () => wrap(() => alchemyFetch("/api/overview", { noAuth: true })),
);

// 14. task_logs
server.tool(
  "alchemy_task_logs",
  "Get recent log output from a task's log buffer. Use tail to control how many lines to retrieve.",
  {
    task_id: z.string().describe("Task UUID"),
    tail: z.number().optional().describe("Number of recent log lines to return (default 50)"),
  },
  ({ task_id, tail = 50 }) =>
    wrap(() => alchemyFetch(`/api/tasks/${task_id}/logs?tail=${tail}`)),
);

// 15. health
server.tool(
  "alchemy_health",
  "Check server health. Returns ok status and server uptime info.",
  {},
  () => wrap(() => alchemyFetch("/api/health", { noAuth: true })),
);

// ═══════════════════════════════════════════════════════════════
// GRID / EXPERIMENT (hyperparameter sweep)
// ═══════════════════════════════════════════════════════════════

// 16. create_grid
server.tool(
  "alchemy_create_grid",
  "Create a hyperparameter sweep grid. Generates one task per cartesian-product combination of param_space (max 1000 combinations). Each param value is passed as --key value CLI arg.",
  {
    script: z.string().describe("Absolute path to the script to run"),
    param_space: z
      .record(z.string(), z.array(z.unknown()))
      .describe("Hyperparameter grid: {\"seed\": [1,2,3], \"lr\": [0.001, 0.01]}"),
    name: z.string().optional().describe("Grid display name"),
    base_args: z
      .record(z.string(), z.string())
      .optional()
      .describe("Fixed args applied to every task in the grid"),
    target_tags: z.array(z.string()).optional().describe("Route all grid tasks to stubs with these tags"),
    requirements: z
      .object({
        gpu_type: z.string().optional(),
        gpu_mem_mb: z.number().optional(),
        gpus: z.number().optional(),
      })
      .optional()
      .describe("Hardware requirements for each task"),
    max_retries: z.number().optional().describe("Max retries per task (default 0)"),
  },
  (params) =>
    wrap(() =>
      alchemyFetch("/api/grids", {
        method: "POST",
        body: params,
      }),
    ),
);

// 17. list_grids
server.tool(
  "alchemy_list_grids",
  "List all hyperparameter sweep grids with their status and task counts.",
  {},
  () => wrap(() => alchemyFetch("/api/grids")),
);

// 18. get_grid
server.tool(
  "alchemy_get_grid",
  "Get full details of a grid including all tasks and derived status (pending/running/partial/completed/failed).",
  {
    grid_id: z.string().describe("Grid UUID"),
  },
  ({ grid_id }) => wrap(() => alchemyFetch(`/api/grids/${grid_id}`)),
);

// ═══════════════════════════════════════════════════════════════
// ERROR DIAGNOSTICS
// ═══════════════════════════════════════════════════════════════

// 19. failed_tasks
server.tool(
  "alchemy_failed_tasks",
  "Get recent failed/killed tasks with error summaries. Useful for quickly diagnosing what went wrong.",
  {
    limit: z.number().optional().describe("Max tasks to return (default 10)"),
    include_logs: z.boolean().optional().describe("Include last 20 lines of logs (default true)"),
  },
  (params) =>
    wrap(async () => {
      const limit = params.limit ?? 10;
      const includeLogs = params.include_logs ?? true;
      // Fetch terminal tasks
      const tasks = await alchemyFetch(`/api/tasks?status_group=terminal&limit=${limit}`) as any;
      // Filter to only failed/killed
      const failed = (tasks.tasks || []).filter((t: any) =>
        ["failed", "killed", "lost"].includes(t.status)
      );
      // Optionally fetch logs for each
      if (includeLogs) {
        for (const t of failed) {
          try {
            const logs = await alchemyFetch(`/api/tasks/${t.id}/logs?tail=20`) as any;
            t.recent_logs = logs.lines || logs;
          } catch {
            t.recent_logs = null;
          }
        }
      }
      // Return concise error summaries
      return failed.map((t: any) => ({
        id: t.id,
        seq: t.seq,
        name: t.display_name || t.name,
        status: t.status,
        exit_code: t.exit_code,
        error: t.error_message,
        stub: t.stub_name || t.stub_id,
        finished_at: t.finished_at,
        recent_logs: t.recent_logs,
      }));
    }),
);

// 20. task_errors
server.tool(
  "alchemy_task_errors",
  "Get detailed error info for a specific task: exit code, error message, and last N log lines. Best for diagnosing why a task failed.",
  {
    task_id: z.string().describe("Task UUID"),
    log_lines: z.number().optional().describe("Number of log lines to include (default 50)"),
  },
  ({ task_id, log_lines }) =>
    wrap(async () => {
      const tail = log_lines ?? 50;
      const [task, logs] = await Promise.all([
        alchemyFetch(`/api/tasks/${task_id}`),
        alchemyFetch(`/api/tasks/${task_id}/logs?tail=${tail}`).catch(() => null),
      ]);
      const t = task as any;
      return {
        id: t.id,
        seq: t.seq,
        name: t.display_name || t.name,
        status: t.status,
        exit_code: t.exit_code,
        error: t.error_message,
        death_cause: t.death_cause,
        stub: t.stub_name || t.stub_id,
        started_at: t.started_at,
        finished_at: t.finished_at,
        command: t.command,
        cwd: t.cwd,
        logs: (logs as any)?.lines || logs,
      };
    }),
);

// ─── Connect ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e: Error) => {
  process.stderr.write(`Alchemy MCP fatal: ${e.message}\n`);
  process.exit(1);
});
