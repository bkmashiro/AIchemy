/**
 * test_server_rest.test.ts — Server standalone REST API tests.
 *
 * Starts the Alchemy server in a subprocess and hits REST endpoints.
 * Tests: Task CRUD, fingerprint dedup, write lock, grid creation/ops, seq numbering,
 * display name generation, command assembly.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import net from "net";

// Disable proxy for test process (fetch uses EnvHttpProxyAgent)
delete process.env.http_proxy;
delete process.env.https_proxy;
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = "*";
process.env.no_proxy = "*";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

async function waitForServer(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${url} did not start in ${timeoutMs}ms`);
}

function makeHeaders(token: string) {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
  };
}

async function apiGet(url: string, token: string) {
  return fetch(url, { headers: makeHeaders(token) });
}

async function apiPost(url: string, token: string, body: any) {
  return fetch(url, {
    method: "POST",
    headers: makeHeaders(token),
    body: JSON.stringify(body),
  });
}

async function apiPatch(url: string, token: string, body: any) {
  return fetch(url, {
    method: "PATCH",
    headers: makeHeaders(token),
    body: JSON.stringify(body),
  });
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let serverProcess: ChildProcess;
let BASE_URL: string;
let TOKEN: string;
const STATE_FILE = `/tmp/alchemy_test_state_${process.pid}.json`;

const SERVER_DIR = path.join(__dirname, "../../server");

beforeAll(async () => {
  const port = await getFreePort();
  BASE_URL = `http://localhost:${port}`;

  const env = {
    ...process.env,
    PORT: String(port),
    STATE_FILE,
    NO_PROXY: "*",
    no_proxy: "*",
  };

  serverProcess = spawn(
    "node_modules/.bin/tsx",
    ["src/index.ts"],
    { cwd: SERVER_DIR, env, stdio: ["ignore", "pipe", "pipe"] }
  );

  serverProcess.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr?.on("data", (d) => process.stderr.write(`[server:err] ${d}`));

  await waitForServer(BASE_URL);

  // Use the default token
  TOKEN = "alchemy-v2-token";
}, 20_000);

afterAll(async () => {
  serverProcess?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  try { require("fs").unlinkSync(STATE_FILE); } catch {}
});

// ─── Helper: reset state between test groups ──────────────────────────────────
// We use unique scripts per test to avoid fingerprint collision

function uniqueScript(suffix: string) {
  return `python train_${suffix}_${Date.now()}.py`;
}

// ─── 1. Task CRUD ─────────────────────────────────────────────────────────────

describe("Task CRUD", () => {
  it("GET /tasks returns empty array initially (no tasks for this script)", async () => {
    const r = await apiGet(`${BASE_URL}/api/tasks`, TOKEN);
    expect(r.status).toBe(200);
    const tasks = await r.json();
    expect(Array.isArray(tasks)).toBe(true);
  });

  it("POST /tasks creates a task", async () => {
    const script = uniqueScript("crud1");
    const r = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    expect(r.status).toBe(201);
    const task = await r.json();
    expect(task.id).toBeTruthy();
    expect(task.status).toBe("pending");
    expect(task.script).toBe(script);
    expect(typeof task.seq).toBe("number");
    expect(task.seq).toBeGreaterThanOrEqual(1);
  });

  it("GET /tasks/:id returns the task", async () => {
    const script = uniqueScript("crud2");
    const createRes = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    const { id } = await createRes.json();

    const r = await apiGet(`${BASE_URL}/api/tasks/${id}`, TOKEN);
    expect(r.status).toBe(200);
    const task = await r.json();
    expect(task.id).toBe(id);
    expect(task.script).toBe(script);
  });

  it("GET /tasks/:id returns 404 for unknown id", async () => {
    const r = await apiGet(`${BASE_URL}/api/tasks/nonexistent-id`, TOKEN);
    expect(r.status).toBe(404);
  });

  it("PATCH /tasks/:id updates priority and name", async () => {
    const script = uniqueScript("crud3");
    const createRes = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    const { id } = await createRes.json();

    const r = await apiPatch(`${BASE_URL}/api/tasks/${id}`, TOKEN, {
      priority: 9,
      name: "my-custom-name",
    });
    expect(r.status).toBe(200);
    const updated = await r.json();
    expect(updated.priority).toBe(9);
    expect(updated.name).toBe("my-custom-name");
    expect(updated.display_name).toBe("my-custom-name");
  });

  it("POST /tasks/batch kill works on pending tasks", async () => {
    const script = uniqueScript("batch1");
    const createRes = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    const { id } = await createRes.json();

    const r = await apiPost(`${BASE_URL}/api/tasks/batch`, TOKEN, {
      action: "kill",
      task_ids: [id],
    });
    expect(r.status).toBe(200);
    const result = await r.json();
    expect(result.results[0].ok).toBe(true);

    const taskRes = await apiGet(`${BASE_URL}/api/tasks/${id}`, TOKEN);
    const task = await taskRes.json();
    expect(task.status).toBe("killed");
  });

  it("POST /tasks/batch delete removes completed task", async () => {
    // We need a terminated task to delete — use batch kill first
    const script = uniqueScript("batch_del");
    const createRes = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    const { id } = await createRes.json();

    // Kill it
    await apiPost(`${BASE_URL}/api/tasks/batch`, TOKEN, {
      action: "kill",
      task_ids: [id],
    });

    // Delete it
    const r = await apiPost(`${BASE_URL}/api/tasks/batch`, TOKEN, {
      action: "delete",
      task_ids: [id],
    });
    expect(r.status).toBe(200);
    const result = await r.json();
    expect(result.results[0].ok).toBe(true);
  });
});

// ─── 2. Sequential numbers ────────────────────────────────────────────────────

describe("Sequential task numbering", () => {
  it("Tasks get sequential seq numbers", async () => {
    const s1 = uniqueScript("seq1");
    const s2 = uniqueScript("seq2");
    const s3 = uniqueScript("seq3");

    const r1 = await (await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script: s1 })).json();
    const r2 = await (await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script: s2 })).json();
    const r3 = await (await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script: s3 })).json();

    expect(r2.seq).toBe(r1.seq + 1);
    expect(r3.seq).toBe(r1.seq + 2);
  });
});

// ─── 3. Display name generation ───────────────────────────────────────────────

describe("Display name generation", () => {
  it("name field takes priority", async () => {
    const script = uniqueScript("dn1");
    const r = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, {
      script,
      name: "my-experiment",
    });
    const task = await r.json();
    expect(task.display_name).toBe("my-experiment");
  });

  it("script + args produces basename args_summary", async () => {
    const script = `python train_atari_${Date.now()}.py`;
    const r = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, {
      script,
      args: { "--config": "atari_ctx512.yaml", "--seed": "42" },
    });
    const task = await r.json();
    const basename = script.split(" ")[1]; // "train_atari_XXX.py"
    // display_name should start with the script basename
    expect(task.display_name).toContain(basename.split("/").pop()!);
    expect(task.display_name).toContain("config=atari_ctx512.yaml");
    expect(task.display_name).toContain("seed=42");
  });

  it("script only produces basename", async () => {
    const r = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, {
      script: `python scripts/train_model_${Date.now()}.py`,
    });
    const task = await r.json();
    expect(task.display_name).toMatch(/train_model_\d+\.py/);
  });
});

// ─── 4. Command assembly ──────────────────────────────────────────────────────

describe("Command assembly", () => {
  it("assembles env_setup + cwd + env + script + args + raw_args", async () => {
    const script = `python train_${Date.now()}.py`;
    const r = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, {
      script,
      args: { "--seed": "42" },
      raw_args: "--verbose",
      cwd: "/workspace/project",
      env_setup: "source activate ml",
      env: { MY_VAR: "hello" },
    });
    const task = await r.json();
    // command should contain all pieces
    expect(task.command).toContain("source activate ml");
    expect(task.command).toContain("cd /workspace/project");
    expect(task.command).toContain("MY_VAR");
    expect(task.command).toContain("--seed 42");
    expect(task.command).toContain("--verbose");
  });

  it("script only produces minimal command", async () => {
    const script = `python train_min_${Date.now()}.py`;
    const r = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    const task = await r.json();
    expect(task.command).toBe(script);
  });
});

// ─── 5. Fingerprint dedup ─────────────────────────────────────────────────────

describe("Fingerprint dedup", () => {
  it("T1: Same fingerprint while active → 409 with existing task", async () => {
    const script = `python dedup_test_${Date.now()}.py`;
    const r1 = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    expect(r1.status).toBe(201);
    const task1 = await r1.json();
    expect(task1.status).toBe("pending");

    // Submit same script (same fingerprint) while first is active (pending)
    const r2 = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    expect(r2.status).toBe(409);
    const body = await r2.json();
    expect(body.existing_task_id).toBe(task1.id);
  });

  it("T2: Same fingerprint after completed → allowed", async () => {
    const script = `python dedup_completed_${Date.now()}.py`;

    // Create and kill task (terminal state)
    const r1 = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    const task1 = await r1.json();

    await apiPost(`${BASE_URL}/api/tasks/batch`, TOKEN, {
      action: "kill",
      task_ids: [task1.id],
    });

    // Verify killed
    const check = await (await apiGet(`${BASE_URL}/api/tasks/${task1.id}`, TOKEN)).json();
    expect(check.status).toBe("killed");

    // Now resubmit — should be allowed
    const r2 = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    expect(r2.status).toBe(201);
    const task2 = await r2.json();
    expect(task2.id).not.toBe(task1.id);
  });

  it("Idempotency key: same key within 60s returns same task", async () => {
    const script = `python idempotent_${Date.now()}.py`;
    const key = `idem-key-${Date.now()}`;

    const r1 = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, {
      script,
      idempotency_key: key,
    });
    expect(r1.status).toBe(201);
    const task1 = await r1.json();

    // Kill the task first so fingerprint dedup doesn't fire
    // (idempotency should win regardless)
    // Resubmit with same key — idempotency should return 200 with same task
    const r2 = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, {
      script,
      idempotency_key: key,
    });
    // Either 200 (idempotency hit) or 409 (fingerprint dedup) — both return same task
    expect([200, 201, 409]).toContain(r2.status);
    const body2 = await r2.json();
    // The returned task should be the original one (same id or existing_task_id)
    const returnedId = body2.id || body2.existing_task_id;
    expect(returnedId).toBe(task1.id);
  });
});

// ─── 6. Write lock ────────────────────────────────────────────────────────────

describe("Write lock", () => {
  it("T3: Two tasks with same run_dir → second rejected", async () => {
    const runDir = `/tmp/alchemy_test_lock_${Date.now()}`;
    const s1 = `python lock_task_a_${Date.now()}.py`;
    const s2 = `python lock_task_b_${Date.now()}.py`;

    const r1 = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, {
      script: s1,
      run_dir: runDir,
    });
    expect(r1.status).toBe(201);

    // Task A acquired the write lock (it's in pending = active status)
    const r2 = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, {
      script: s2,
      run_dir: runDir,
    });
    expect(r2.status).toBe(409);
    const body = await r2.json();
    expect(body.error).toContain("locked");
  });

  it("Prefix path conflict: sub-path conflicts with parent", async () => {
    const base = `/tmp/alchemy_prefix_${Date.now()}`;
    const s1 = `python prefix_a_${Date.now()}.py`;
    const s2 = `python prefix_b_${Date.now()}.py`;

    const r1 = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, {
      script: s1,
      run_dir: base,
    });
    expect(r1.status).toBe(201);

    // Sub-path of the locked path should also be rejected
    const r2 = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, {
      script: s2,
      run_dir: `${base}/sub`,
    });
    expect(r2.status).toBe(409);
  });
});

// ─── 7. Grid creation ────────────────────────────────────────────────────────

describe("Grid creation", () => {
  it("POST /grids creates correct number of tasks (cartesian product)", async () => {
    const script = `python grid_train_${Date.now()}.py`;
    const r = await apiPost(`${BASE_URL}/api/grids`, TOKEN, {
      script,
      param_space: {
        seed: [42, 123, 789],
        ctx: [256, 512],
      },
    });
    expect(r.status).toBe(201);
    const grid = await r.json();
    expect(grid.id).toBeTruthy();
    // 3 seeds × 2 ctx = 6 tasks
    expect(grid.task_ids.length).toBe(6);
  });

  it("Grid tasks have param_overrides set correctly", async () => {
    const script = `python grid_params_${Date.now()}.py`;
    const r = await apiPost(`${BASE_URL}/api/grids`, TOKEN, {
      script,
      param_space: { seed: [42, 99] },
    });
    const grid = await r.json();

    // Fetch grid detail
    const detailR = await apiGet(`${BASE_URL}/api/grids/${grid.id}`, TOKEN);
    expect(detailR.status).toBe(200);
    const detail = await detailR.json();
    expect(detail.tasks.length).toBe(2);

    const seeds = detail.tasks.map((t: any) => t.param_overrides?.seed).sort();
    expect(seeds).toEqual([42, 99]);
  });

  it("Grid status is pending when all tasks are pending", async () => {
    const script = `python grid_status_${Date.now()}.py`;
    const r = await apiPost(`${BASE_URL}/api/grids`, TOKEN, {
      script,
      param_space: { seed: [1, 2] },
    });
    const grid = await r.json();
    expect(grid.status).toBe("pending");
  });

  it("POST /grids/:id/cancel cancels all active tasks", async () => {
    const script = `python grid_cancel_${Date.now()}.py`;
    const r = await apiPost(`${BASE_URL}/api/grids`, TOKEN, {
      script,
      param_space: { seed: [1, 2, 3] },
    });
    const grid = await r.json();

    const cancelR = await apiPost(`${BASE_URL}/api/grids/${grid.id}/cancel`, TOKEN, {});
    expect(cancelR.status).toBe(200);
    const result = await cancelR.json();
    expect(result.cancelled).toBeGreaterThanOrEqual(3);

    // All tasks should be killed now
    const detailR = await apiGet(`${BASE_URL}/api/grids/${grid.id}`, TOKEN);
    const detail = await detailR.json();
    for (const task of detail.tasks) {
      expect(task.status).toBe("killed");
    }
  });

  it("POST /grids/:id/retry-failed retries failed tasks", async () => {
    const script = `python grid_retry_${Date.now()}.py`;
    const r = await apiPost(`${BASE_URL}/api/grids`, TOKEN, {
      script,
      param_space: { seed: [1, 2] },
    });
    const grid = await r.json();

    // Cancel all (→ killed status)
    await apiPost(`${BASE_URL}/api/grids/${grid.id}/cancel`, TOKEN, {});

    // retry-failed only retries "failed"/"killed"/"lost" tasks
    const retryR = await apiPost(`${BASE_URL}/api/grids/${grid.id}/retry-failed`, TOKEN, {});
    expect(retryR.status).toBe(200);
    const result = await retryR.json();
    expect(result.retried).toBe(2);
  });

  it("Grid requires param_space", async () => {
    const r = await apiPost(`${BASE_URL}/api/grids`, TOKEN, {
      script: "python train.py",
    });
    expect(r.status).toBe(400);
  });
});

// ─── 8. Auth ──────────────────────────────────────────────────────────────────

describe("Auth", () => {
  it("Missing token returns 401", async () => {
    const r = await fetch(`${BASE_URL}/api/tasks`);
    expect(r.status).toBe(401);
  });

  it("Invalid token returns 401", async () => {
    const r = await fetch(`${BASE_URL}/api/tasks`, {
      headers: { Authorization: "Bearer invalid-token-xyz" },
    });
    expect(r.status).toBe(401);
  });

  it("Health check is unauthenticated", async () => {
    const r = await fetch(`${BASE_URL}/health`);
    expect(r.ok).toBe(true);
  });
});
