/**
 * test_scenarios.test.ts — Real-world scenario tests: failure modes, edge cases, error states.
 *
 * Tests cover: auth failures, invalid input, concurrent stubs, tag routing,
 * task failure/retry, grid lifecycle, run_dir computation, state persistence,
 * dedup edge cases, write lock conflicts, stub disconnect during dispatch,
 * rapid reconnects, max_concurrent enforcement, priority scheduling.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import net from "net";
import fs from "fs";
import { io as ioClient, Socket } from "socket.io-client";

// Disable proxy
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

function headers(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function apiGet(url: string, token: string) {
  return fetch(url, { headers: headers(token) });
}

async function apiPost(url: string, token: string, body: any) {
  return fetch(url, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
}

async function apiPatch(url: string, token: string, body: any) {
  return fetch(url, { method: "PATCH", headers: headers(token), body: JSON.stringify(body) });
}

async function apiDelete(url: string, token: string) {
  return fetch(url, { method: "DELETE", headers: headers(token) });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function createStub(url: string): Socket {
  return ioClient(`${url}/stubs`, { transports: ["websocket"] });
}

async function connectStub(url: string): Promise<Socket> {
  const socket = createStub(url);
  await new Promise<void>((r, j) => {
    socket.on("connect", r);
    socket.on("connect_error", j);
    setTimeout(() => j(new Error("connect timeout")), 5000);
  });
  return socket;
}

function sendResume(socket: Socket, opts: {
  token: string;
  hostname: string;
  gpuName?: string;
  maxConcurrent?: number;
  runningTasks?: any[];
  localQueue?: string[];
  tags?: string[];
}) {
  socket.emit("resume", {
    hostname: opts.hostname,
    gpu: { name: opts.gpuName || "A40", vram_total_mb: 10240, count: 1 },
    max_concurrent: opts.maxConcurrent ?? 2,
    token: opts.token,
    running_tasks: opts.runningTasks ?? [],
    local_queue: opts.localQueue ?? [],
    lastSeq: 0,
    tags: opts.tags,
  });
}

function waitReliable(socket: Socket, event: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("r", handler);
      reject(new Error(`Timed out waiting for '${event}' after ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(msg: any) {
      if (msg.event === event) {
        clearTimeout(timer);
        socket.off("r", handler);
        socket.emit("r.ack", { seq: msg.seq });
        resolve(msg.payload);
      }
    }
    socket.on("r", handler);
  });
}

async function connectAndResume(url: string, token: string, opts: {
  hostname: string;
  gpuName?: string;
  maxConcurrent?: number;
  tags?: string[];
}): Promise<{ socket: Socket; stubId: string; resp: any }> {
  const socket = await connectStub(url);
  const resumeP = waitReliable(socket, "resume_response");
  sendResume(socket, { token, ...opts });
  const resp = await resumeP;
  return { socket, stubId: resp.stub_id, resp };
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let serverProcess: ChildProcess;
let BASE: string;
let TOKEN: string;
const STATE_FILE = `/tmp/alchemy_scenario_${process.pid}.json`;
const SERVER_DIR = path.join(__dirname, "../../server");

beforeAll(async () => {
  const port = await getFreePort();
  BASE = `http://localhost:${port}`;
  serverProcess = spawn("node_modules/.bin/tsx", ["src/index.ts"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(port), STATE_FILE, NO_PROXY: "*", no_proxy: "*" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout?.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  serverProcess.stderr?.on("data", (d) => process.stderr.write(`[srv:err] ${d}`));
  await waitForServer(BASE);
  TOKEN = "alchemy-v2-token";
}, 20_000);

afterAll(async () => {
  serverProcess?.kill("SIGTERM");
  await sleep(500);
  try { fs.unlinkSync(STATE_FILE); } catch {}
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. AUTH FAILURES
// ═══════════════════════════════════════════════════════════════════════════════

describe("Auth failures", () => {
  it("No token → 401", async () => {
    const r = await fetch(`${BASE}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script: "python test.py" }),
    });
    expect(r.status).toBe(401);
  });

  it("Wrong token → 401", async () => {
    const r = await apiPost(`${BASE}/api/tasks`, "wrong-token-xyz", { script: "python test.py" });
    expect(r.status).toBe(401);
  });

  it("Health endpoint works without auth", async () => {
    const r = await fetch(`${BASE}/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. INVALID INPUT
// ═══════════════════════════════════════════════════════════════════════════════

describe("Invalid input", () => {
  it("Empty body → 400", async () => {
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, {});
    expect(r.status).toBe(400);
  });

  it("Missing script → 400", async () => {
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { args: { "--seed": "42" } });
    expect(r.status).toBe(400);
  });

  it("Get nonexistent task → 404", async () => {
    const r = await apiGet(`${BASE}/api/tasks/nonexistent-uuid`, TOKEN);
    expect(r.status).toBe(404);
  });

  it("Get nonexistent stub → 404", async () => {
    const r = await apiGet(`${BASE}/api/stubs/nonexistent-stub`, TOKEN);
    expect(r.status).toBe(404);
  });

  it("Delete nonexistent token → 404", async () => {
    const r = await apiDelete(`${BASE}/api/tokens/nonexistent`, TOKEN);
    expect(r.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. TAG-BASED ROUTING
// ═══════════════════════════════════════════════════════════════════════════════

describe("Tag-based routing", () => {
  it("Task with target_tags dispatches only to matching stub", async () => {
    const ts = Date.now();

    // Stub A: has tag "fast-gpu"
    const { socket: stubA } = await connectAndResume(BASE, TOKEN, {
      hostname: `tag-a-${ts}`, gpuName: "A100", tags: ["fast-gpu"],
    });

    // Stub B: no matching tag
    const { socket: stubB } = await connectAndResume(BASE, TOKEN, {
      hostname: `tag-b-${ts}`, gpuName: "A30", tags: ["slow-gpu"],
    });

    // Submit task targeting "fast-gpu"
    const taskRunA = waitReliable(stubA, "task.run", 5000);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, {
      script: `python tag_test_${ts}.py`,
      target_tags: ["fast-gpu"],
    });
    expect(r.status).toBe(201);

    // Stub A should get it
    const payload = await taskRunA;
    expect(payload.task_id).toBeTruthy();
    expect(payload.command).toContain("tag_test");

    // Stub B should NOT get anything (give it a moment)
    let stubBGotTask = false;
    const bListener = (msg: any) => { if (msg.event === "task.run") stubBGotTask = true; };
    stubB.on("r", bListener);
    await sleep(500);
    stubB.off("r", bListener);
    expect(stubBGotTask).toBe(false);

    stubA.disconnect();
    stubB.disconnect();
  }, 15_000);

  it("Task with no target_tags dispatches to any stub", async () => {
    const ts = Date.now();
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `notag-${ts}`, gpuName: "A40", tags: ["whatever"],
    });

    const taskRunP = waitReliable(socket, "task.run", 5000);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, {
      script: `python notag_${ts}.py`,
    });
    expect(r.status).toBe(201);

    const payload = await taskRunP;
    expect(payload.task_id).toBeTruthy();

    socket.disconnect();
  }, 10_000);

  it("Task with unmatched tag stays pending", async () => {
    const ts = Date.now();
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `nomatch-${ts}`, gpuName: "A40", tags: ["gpu-a"],
    });

    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, {
      script: `python unmatch_${ts}.py`,
      target_tags: ["nonexistent-tag"],
    });
    expect(r.status).toBe(201);
    const task = await r.json();

    await sleep(500);
    const check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    const t = await check.json();
    expect(t.status).toBe("pending"); // Not dispatched — no matching stub

    socket.disconnect();
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. TASK FAILURE & EXIT CODES
// ═══════════════════════════════════════════════════════════════════════════════

describe("Task failure", () => {
  it("Non-zero exit → status=failed with exit_code", async () => {
    const ts = Date.now();
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `fail-${ts}`, gpuName: "A40",
    });

    const taskRunP = waitReliable(socket, "task.run", 5000);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python fail_${ts}.py` });
    const task = await r.json();
    const runPayload = await taskRunP;

    // started → failed
    socket.emit("r", { seq: 1, event: "task.started", payload: { task_id: runPayload.task_id, pid: 111 }, ts: Date.now() });
    await sleep(200);
    socket.emit("r", { seq: 2, event: "task.failed", payload: { task_id: runPayload.task_id, exit_code: 137, error: "OOM killed" }, ts: Date.now() });
    await sleep(300);

    const check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    const t = await check.json();
    expect(t.status).toBe("failed");
    expect(t.exit_code).toBe(137);
    expect(t.finished_at).toBeTruthy();

    socket.disconnect();
  }, 10_000);

  it("Failed task with same fingerprint can be re-submitted", async () => {
    const ts = Date.now();
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `resubmit-${ts}`, gpuName: "A40",
    });

    const script = `python resubmit_${ts}.py`;

    // Submit first
    const run1P = waitReliable(socket, "task.run", 5000);
    const r1 = await apiPost(`${BASE}/api/tasks`, TOKEN, { script });
    expect(r1.status).toBe(201);
    const t1 = await r1.json();
    const payload1 = await run1P;

    // Mark failed
    socket.emit("r", { seq: 1, event: "task.started", payload: { task_id: payload1.task_id, pid: 222 }, ts: Date.now() });
    await sleep(200);
    socket.emit("r", { seq: 2, event: "task.failed", payload: { task_id: payload1.task_id, exit_code: 1 }, ts: Date.now() });
    await sleep(300);

    // Re-submit same script → should succeed (dedup allows re-run of failed)
    const run2P = waitReliable(socket, "task.run", 5000);
    const r2 = await apiPost(`${BASE}/api/tasks`, TOKEN, { script });
    expect(r2.status).toBe(201);
    const t2 = await r2.json();
    expect(t2.id).not.toBe(t1.id); // New task
    expect(t2.fingerprint).toBe(t1.fingerprint); // Same fingerprint

    await run2P; // dispatched
    socket.disconnect();
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. RUN_DIR SERVER-COMPUTED
// ═══════════════════════════════════════════════════════════════════════════════

describe("run_dir computed by server", () => {
  it("task.run payload always includes run_dir", async () => {
    const ts = Date.now();
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `rundir-${ts}`, gpuName: "A40",
    });

    const taskRunP = waitReliable(socket, "task.run", 5000);
    await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python rundir_${ts}.py` });
    const payload = await taskRunP;

    expect(payload.run_dir).toBeTruthy();
    expect(typeof payload.run_dir).toBe("string");
    // run_dir should contain fingerprint[:12]
    expect(payload.run_dir.length).toBeGreaterThan(10);

    socket.disconnect();
  }, 10_000);

  it("Same fingerprint → same run_dir", async () => {
    const ts = Date.now();
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `samerundir-${ts}`, gpuName: "A40",
    });

    const script = `python samefp_${ts}.py`;

    // First task
    const run1P = waitReliable(socket, "task.run", 5000);
    const r1 = await apiPost(`${BASE}/api/tasks`, TOKEN, { script });
    const t1 = await r1.json();
    const p1 = await run1P;

    // Complete it
    socket.emit("r", { seq: 1, event: "task.started", payload: { task_id: p1.task_id, pid: 333 }, ts: Date.now() });
    await sleep(200);
    socket.emit("r", { seq: 2, event: "task.completed", payload: { task_id: p1.task_id, exit_code: 0 }, ts: Date.now() });
    await sleep(300);

    // Second task with same script
    const run2P = waitReliable(socket, "task.run", 5000);
    const r2 = await apiPost(`${BASE}/api/tasks`, TOKEN, { script });
    const p2 = await run2P;

    // Same fingerprint → same run_dir
    expect(p2.run_dir).toBe(p1.run_dir);

    socket.disconnect();
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. DEDUP EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe("Dedup edge cases", () => {
  it("Same script with different args → different fingerprint → both allowed", async () => {
    const ts = Date.now();
    const script = `python dedup_args_${ts}.py`;

    const r1 = await apiPost(`${BASE}/api/tasks`, TOKEN, { script, args: { "--seed": "1" } });
    const r2 = await apiPost(`${BASE}/api/tasks`, TOKEN, { script, args: { "--seed": "2" } });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const t1 = await r1.json();
    const t2 = await r2.json();
    expect(t1.fingerprint).not.toBe(t2.fingerprint);
  });

  it("Duplicate active task → 409", async () => {
    const ts = Date.now();
    const script = `python dedup_active_${ts}.py`;

    const r1 = await apiPost(`${BASE}/api/tasks`, TOKEN, { script });
    expect(r1.status).toBe(201);

    const r2 = await apiPost(`${BASE}/api/tasks`, TOKEN, { script });
    expect(r2.status).toBe(409);
  });

  it("Idempotency key — same key within window → same task", async () => {
    const ts = Date.now();
    const ikey = `idem-${ts}`;
    const script = `python idem_${ts}.py`;

    const r1 = await apiPost(`${BASE}/api/tasks`, TOKEN, {
      script, idempotency_key: ikey,
    });
    const r2 = await apiPost(`${BASE}/api/tasks`, TOKEN, {
      script, idempotency_key: ikey,
    });
    expect(r1.status).toBe(201);
    // Second should return the same task (idempotent)
    const t1 = await r1.json();
    const t2 = await r2.json();
    expect(t2.id).toBe(t1.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. MAX_CONCURRENT ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════════════════

describe("max_concurrent enforcement", () => {
  it("Stub with max_concurrent=1 only gets 1 task at a time", async () => {
    const ts = Date.now();
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `maxcon1-${ts}`, gpuName: "A40", maxConcurrent: 1,
    });

    // Submit first task
    const run1P = waitReliable(socket, "task.run", 5000);
    await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python mc1_a_${ts}.py` });
    const p1 = await run1P;

    // Mark running
    socket.emit("r", { seq: 1, event: "task.started", payload: { task_id: p1.task_id, pid: 444 }, ts: Date.now() });
    await sleep(200);

    // Submit second task — should NOT be dispatched to this stub (at capacity)
    await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python mc1_b_${ts}.py` });

    let gotSecondTask = false;
    const handler = (msg: any) => { if (msg.event === "task.run") gotSecondTask = true; };
    socket.on("r", handler);
    await sleep(800);
    socket.off("r", handler);
    expect(gotSecondTask).toBe(false);

    // Complete first task
    socket.emit("r", { seq: 2, event: "task.completed", payload: { task_id: p1.task_id, exit_code: 0 }, ts: Date.now() });

    // Now second task should get dispatched
    const run2P = waitReliable(socket, "task.run", 5000);
    const p2 = await run2P;
    expect(p2.task_id).toBeTruthy();

    socket.disconnect();
  }, 20_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. PRIORITY SCHEDULING
// ═══════════════════════════════════════════════════════════════════════════════

describe("Priority scheduling", () => {
  it("Higher priority task dispatches first", async () => {
    const ts = Date.now();

    // Submit tasks BEFORE stub connects → both pending
    const rLow = await apiPost(`${BASE}/api/tasks`, TOKEN, {
      script: `python pri_low_${ts}.py`, priority: 1,
    });
    const rHigh = await apiPost(`${BASE}/api/tasks`, TOKEN, {
      script: `python pri_high_${ts}.py`, priority: 10,
    });
    expect(rLow.status).toBe(201);
    expect(rHigh.status).toBe(201);
    const tLow = await rLow.json();
    const tHigh = await rHigh.json();

    // Connect stub with max_concurrent=1
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `priority-${ts}`, gpuName: "A40", maxConcurrent: 1,
    });

    // Wait for task dispatch — should be the HIGH priority one
    const runP = waitReliable(socket, "task.run", 5000);
    const payload = await runP;
    expect(payload.task_id).toBe(tHigh.id);

    socket.disconnect();
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. STUB DISCONNECT DURING DISPATCH
// ═══════════════════════════════════════════════════════════════════════════════

describe("Stub disconnect during task lifecycle", () => {
  it("Stub disconnects with running task → task marked lost", async () => {
    const ts = Date.now();
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `disclost-${ts}`, gpuName: "A40",
    });

    const runP = waitReliable(socket, "task.run", 5000);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python disclost_${ts}.py` });
    const task = await r.json();
    const payload = await runP;

    socket.emit("r", { seq: 1, event: "task.started", payload: { task_id: payload.task_id, pid: 555 }, ts: Date.now() });
    await sleep(200);

    // Disconnect abruptly
    socket.disconnect();
    await sleep(500);

    const check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    const t = await check.json();
    expect(t.status).toBe("lost");

    // Can resubmit lost task
    const r2 = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python disclost_${ts}.py` });
    expect(r2.status).toBe(201);
  }, 10_000);

  it("Stub disconnects with dispatched (not started) task → task goes back to pending", async () => {
    const ts = Date.now();
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `discpend-${ts}`, gpuName: "A40",
    });

    const runP = waitReliable(socket, "task.run", 5000);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python discpend_${ts}.py` });
    const task = await r.json();
    await runP; // dispatched but NOT started

    // Disconnect without ever sending task.started
    socket.disconnect();
    await sleep(500);

    const check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    const t = await check.json();
    // Dispatched tasks should go back to pending or lost
    expect(["pending", "lost"]).toContain(t.status);
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. RAPID RECONNECT
// ═══════════════════════════════════════════════════════════════════════════════

describe("Rapid reconnect", () => {
  it("Same stub reconnects 3 times rapidly → server handles gracefully", async () => {
    const ts = Date.now();
    const hostname = `rapid-${ts}`;
    let lastStubId = "";

    for (let i = 0; i < 3; i++) {
      const { socket, stubId } = await connectAndResume(BASE, TOKEN, {
        hostname, gpuName: "A40",
      });
      if (lastStubId) expect(stubId).toBe(lastStubId); // Same identity
      lastStubId = stubId;
      socket.disconnect();
      await sleep(200);
    }

    // Verify stub is offline
    const stubs = await (await apiGet(`${BASE}/api/stubs`, TOKEN)).json();
    const stub = stubs.find((s: any) => s.hostname === hostname);
    expect(stub).toBeTruthy();
    expect(stub.status).toBe("offline");
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. GRID LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Grid lifecycle", () => {
  it("Grid generates cartesian product of params", async () => {
    const ts = Date.now();
    const r = await apiPost(`${BASE}/api/grids`, TOKEN, {
      script: `python grid_${ts}.py`,
      param_space: { seed: [1, 2, 3], lr: [0.01, 0.1] },
    });
    expect(r.status).toBe(201);
    const grid = await r.json();

    expect(grid.task_ids.length).toBe(6); // 3 × 2

    // Each task should have unique param_overrides
    const tasks = await Promise.all(
      grid.task_ids.map(async (id: string) => {
        const tr = await apiGet(`${BASE}/api/tasks/${id}`, TOKEN);
        return tr.json();
      })
    );

    const paramSets = tasks.map((t: any) => JSON.stringify(t.param_overrides));
    const unique = new Set(paramSets);
    expect(unique.size).toBe(6);
  }, 10_000);

  it("Grid with target_tags → all tasks inherit target_tags", async () => {
    const ts = Date.now();
    const r = await apiPost(`${BASE}/api/grids`, TOKEN, {
      script: `python grid_tag_${ts}.py`,
      param_space: { seed: [42] },
      target_tags: ["a100-cluster"],
    });
    expect(r.status).toBe(201);
    const grid = await r.json();

    const taskR = await apiGet(`${BASE}/api/tasks/${grid.task_ids[0]}`, TOKEN);
    const task = await taskR.json();
    expect(task.target_tags).toEqual(["a100-cluster"]);
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. TOKEN MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

describe("Token management", () => {
  it("Create, list, delete token lifecycle", async () => {
    // Create
    const cr = await apiPost(`${BASE}/api/tokens`, TOKEN, { name: "test-token" });
    expect(cr.status).toBe(201);
    const created = await cr.json();
    expect(created.name).toBe("test-token");
    expect(created.token).toBeTruthy();
    expect(created.token.startsWith("tk_")).toBe(true);

    // List — should see it
    const lr = await apiGet(`${BASE}/api/tokens`, TOKEN);
    const tokens = await lr.json();
    const found = tokens.find((t: any) => t.name === "test-token");
    expect(found).toBeTruthy();
    // Token value should NOT be exposed in list
    expect(found.token).toBeUndefined();

    // New token works for auth
    const testR = await apiGet(`${BASE}/api/tasks`, created.token);
    expect(testR.status).toBe(200);

    // Delete
    const dr = await apiDelete(`${BASE}/api/tokens/test-token`, TOKEN);
    expect(dr.status).toBe(200);

    // Deleted token no longer works
    const failR = await apiGet(`${BASE}/api/tasks`, created.token);
    expect(failR.status).toBe(401);
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. STUB TAGS UPDATE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Stub tags update", () => {
  it("PATCH /stubs/:id updates tags", async () => {
    const ts = Date.now();
    const { socket, stubId } = await connectAndResume(BASE, TOKEN, {
      hostname: `tagupd-${ts}`, gpuName: "A40", tags: ["old-tag"],
    });

    const pr = await apiPatch(`${BASE}/api/stubs/${stubId}`, TOKEN, {
      tags: ["new-tag", "another-tag"],
    });
    expect(pr.status).toBe(200);

    const sr = await apiGet(`${BASE}/api/stubs/${stubId}`, TOKEN);
    const stub = await sr.json();
    expect(stub.tags).toEqual(["new-tag", "another-tag"]);

    socket.disconnect();
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. TASK KILL
// ═══════════════════════════════════════════════════════════════════════════════

describe("Task kill via API", () => {
  it("PATCH task to killed → stub receives should_stop signal (kill chain start)", async () => {
    const ts = Date.now();
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `kill-${ts}`, gpuName: "A40",
    });

    const runP = waitReliable(socket, "task.run", 5000);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python kill_${ts}.py` });
    const task = await r.json();
    const payload = await runP;

    socket.emit("r", { seq: 1, event: "task.started", payload: { task_id: payload.task_id, pid: 666 }, ts: Date.now() });
    await sleep(200);

    // Kill chain: first sends task.signal should_stop, then task.kill after 30s grace
    const signalP = waitReliable(socket, "task.signal", 5000);

    // Kill via API
    await apiPatch(`${BASE}/api/tasks/${task.id}`, TOKEN, { status: "killed" });

    const signalPayload = await signalP;
    expect(signalPayload.task_id).toBe(task.id);
    expect(signalPayload.signal).toBe("should_stop");

    socket.disconnect();
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 15. COMMAND ASSEMBLY
// ═══════════════════════════════════════════════════════════════════════════════

describe("Command assembly", () => {
  it("Full command with env_setup + cwd + args + raw_args", async () => {
    const ts = Date.now();
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, {
      script: `python train_${ts}.py`,
      args: { "--lr": "0.001", "--seed": "42" },
      raw_args: "--verbose",
      cwd: "/tmp/workdir",
      env_setup: "source activate myenv",
    });
    expect(r.status).toBe(201);
    const task = await r.json();
    const cmd = task.command;

    expect(cmd).toContain("source activate myenv");
    expect(cmd).toContain("cd /tmp/workdir");
    expect(cmd).toContain(`python train_${ts}.py`);
    expect(cmd).toContain("--lr 0.001");
    expect(cmd).toContain("--seed 42");
    expect(cmd).toContain("--verbose");
  });

  it("Task with env vars injects them in command", async () => {
    const ts = Date.now();
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, {
      script: `python env_${ts}.py`,
      env: { CUDA_VISIBLE_DEVICES: "0,1" },
    });
    expect(r.status).toBe(201);
    const task = await r.json();
    expect(task.command).toContain("CUDA_VISIBLE_DEVICES");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 16. MULTIPLE STUBS — LOAD BALANCING
// ═══════════════════════════════════════════════════════════════════════════════

describe("Multiple stubs load balancing", () => {
  it("Tasks distribute across stubs based on capacity", async () => {
    const ts = Date.now();

    const { socket: s1 } = await connectAndResume(BASE, TOKEN, {
      hostname: `lb-a-${ts}`, gpuName: "A40", maxConcurrent: 1,
    });
    const { socket: s2 } = await connectAndResume(BASE, TOKEN, {
      hostname: `lb-b-${ts}`, gpuName: "A40", maxConcurrent: 1,
    });

    // Submit first task, wait for dispatch, mark running, then submit second
    const run1 = waitReliable(s1, "task.run", 5000).catch(() => null);
    const run1b = waitReliable(s2, "task.run", 5000).catch(() => null);

    await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python lb_1_${ts}.py` });

    // One of the stubs gets it
    const first = await Promise.race([run1, run1b]);
    expect(first.task_id).toBeTruthy();

    // Mark first task as running so that stub is at capacity
    const firstSocket = first === await run1 ? s1 : s2;
    firstSocket.emit("r", {
      seq: 1, event: "task.started",
      payload: { task_id: first.task_id, pid: 8888 }, ts: Date.now(),
    });
    await sleep(300);

    // Submit second task — should go to the other stub
    await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python lb_2_${ts}.py` });
    await sleep(500);

    // Verify both stubs have tasks assigned
    const stubsR = await apiGet(`${BASE}/api/stubs`, TOKEN);
    const stubs = await stubsR.json();
    const lbStubs = stubs.filter((s: any) => s.hostname.startsWith("lb-"));
    const withTasks = lbStubs.filter((s: any) => s.tasks && s.tasks.length > 0);
    expect(withTasks.length).toBe(2);

    s1.disconnect();
    s2.disconnect();
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 17. LOG BUFFER
// ═══════════════════════════════════════════════════════════════════════════════

describe("Log buffer", () => {
  it("task.log lines accumulate in buffer", async () => {
    const ts = Date.now();
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `logbuf-${ts}`, gpuName: "A40",
    });

    const runP = waitReliable(socket, "task.run", 5000);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python logbuf_${ts}.py` });
    const task = await r.json();
    const payload = await runP;

    socket.emit("r", { seq: 1, event: "task.started", payload: { task_id: payload.task_id, pid: 777 }, ts: Date.now() });
    await sleep(200);

    // Send log lines
    socket.emit("task.log", { task_id: payload.task_id, lines: ["epoch 1 loss=0.5", "epoch 2 loss=0.3"] });
    await sleep(300);

    const check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    const t = await check.json();
    expect(t.log_buffer.length).toBeGreaterThanOrEqual(2);
    expect(t.log_buffer).toContain("epoch 1 loss=0.5");

    socket.disconnect();
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 18. SEQ NUMBERS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Seq numbers", () => {
  it("Tasks get monotonically increasing seq", async () => {
    const ts = Date.now();

    const r1 = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python seq_a_${ts}.py` });
    const r2 = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python seq_b_${ts}.py` });
    const r3 = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python seq_c_${ts}.py` });

    const t1 = await r1.json();
    const t2 = await r2.json();
    const t3 = await r3.json();

    expect(t2.seq).toBe(t1.seq + 1);
    expect(t3.seq).toBe(t2.seq + 1);
  });
});
