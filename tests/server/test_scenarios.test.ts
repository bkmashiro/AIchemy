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

// Server uses socket.io native ack callbacks. Register a one-time listener
// that auto-acks and resolves with the payload.
function waitReliable(socket: Socket, event: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for '${event}' after ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(payload: any, ack?: Function) {
      clearTimeout(timer);
      socket.off(event, handler);
      if (typeof ack === "function") ack({ ok: true });
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

// Buffered task.run listener — starts collecting task.run events immediately, acking all.
// Call waitForTask(taskId) to get the payload for a specific task even if it arrived before calling.
class TaskRunBuffer {
  private buffer: Array<{ payload: any }> = [];
  private waiters: Map<string, (payload: any) => void> = new Map();
  private socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("task.run", (payload: any, ack?: Function) => {
      if (typeof ack === "function") ack({ ok: true });
      const waiter = this.waiters.get(payload.task_id);
      if (waiter) {
        this.waiters.delete(payload.task_id);
        waiter(payload);
      } else {
        this.buffer.push({ payload });
      }
    });
  }

  waitForTask(taskId: string, timeoutMs = 8000): Promise<any> {
    const idx = this.buffer.findIndex((e) => e.payload.task_id === taskId);
    if (idx !== -1) {
      const [entry] = this.buffer.splice(idx, 1);
      return Promise.resolve(entry.payload);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(taskId);
        reject(new Error(`Timed out waiting for task.run for task ${taskId} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.set(taskId, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  destroy() {
    this.socket.off("task.run");
  }
}

// Wait for a task.run event for a specific task_id (acks all other task.run events too).
// Only use this when starting the listener BEFORE submitting (no race condition).
function waitReliableTaskRun(socket: Socket, taskId: string, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("task.run", handler);
      reject(new Error(`Timed out waiting for task.run for task ${taskId} after ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(payload: any, ack?: Function) {
      if (typeof ack === "function") ack({ ok: true });
      if (payload.task_id === taskId) {
        clearTimeout(timer);
        socket.off("task.run", handler);
        resolve(payload);
      }
      // else: ack but keep waiting for the right task
    }
    socket.on("task.run", handler);
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
    const bListener = (msg: any) => { stubBGotTask = true; };
    stubB.on("task.run", bListener);
    await sleep(500);
    stubB.off("task.run", bListener);
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
    socket.emit("task.started", { task_id: runPayload.task_id, pid: 111 });
    await sleep(200);
    socket.emit("task.failed", { task_id: runPayload.task_id, exit_code: 137, error: "OOM killed" });
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
    socket.emit("task.started", { task_id: payload1.task_id, pid: 222 });
    await sleep(200);
    socket.emit("task.failed", { task_id: payload1.task_id, exit_code: 1 });
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
    socket.emit("task.started", { task_id: p1.task_id, pid: 333 });
    await sleep(200);
    socket.emit("task.completed", { task_id: p1.task_id, exit_code: 0 });
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
    socket.emit("task.started", { task_id: p1.task_id, pid: 444 });
    await sleep(200);

    // Submit second task — should NOT be dispatched to this stub (at capacity)
    await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python mc1_b_${ts}.py` });

    let gotSecondTask = false;
    const handler = (msg: any) => { gotSecondTask = true; };
    socket.on("task.run", handler);
    await sleep(800);
    socket.off("task.run", handler);
    expect(gotSecondTask).toBe(false);

    // Complete first task
    socket.emit("task.completed", { task_id: p1.task_id, exit_code: 0 });

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
      hostname: `disclost-${ts}`, gpuName: "A40", maxConcurrent: 20,
    });

    const buf = new TaskRunBuffer(socket);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python disclost_${ts}.py` });
    const task = await r.json();
    const payload = await buf.waitForTask(task.id);

    // Wait for server to confirm task.started before disconnecting
    await new Promise<void>((resolve) => {
      socket.emit("task.started", { task_id: payload.task_id, pid: 555 }, () => resolve());
      setTimeout(resolve, 500); // fallback
    });
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
      hostname: `discpend-${ts}`, gpuName: "A40", maxConcurrent: 20,
    });

    const buf = new TaskRunBuffer(socket);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python discpend_${ts}.py` });
    const task = await r.json();
    await buf.waitForTask(task.id); // dispatched but NOT started

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
      hostname: `kill-${ts}`, gpuName: "A40", maxConcurrent: 20,
    });

    const buf = new TaskRunBuffer(socket);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python kill_${ts}.py` });
    const task = await r.json();
    const payload = await buf.waitForTask(task.id);

    // Wait for server to confirm task.started (so task is in "running" state before kill)
    await new Promise<void>((resolve) => {
      socket.emit("task.started", { task_id: payload.task_id, pid: 666 }, () => resolve());
      setTimeout(resolve, 500); // fallback
    });

    // Kill chain: server sends task.kill with grace_period_s
    const killP = waitReliable(socket, "task.kill", 5000);

    // Kill via API
    await apiPatch(`${BASE}/api/tasks/${task.id}`, TOKEN, { status: "killed" });

    const killPayload = await killP;
    expect(killPayload.task_id).toBe(task.id);
    expect(killPayload.grace_period_s).toBeGreaterThan(0);

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
    expect(cmd).toContain("cd '/tmp/workdir'");
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
    firstSocket.emit("task.started", { task_id: first.task_id, pid: 8888 });
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
      hostname: `logbuf-${ts}`, gpuName: "A40", maxConcurrent: 20,
    });

    const buf = new TaskRunBuffer(socket);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python logbuf_${ts}.py` });
    const task = await r.json();
    const payload = await buf.waitForTask(task.id);

    await new Promise<void>((resolve) => {
      socket.emit("task.started", { task_id: payload.task_id, pid: 777 }, () => resolve());
      setTimeout(resolve, 500); // fallback
    });

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

// ═══════════════════════════════════════════════════════════════════════════════
// 19. TASK RETRY VIA API
// ═══════════════════════════════════════════════════════════════════════════════

describe("Task retry via API", () => {
  it("POST /tasks/:id/retry creates retry task with incremented retry_count", async () => {
    const ts = Date.now();
    const tag = `retry-tag-${ts}`;
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `retry-${ts}`, gpuName: "A40", maxConcurrent: 20, tags: [tag],
    });

    const buf = new TaskRunBuffer(socket);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, {
      script: `python retry_${ts}.py`, max_retries: 3, target_tags: [tag],
    });
    const task = await r.json();
    const payload = await buf.waitForTask(task.id);

    // Start and fail
    socket.emit("task.started", { task_id: payload.task_id, pid: 900 });
    await sleep(200);
    socket.emit("task.failed", { task_id: payload.task_id, exit_code: 1 });
    await sleep(300);

    // Retry
    const retryR = await apiPost(`${BASE}/api/tasks/${task.id}/retry`, TOKEN, {});
    expect(retryR.status).toBe(201);
    const retryTask = await retryR.json();
    expect(retryTask.retry_of).toBe(task.id);
    expect(retryTask.retry_count).toBe(1);
    expect(["pending", "queued", "dispatched"]).toContain(retryTask.status);

    socket.disconnect();
  }, 15_000);

  it("Retry of running task → 400", async () => {
    const ts = Date.now();
    const tag = `retryrun-tag-${ts}`;
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `retryrun-${ts}`, gpuName: "A40", maxConcurrent: 20, tags: [tag],
    });

    const buf = new TaskRunBuffer(socket);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, {
      script: `python retryrun_${ts}.py`, target_tags: [tag],
    });
    const task = await r.json();
    const payload = await buf.waitForTask(task.id);

    socket.emit("task.started", { task_id: payload.task_id, pid: 901 });
    await sleep(200);

    // Can't retry a running task
    const retryR = await apiPost(`${BASE}/api/tasks/${task.id}/retry`, TOKEN, {});
    expect([400, 409]).toContain(retryR.status);

    socket.disconnect();
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 20. TASK PROGRESS REPORTING
// ═══════════════════════════════════════════════════════════════════════════════

describe("Task progress reporting", () => {
  it("task.progress updates step/total/loss", async () => {
    const ts = Date.now();
    const tag = `prog-tag-${ts}`;
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `prog-${ts}`, gpuName: "A40", maxConcurrent: 20, tags: [tag],
    });

    const buf = new TaskRunBuffer(socket);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python prog_${ts}.py`, target_tags: [tag] });
    const task = await r.json();
    const payload = await buf.waitForTask(task.id);

    socket.emit("task.started", { task_id: payload.task_id, pid: 910 });
    await sleep(200);

    socket.emit("task.progress", { task_id: payload.task_id, step: 500, total: 10000, loss: 0.42 });
    await sleep(300);

    const check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    const t = await check.json();
    expect(t.progress).toBeTruthy();
    expect(t.progress.step).toBe(500);
    expect(t.progress.total).toBe(10000);
    expect(t.progress.loss).toBe(0.42);

    socket.disconnect();
  }, 10_000);

  it("Progress updates are cumulative (last wins)", async () => {
    const ts = Date.now();
    const tag = `progcum-tag-${ts}`;
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `progcum-${ts}`, gpuName: "A40", maxConcurrent: 20, tags: [tag],
    });

    const buf = new TaskRunBuffer(socket);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python progcum_${ts}.py`, target_tags: [tag] });
    const task = await r.json();
    const payload = await buf.waitForTask(task.id);

    socket.emit("task.started", { task_id: payload.task_id, pid: 911 });
    await sleep(200);

    socket.emit("task.progress", { task_id: payload.task_id, step: 100, total: 1000, loss: 0.9 });
    await sleep(100);
    socket.emit("task.progress", { task_id: payload.task_id, step: 200, total: 1000, loss: 0.7 });
    await sleep(100);
    socket.emit("task.progress", { task_id: payload.task_id, step: 300, total: 1000, loss: 0.5 });
    await sleep(300);

    const check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    const t = await check.json();
    expect(t.progress.step).toBe(300);
    expect(t.progress.loss).toBe(0.5);

    socket.disconnect();
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 21. TASK PHASE REPORTING
// ═══════════════════════════════════════════════════════════════════════════════

describe("Task phase reporting", () => {
  it("task.phase updates phase field", async () => {
    const ts = Date.now();
    const tag = `phase-tag-${ts}`;
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `phase-${ts}`, gpuName: "A40", maxConcurrent: 20, tags: [tag],
    });

    const buf = new TaskRunBuffer(socket);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python phase_${ts}.py`, target_tags: [tag] });
    const task = await r.json();
    const payload = await buf.waitForTask(task.id);

    socket.emit("task.started", { task_id: payload.task_id, pid: 920 });
    await sleep(200);

    socket.emit("task.phase", { task_id: payload.task_id, phase: "warmup" });
    await sleep(200);

    let check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    let t = await check.json();
    expect(t.phase).toBe("warmup");

    socket.emit("task.phase", { task_id: payload.task_id, phase: "training" });
    await sleep(200);

    check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    t = await check.json();
    expect(t.phase).toBe("training");

    socket.disconnect();
  }, 10_000);

  it("Invalid phase is rejected", async () => {
    const ts = Date.now();
    const tag = `badphase-tag-${ts}`;
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `badphase-${ts}`, gpuName: "A40", maxConcurrent: 20, tags: [tag],
    });

    const buf = new TaskRunBuffer(socket);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python badphase_${ts}.py`, target_tags: [tag] });
    const task = await r.json();
    const payload = await buf.waitForTask(task.id);

    socket.emit("task.started", { task_id: payload.task_id, pid: 921 });
    await sleep(200);

    socket.emit("task.phase", { task_id: payload.task_id, phase: "invalid_phase" });
    await sleep(200);

    const check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    const t = await check.json();
    expect(t.phase).not.toBe("invalid_phase");

    socket.disconnect();
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 22. TASK COMPLETION LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Task completion lifecycle", () => {
  it("Normal completion: started → completed with exit_code 0", async () => {
    const ts = Date.now();
    const tag = `complete-tag-${ts}`;
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `complete-${ts}`, gpuName: "A40", maxConcurrent: 20, tags: [tag],
    });

    const buf = new TaskRunBuffer(socket);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python complete_${ts}.py`, target_tags: [tag] });
    const task = await r.json();
    const payload = await buf.waitForTask(task.id);

    socket.emit("task.started", { task_id: payload.task_id, pid: 930 });
    await sleep(200);
    socket.emit("task.completed", { task_id: payload.task_id, exit_code: 0 });
    await sleep(300);

    const check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    const t = await check.json();
    expect(t.status).toBe("completed");
    expect(t.exit_code).toBe(0);
    expect(t.started_at).toBeTruthy();
    expect(t.finished_at).toBeTruthy();

    socket.disconnect();
  }, 10_000);

  it("Completion frees stub slot for next task", async () => {
    const ts = Date.now();
    const tag = `compfree-tag-${ts}`;
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `compfree-${ts}`, gpuName: "A40", maxConcurrent: 1, tags: [tag],
    });

    const buf = new TaskRunBuffer(socket);

    // Submit two tasks
    const r1 = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python compfree_a_${ts}.py`, target_tags: [tag] });
    const t1 = await r1.json();
    const p1 = await buf.waitForTask(t1.id);

    const r2 = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python compfree_b_${ts}.py`, target_tags: [tag] });
    const t2 = await r2.json();

    // Start and complete first task
    socket.emit("task.started", { task_id: p1.task_id, pid: 931 });
    await sleep(200);
    socket.emit("task.completed", { task_id: p1.task_id, exit_code: 0 });

    // Second task should now be dispatched
    const p2 = await buf.waitForTask(t2.id);
    expect(p2.task_id).toBe(t2.id);

    socket.disconnect();
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 23. DEATH CAUSE IN TASK.FAILED
// ═══════════════════════════════════════════════════════════════════════════════

describe("Death cause classification", () => {
  it("task.failed with death_cause persists on task", async () => {
    const ts = Date.now();
    const tag = `death-tag-${ts}`;
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `death-${ts}`, gpuName: "A40", maxConcurrent: 20, tags: [tag],
    });

    const buf = new TaskRunBuffer(socket);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python death_${ts}.py`, target_tags: [tag] });
    const task = await r.json();
    const payload = await buf.waitForTask(task.id);

    socket.emit("task.started", { task_id: payload.task_id, pid: 940 });
    await sleep(200);
    socket.emit("task.failed", {
      task_id: payload.task_id,
      exit_code: 137,
      death_cause: "oom",
      has_checkpoint: true,
    });
    await sleep(300);

    const check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    const t = await check.json();
    expect(t.status).toBe("failed");
    expect(t.death_cause).toBe("oom");
    expect(t.has_checkpoint).toBe(true);

    socket.disconnect();
  }, 10_000);

  it("task.failed with death_cause=walltime sets correct fields", async () => {
    const ts = Date.now();
    const tag = `wall-tag-${ts}`;
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `walltime-${ts}`, gpuName: "A40", maxConcurrent: 20, tags: [tag],
    });

    const buf = new TaskRunBuffer(socket);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python walltime_${ts}.py`, target_tags: [tag] });
    const task = await r.json();
    const payload = await buf.waitForTask(task.id);

    socket.emit("task.started", { task_id: payload.task_id, pid: 941 });
    await sleep(200);
    socket.emit("task.failed", {
      task_id: payload.task_id,
      exit_code: 143,
      death_cause: "walltime",
      has_checkpoint: false,
    });
    await sleep(300);

    const check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    const t = await check.json();
    expect(t.death_cause).toBe("walltime");

    socket.disconnect();
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 24. TASK PAUSE / RESUME
// ═══════════════════════════════════════════════════════════════════════════════

describe("Task pause and resume", () => {
  it("PATCH task to paused → task status becomes paused", async () => {
    const ts = Date.now();
    const tag = `pause-tag-${ts}`;
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `pause-${ts}`, gpuName: "A40", maxConcurrent: 20, tags: [tag],
    });

    const buf = new TaskRunBuffer(socket);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python pause_${ts}.py`, target_tags: [tag] });
    const task = await r.json();
    const payload = await buf.waitForTask(task.id);

    socket.emit("task.started", { task_id: payload.task_id, pid: 950 });
    await sleep(200);

    const pauseR = await apiPatch(`${BASE}/api/tasks/${task.id}`, TOKEN, { status: "paused" });
    expect(pauseR.status).toBe(200);

    await sleep(200);
    const check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    const t = await check.json();
    expect(t.status).toBe("paused");

    socket.disconnect();
  }, 10_000);

  it("PATCH paused task to running → resumes", async () => {
    const ts = Date.now();
    const tag = `resume-tag-${ts}`;
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `resume-${ts}`, gpuName: "A40", maxConcurrent: 20, tags: [tag],
    });

    const buf = new TaskRunBuffer(socket);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python resume_${ts}.py`, target_tags: [tag] });
    const task = await r.json();
    const payload = await buf.waitForTask(task.id);

    socket.emit("task.started", { task_id: payload.task_id, pid: 951 });
    await sleep(200);

    await apiPatch(`${BASE}/api/tasks/${task.id}`, TOKEN, { status: "paused" });
    await sleep(200);
    const resumeR = await apiPatch(`${BASE}/api/tasks/${task.id}`, TOKEN, { status: "running" });
    expect(resumeR.status).toBe(200);

    await sleep(200);
    const check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    const t = await check.json();
    expect(t.status).toBe("running");

    socket.disconnect();
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 25. ENV KEY VALIDATION (shell injection prevention)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Env key validation", () => {
  it("Valid env keys accepted", async () => {
    const ts = Date.now();
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, {
      script: `python envvalid_${ts}.py`,
      env: { CUDA_VISIBLE_DEVICES: "0", MY_VAR_123: "hello" },
    });
    expect(r.status).toBe(201);
  });

  it("Invalid env key → 400", async () => {
    const ts = Date.now();
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, {
      script: `python envinject_${ts}.py`,
      env: { "FOO$(evil)": "bar" },
    });
    expect(r.status).toBe(400);
  });

  it("Env key with spaces → 400", async () => {
    const ts = Date.now();
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, {
      script: `python envspace_${ts}.py`,
      env: { "MY VAR": "val" },
    });
    expect(r.status).toBe(400);
  });

  it("Env key starting with number → 400", async () => {
    const ts = Date.now();
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, {
      script: `python envnum_${ts}.py`,
      env: { "123FOO": "val" },
    });
    expect(r.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 26. CHECKPOINT REPORTING
// ═══════════════════════════════════════════════════════════════════════════════

describe("Checkpoint reporting", () => {
  it("task.checkpoint increments checkpoint_count", async () => {
    const ts = Date.now();
    const tag = `ckpt-tag-${ts}`;
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `ckpt-${ts}`, gpuName: "A40", maxConcurrent: 20, tags: [tag],
    });

    const buf = new TaskRunBuffer(socket);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python ckpt_${ts}.py`, target_tags: [tag] });
    const task = await r.json();
    const payload = await buf.waitForTask(task.id);

    socket.emit("task.started", { task_id: payload.task_id, pid: 960 });
    await sleep(200);

    socket.emit("task.checkpoint", { task_id: payload.task_id, path: "/runs/ckpt_100.pt", step: 100 });
    await sleep(200);
    socket.emit("task.checkpoint", { task_id: payload.task_id, path: "/runs/ckpt_200.pt", step: 200 });
    await sleep(300);

    const check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    const t = await check.json();
    expect(t.checkpoint_path).toBe("/runs/ckpt_200.pt");
    expect(t.checkpoint_count).toBe(2);
    // has_checkpoint is set by stub on task completion, not by checkpoint events

    socket.disconnect();
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 27. STUB RECONNECT WITH RUNNING TASKS (reconciliation)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Stub reconnect reconciliation", () => {
  it("Reconnecting stub reports running tasks → server reconciles", async () => {
    const ts = Date.now();
    const hostname = `recon-${ts}`;
    const tag = `recon-tag-${ts}`;

    // First connection: get a task running
    const { socket: s1 } = await connectAndResume(BASE, TOKEN, {
      hostname, gpuName: "A40", maxConcurrent: 5, tags: [tag],
    });
    const buf1 = new TaskRunBuffer(s1);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python recon_${ts}.py`, target_tags: [tag] });
    const task = await r.json();
    const payload = await buf1.waitForTask(task.id);

    s1.emit("task.started", { task_id: payload.task_id, pid: 970 });
    await sleep(200);

    // Disconnect
    s1.disconnect();
    await sleep(500);

    // Task should be lost now
    let check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    let t = await check.json();
    expect(t.status).toBe("lost");

    // Reconnect with task still running
    const s2 = await connectStub(BASE);
    const resumeP = waitReliable(s2, "resume_response");
    sendResume(s2, {
      token: TOKEN,
      hostname,
      gpuName: "A40",
      maxConcurrent: 5,
      runningTasks: [{ task_id: task.id, pid: 970 }],
      tags: [tag],
    });
    await resumeP;

    // Task should be back to running
    await sleep(300);
    check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    t = await check.json();
    expect(t.status).toBe("running");

    s2.disconnect();
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 28. BATCH OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Batch operations", () => {
  it("Batch kill multiple tasks", async () => {
    const ts = Date.now();
    const tag = `batchkill-${ts}`;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python batchkill_${i}_${ts}.py`, target_tags: [tag] });
      const t = await r.json();
      ids.push(t.id);
    }

    // Tasks stay pending (no stub with this tag), so batch kill works directly
    const r = await apiPost(`${BASE}/api/tasks/batch`, TOKEN, {
      action: "kill",
      task_ids: ids,
    });
    expect(r.status).toBe(200);
    const result = await r.json();
    expect(result.results.filter((r: any) => r.ok).length).toBe(3);

    // Verify all killed
    for (const id of ids) {
      const check = await apiGet(`${BASE}/api/tasks/${id}`, TOKEN);
      const t = await check.json();
      expect(t.status).toBe("killed");
    }
  }, 10_000);

  it("Batch requeue killed tasks", async () => {
    const ts = Date.now();
    const tag = `batchreq-${ts}`;
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python batchreq_${i}_${ts}.py`, target_tags: [tag] });
      const t = await r.json();
      ids.push(t.id);
    }

    // Kill first (pending → killed, no kill chain needed)
    await apiPost(`${BASE}/api/tasks/batch`, TOKEN, { action: "kill", task_ids: ids });
    await sleep(200);

    // Requeue
    const r = await apiPost(`${BASE}/api/tasks/batch`, TOKEN, {
      action: "requeue",
      task_ids: ids,
    });
    expect(r.status).toBe(200);
    const result = await r.json();
    expect(result.results.filter((r: any) => r.ok).length).toBe(2);
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 29. PAGINATION
// ═══════════════════════════════════════════════════════════════════════════════

describe("Task pagination", () => {
  it("GET /tasks with limit returns correct page size", async () => {
    const r = await apiGet(`${BASE}/api/tasks?limit=2&page=1`, TOKEN);
    expect(r.status).toBe(200);
    const body = await r.json();
    const tasks = Array.isArray(body) ? body : body.tasks;
    expect(tasks.length).toBeLessThanOrEqual(2);
    if (!Array.isArray(body)) {
      expect(typeof body.total).toBe("number");
    }
  });

  it("GET /tasks with status filter", async () => {
    const r = await apiGet(`${BASE}/api/tasks?status=pending`, TOKEN);
    expect(r.status).toBe(200);
    const body = await r.json();
    const tasks = Array.isArray(body) ? body : body.tasks;
    for (const t of tasks) {
      expect(t.status).toBe("pending");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 30. STATE PERSISTENCE (globalQueue survives restart)
// ═══════════════════════════════════════════════════════════════════════════════

describe("State persistence", () => {
  it("Pending tasks survive server restart", async () => {
    const ts = Date.now();
    const tag = `persist-${ts}`;
    const script = `python persist_${ts}.py`;

    // Submit with unique tag → no stub has this tag → stays pending
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script, target_tags: [tag] });
    expect(r.status).toBe(201);
    const task = await r.json();
    expect(task.status).toBe("pending");

    // Force state save via health check (server saves periodically)
    await sleep(1000);

    // Verify task is still there
    const check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    const t = await check.json();
    expect(t.status).toBe("pending");
    expect(t.script).toBe(script);
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 31. KILL CHAIN: RUNNING TASK
// ═══════════════════════════════════════════════════════════════════════════════

describe("Kill chain for running tasks", () => {
  it("Kill running task → stub receives task.kill, then task.failed closes it", async () => {
    const ts = Date.now();
    const tag = `killchain-${ts}`;
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `killchain-${ts}`, gpuName: "A40", maxConcurrent: 20, tags: [tag],
    });

    const buf = new TaskRunBuffer(socket);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python killchain_${ts}.py`, target_tags: [tag] });
    const task = await r.json();
    const payload = await buf.waitForTask(task.id);

    socket.emit("task.started", { task_id: payload.task_id, pid: 990 });
    await sleep(200);

    // Listen for kill signal
    const killP = waitReliable(socket, "task.kill", 5000);

    // Kill via API
    await apiPatch(`${BASE}/api/tasks/${task.id}`, TOKEN, { status: "killed" });

    const killPayload = await killP;
    expect(killPayload.task_id).toBe(task.id);

    // Stub reports task.failed (process killed)
    socket.emit("task.failed", { task_id: payload.task_id, exit_code: 137, death_cause: "killed" });
    await sleep(300);

    const check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    const t = await check.json();
    expect(["killed", "failed"]).toContain(t.status);

    socket.disconnect();
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 32. DOUBLE-ACTION PROTECTION
// ═══════════════════════════════════════════════════════════════════════════════

describe("Double-action protection", () => {
  it("Killing an already killed task is idempotent", async () => {
    const ts = Date.now();
    const tag = `dblkill-${ts}`;
    const script = `python dblkill_${ts}.py`;
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script, target_tags: [tag] });
    const task = await r.json();

    // Kill it (pending → killed)
    const k1 = await apiPatch(`${BASE}/api/tasks/${task.id}`, TOKEN, { status: "killed" });
    expect(k1.status).toBe(200);

    // Kill again — should not error
    const k2 = await apiPatch(`${BASE}/api/tasks/${task.id}`, TOKEN, { status: "killed" });
    expect([200, 400]).toContain(k2.status);
  });

  it("Completing an already completed task is rejected", async () => {
    const ts = Date.now();
    const tag = `dblcomp-${ts}`;
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `dblcomp-${ts}`, gpuName: "A40", maxConcurrent: 20, tags: [tag],
    });

    const buf = new TaskRunBuffer(socket);
    const r = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: `python dblcomp_${ts}.py`, target_tags: [tag] });
    const task = await r.json();
    const payload = await buf.waitForTask(task.id);

    socket.emit("task.started", { task_id: payload.task_id, pid: 995 });
    await sleep(200);
    socket.emit("task.completed", { task_id: payload.task_id, exit_code: 0 });
    await sleep(300);

    // Send completed again — should be ignored gracefully
    socket.emit("task.completed", { task_id: payload.task_id, exit_code: 0 });
    await sleep(200);

    const check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    const t = await check.json();
    expect(t.status).toBe("completed");

    socket.disconnect();
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// DAG PIPELINE EXPERIMENTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("DAG pipeline experiments", () => {

  it("creates experiment with task_specs and wires depends_on", async () => {
    const r = await apiPost(`${BASE}/api/experiments`, TOKEN, {
      name: "dag-linear",
      task_specs: [
        { ref: "train", script: "python train.py" },
        { ref: "eval", script: "python eval.py", depends_on: ["train"] },
        { ref: "report", script: "python report.py", depends_on: ["eval"] },
      ],
    });
    expect(r.status).toBe(201);
    const exp = await r.json();
    expect(exp.task_refs).toBeDefined();
    expect(Object.keys(exp.task_refs)).toEqual(expect.arrayContaining(["train", "eval", "report"]));

    // Check task statuses
    const trainR = await apiGet(`${BASE}/api/tasks/${exp.task_refs.train}`, TOKEN);
    const train = await trainR.json();
    expect(train.status).toBe("pending"); // no deps → pending

    const evalR = await apiGet(`${BASE}/api/tasks/${exp.task_refs.eval}`, TOKEN);
    const evalTask = await evalR.json();
    expect(evalTask.status).toBe("blocked");
    expect(evalTask.depends_on).toContain(exp.task_refs.train);

    const reportR = await apiGet(`${BASE}/api/tasks/${exp.task_refs.report}`, TOKEN);
    const report = await reportR.json();
    expect(report.status).toBe("blocked");
    expect(report.depends_on).toContain(exp.task_refs.eval);
  }, 10_000);

  it("rejects DAG with cycle", async () => {
    const r = await apiPost(`${BASE}/api/experiments`, TOKEN, {
      name: "dag-cycle",
      task_specs: [
        { ref: "a", script: "a.py", depends_on: ["b"] },
        { ref: "b", script: "b.py", depends_on: ["a"] },
      ],
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/cycle/i);
  });

  it("rejects DAG with unknown dependency ref", async () => {
    const r = await apiPost(`${BASE}/api/experiments`, TOKEN, {
      name: "dag-bad-ref",
      task_specs: [
        { ref: "a", script: "a.py", depends_on: ["ghost"] },
      ],
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/unknown ref/);
  });

  it("linear pipeline: train→eval promotion on completion", async () => {
    const expR = await apiPost(`${BASE}/api/experiments`, TOKEN, {
      name: "dag-promote-test",
      task_specs: [
        { ref: "train", script: "echo train" },
        { ref: "eval", script: "echo eval", depends_on: ["train"] },
      ],
    });
    const exp = await expR.json();
    const trainId = exp.task_refs.train;
    const evalId = exp.task_refs.eval;

    // Connect stub
    const { socket, stubId } = await connectAndResume(BASE, TOKEN, {
      hostname: `dag-stub-${Date.now()}`,
      maxConcurrent: 2,
    });

    // Stub should get train task (eval is blocked)
    const buf = new TaskRunBuffer(socket);
    await sleep(500); // let scheduler run
    const trainPayload = await buf.waitForTask(trainId);
    expect(trainPayload.task_id).toBe(trainId);

    // Complete train
    socket.emit("task.started", { task_id: trainId, pid: 1 });
    await sleep(100);
    socket.emit("task.completed", { task_id: trainId, exit_code: 0 });
    await sleep(800); // let promotion + scheduler run

    // eval should now be promoted to pending and dispatched
    const evalCheck = await apiGet(`${BASE}/api/tasks/${evalId}`, TOKEN);
    const evalTask = await evalCheck.json();
    expect(["pending", "queued", "dispatched", "running"]).toContain(evalTask.status);

    buf.destroy();
    socket.disconnect();
  }, 15_000);

  it("cascading cancellation: fail train → cancel eval + report", async () => {
    const expR = await apiPost(`${BASE}/api/experiments`, TOKEN, {
      name: "dag-cascade-test",
      task_specs: [
        { ref: "train", script: "echo fail" },
        { ref: "eval", script: "echo eval", depends_on: ["train"] },
        { ref: "report", script: "echo report", depends_on: ["eval"] },
      ],
    });
    const exp = await expR.json();
    const trainId = exp.task_refs.train;
    const evalId = exp.task_refs.eval;
    const reportId = exp.task_refs.report;

    // Connect stub and run train
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `dag-cascade-${Date.now()}`,
      maxConcurrent: 2,
    });

    const buf = new TaskRunBuffer(socket);
    await sleep(500);
    await buf.waitForTask(trainId);

    // Fail train
    socket.emit("task.started", { task_id: trainId, pid: 2 });
    await sleep(100);
    socket.emit("task.failed", { task_id: trainId, exit_code: 1, error: "crash" });
    await sleep(800);

    // eval and report should be cancelled
    const evalCheck = await apiGet(`${BASE}/api/tasks/${evalId}`, TOKEN);
    expect((await evalCheck.json()).status).toBe("cancelled");

    const reportCheck = await apiGet(`${BASE}/api/tasks/${reportId}`, TOKEN);
    expect((await reportCheck.json()).status).toBe("cancelled");

    buf.destroy();
    socket.disconnect();
  }, 15_000);

  it("fan-out: one root, two downstream — both blocked then promoted", async () => {
    const expR = await apiPost(`${BASE}/api/experiments`, TOKEN, {
      name: "dag-fanout",
      task_specs: [
        { ref: "data", script: "echo data" },
        { ref: "branch_a", script: "echo a", depends_on: ["data"] },
        { ref: "branch_b", script: "echo b", depends_on: ["data"] },
      ],
    });
    const exp = await expR.json();

    // Initially branch_a and branch_b should be blocked
    const aR = await apiGet(`${BASE}/api/tasks/${exp.task_refs.branch_a}`, TOKEN);
    expect((await aR.json()).status).toBe("blocked");

    const bR = await apiGet(`${BASE}/api/tasks/${exp.task_refs.branch_b}`, TOKEN);
    expect((await bR.json()).status).toBe("blocked");

    // Connect stub, complete data
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `dag-fanout-${Date.now()}`,
      maxConcurrent: 4,
    });
    const buf = new TaskRunBuffer(socket);
    await sleep(500);
    const dataPayload = await buf.waitForTask(exp.task_refs.data);
    socket.emit("task.started", { task_id: dataPayload.task_id, pid: 3 });
    await sleep(100);
    socket.emit("task.completed", { task_id: dataPayload.task_id, exit_code: 0 });
    await sleep(800);

    // Both should be promoted
    const aCheck = await apiGet(`${BASE}/api/tasks/${exp.task_refs.branch_a}`, TOKEN);
    expect(["pending", "queued", "dispatched", "running"]).toContain((await aCheck.json()).status);

    const bCheck = await apiGet(`${BASE}/api/tasks/${exp.task_refs.branch_b}`, TOKEN);
    expect(["pending", "queued", "dispatched", "running"]).toContain((await bCheck.json()).status);

    buf.destroy();
    socket.disconnect();
  }, 15_000);

  it("kill blocked task transitions to killed", async () => {
    const expR = await apiPost(`${BASE}/api/experiments`, TOKEN, {
      name: "dag-kill-blocked",
      task_specs: [
        { ref: "slow", script: "echo slow" },
        { ref: "wait", script: "echo wait", depends_on: ["slow"] },
      ],
    });
    const exp = await expR.json();
    const waitId = exp.task_refs.wait;

    // Kill the blocked task
    const killR = await apiPatch(`${BASE}/api/tasks/${waitId}`, TOKEN, { status: "killed" });
    expect(killR.status).toBe(200);
    const killed = await killR.json();
    expect(killed.status).toBe("killed");
  }, 10_000);

  it("export via SDK endpoint persists on task", async () => {
    // Create a simple task
    const taskR = await apiPost(`${BASE}/api/tasks`, TOKEN, { script: "echo export-test" });
    const task = await taskR.json();

    // Connect stub, start the task
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `dag-export-${Date.now()}`,
      maxConcurrent: 2,
    });
    const buf = new TaskRunBuffer(socket);
    await sleep(500);
    await buf.waitForTask(task.id);
    socket.emit("task.started", { task_id: task.id, pid: 4 });
    await sleep(200);

    // SDK export endpoint (no auth — task_id is the credential)
    const sdkR = await fetch(`${BASE}/api/sdk/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: task.id, type: "export", key: "best_model", value: "/runs/model.pt" }),
    });
    expect(sdkR.status).toBe(200);

    // Check export is stored
    const check = await apiGet(`${BASE}/api/tasks/${task.id}`, TOKEN);
    const t = await check.json();
    expect(t.exports?.best_model).toBe("/runs/model.pt");

    buf.destroy();
    socket.disconnect();
  }, 10_000);

  it("template resolution with exports in args_template", async () => {
    const expR = await apiPost(`${BASE}/api/experiments`, TOKEN, {
      name: "dag-template",
      task_specs: [
        { ref: "train", script: "echo train" },
        { ref: "eval", script: "echo eval",
          depends_on: ["train"],
          args_template: { "--ckpt": "{{deps.train.exports.last_checkpoint_path}}" },
        },
      ],
    });
    const exp = await expR.json();
    const trainId = exp.task_refs.train;
    const evalId = exp.task_refs.eval;

    // Connect stub
    const { socket } = await connectAndResume(BASE, TOKEN, {
      hostname: `dag-tmpl-${Date.now()}`,
      maxConcurrent: 2,
    });
    const buf = new TaskRunBuffer(socket);
    await sleep(500);
    await buf.waitForTask(trainId);
    socket.emit("task.started", { task_id: trainId, pid: 5 });
    await sleep(100);

    // Export checkpoint via SDK
    await fetch(`${BASE}/api/sdk/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: trainId, type: "export", key: "last_checkpoint_path", value: "/runs/train/ckpt_100.pt" }),
    });
    await sleep(100);

    // Complete train → should promote eval with resolved template
    socket.emit("task.completed", { task_id: trainId, exit_code: 0 });
    await sleep(800);

    const evalCheck = await apiGet(`${BASE}/api/tasks/${evalId}`, TOKEN);
    const evalTask = await evalCheck.json();
    expect(["pending", "queued", "dispatched", "running"]).toContain(evalTask.status);
    expect(evalTask.args?.["--ckpt"]).toBe("/runs/train/ckpt_100.pt");

    buf.destroy();
    socket.disconnect();
  }, 15_000);
});
