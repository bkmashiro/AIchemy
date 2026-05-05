/**
 * test_fuzz.test.ts — Fuzz / property-based testing for alchemy server.
 *
 * Randomly generates stubs, tasks, and event sequences, then asserts
 * system invariants hold after every action. Catches edge cases that
 * deterministic tests miss: same-host collisions, retry dedup under
 * rapid reconnects, DAG state consistency, etc.
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

// ─── Random helpers ─────────────────────────────────────────────────────────

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function maybe(p: number = 0.5): boolean {
  return Math.random() < p;
}

// ─── Config pools ───────────────────────────────────────────────────────────

const HOSTNAMES = ["gpu32", "gpu33", "gpu35", "dipper", "workstation-1"];
const GPU_NAMES = ["NVIDIA A40", "NVIDIA A30", "NVIDIA A100 80GB"];
const GPU_COUNTS = [1, 2, 4];
const SCRIPTS = ["train.py", "eval.py", "report.py", "preprocess.py"];
const TAGS_POOL = ["fast", "slow", "gpu", "cpu", "priority"];

// ─── Helpers ────────────────────────────────────────────────────────────────

function headers(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function apiGet(url: string, token: string) {
  return fetch(url, { headers: headers(token) });
}

async function apiPost(url: string, token: string, body: any) {
  return fetch(url, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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
  throw new Error(`Server did not start in ${timeoutMs}ms`);
}

// ─── Stub wrapper ───────────────────────────────────────────────────────────

interface FuzzStub {
  socket: Socket;
  hostname: string;
  gpuName: string;
  gpuCount: number;
  slurmJobId?: string;
  maxConcurrent: number;
  tags: string[];
  connected: boolean;
  runningTaskIds: Set<string>;
}

function createFuzzStub(url: string): Socket {
  return ioClient(`${url}/stubs`, { transports: ["websocket"] });
}

async function connectFuzzStub(url: string, config: {
  hostname: string;
  gpuName: string;
  gpuCount: number;
  slurmJobId?: string;
  maxConcurrent: number;
  tags: string[];
  token: string;
}): Promise<FuzzStub> {
  const socket = createFuzzStub(url);
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", resolve);
    socket.on("connect_error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });

  const resumeP = new Promise<any>((resolve) => {
    socket.on("resume_response", (payload: any, ack?: Function) => {
      if (typeof ack === "function") ack({ ok: true });
      resolve(payload);
    });
  });

  socket.emit("resume", {
    hostname: config.hostname,
    gpu: { name: config.gpuName, vram_total_mb: 49140, count: config.gpuCount },
    max_concurrent: config.maxConcurrent,
    token: config.token,
    running_tasks: [],
    local_queue: [],
    slurm_job_id: config.slurmJobId,
    tags: config.tags,
  });

  await resumeP;

  // Auto-ack any task.run events
  const stub: FuzzStub = {
    socket,
    hostname: config.hostname,
    gpuName: config.gpuName,
    gpuCount: config.gpuCount,
    slurmJobId: config.slurmJobId,
    maxConcurrent: config.maxConcurrent,
    tags: config.tags,
    connected: true,
    runningTaskIds: new Set(),
  };

  socket.on("task.run", (payload: any, ack?: Function) => {
    if (typeof ack === "function") ack({ ok: true });
    stub.runningTaskIds.add(payload.task_id);
    // Auto-start
    socket.emit("task.started", { task_id: payload.task_id, pid: randInt(1000, 99999) });
  });

  return stub;
}

// ─── Invariant checks ───────────────────────────────────────────────────────

interface ServerState {
  tasks: any[];
  stubs: any[];
  globalQueue: any[];
}

async function fetchState(base: string, token: string): Promise<ServerState> {
  const [tasksR, stubsR] = await Promise.all([
    apiGet(`${base}/api/tasks`, token),
    apiGet(`${base}/api/stubs`, token),
  ]);
  const tasks = await tasksR.json();
  const stubs = await stubsR.json();
  // Global queue = tasks with no stub_id that are pending/blocked
  const globalQueue = Array.isArray(tasks) ? tasks.filter((t: any) => !t.stub_id && ["pending", "blocked"].includes(t.status)) : [];
  return { tasks: Array.isArray(tasks) ? tasks : [], stubs: Array.isArray(stubs) ? stubs : [], globalQueue };
}

function checkInvariants(state: ServerState, label: string): void {
  const { tasks, stubs } = state;

  // INV-1: No duplicate active tasks with same fingerprint
  const activeFPs = new Map<string, string[]>();
  for (const t of tasks) {
    if (["pending", "queued", "dispatched", "running", "paused", "blocked"].includes(t.status)) {
      const fp = t.fingerprint;
      if (!activeFPs.has(fp)) activeFPs.set(fp, []);
      activeFPs.get(fp)!.push(t.id);
    }
  }
  for (const [fp, ids] of activeFPs) {
    expect(ids.length, `INV-1 [${label}]: fingerprint ${fp} has ${ids.length} active tasks: ${ids.join(", ")}`).toBeLessThanOrEqual(1);
  }

  // INV-2: Running/dispatched tasks must be on an existing stub
  for (const t of tasks) {
    if (["running", "dispatched"].includes(t.status)) {
      expect(t.stub_id, `INV-2 [${label}]: ${t.status} task ${t.id} has no stub_id`).toBeTruthy();
    }
  }

  // INV-3: Blocked tasks' depends_on must reference existing tasks
  for (const t of tasks) {
    if (t.status === "blocked" && t.depends_on) {
      for (const depId of t.depends_on) {
        const dep = tasks.find((d: any) => d.id === depId);
        expect(dep, `INV-3 [${label}]: blocked task ${t.id} depends on missing task ${depId}`).toBeTruthy();
      }
    }
  }

  // INV-4: No active retry chain has more than 1 active task
  const retryChains = new Map<string, string[]>();
  for (const t of tasks) {
    if (!["pending", "queued", "dispatched", "running"].includes(t.status)) continue;
    const root = t.retry_of || t.id;
    if (!retryChains.has(root)) retryChains.set(root, []);
    retryChains.get(root)!.push(t.id);
  }
  for (const [root, ids] of retryChains) {
    expect(ids.length, `INV-4 [${label}]: retry chain ${root} has ${ids.length} active: ${ids.join(", ")}`).toBeLessThanOrEqual(1);
  }

  // INV-5: Cancelled tasks should have a failed/killed/cancelled dependency or be manually killed
  for (const t of tasks) {
    if (t.status === "cancelled" && t.depends_on?.length > 0) {
      const hasFailedDep = t.depends_on.some((depId: string) => {
        const dep = tasks.find((d: any) => d.id === depId);
        return dep && ["failed", "killed", "cancelled"].includes(dep.status);
      });
      expect(hasFailedDep, `INV-5 [${label}]: cancelled task ${t.id} has no failed dependency`).toBe(true);
    }
  }

  // INV-6: Completed tasks should have exit_code 0
  for (const t of tasks) {
    if (t.status === "completed") {
      expect(t.exit_code, `INV-6 [${label}]: completed task ${t.id} has exit_code ${t.exit_code}`).toBe(0);
    }
  }
}

// ─── Server lifecycle ───────────────────────────────────────────────────────

let serverProcess: ChildProcess;
let BASE: string;
const TOKEN = "alchemy-v2-token";
const STATE_FILE = `/tmp/alchemy_fuzz_${process.pid}.json`;
const SERVER_DIR = path.join(__dirname, "../../server");

beforeAll(async () => {
  const port = await getFreePort();
  BASE = `http://localhost:${port}`;
  serverProcess = spawn("node_modules/.bin/tsx", ["src/index.ts"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(port), STATE_FILE, NO_PROXY: "*", no_proxy: "*" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout?.on("data", () => {}); // drain
  serverProcess.stderr?.on("data", () => {});
  await waitForServer(BASE);
}, 20_000);

afterAll(async () => {
  serverProcess?.kill("SIGTERM");
  await sleep(500);
  try { fs.unlinkSync(STATE_FILE); } catch {}
});

// ═══════════════════════════════════════════════════════════════════════════════
// FUZZ: Random stub identity collisions
// ═══════════════════════════════════════════════════════════════════════════════

describe("Fuzz: stub identity", () => {
  it("same hostname + different GPU → different stubs", async () => {
    const host = "fuzz-gpu-" + randId();
    const stubs: FuzzStub[] = [];

    for (const gpuName of ["NVIDIA A40", "NVIDIA A30"]) {
      const s = await connectFuzzStub(BASE, {
        hostname: host,
        gpuName,
        gpuCount: 1,
        maxConcurrent: 2,
        tags: [],
        token: TOKEN,
      });
      stubs.push(s);
    }

    await sleep(300);

    const state = await fetchState(BASE, TOKEN);
    const hostStubs = state.stubs.filter((s: any) => s.hostname === host && s.status === "online");
    expect(hostStubs.length, "Same host, different GPU should create 2 stubs").toBe(2);

    for (const s of stubs) s.socket.disconnect();
  }, 10_000);

  it("same hostname + same GPU + different slurm_job_id → different stubs", async () => {
    const host = "fuzz-slurm-" + randId();
    const stubs: FuzzStub[] = [];

    for (const jobId of ["100001", "100002", "100003"]) {
      const s = await connectFuzzStub(BASE, {
        hostname: host,
        gpuName: "NVIDIA A40",
        gpuCount: 1,
        slurmJobId: jobId,
        maxConcurrent: 2,
        tags: [],
        token: TOKEN,
      });
      stubs.push(s);
    }

    await sleep(300);

    const state = await fetchState(BASE, TOKEN);
    const hostStubs = state.stubs.filter((s: any) => s.hostname === host && s.status === "online");
    expect(hostStubs.length, "Same host+GPU, different SLURM jobs → 3 stubs").toBe(3);

    for (const s of stubs) s.socket.disconnect();
  }, 10_000);

  it("same hostname + same GPU + NO slurm_job_id → SAME stub (collision)", async () => {
    const host = "fuzz-collision-" + randId();
    const s1 = await connectFuzzStub(BASE, {
      hostname: host,
      gpuName: "NVIDIA A100 80GB",
      gpuCount: 2,
      maxConcurrent: 4,
      tags: [],
      token: TOKEN,
    });
    const s2 = await connectFuzzStub(BASE, {
      hostname: host,
      gpuName: "NVIDIA A100 80GB",
      gpuCount: 2,
      maxConcurrent: 4,
      tags: [],
      token: TOKEN,
    });

    await sleep(300);

    const state = await fetchState(BASE, TOKEN);
    const hostStubs = state.stubs.filter((s: any) => s.hostname === host && s.status === "online");
    // Without SLURM job ID they collide — this is expected behavior (same machine, same GPU)
    expect(hostStubs.length, "Same identity without SLURM = collision → 1 stub").toBe(1);

    s1.socket.disconnect();
    s2.socket.disconnect();
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FUZZ: Rapid disconnect/reconnect cycles
// ═══════════════════════════════════════════════════════════════════════════════

describe("Fuzz: reconnect cycles", () => {
  it("rapid disconnect/reconnect does not duplicate retries", async () => {
    const host = "fuzz-reconnect-" + randId();
    const tag = `fuzz-${randId()}`;

    // Submit a task with max_retries
    const taskR = await apiPost(`${BASE}/api/tasks`, TOKEN, {
      script: `python fuzz_retry_${randId()}.py`,
      max_retries: 3,
      target_tags: [tag],
    });
    const task = await taskR.json();

    // Connect, get task dispatched, then rapid disconnect/reconnect 5 times
    for (let cycle = 0; cycle < 5; cycle++) {
      const stub = await connectFuzzStub(BASE, {
        hostname: host,
        gpuName: "NVIDIA A40",
        gpuCount: 1,
        slurmJobId: `fuzz-${cycle}`,
        maxConcurrent: 2,
        tags: [tag],
        token: TOKEN,
      });
      await sleep(500); // let scheduler dispatch

      // Disconnect abruptly
      stub.socket.disconnect();
      await sleep(200);
    }

    await sleep(500);

    // Check invariants — should not have multiple active retries
    const state = await fetchState(BASE, TOKEN);
    checkInvariants(state, `reconnect-cycle`);
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FUZZ: Random DAG pipelines
// ═══════════════════════════════════════════════════════════════════════════════

describe("Fuzz: DAG pipelines", () => {
  it("random DAG shapes maintain invariants through completion/failure", async () => {
    const tag = `fuzz-dag-${randId()}`;

    // Generate random DAG: 3-6 nodes, random edges (acyclic)
    const nodeCount = randInt(3, 6);
    const specs: any[] = [];
    for (let i = 0; i < nodeCount; i++) {
      const ref = `step_${i}`;
      const deps: string[] = [];
      // Each node can depend on any earlier node (ensures acyclic)
      for (let j = 0; j < i; j++) {
        if (maybe(0.4)) deps.push(`step_${j}`);
      }
      specs.push({
        ref,
        script: `echo ${ref}`,
        depends_on: deps.length > 0 ? deps : undefined,
        target_tags: [tag],
      });
    }

    const expR = await apiPost(`${BASE}/api/experiments`, TOKEN, {
      name: `fuzz-dag-${randId()}`,
      task_specs: specs,
    });
    expect(expR.status).toBe(201);
    const exp = await expR.json();

    // Connect stub
    const stub = await connectFuzzStub(BASE, {
      hostname: `fuzz-dag-host-${randId()}`,
      gpuName: pick(GPU_NAMES),
      gpuCount: 1,
      maxConcurrent: nodeCount,
      tags: [tag],
      token: TOKEN,
    });

    // Run tasks as they arrive — randomly complete or fail
    const completed = new Set<string>();
    const failed = new Set<string>();

    for (let round = 0; round < nodeCount * 3; round++) {
      await sleep(300);

      // Find any running tasks and resolve them
      for (const taskId of [...stub.runningTaskIds]) {
        if (completed.has(taskId) || failed.has(taskId)) continue;

        if (maybe(0.8)) {
          // Complete
          stub.socket.emit("task.completed", { task_id: taskId, exit_code: 0 });
          completed.add(taskId);
          stub.runningTaskIds.delete(taskId);
        } else {
          // Fail
          stub.socket.emit("task.failed", { task_id: taskId, exit_code: 1, error: "fuzz fail" });
          failed.add(taskId);
          stub.runningTaskIds.delete(taskId);
        }
      }
    }

    await sleep(500);

    // Check invariants
    const state = await fetchState(BASE, TOKEN);
    checkInvariants(state, "dag-fuzz");

    // Additional DAG invariant: if a task completed, all its deps must be completed
    const taskMap = new Map(state.tasks.map((t: any) => [t.id, t]));
    for (const [ref, taskId] of Object.entries(exp.task_refs as Record<string, string>)) {
      const task = taskMap.get(taskId);
      if (!task) continue;
      if (task.status === "completed" && task.depends_on) {
        for (const depId of task.depends_on) {
          const dep = taskMap.get(depId);
          expect(dep?.status, `DAG-INV [dag-fuzz]: completed task ${ref} has non-completed dep`).toBe("completed");
        }
      }
      // If cancelled, at least one dep should be failed/killed/cancelled
      if (task.status === "cancelled" && task.depends_on?.length > 0) {
        const anyFailed = task.depends_on.some((depId: string) => {
          const dep = taskMap.get(depId);
          return dep && ["failed", "killed", "cancelled"].includes(dep.status);
        });
        expect(anyFailed, `DAG-INV [dag-fuzz]: cancelled task ${ref} has no failed dep`).toBe(true);
      }
    }

    stub.socket.disconnect();
  }, 30_000);

  it("fan-out stress: 10 downstream from 1 root", async () => {
    const tag = `fuzz-fan-${randId()}`;
    const fanSize = 10;

    const specs: any[] = [{ ref: "root", script: "echo root", target_tags: [tag] }];
    for (let i = 0; i < fanSize; i++) {
      specs.push({
        ref: `branch_${i}`,
        script: `echo branch_${i}`,
        depends_on: ["root"],
        target_tags: [tag],
      });
    }

    const expR = await apiPost(`${BASE}/api/experiments`, TOKEN, {
      name: `fuzz-fan-${randId()}`,
      task_specs: specs,
    });
    expect(expR.status).toBe(201);
    const exp = await expR.json();

    // All branches should be blocked (check individually for better error message)
    for (let i = 0; i < fanSize; i++) {
      const branchId = exp.task_refs[`branch_${i}`];
      const r = await apiGet(`${BASE}/api/tasks/${branchId}`, TOKEN);
      const t = await r.json();
      expect(t.status, `branch_${i} should start as blocked`).toBe("blocked");
    }

    // Connect stub, complete root
    const stub = await connectFuzzStub(BASE, {
      hostname: `fuzz-fan-host-${randId()}`,
      gpuName: "NVIDIA A40",
      gpuCount: 1,
      maxConcurrent: 20,
      tags: [tag],
      token: TOKEN,
    });

    await sleep(500);
    // Root should be dispatched
    const rootId = exp.task_refs.root;
    if (stub.runningTaskIds.has(rootId)) {
      stub.socket.emit("task.completed", { task_id: rootId, exit_code: 0 });
    }
    await sleep(1000);

    // All branches should be promoted
    for (let i = 0; i < fanSize; i++) {
      const branchId = exp.task_refs[`branch_${i}`];
      const r = await apiGet(`${BASE}/api/tasks/${branchId}`, TOKEN);
      const t = await r.json();
      expect(["pending", "queued", "dispatched", "running"], `branch_${i} should be promoted`)
        .toContain(t?.status);
    }

    const state1 = await fetchState(BASE, TOKEN);
    checkInvariants(state1, "fan-out-stress");

    stub.socket.disconnect();
  }, 20_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FUZZ: Mixed random events
// ═══════════════════════════════════════════════════════════════════════════════

describe("Fuzz: chaos sequence", () => {
  it("random mix of submits, connects, disconnects, completes, fails — invariants hold", async () => {
    const ROUNDS = 30;
    const tag = `fuzz-chaos-${randId()}`;
    const stubs: FuzzStub[] = [];
    const taskIds: string[] = [];

    for (let round = 0; round < ROUNDS; round++) {
      const action = pick(["submit", "connect", "disconnect", "complete", "fail"]);

      switch (action) {
        case "submit": {
          const r = await apiPost(`${BASE}/api/tasks`, TOKEN, {
            script: `python fuzz_${randId()}.py`,
            args: { "--round": String(round) },
            target_tags: [tag],
            max_retries: maybe(0.3) ? randInt(1, 3) : 0,
          });
          if (r.ok) {
            const t = await r.json();
            taskIds.push(t.id);
          }
          break;
        }
        case "connect": {
          if (stubs.length < 5) {
            try {
              const s = await connectFuzzStub(BASE, {
                hostname: pick(HOSTNAMES),
                gpuName: pick(GPU_NAMES),
                gpuCount: pick(GPU_COUNTS),
                slurmJobId: maybe(0.7) ? String(randInt(100000, 999999)) : undefined,
                maxConcurrent: randInt(1, 4),
                tags: [tag],
                token: TOKEN,
              });
              stubs.push(s);
            } catch {}
          }
          break;
        }
        case "disconnect": {
          const online = stubs.filter((s) => s.connected);
          if (online.length > 0) {
            const s = pick(online);
            s.socket.disconnect();
            s.connected = false;
          }
          break;
        }
        case "complete": {
          const withTasks = stubs.filter((s) => s.connected && s.runningTaskIds.size > 0);
          if (withTasks.length > 0) {
            const s = pick(withTasks);
            const taskId = pick([...s.runningTaskIds]);
            s.socket.emit("task.completed", { task_id: taskId, exit_code: 0 });
            s.runningTaskIds.delete(taskId);
          }
          break;
        }
        case "fail": {
          const withTasks = stubs.filter((s) => s.connected && s.runningTaskIds.size > 0);
          if (withTasks.length > 0) {
            const s = pick(withTasks);
            const taskId = pick([...s.runningTaskIds]);
            s.socket.emit("task.failed", { task_id: taskId, exit_code: 1, error: "fuzz" });
            s.runningTaskIds.delete(taskId);
          }
          break;
        }
      }

      await sleep(150);
    }

    // Let things settle
    await sleep(1000);

    // Final invariant check
    const state = await fetchState(BASE, TOKEN);
    checkInvariants(state, "chaos-final");

    // Cleanup
    for (const s of stubs) {
      if (s.connected) s.socket.disconnect();
    }
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FUZZ: Export + template resolution under stress
// ═══════════════════════════════════════════════════════════════════════════════

describe("Fuzz: export + template stress", () => {
  it("multiple exports resolve correctly in downstream tasks", async () => {
    const tag = `fuzz-tmpl-${randId()}`;
    const exportKeys = ["model_path", "loss", "accuracy", "config_hash"];

    const specs: any[] = [
      { ref: "producer", script: "echo produce", target_tags: [tag] },
      {
        ref: "consumer",
        script: "echo consume",
        depends_on: ["producer"],
        args_template: Object.fromEntries(
          exportKeys.map((k) => [`--${k}`, `{{deps.producer.exports.${k}}}`])
        ),
        target_tags: [tag],
      },
    ];

    const expR = await apiPost(`${BASE}/api/experiments`, TOKEN, {
      name: `fuzz-tmpl-${randId()}`,
      task_specs: specs,
    });
    expect(expR.status).toBe(201);
    const exp = await expR.json();
    const producerId = exp.task_refs.producer;
    const consumerId = exp.task_refs.consumer;

    // Connect and run producer
    const stub = await connectFuzzStub(BASE, {
      hostname: `fuzz-tmpl-host-${randId()}`,
      gpuName: "NVIDIA A40",
      gpuCount: 1,
      maxConcurrent: 4,
      tags: [tag],
      token: TOKEN,
    });

    await sleep(500);

    // Export random values
    const exportValues: Record<string, string> = {};
    for (const key of exportKeys) {
      const value = `val_${randId()}`;
      exportValues[key] = value;
      await fetch(`${BASE}/api/sdk/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: producerId, type: "export", key, value }),
      });
    }
    await sleep(100);

    // Complete producer
    if (stub.runningTaskIds.has(producerId)) {
      stub.socket.emit("task.completed", { task_id: producerId, exit_code: 0 });
    }
    await sleep(800);

    // Consumer should have resolved args
    const consumerR = await apiGet(`${BASE}/api/tasks/${consumerId}`, TOKEN);
    const consumer = await consumerR.json();
    expect(["pending", "queued", "dispatched", "running"]).toContain(consumer.status);

    for (const key of exportKeys) {
      expect(consumer.args?.[`--${key}`], `Template --${key} should resolve`).toBe(exportValues[key]);
    }

    // Final invariant check
    const state = await fetchState(BASE, TOKEN);
    checkInvariants(state, "export-template-stress");

    stub.socket.disconnect();
  }, 20_000);
});
