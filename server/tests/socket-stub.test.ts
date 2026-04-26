/**
 * socket-stub.test.ts — Unit tests for socket/stub.ts logic.
 *
 * Mocks all external dependencies (store, task-actions, reliable, discord, …)
 * and exercises: markTasksLost, handleAutoRetry, initiateKillChain /
 * cancelKillChain, and the full resume/reconciliation flow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";
import { v4 as uuidv4 } from "uuid";

// ─── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../src/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// In-memory store state shared with mock implementations
const _stubs = new Map<string, any>();
let _seqCounter = 0;
const _queue: any[] = [];

vi.mock("../src/store", () => ({
  store: {
    getStub: (id: string) => _stubs.get(id),
    getAllStubs: () => Array.from(_stubs.values()),
    setStub: (stub: any) => { _stubs.set(stub.id, JSON.parse(JSON.stringify(stub))); },
    getTask: (stubId: string, taskId: string) => {
      const stub = _stubs.get(stubId);
      return stub?.tasks?.find((t: any) => t.id === taskId);
    },
    findTask: (taskId: string) => {
      for (const stub of _stubs.values()) {
        const task = stub.tasks?.find((t: any) => t.id === taskId);
        if (task) return { task, archived: false };
      }
      return undefined;
    },
    updateTask: (stubId: string, taskId: string, patch: any) => {
      const stub = _stubs.get(stubId);
      if (!stub) return undefined;
      const idx = stub.tasks?.findIndex((t: any) => t.id === taskId) ?? -1;
      if (idx === -1) return undefined;
      stub.tasks[idx] = { ...stub.tasks[idx], ...patch };
      return stub.tasks[idx];
    },
    addToGlobalQueue: (task: any) => _queue.push(task),
    getAllTasks: () => {
      const tasks: any[] = [..._queue];
      for (const stub of _stubs.values()) {
        if (stub.tasks) tasks.push(...stub.tasks);
      }
      return tasks;
    },
    getGrid: () => undefined,
    updateGridStatus: () => {},
    getGridTasks: () => [],
    getExperimentByGridId: () => undefined,
    setExperiment: () => {},
    nextSeq: () => ++_seqCounter,
    getToken: (token: string) => (token === "valid-token" ? { token, name: "test" } : undefined),
    rebuildWriteLocks: vi.fn(),
    unarchiveTask: vi.fn(),
  },
}));

vi.mock("../src/metrics", () => ({
  metricsStore: {
    pushStubMetrics: vi.fn(),
    pushTaskMetrics: vi.fn(),
    pushTaskMetricsDirect: vi.fn(),
  },
}));

vi.mock("../src/scheduler", () => ({
  maybeDispatch: vi.fn(),
  triggerSchedule: vi.fn(),
  buildRunPayload: (task: any) => ({ task_id: task.id, command: task.command }),
  computeRunDir: vi.fn(() => "/runs/task"),
  isCheckpointProtected: vi.fn(() => false),
}));

vi.mock("../src/reliable", () => ({
  registerStubSocket: vi.fn(),
  unregisterStubSocket: vi.fn(),
  reliableEmitToStub: vi.fn(),
}));

vi.mock("../src/discord", () => ({
  notifySubmitted: vi.fn().mockResolvedValue(undefined),
  notifyDispatched: vi.fn().mockResolvedValue(undefined),
  notifyRunning: vi.fn().mockResolvedValue(undefined),
  notifyCompleted: vi.fn().mockResolvedValue(undefined),
  notifyFailed: vi.fn().mockResolvedValue(undefined),
  notifyKilled: vi.fn().mockResolvedValue(undefined),
  notifyLost: vi.fn().mockResolvedValue(undefined),
  notifyGridDone: vi.fn().mockResolvedValue(undefined),
  notifyTaskMessage: vi.fn().mockResolvedValue(undefined),
  notifyExperimentPassed: vi.fn().mockResolvedValue(undefined),
  notifyExperimentPartial: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/criteria", () => ({
  evaluateCriteria: vi.fn(() => ({ passed: true, details: {} })),
}));

vi.mock("../src/api/experiments", () => ({
  deriveExperimentStatus: vi.fn(() => "passed"),
}));

vi.mock("../src/dedup", () => ({
  writeLockTable: { acquire: vi.fn(), release: vi.fn() },
}));

// task-actions mock backed by our _stubs map
vi.mock("../src/task-actions", () => ({
  loseTask: vi.fn((stubId: string, taskId: string) => {
    const stub = _stubs.get(stubId);
    if (!stub) return undefined;
    const idx = stub.tasks?.findIndex((t: any) => t.id === taskId) ?? -1;
    if (idx === -1) return undefined;
    stub.tasks[idx] = { ...stub.tasks[idx], status: "lost", finished_at: new Date().toISOString() };
    return stub.tasks[idx];
  }),
  startTask: vi.fn((stubId: string, taskId: string, pid: number) => {
    const stub = _stubs.get(stubId);
    if (!stub) return undefined;
    const idx = stub.tasks?.findIndex((t: any) => t.id === taskId) ?? -1;
    if (idx === -1) return undefined;
    stub.tasks[idx] = { ...stub.tasks[idx], status: "running", pid, started_at: new Date().toISOString() };
    return stub.tasks[idx];
  }),
  completeTask: vi.fn((stubId: string, taskId: string, exitCode: number) => {
    const stub = _stubs.get(stubId);
    if (!stub) return undefined;
    const idx = stub.tasks?.findIndex((t: any) => t.id === taskId) ?? -1;
    if (idx === -1) return undefined;
    stub.tasks[idx] = { ...stub.tasks[idx], status: "completed", exit_code: exitCode, finished_at: new Date().toISOString() };
    return stub.tasks[idx];
  }),
  failTask: vi.fn((stubId: string, taskId: string, exitCode?: number) => {
    const stub = _stubs.get(stubId);
    if (!stub) return undefined;
    const idx = stub.tasks?.findIndex((t: any) => t.id === taskId) ?? -1;
    if (idx === -1) return undefined;
    stub.tasks[idx] = { ...stub.tasks[idx], status: "failed", exit_code: exitCode, finished_at: new Date().toISOString() };
    return stub.tasks[idx];
  }),
  killTask: vi.fn((stubId: string, taskId: string, exitCode?: number) => {
    const stub = _stubs.get(stubId);
    if (!stub) return undefined;
    const idx = stub.tasks?.findIndex((t: any) => t.id === taskId) ?? -1;
    if (idx === -1) return undefined;
    stub.tasks[idx] = { ...stub.tasks[idx], status: "killed", exit_code: exitCode, finished_at: new Date().toISOString() };
    return stub.tasks[idx];
  }),
  recoverTask: vi.fn((stubId: string, taskId: string, pid: number) => {
    const stub = _stubs.get(stubId);
    if (!stub) return undefined;
    const idx = stub.tasks?.findIndex((t: any) => t.id === taskId) ?? -1;
    if (idx === -1) return undefined;
    stub.tasks[idx] = { ...stub.tasks[idx], status: "running", pid, finished_at: undefined };
    return stub.tasks[idx];
  }),
  resolveDeadTask: vi.fn((stubId: string, taskId: string, exitCode: number) => {
    const stub = _stubs.get(stubId);
    if (!stub) return undefined;
    const idx = stub.tasks?.findIndex((t: any) => t.id === taskId) ?? -1;
    if (idx === -1) return undefined;
    const status = exitCode === 0 ? "completed" : "failed";
    stub.tasks[idx] = { ...stub.tasks[idx], status, exit_code: exitCode, finished_at: new Date().toISOString() };
    return stub.tasks[idx];
  }),
  preflightFail: vi.fn(),
  promoteIfDispatched: vi.fn(),
  dispatchTask: vi.fn(),
  createRetryTask: vi.fn((task: any, opts?: any) => ({
    ...task,
    id: `retry-${task.id}-${Date.now()}`,
    seq: 9999,
    status: "pending",
    stub_id: undefined,
    run_dir: opts?.clearRunDir === false ? task.run_dir : undefined,
    retry_count: (task.retry_count || 0) + 1,
    retry_of: task.retry_of || task.id,
    created_at: new Date().toISOString(),
    started_at: undefined,
    finished_at: undefined,
    exit_code: undefined,
    pid: undefined,
    log_buffer: [],
    progress: undefined,
    should_stop: false,
    should_checkpoint: false,
    requirements: opts?.requirements ?? task.requirements,
  })),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { initiateKillChain, cancelKillChain, setupStubNamespace } from "../src/socket/stub";
import { notifyLost, notifyKilled } from "../src/discord";
import { loseTask, killTask, recoverTask, resolveDeadTask, createRetryTask } from "../src/task-actions";
import { reliableEmitToStub } from "../src/reliable";
import { triggerSchedule } from "../src/scheduler";
import { logger } from "../src/log";

// ─── Stable stub ID (mirrors computeStubId in stub.ts) ───────────────────────

// Base resume payload used across tests
const BASE_HOSTNAME = "gpu32";
const BASE_GPU = { name: "A40", count: 1 };
const BASE_RESUME_PAYLOAD = {
  hostname: BASE_HOSTNAME,
  gpu: BASE_GPU,
  max_concurrent: 5,
  token: "valid-token",
  running_tasks: [] as any[],
  local_queue: [] as string[],
};

/** Compute the same stub ID that stub.ts would for our base payload */
function computeExpectedStubId(
  hostname = BASE_HOSTNAME,
  gpu = BASE_GPU,
  defaultCwd?: string,
  slurmJobId?: string,
): string {
  const input = `${hostname}|${gpu.name}|${gpu.count}|${defaultCwd || ""}|${slurmJobId || ""}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

const STUB_ID = computeExpectedStubId();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<any> = {}): any {
  return {
    id: uuidv4(),
    seq: ++_seqCounter,
    status: "running",
    stub_id: STUB_ID,
    should_stop: false,
    max_retries: 0,
    retry_count: 0,
    log_buffer: [],
    command: "python train.py",
    display_name: "task",
    fingerprint: "fp-" + Math.random(),
    script: "train.py",
    priority: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Seed a stub at the correct computed ID */
function makeStub(overrides: Partial<any> = {}): any {
  return {
    id: STUB_ID,
    name: "gpu32-a40",
    hostname: BASE_HOSTNAME,
    status: "online",
    socket_id: undefined as string | undefined,
    tasks: [] as any[],
    connected_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    max_concurrent: 5,
    type: "slurm",
    gpu: BASE_GPU,
    ...overrides,
  };
}

function makeWebNs(): any {
  return { emit: vi.fn() };
}

// ─── Setup helper ──────────────────────────────────────────────────────────────

interface Harness {
  /**
   * socketHandlers[event](...args) fires ALL listeners for that event.
   * Calling it with `?.()` syntax also works safely.
   */
  socketHandlers: Record<string, (...args: any[]) => void>;
  mockSocket: any;
  webNs: any;
}

/**
 * Create a mock socket + namespace, call setupStubNamespace, optionally
 * fire a resume event so the socket→stub mapping is established.
 *
 * If `preExistingStub` is provided it is seeded in _stubs before resume.
 * The stub's socket_id is automatically updated to the mock socket's id
 * after resume completes.
 */
function buildHarness(opts: {
  socketId?: string;
  preExistingStub?: any;
  nsSocketMap?: Record<string, any>;
  resumePayload?: Partial<typeof BASE_RESUME_PAYLOAD> & Record<string, any>;
  skipResume?: boolean;
} = {}): Harness {
  const socketId = opts.socketId ?? ("sock-" + Math.random().toString(36).slice(2));
  // Support multiple listeners per event (socket.io EventEmitter semantics)
  const socketListeners: Record<string, Function[]> = {};

  const mockSocket: any = {
    id: socketId,
    on: (ev: string, fn: Function) => {
      if (!socketListeners[ev]) socketListeners[ev] = [];
      socketListeners[ev].push(fn);
    },
    emit: vi.fn(),
    join: vi.fn(),
    disconnect: vi.fn(),
  };

  const nsSocketMap = opts.nsSocketMap ?? {};
  const ns: any = {
    sockets: { get: (id: string) => nsSocketMap[id] },
    on: (_ev: string, fn: Function) => fn(mockSocket),
  };

  const webNs = makeWebNs();
  setupStubNamespace(ns, webNs);

  // Build a proxy object that fires ALL registered listeners when called
  const socketHandlers = new Proxy({} as Record<string, (...args: any[]) => void>, {
    get(_target, prop: string) {
      return (...args: any[]) => {
        for (const fn of socketListeners[prop] ?? []) fn(...args);
      };
    },
    has(_target, prop: string) {
      return prop in socketListeners;
    },
  });

  if (!opts.skipResume) {
    if (opts.preExistingStub) {
      // Ensure socket_id is set to our mock socket's id so disconnect guard passes
      _stubs.set(opts.preExistingStub.id, { ...opts.preExistingStub, socket_id: socketId });
    }
    const payload = { ...BASE_RESUME_PAYLOAD, ...(opts.resumePayload ?? {}) };
    socketHandlers["resume"](payload);
    // After resume, stub in store will have socket_id = socketId
  }

  return { socketHandlers, mockSocket, webNs };
}

// ─── State cleanup ────────────────────────────────────────────────────────────

beforeEach(() => {
  _stubs.clear();
  _queue.length = 0;
  _seqCounter = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ═══════════════════════════════════════════════════════════════════════════════
// markTasksLost — exercised via the disconnect event
// ═══════════════════════════════════════════════════════════════════════════════

describe("markTasksLost (via disconnect)", () => {
  it("loses a running task on disconnect", () => {
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    const { socketHandlers, webNs } = buildHarness({ preExistingStub: stub });

    socketHandlers["disconnect"]?.();

    expect(loseTask).toHaveBeenCalledWith(STUB_ID, task.id);
    expect(webNs.emit).toHaveBeenCalledWith("task.update", expect.objectContaining({ status: "lost" }));
    expect(notifyLost).toHaveBeenCalled();
  });

  it("loses a dispatched task on disconnect", () => {
    const task = makeTask({ status: "dispatched" });
    const stub = makeStub({ tasks: [task] });
    const { socketHandlers } = buildHarness({ preExistingStub: stub });

    socketHandlers["disconnect"]?.();

    expect(loseTask).toHaveBeenCalledWith(STUB_ID, task.id);
  });

  it("loses a paused task on disconnect", () => {
    const task = makeTask({ status: "paused" });
    const stub = makeStub({ tasks: [task] });
    const { socketHandlers } = buildHarness({ preExistingStub: stub });

    socketHandlers["disconnect"]?.();

    expect(loseTask).toHaveBeenCalledWith(STUB_ID, task.id);
  });

  it("kills a task (should_stop=true) instead of losing it on disconnect", () => {
    const task = makeTask({ status: "running", should_stop: true });
    const stub = makeStub({ tasks: [task] });
    // Report the task as running during resume so reconciliation doesn't touch it;
    // disconnect is where the should_stop logic fires.
    const { socketHandlers, webNs } = buildHarness({
      preExistingStub: stub,
      resumePayload: { running_tasks: [{ task_id: task.id, pid: 123 }] },
    });

    // Record call count after resume (reconciliation may have called some mocks)
    const killCallsBefore = (killTask as any).mock.calls.length;
    const loseCallsBefore = (loseTask as any).mock.calls.length;

    socketHandlers["disconnect"]?.();

    // killTask must have been called at least once MORE than before disconnect
    expect((killTask as any).mock.calls.length).toBeGreaterThan(killCallsBefore);
    // The additional call should be for our task
    const newKillCalls = (killTask as any).mock.calls.slice(killCallsBefore);
    expect(newKillCalls).toEqual(expect.arrayContaining([[STUB_ID, task.id, undefined]]));
    // loseTask should NOT have been called any additional times
    expect((loseTask as any).mock.calls.length).toBe(loseCallsBefore);
    expect(notifyKilled).toHaveBeenCalled();
    expect(webNs.emit).toHaveBeenCalledWith("task.update", expect.objectContaining({ status: "killed" }));
  });

  it("skips tasks already in lost state — no duplicate notification", () => {
    const task = makeTask({ status: "lost" });
    const stub = makeStub({ tasks: [task] });
    const { socketHandlers } = buildHarness({ preExistingStub: stub });

    socketHandlers["disconnect"]?.();

    expect(loseTask).not.toHaveBeenCalled();
  });

  it("skips terminal tasks (completed / failed / killed)", () => {
    const tasks = [
      makeTask({ status: "completed" }),
      makeTask({ status: "failed" }),
      makeTask({ status: "killed" }),
    ];
    const stub = makeStub({ tasks });
    const { socketHandlers } = buildHarness({ preExistingStub: stub });

    socketHandlers["disconnect"]?.();

    expect(loseTask).not.toHaveBeenCalled();
  });

  it("does NOT process disconnect if socket.id no longer matches stub.socket_id (reconnect race)", () => {
    // Report the task as running during resume so reconciliation doesn't touch it;
    // only the disconnect guard is under test here.
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    const { socketHandlers } = buildHarness({
      preExistingStub: stub,
      resumePayload: { running_tasks: [{ task_id: task.id, pid: 456 }] },
    });

    // Record calls from reconciliation
    const loseCallsBefore = (loseTask as any).mock.calls.length;

    // Simulate a new socket taking over: update stub.socket_id to a different value
    _stubs.get(STUB_ID)!.socket_id = "sock-brand-new";

    socketHandlers["disconnect"]?.();

    // The disconnect guard (stub.socket_id !== socket.id) should have fired → no additional loseTask
    expect((loseTask as any).mock.calls.length).toBe(loseCallsBefore);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleAutoRetry — triggered by markTasksLost
// ═══════════════════════════════════════════════════════════════════════════════

describe("handleAutoRetry (via disconnect → markTasksLost)", () => {
  it("creates a retry task when max_retries > 0 and retry_count < max_retries", () => {
    const task = makeTask({ status: "running", max_retries: 3, retry_count: 0 });
    const stub = makeStub({ tasks: [task] });
    const { socketHandlers, webNs } = buildHarness({ preExistingStub: stub });

    socketHandlers["disconnect"]?.();

    expect(_queue).toHaveLength(1);
    const retryTask = _queue[0];
    expect(retryTask.status).toBe("pending");
    expect(retryTask.retry_count).toBe(1);
    expect(retryTask.retry_of).toBe(task.id);
    expect(retryTask.id).not.toBe(task.id);
    expect(retryTask.stub_id).toBeUndefined();
    expect(retryTask.run_dir).toBeUndefined();
    expect(retryTask.log_buffer).toEqual([]);
    expect(webNs.emit).toHaveBeenCalledWith("task.update", expect.objectContaining({ status: "pending" }));
    expect(triggerSchedule).toHaveBeenCalled();
  });

  it("does NOT retry when max_retries is 0", () => {
    const task = makeTask({ status: "running", max_retries: 0 });
    const stub = makeStub({ tasks: [task] });
    const { socketHandlers } = buildHarness({ preExistingStub: stub });

    socketHandlers["disconnect"]?.();

    expect(_queue).toHaveLength(0);
  });

  it("does NOT retry when retry_count has reached max_retries", () => {
    const task = makeTask({ status: "running", max_retries: 2, retry_count: 2 });
    const stub = makeStub({ tasks: [task] });
    const { socketHandlers } = buildHarness({ preExistingStub: stub });

    socketHandlers["disconnect"]?.();

    expect(_queue).toHaveLength(0);
  });

  it("preserves retry_of across multiple retry hops", () => {
    const originalId = uuidv4();
    const task = makeTask({ status: "running", max_retries: 5, retry_count: 2, retry_of: originalId });
    const stub = makeStub({ tasks: [task] });
    const { socketHandlers } = buildHarness({ preExistingStub: stub });

    socketHandlers["disconnect"]?.();

    expect(_queue[0].retry_of).toBe(originalId);
  });

  it("sets retry_of to the original task.id on the first retry", () => {
    const task = makeTask({ status: "running", max_retries: 1, retry_count: 0, retry_of: undefined });
    const stub = makeStub({ tasks: [task] });
    const { socketHandlers } = buildHarness({ preExistingStub: stub });

    socketHandlers["disconnect"]?.();

    expect(_queue[0].retry_of).toBe(task.id);
  });

  it("clears all lifecycle fields on the retry task", () => {
    const task = makeTask({
      status: "running",
      max_retries: 1,
      retry_count: 0,
      started_at: "2024-01-01T00:00:00Z",
      finished_at: "2024-01-01T01:00:00Z",
      exit_code: 1,
      pid: 1234,
      progress: { step: 50, total: 100 },
    });
    const stub = makeStub({ tasks: [task] });
    const { socketHandlers } = buildHarness({ preExistingStub: stub });

    socketHandlers["disconnect"]?.();

    const r = _queue[0];
    expect(r.started_at).toBeUndefined();
    expect(r.finished_at).toBeUndefined();
    expect(r.exit_code).toBeUndefined();
    expect(r.pid).toBeUndefined();
    expect(r.progress).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// initiateKillChain / cancelKillChain
// ═══════════════════════════════════════════════════════════════════════════════

describe("initiateKillChain / cancelKillChain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("emits task.kill reliably with correct payload", () => {
    const taskId = uuidv4();
    const task = makeTask({ id: taskId, status: "running" });
    const stub = makeStub({ tasks: [task] });
    _stubs.set(stub.id, stub);

    initiateKillChain(stub.id, taskId, 30);

    expect(reliableEmitToStub).toHaveBeenCalledWith(
      stub.id,
      "task.kill",
      { task_id: taskId, grace_period_s: 30 },
    );
  });

  it("uses default grace period of 30s", () => {
    const taskId = uuidv4();
    const task = makeTask({ id: taskId, status: "running" });
    const stub = makeStub({ tasks: [task] });
    _stubs.set(stub.id, stub);

    initiateKillChain(stub.id, taskId);

    expect(reliableEmitToStub).toHaveBeenCalledWith(
      stub.id,
      "task.kill",
      expect.objectContaining({ grace_period_s: 30 }),
    );
  });

  it("fires safety-net kill (grace=5) after 2× grace period if task still running", async () => {
    const taskId = uuidv4();
    const task = makeTask({ id: taskId, status: "running" });
    const stub = makeStub({ tasks: [task] });
    _stubs.set(stub.id, stub);

    initiateKillChain(stub.id, taskId, 10);

    await vi.advanceTimersByTimeAsync(10 * 2 * 1000 + 100);

    expect(reliableEmitToStub).toHaveBeenCalledTimes(2);
    expect((reliableEmitToStub as any).mock.calls[1][2]).toMatchObject({ grace_period_s: 5 });
  });

  it("does NOT fire safety-net if task already completed before timer fires", async () => {
    const taskId = uuidv4();
    const task = makeTask({ id: taskId, status: "running" });
    const stub = makeStub({ tasks: [task] });
    _stubs.set(stub.id, stub);

    initiateKillChain(stub.id, taskId, 10);

    // Transition task to completed before timer fires
    _stubs.get(stub.id)!.tasks[0].status = "completed";

    await vi.advanceTimersByTimeAsync(10 * 2 * 1000 + 100);

    expect(reliableEmitToStub).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire safety-net if task was removed from store before timer fires", async () => {
    const taskId = uuidv4();
    const task = makeTask({ id: taskId, status: "running" });
    const stub = makeStub({ tasks: [task] });
    _stubs.set(stub.id, stub);

    initiateKillChain(stub.id, taskId, 10);

    // Remove the task
    _stubs.get(stub.id)!.tasks = [];

    await vi.advanceTimersByTimeAsync(10 * 2 * 1000 + 100);

    expect(reliableEmitToStub).toHaveBeenCalledTimes(1);
  });

  it("cancelKillChain cancels the safety-net timer", async () => {
    const taskId = uuidv4();
    const task = makeTask({ id: taskId, status: "running" });
    const stub = makeStub({ tasks: [task] });
    _stubs.set(stub.id, stub);

    initiateKillChain(stub.id, taskId, 10);
    cancelKillChain(taskId);

    await vi.advanceTimersByTimeAsync(10 * 2 * 1000 + 100);

    // Only the initial emit
    expect(reliableEmitToStub).toHaveBeenCalledTimes(1);
  });

  it("cancelKillChain is safe to call for unknown task IDs", () => {
    expect(() => cancelKillChain("no-such-task-id")).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Resume / Reconciliation
// ═══════════════════════════════════════════════════════════════════════════════

describe("resume reconciliation", () => {
  it("rejects invalid token and disconnects the socket", () => {
    const { socketHandlers, mockSocket } = buildHarness({ skipResume: true });
    socketHandlers["resume"]?.({ ...BASE_RESUME_PAYLOAD, token: "wrong" });
    expect(mockSocket.emit).toHaveBeenCalledWith("error", expect.objectContaining({ message: "Invalid token" }));
    expect(mockSocket.disconnect).toHaveBeenCalled();
  });

  it("emits stub.online on successful first resume", () => {
    const { socketHandlers, webNs } = buildHarness({ skipResume: true });
    socketHandlers["resume"]?.(BASE_RESUME_PAYLOAD);
    expect(webNs.emit).toHaveBeenCalledWith("stub.online", expect.objectContaining({ hostname: BASE_HOSTNAME }));
  });

  it("stub.online payload omits socket_id (sanitized)", () => {
    const { socketHandlers, webNs } = buildHarness({ skipResume: true });
    socketHandlers["resume"]?.(BASE_RESUME_PAYLOAD);
    const call = webNs.emit.mock.calls.find((c: any[]) => c[0] === "stub.online");
    expect(call![1]).not.toHaveProperty("socket_id");
  });

  it("calls ack with { ok: true } when ack callback is provided", () => {
    const { socketHandlers } = buildHarness({ skipResume: true });
    const ack = vi.fn();
    socketHandlers["resume"]?.(BASE_RESUME_PAYLOAD, ack);
    expect(ack).toHaveBeenCalledWith({ ok: true });
  });

  it("does not throw when no ack callback is provided", () => {
    const { socketHandlers } = buildHarness({ skipResume: true });
    expect(() => socketHandlers["resume"]?.(BASE_RESUME_PAYLOAD)).not.toThrow();
  });

  it("Case A: server-side running task not reported by stub → task marked lost", () => {
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    _stubs.set(stub.id, stub);

    const { socketHandlers, webNs } = buildHarness({ skipResume: true });
    // Stub reports zero running tasks
    socketHandlers["resume"]?.({ ...BASE_RESUME_PAYLOAD, running_tasks: [] });

    expect(loseTask).toHaveBeenCalledWith(STUB_ID, task.id);
    expect(webNs.emit).toHaveBeenCalledWith("task.update", expect.objectContaining({ status: "lost" }));
    expect(notifyLost).toHaveBeenCalled();
  });

  it("Case A: dispatched task not reported by stub → also marked lost", () => {
    const task = makeTask({ status: "dispatched" });
    const stub = makeStub({ tasks: [task] });
    _stubs.set(stub.id, stub);

    const { socketHandlers } = buildHarness({ skipResume: true });
    socketHandlers["resume"]?.({ ...BASE_RESUME_PAYLOAD, running_tasks: [] });

    expect(loseTask).toHaveBeenCalledWith(STUB_ID, task.id);
  });

  it("Case B: stub reports unknown task → orphan added to kill_tasks", () => {
    const orphanId = uuidv4();
    const { socketHandlers } = buildHarness({ skipResume: true });

    socketHandlers["resume"]?.({
      ...BASE_RESUME_PAYLOAD,
      running_tasks: [{ task_id: orphanId, pid: 999 }],
    });

    expect(reliableEmitToStub).toHaveBeenCalledWith(
      STUB_ID,
      "resume_response",
      expect.objectContaining({ kill_tasks: expect.arrayContaining([orphanId]) }),
    );
  });

  it("recovers a 'lost' task that stub still reports as running", () => {
    const task = makeTask({ status: "lost" });
    const stub = makeStub({ tasks: [task] });
    _stubs.set(stub.id, stub);

    const { socketHandlers, webNs } = buildHarness({ skipResume: true });
    socketHandlers["resume"]?.({
      ...BASE_RESUME_PAYLOAD,
      running_tasks: [{ task_id: task.id, pid: 1111 }],
    });

    expect(recoverTask).toHaveBeenCalledWith(STUB_ID, task.id, 1111);
    expect(webNs.emit).toHaveBeenCalledWith("task.update", expect.objectContaining({ status: "running" }));
  });

  it("'killed' server task that stub still runs → included in kill_tasks", () => {
    const task = makeTask({ status: "killed" });
    const stub = makeStub({ tasks: [task] });
    _stubs.set(stub.id, stub);

    const { socketHandlers } = buildHarness({ skipResume: true });
    socketHandlers["resume"]?.({
      ...BASE_RESUME_PAYLOAD,
      running_tasks: [{ task_id: task.id, pid: 5555 }],
    });

    expect(reliableEmitToStub).toHaveBeenCalledWith(
      STUB_ID,
      "resume_response",
      expect.objectContaining({ kill_tasks: expect.arrayContaining([task.id]) }),
    );
  });

  it("Case C: queued server task not in stub local_queue → included in adopt_tasks", () => {
    const task = makeTask({ status: "queued" });
    const stub = makeStub({ tasks: [task] });
    _stubs.set(stub.id, stub);

    const { socketHandlers } = buildHarness({ skipResume: true });
    socketHandlers["resume"]?.({ ...BASE_RESUME_PAYLOAD, local_queue: [] });

    expect(reliableEmitToStub).toHaveBeenCalledWith(
      STUB_ID,
      "resume_response",
      expect.objectContaining({
        adopt_tasks: expect.arrayContaining([
          expect.objectContaining({ task_id: task.id }),
        ]),
      }),
    );
  });

  it("kicks ghost socket when elapsed time since last connect > 3s", () => {
    const ghostSocket = { disconnect: vi.fn(), id: "ghost" };
    const stub = makeStub({
      socket_id: "ghost",
      connected_at: new Date(Date.now() - 5000).toISOString(),
    });
    _stubs.set(stub.id, stub);

    const { socketHandlers } = buildHarness({
      socketId: "new-sock-" + Math.random(),
      nsSocketMap: { ghost: ghostSocket },
      skipResume: true,
    });
    socketHandlers["resume"]?.(BASE_RESUME_PAYLOAD);

    expect(ghostSocket.disconnect).toHaveBeenCalledWith(true);
  });

  it("rate-limiter: rejects reconnect if elapsed < configured limit", () => {
    // Rate limiter is configurable via RECONNECT_RATE_LIMIT_MS env var (default 0 = disabled).
    // Set it to 3000ms to test the rate limit behavior.
    const origEnv = process.env.RECONNECT_RATE_LIMIT_MS;
    process.env.RECONNECT_RATE_LIMIT_MS = "3000";
    try {
      const stub = makeStub({
        socket_id: "prev",
        connected_at: new Date(Date.now() - 500).toISOString(),
      });
      _stubs.set(stub.id, stub);

      const { socketHandlers, mockSocket } = buildHarness({ skipResume: true });
      socketHandlers["resume"]?.(BASE_RESUME_PAYLOAD);

      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
    } finally {
      if (origEnv === undefined) {
        delete process.env.RECONNECT_RATE_LIMIT_MS;
      } else {
        process.env.RECONNECT_RATE_LIMIT_MS = origEnv;
      }
    }
  });

  it("server max_concurrent is preserved on reconnect (authoritative over stub)", () => {
    const stub = makeStub({
      socket_id: "ghost2",
      max_concurrent: 8,  // server value
      connected_at: new Date(Date.now() - 5000).toISOString(),
    });
    _stubs.set(stub.id, stub);

    const { socketHandlers } = buildHarness({
      nsSocketMap: { ghost2: { disconnect: vi.fn(), id: "ghost2" } },
      skipResume: true,
    });
    socketHandlers["resume"]?.({ ...BASE_RESUME_PAYLOAD, max_concurrent: 3 }); // stub says 3

    const updated = _stubs.get(STUB_ID)!;
    expect(updated.max_concurrent).toBe(8); // server wins
  });

  it("auto-retry triggered for tasks lost during Case A reconciliation", () => {
    const task = makeTask({ status: "running", max_retries: 2, retry_count: 0 });
    const stub = makeStub({ tasks: [task] });
    _stubs.set(stub.id, stub);

    const { socketHandlers } = buildHarness({ skipResume: true });
    socketHandlers["resume"]?.({ ...BASE_RESUME_PAYLOAD, running_tasks: [] });

    expect(_queue).toHaveLength(1);
    expect(_queue[0].status).toBe("pending");
    expect(_queue[0].retry_count).toBe(1);
  });

  it("dead_tasks with exit_code=0 are resolved as completed", () => {
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    _stubs.set(stub.id, stub);

    const { socketHandlers, webNs } = buildHarness({ skipResume: true });
    socketHandlers["resume"]?.({
      ...BASE_RESUME_PAYLOAD,
      dead_tasks: [{ task_id: task.id, exit_code: 0 }],
    });

    expect(resolveDeadTask).toHaveBeenCalledWith(STUB_ID, task.id, 0);
    expect(webNs.emit).toHaveBeenCalledWith("task.update", expect.objectContaining({ status: "completed" }));
  });

  it("dead_tasks with non-zero exit_code are resolved as failed", () => {
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    _stubs.set(stub.id, stub);

    const { socketHandlers, webNs } = buildHarness({ skipResume: true });
    socketHandlers["resume"]?.({
      ...BASE_RESUME_PAYLOAD,
      dead_tasks: [{ task_id: task.id, exit_code: 1 }],
    });

    expect(resolveDeadTask).toHaveBeenCalledWith(STUB_ID, task.id, 1);
    expect(webNs.emit).toHaveBeenCalledWith("task.update", expect.objectContaining({ status: "failed" }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Heartbeat
// ═══════════════════════════════════════════════════════════════════════════════

describe("heartbeat event", () => {
  it("updates stub.last_heartbeat with provided timestamp", () => {
    const stub = makeStub();
    const { socketHandlers } = buildHarness({ preExistingStub: stub });

    const ts = "2024-06-01T12:00:00.000Z";
    socketHandlers["heartbeat"]?.({ timestamp: ts });

    // After resume, the stub is stored with a new socket_id but same id
    const updated = _stubs.get(STUB_ID)!;
    expect(updated.last_heartbeat).toBe(ts);
  });

  it("falls back to current ISO time when timestamp is absent", () => {
    const before = Date.now();
    const stub = makeStub();
    const { socketHandlers } = buildHarness({ preExistingStub: stub });

    socketHandlers["heartbeat"]?.({});

    const updated = _stubs.get(STUB_ID)!;
    const hbTime = new Date(updated.last_heartbeat).getTime();
    expect(hbTime).toBeGreaterThanOrEqual(before);
  });

  it("is a no-op (does not crash) if socket has not done resume", () => {
    const { socketHandlers } = buildHarness({ skipResume: true });
    expect(() => socketHandlers["heartbeat"]?.({ timestamp: "ts" })).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// task.zombie
// ═══════════════════════════════════════════════════════════════════════════════

describe("task.zombie event", () => {
  it("logs a warning and does not crash", () => {
    const stub = makeStub();
    const { socketHandlers } = buildHarness({ preExistingStub: stub });

    expect(() =>
      socketHandlers["task.zombie"]?.({ task_id: "z-123" }, () => {}),
    ).not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith("task.zombie", expect.objectContaining({ task_id: "z-123" }));
  });

  it("calls ack with { ok: true }", () => {
    const stub = makeStub();
    const { socketHandlers } = buildHarness({ preExistingStub: stub });
    const ack = vi.fn();
    socketHandlers["task.zombie"]?.({ task_id: "z-456" }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Grid completion
// ═══════════════════════════════════════════════════════════════════════════════

describe("checkGridCompletion", () => {
  it("does not crash when grid does not exist in store", () => {
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    const { socketHandlers } = buildHarness({ preExistingStub: stub });

    // store.getGrid returns undefined — should be a graceful no-op
    expect(() =>
      socketHandlers["task.completed"]?.({ task_id: task.id, exit_code: 0 }, () => {}),
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Shell relay
// ═══════════════════════════════════════════════════════════════════════════════

describe("shell relay (stub → web)", () => {
  it("shell.output is forwarded verbatim to webNs", () => {
    const stub = makeStub();
    const { socketHandlers, webNs } = buildHarness({ preExistingStub: stub });
    const data = { request_id: "req-1", chunk: "hello stdout", stream: "stdout" };
    socketHandlers["shell.output"]?.(data);
    expect(webNs.emit).toHaveBeenCalledWith("shell.output", data);
  });

  it("shell.done is forwarded verbatim to webNs", () => {
    const stub = makeStub();
    const { socketHandlers, webNs } = buildHarness({ preExistingStub: stub });
    const data = { request_id: "req-1", exit_code: 0 };
    socketHandlers["shell.done"]?.(data);
    expect(webNs.emit).toHaveBeenCalledWith("shell.done", data);
  });
});
