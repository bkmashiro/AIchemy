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

function waitForReliableEvent(socket: Socket, eventName: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("r", handler);
      reject(new Error(`Timed out waiting for reliable event '${eventName}' after ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(msg: any) {
      if (msg.event === eventName) {
        clearTimeout(timer);
        socket.off("r", handler);
        // Send ack
        socket.emit("r.ack", { seq: msg.seq });
        resolve(msg.payload);
      }
    }

    socket.on("r", handler);
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
      hostname, gpuName: "A40", maxConcurrent: 2,
    });
    await resumeP;

    // Set up listener for task.run BEFORE submitting
    const taskRunP = waitForReliableEvent(socket, "task.run", 8000);

    // Submit task to global queue
    const script = `python dispatch_test_${Date.now()}.py`;
    const r = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    expect(r.status).toBe(201);
    const task = await r.json();

    const runPayload = await taskRunP;
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
      hostname, gpuName: "A30", maxConcurrent: 2,
    });
    await resumeP;

    // Submit task
    const taskRunP = waitForReliableEvent(socket, "task.run", 8000);
    const script = `python lifecycle_test_${Date.now()}.py`;
    const r = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    const task = await r.json();

    const runPayload = await taskRunP;
    const taskId = runPayload.task_id;

    // Get stub_id from server
    const stubsR = await apiGet(`${BASE_URL}/api/stubs`, TOKEN);
    const stubs = await stubsR.json();
    const stub = stubs.find((s: any) => s.hostname === hostname);
    expect(stub).toBeTruthy();
    const stubId = stub.id;

    // Simulate: task.started (reliable)
    socket.emit("r", {
      seq: 1,
      event: "task.started",
      payload: { task_id: taskId, pid: 12345 },
      ts: Date.now(),
    });
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
    socket.emit("r", {
      seq: 2,
      event: "task.completed",
      payload: { task_id: taskId, exit_code: 0 },
      ts: Date.now(),
    });
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
      hostname, gpuName: "A40", maxConcurrent: 2,
    });
    await resumeP;

    // Submit task and wait for dispatch
    const taskRunP = waitForReliableEvent(socket, "task.run", 8000);
    const script = `python autopromote_${Date.now()}.py`;
    const taskR = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    const task = await taskR.json();
    const runPayload = await taskRunP;
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
  it("Server sends r.ack for received stub messages", async () => {
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

    // Listen for ack
    const ackP = new Promise<any>((resolve) => {
      socket.once("r.ack", resolve);
    });

    // Send a reliable heartbeat-like message (use task.started which always acks)
    // We can use a dummy task ID — it won't find it but will still ack the seq
    socket.emit("r", {
      seq: 1,
      event: "task.started",
      payload: { task_id: "nonexistent-task-id", pid: 9999 },
      ts: Date.now(),
    });

    const ack = await Promise.race([
      ackP,
      sleep(3000).then(() => null),
    ]);

    // Ack should come back
    expect(ack).not.toBeNull();
    expect(ack.seq).toBeGreaterThanOrEqual(1);

    socket.disconnect();
  }, 10_000);

  it("Out-of-order messages trigger r.nack", async () => {
    const hostname = `nack-test-${Date.now()}`;
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

    // Listen for nack
    const nackP = new Promise<any>((resolve) => {
      socket.once("r.nack", resolve);
    });

    // Send seq=3 skipping 1 and 2 — server receiver should nack
    socket.emit("r", {
      seq: 3,
      event: "task.started",
      payload: { task_id: "nonce", pid: 1 },
      ts: Date.now(),
    });

    const nack = await Promise.race([
      nackP,
      sleep(3000).then(() => null),
    ]);

    expect(nack).not.toBeNull();
    expect(nack.from).toBe(1);

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
    sendResume(socket1, { serverUrl: BASE_URL, token: TOKEN, hostname, gpuName, maxConcurrent: 1 });
    const resp1 = await resumeP1;
    const stubId = resp1.stub_id;

    // Submit a task and dispatch it
    const taskRunP = waitForReliableEvent(socket1, "task.run", 8000);
    const script = `python reconcile_${Date.now()}.py`;
    const taskR = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    const task = await taskR.json();
    const runPayload = await taskRunP;
    const taskId = runPayload.task_id;

    // Mark task as running (so it's not lost on disconnect)
    socket1.emit("r", {
      seq: 1,
      event: "task.started",
      payload: { task_id: taskId, pid: 55555 },
      ts: Date.now(),
    });
    await sleep(300);

    // Disconnect stub
    socket1.disconnect();
    await sleep(500);

    // Kill the task via API while stub is offline
    await apiPatch(`${BASE_URL}/api/tasks/${taskId}`, TOKEN, { status: "killed" });
    await sleep(200);

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
    sendResume(socket1, { serverUrl: BASE_URL, token: TOKEN, hostname, gpuName, maxConcurrent: 1 });
    await resumeP1;

    // Submit + dispatch
    const taskRunP = waitForReliableEvent(socket1, "task.run", 8000);
    const script = `python crash_test_${Date.now()}.py`;
    const taskR = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    const task = await taskR.json();
    const runPayload = await taskRunP;
    const taskId = runPayload.task_id;

    // Mark running
    socket1.emit("r", {
      seq: 1,
      event: "task.started",
      payload: { task_id: taskId, pid: 77777 },
      ts: Date.now(),
    });
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
    sendResume(socket, { serverUrl: BASE_URL, token: TOKEN, hostname, gpuName: "A40", maxConcurrent: 1 });
    await resumeP;

    // Submit + dispatch task
    const taskRunP = waitForReliableEvent(socket, "task.run", 8000);
    const script = `python kill_test_${Date.now()}.py`;
    const taskR = await apiPost(`${BASE_URL}/api/tasks`, TOKEN, { script });
    const task = await taskR.json();
    const runPayload = await taskRunP;
    const taskId = runPayload.task_id;

    // Mark running
    socket.emit("r", {
      seq: 1,
      event: "task.started",
      payload: { task_id: taskId, pid: 33333 },
      ts: Date.now(),
    });
    await sleep(300);

    // Listen for should_stop signal
    const signalP = waitForReliableEvent(socket, "task.signal", 6000);

    // Cancel the task via API
    await apiPatch(`${BASE_URL}/api/tasks/${taskId}`, TOKEN, { status: "killed" });

    const signal = await signalP;
    expect(signal.task_id).toBe(taskId);
    expect(signal.signal).toBe("should_stop");

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
