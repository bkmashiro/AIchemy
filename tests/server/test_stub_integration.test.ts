/**
 * test_stub_integration.test.ts — Server + mock stub socket.io integration tests.
 *
 * Starts the server, connects a socket.io client simulating a stub,
 * and verifies the resume flow, reliable messaging, task dispatch,
 * task lifecycle, auto-promote, kill chain, and stub identity.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import net from "net";
import { io as ioClient, Socket } from "socket.io-client";

// Disable proxy for test process
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Mock Stub ───────────────────────────────────────────────────────────────

interface MockStubOptions {
  serverUrl: string;
  token: string;
  hostname?: string;
  gpuName?: string;
  maxConcurrent?: number;
  runningTasks?: Array<{ task_id: string; pid: number; status: string }>;
  localQueue?: string[];
  lastSeq?: number;
}

function createMockStub(opts: MockStubOptions): Socket {
  const socket = ioClient(`${opts.serverUrl}/stubs`, {
    transports: ["websocket"],
  });
  return socket;
}

function sendResume(socket: Socket, opts: MockStubOptions & { hostname: string; gpuName: string }): void {
  socket.emit("resume", {
    hostname: opts.hostname,
    gpu: {
      name: opts.gpuName,
      vram_total_mb: 10240,
      count: 1,
    },
    max_concurrent: opts.maxConcurrent ?? 2,
    token: opts.token,
    running_tasks: opts.runningTasks ?? [],
    local_queue: opts.localQueue ?? [],
    lastSeq: opts.lastSeq ?? 0,
  });
}

function waitForEvent(socket: Socket, event: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for event '${event}' after ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(data: any) {
      clearTimeout(timer);
      resolve(data);
    }

    socket.once(event, handler);
  });
}

// Server uses socket.io native ack callbacks. The server emits an event and
// expects the client to call the ack callback. We register a one-time listener
// that acks automatically and resolves with the payload.
function waitForReliableEvent(socket: Socket, eventName: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handler);
      reject(new Error(`Timed out waiting for reliable event '${eventName}' after ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(payload: any, ack?: Function) {
      clearTimeout(timer);
      socket.off(eventName, handler);
      // Send ack back to server (native socket.io ack)
      if (typeof ack === "function") ack({ ok: true });
      resolve(payload);
    }

    socket.on(eventName, handler);
  });
}

// Buffered task.run listener: starts collecting task.run events immediately,
// acking all of them. Call waitForTask(taskId) to get the payload for a specific task.
// This solves the race condition where the server dispatches before we submit the task.
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
    // Check if already buffered
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

// Like waitForReliableEvent but filters for a specific task_id (acks others and keeps waiting).
// Use this when setting up the listener BEFORE submitting the task.
function waitForReliableTaskRun(socket: Socket, taskId: string, timeoutMs = 8000): Promise<any> {
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
      // else: ack other tasks but keep waiting
    }
    socket.on("task.run", handler);
  });
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let serverProcess: ChildProcess;
let BASE_URL: string;
let TOKEN: string;
const STATE_FILE = `/tmp/alchemy_stub_test_state_${process.pid}.json`;

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
  TOKEN = "alchemy-v2-token";
}, 20_000);

afterAll(async () => {
  serverProcess?.kill("SIGTERM");
  await sleep(500);
  try { require("fs").unlinkSync(STATE_FILE); } catch {}
});

// ─── 1. Unified resume — fresh connect ───────────────────────────────────────

describe("Unified resume — fresh connect", () => {
  it("T1: First connect gets resume_response with empty adopt/kill", async () => {
    const socket = createMockStub({ serverUrl: BASE_URL, token: TOKEN });

    await new Promise<void>((resolve, reject) => {
      socket.on("connect", () => resolve());
      socket.on("connect_error", reject);
      setTimeout(() => reject(new Error("connect timeout")), 5000);
    });

    // Send resume with empty state
    const resumeResponseP = waitForReliableEvent(socket, "resume_response");
    sendResume(socket, {
      serverUrl: BASE_URL,
      token: TOKEN,
      hostname: `test-host-${Date.now()}`,
      gpuName: "TestGPU",
      maxConcurrent: 2,
    });

    const resp = await resumeResponseP;

    expect(resp.stub_id).toBeTruthy();
    expect(resp.name).toBeTruthy();
    expect(Array.isArray(resp.adopt_tasks)).toBe(true);
    expect(Array.isArray(resp.kill_tasks)).toBe(true);
    // Fresh connect = no adopt/kill
    expect(resp.adopt_tasks.length).toBe(0);
    expect(resp.kill_tasks.length).toBe(0);

    socket.disconnect();
  }, 10_000);

  it("T6: Same stub identity (same hostname+GPU) reconnect → same stub_id", async () => {
    const hostname = `identity-test-${Date.now()}`;
    const gpuName = "A40";

    // First connect
    const socket1 = createMockStub({ serverUrl: BASE_URL, token: TOKEN });
    await new Promise<void>((r, j) => {
      socket1.on("connect", r);
      socket1.on("connect_error", j);
    });

    const r1P = waitForReliableEvent(socket1, "resume_response");
    sendResume(socket1, { serverUrl: BASE_URL, token: TOKEN, hostname, gpuName, maxConcurrent: 2 });
    const resp1 = await r1P;
    const stubId1 = resp1.stub_id;

    socket1.disconnect();
    await sleep(500);

    // Reconnect with same hostname + GPU
    const socket2 = createMockStub({ serverUrl: BASE_URL, token: TOKEN });
    await new Promise<void>((r, j) => {
      socket2.on("connect", r);
      socket2.on("connect_error", j);
    });

    const r2P = waitForReliableEvent(socket2, "resume_response");
    sendResume(socket2, { serverUrl: BASE_URL, token: TOKEN, hostname, gpuName, maxConcurrent: 2 });
    const resp2 = await r2P;
    const stubId2 = resp2.stub_id;

    expect(stubId2).toBe(stubId1);
    socket2.disconnect();
  }, 15_000);
});

// ─── 2. Task dispatch ─────────────────────────────────────────────────────────

describe("Task dispatch", () => {
  it("Submit task to global queue → scheduler dispatches to connected stub", async () => {
    const hostname = `dispatch-test-${Date.now()}`;
    const socket = createMockStub({ serverUrl: BASE_URL, token: TOKEN });

    await new Promise<void>((r, j) => {
      socket.on("connect", r);
      socket.on("connect_error", j);
    });

    // Connect stub
    const resumeP = waitForReliableEvent(socket, "resume_response");
    sendResume(socket, {
      serverUrl: BASE_URL, token: TOKEN,
      hostname, gpuName: "A40", maxConcurrent: 20,
    });
    await resumeP;

    // Start buffering task.run events immediately (before submit, to avoid race)
    const buf = new TaskRunBuffer(socket);

    // Submit task to global queue
    const script = `python dispatch_test_${Date.now()}.py`;
    const r = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    expect(r.status).toBe(201);
    const task = await r.json();

    // Wait for this specific task (buffer catches event even if fired before this line)
    const runPayload = await buf.waitForTask(task.id, 8000);
    expect(runPayload.task_id).toBe(task.id);
    expect(runPayload.command).toBeTruthy();

    socket.disconnect();
  }, 15_000);
});

// ─── 3. Task lifecycle ────────────────────────────────────────────────────────

describe("Task lifecycle", () => {
  it("task.started → task.progress → task.completed updates server state", async () => {
    const hostname = `lifecycle-test-${Date.now()}`;
    const socket = createMockStub({ serverUrl: BASE_URL, token: TOKEN });

    await new Promise<void>((r, j) => {
      socket.on("connect", r);
      socket.on("connect_error", j);
    });

    const resumeP = waitForReliableEvent(socket, "resume_response");
    sendResume(socket, {
      serverUrl: BASE_URL, token: TOKEN,
      hostname, gpuName: "A30", maxConcurrent: 20,
    });
    await resumeP;

    const buf = new TaskRunBuffer(socket);

    // Submit task
    const script = `python lifecycle_test_${Date.now()}.py`;
    const r = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    const task = await r.json();

    const runPayload = await buf.waitForTask(task.id, 8000);
    const taskId = runPayload.task_id;

    // Get stub_id from server
    const stubsR = await apiGet(`${BASE_URL}/api/stubs`, TOKEN);
    const stubs = await stubsR.json();
    const stub = stubs.find((s: any) => s.hostname === hostname);
    expect(stub).toBeTruthy();
    const stubId = stub.id;

    // Simulate: task.started (reliable)
    socket.emit("task.started", { task_id: taskId, pid: 12345 });
    await sleep(300);

    // Verify running status
    const taskR1 = await apiGet(`${BASE_URL}/api/tasks/${taskId}`, TOKEN);
    const t1 = await taskR1.json();
    expect(t1.status).toBe("running");
    expect(t1.pid).toBe(12345);

    // Simulate: task.progress (non-reliable)
    socket.emit("task.progress", {
      task_id: taskId,
      step: 100,
      total: 1000,
      loss: 0.5,
    });
    await sleep(300);

    const taskR2 = await apiGet(`${BASE_URL}/api/tasks/${taskId}`, TOKEN);
    const t2 = await taskR2.json();
    expect(t2.progress?.step).toBe(100);
    expect(t2.progress?.loss).toBe(0.5);

    // Simulate: task.completed (reliable)
    socket.emit("task.completed", { task_id: taskId, exit_code: 0 });
    await sleep(300);

    const taskR3 = await apiGet(`${BASE_URL}/api/tasks/${taskId}`, TOKEN);
    const t3 = await taskR3.json();
    expect(t3.status).toBe("completed");
    expect(t3.exit_code).toBe(0);
    expect(t3.finished_at).toBeTruthy();

    socket.disconnect();
  }, 20_000);

  it("Auto-promote: task.progress on dispatched → status becomes running", async () => {
    const hostname = `autopromote-test-${Date.now()}`;
    const socket = createMockStub({ serverUrl: BASE_URL, token: TOKEN });

    await new Promise<void>((r, j) => {
      socket.on("connect", r);
      socket.on("connect_error", j);
    });

    const resumeP = waitForReliableEvent(socket, "resume_response");
    sendResume(socket, {
      serverUrl: BASE_URL, token: TOKEN,
      hostname, gpuName: "A40", maxConcurrent: 20,
    });
    await resumeP;

    const buf = new TaskRunBuffer(socket);

    // Submit task and wait for dispatch
    const script = `python autopromote_${Date.now()}.py`;
    const taskR = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    const task = await taskR.json();
    const runPayload = await buf.waitForTask(task.id, 8000);
    const taskId = runPayload.task_id;

    // Verify dispatched status
    await sleep(300);

    // Send progress WITHOUT sending task.started first
    socket.emit("task.progress", {
      task_id: taskId,
      step: 1,
      total: 100,
      loss: 0.9,
    });
    await sleep(500);

    const checkR = await apiGet(`${BASE_URL}/api/tasks/${taskId}`, TOKEN);
    const check = await checkR.json();
    // Auto-promote: dispatched → running when progress received
    expect(check.status).toBe("running");

    socket.disconnect();
  }, 15_000);
});

// ─── 4. Reliable messaging ────────────────────────────────────────────────────

describe("Reliable messaging", () => {
  it("Server acks task.started via native socket.io ack callback", async () => {
    const hostname = `reliable-test-${Date.now()}`;
    const socket = createMockStub({ serverUrl: BASE_URL, token: TOKEN });

    await new Promise<void>((r, j) => {
      socket.on("connect", r);
      socket.on("connect_error", j);
    });

    const resumeP = waitForReliableEvent(socket, "resume_response");
    sendResume(socket, {
      serverUrl: BASE_URL, token: TOKEN,
      hostname, gpuName: "A100", maxConcurrent: 1,
    });
    await resumeP;

    // Server listens on "task.started" directly with native ack callback support
    const ackP = new Promise<any>((resolve) => {
      socket.emit("task.started", { task_id: "nonexistent-task-id", pid: 9999 }, (ack: any) => {
        resolve(ack);
      });
    });

    const ack = await Promise.race([
      ackP,
      sleep(3000).then(() => null),
    ]);

    // Server calls ack({ ok: true }) for every task.started
    expect(ack).not.toBeNull();
    expect(ack.ok).toBe(true);

    socket.disconnect();
  }, 10_000);

  it("Server acks task.completed via native socket.io ack callback", async () => {
    const hostname = `ack-completed-${Date.now()}`;
    const socket = createMockStub({ serverUrl: BASE_URL, token: TOKEN });

    await new Promise<void>((r, j) => {
      socket.on("connect", r);
      socket.on("connect_error", j);
    });

    const resumeP = waitForReliableEvent(socket, "resume_response");
    sendResume(socket, {
      serverUrl: BASE_URL, token: TOKEN,
      hostname, gpuName: "A100", maxConcurrent: 1,
    });
    await resumeP;

    const ackP = new Promise<any>((resolve) => {
      socket.emit("task.completed", { task_id: "nonexistent-task-id", exit_code: 0 }, (ack: any) => {
        resolve(ack);
      });
    });

    const ack = await Promise.race([
      ackP,
      sleep(3000).then(() => null),
    ]);

    expect(ack).not.toBeNull();
    expect(ack.ok).toBe(true);

    socket.disconnect();
  }, 10_000);
});

// ─── 5. Reconciliation ────────────────────────────────────────────────────────

describe("Reconciliation on reconnect", () => {
  it("T3: Server kills task while stub offline → kill_tasks on reconnect", async () => {
    const hostname = `reconcile-${Date.now()}`;
    const gpuName = "A40";

    // First connect
    const socket1 = createMockStub({ serverUrl: BASE_URL, token: TOKEN });
    await new Promise<void>((r, j) => { socket1.on("connect", r); socket1.on("connect_error", j); });

    const resumeP1 = waitForReliableEvent(socket1, "resume_response");
    sendResume(socket1, { serverUrl: BASE_URL, token: TOKEN, hostname, gpuName, maxConcurrent: 20 });
    const resp1 = await resumeP1;
    const stubId = resp1.stub_id;

    const buf1 = new TaskRunBuffer(socket1);

    // Submit a task and dispatch it
    const script = `python reconcile_${Date.now()}.py`;
    const taskR = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    const task = await taskR.json();
    const runPayload = await buf1.waitForTask(task.id, 8000);
    const taskId = runPayload.task_id;

    // Mark task as running
    await new Promise<void>((resolve) => {
      socket1.emit("task.started", { task_id: taskId, pid: 55555 }, () => resolve());
      setTimeout(resolve, 500); // fallback
    });

    // Kill the task via API BEFORE disconnecting (task is running → kill valid)
    await apiPatch(`${BASE_URL}/api/tasks/${taskId}`, TOKEN, { status: "killed" });
    await sleep(200);

    // Disconnect stub (simulating it going offline after kill was issued)
    socket1.disconnect();
    await sleep(500);

    // Reconnect with running task still reported
    const socket2 = createMockStub({ serverUrl: BASE_URL, token: TOKEN });
    await new Promise<void>((r, j) => { socket2.on("connect", r); socket2.on("connect_error", j); });

    const resumeP2 = waitForReliableEvent(socket2, "resume_response");
    sendResume(socket2, {
      serverUrl: BASE_URL, token: TOKEN,
      hostname, gpuName,
      maxConcurrent: 1,
      runningTasks: [{ task_id: taskId, pid: 55555, status: "running" }],
      localQueue: [],
      lastSeq: 0,
    });
    const resp2 = await resumeP2;

    // Server should tell stub to kill the task
    expect(resp2.kill_tasks).toContain(taskId);

    socket2.disconnect();
  }, 20_000);

  it("T4: Stub crashes, reconnects with empty state → tasks marked lost", async () => {
    const hostname = `crash-${Date.now()}`;
    const gpuName = "A30";

    // Connect and get a task running
    const socket1 = createMockStub({ serverUrl: BASE_URL, token: TOKEN });
    await new Promise<void>((r, j) => { socket1.on("connect", r); socket1.on("connect_error", j); });

    const resumeP1 = waitForReliableEvent(socket1, "resume_response");
    sendResume(socket1, { serverUrl: BASE_URL, token: TOKEN, hostname, gpuName, maxConcurrent: 20 });
    await resumeP1;

    const buf1 = new TaskRunBuffer(socket1);

    // Submit + dispatch
    const script = `python crash_test_${Date.now()}.py`;
    const taskR = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    const task = await taskR.json();
    const runPayload = await buf1.waitForTask(task.id, 8000);
    const taskId = runPayload.task_id;

    // Mark running
    socket1.emit("task.started", { task_id: taskId, pid: 77777 });
    await sleep(300);

    // Disconnect without reporting task end
    socket1.disconnect();
    await sleep(500);

    // Reconnect with empty running_tasks (stub "crashed")
    const socket2 = createMockStub({ serverUrl: BASE_URL, token: TOKEN });
    await new Promise<void>((r, j) => { socket2.on("connect", r); socket2.on("connect_error", j); });

    const resumeP2 = waitForReliableEvent(socket2, "resume_response");
    sendResume(socket2, {
      serverUrl: BASE_URL, token: TOKEN,
      hostname, gpuName,
      maxConcurrent: 1,
      runningTasks: [], // stub reports nothing running
      localQueue: [],
      lastSeq: 0,
    });
    await resumeP2;
    await sleep(300);

    // Task should now be "lost"
    const taskCheck = await apiGet(`${BASE_URL}/api/tasks/${taskId}`, TOKEN);
    const t = await taskCheck.json();
    expect(t.status).toBe("lost");

    socket2.disconnect();
  }, 20_000);
});

// ─── 6. Kill chain ────────────────────────────────────────────────────────────

describe("Kill chain", () => {
  it("Cancel task → should_stop signal sent to stub", async () => {
    const hostname = `kill-test-${Date.now()}`;
    const socket = createMockStub({ serverUrl: BASE_URL, token: TOKEN });

    await new Promise<void>((r, j) => { socket.on("connect", r); socket.on("connect_error", j); });

    const resumeP = waitForReliableEvent(socket, "resume_response");
    sendResume(socket, { serverUrl: BASE_URL, token: TOKEN, hostname, gpuName: "A40", maxConcurrent: 20 });
    await resumeP;

    const buf = new TaskRunBuffer(socket);

    // Submit + dispatch task
    const script = `python kill_test_${Date.now()}.py`;
    const taskR = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    const task = await taskR.json();
    const runPayload = await buf.waitForTask(task.id, 8000);
    const taskId = runPayload.task_id;

    // Mark running
    socket.emit("task.started", { task_id: taskId, pid: 33333 });
    await sleep(300);

    // Listen for task.kill signal (server sends this via reliableEmitToStub)
    const killP = waitForReliableEvent(socket, "task.kill", 6000);

    // Cancel the task via API
    await apiPatch(`${BASE_URL}/api/tasks/${taskId}`, TOKEN, { status: "killed" });

    const killPayload = await killP;
    expect(killPayload.task_id).toBe(taskId);
    expect(killPayload.grace_period_s).toBeGreaterThan(0);

    socket.disconnect();
  }, 15_000);
});

// ─── 7. max_concurrent — server authoritative ─────────────────────────────────

describe("max_concurrent server authoritative", () => {
  it("Server preserves max_concurrent across reconnect", async () => {
    const hostname = `maxcon-${Date.now()}`;
    const gpuName = "A40";

    // First connect with max_concurrent=3
    const socket1 = createMockStub({ serverUrl: BASE_URL, token: TOKEN });
    await new Promise<void>((r, j) => { socket1.on("connect", r); socket1.on("connect_error", j); });

    const resumeP1 = waitForReliableEvent(socket1, "resume_response");
    sendResume(socket1, { serverUrl: BASE_URL, token: TOKEN, hostname, gpuName, maxConcurrent: 3 });
    const resp1 = await resumeP1;
    const stubId = resp1.stub_id;

    // Update max_concurrent via API to 1
    await apiPatch(`${BASE_URL}/api/stubs/${stubId}`, TOKEN, { max_concurrent: 1 });

    socket1.disconnect();
    await sleep(500);

    // Reconnect with max_concurrent=5 (stub tries to override)
    const socket2 = createMockStub({ serverUrl: BASE_URL, token: TOKEN });
    await new Promise<void>((r, j) => { socket2.on("connect", r); socket2.on("connect_error", j); });

    const resumeP2 = waitForReliableEvent(socket2, "resume_response");
    sendResume(socket2, { serverUrl: BASE_URL, token: TOKEN, hostname, gpuName, maxConcurrent: 5 });
    const resp2 = await resumeP2;

    // Server is authoritative — should return 1 (the value we set)
    expect(resp2.config.max_concurrent).toBe(1);

    socket2.disconnect();
  }, 20_000);
});
