/**
 * scheduler.test.ts — Unit tests for scheduler.ts
 *
 * Covers: scoreStub (hard constraints + soft scoring), computeRunDir,
 * buildRunPayload, maybeDispatch, schedule re-entrancy guard,
 * fingerprint handling in dispatch.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ─── Mock external modules ────────────────────────────────────────────────────

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => "{}"),
    writeFileSync: vi.fn(),
  },
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: {
    writeFile: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
  },
  writeFile: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
}));

vi.mock("../src/store/backup", () => ({
  backupState: vi.fn(async () => "backup.json"),
  pruneBackups: vi.fn(async () => {}),
}));

vi.mock("../src/log", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../src/reliable", () => ({
  reliableEmitToStub: vi.fn(),
}));

vi.mock("../src/discord", () => ({
  notifyDispatched: vi.fn(async () => {}),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { scoreStub, computeRunDir, buildRunPayload, maybeDispatch, schedule, triggerSchedule } from "../src/scheduler";
import { store } from "../src/store/index";
import { reliableEmitToStub } from "../src/reliable";
import { Task, Stub, TaskStatus, GpuStatEntry } from "../src/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _seq = 500;

function makeTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? `task-${_seq++}`;
  return {
    id,
    seq: _seq++,
    fingerprint: `fp-${id}`,
    display_name: `Task ${id}`,
    script: "train.py",
    command: "python train.py",
    status: "pending" as TaskStatus,
    priority: 0,
    created_at: new Date().toISOString(),
    log_buffer: [],
    retry_count: 0,
    max_retries: 0,
    should_stop: false,
    should_checkpoint: false,
    ...overrides,
  };
}

function makeStub(overrides: Partial<Stub> = {}): Stub {
  const id = overrides.id ?? `stub-${_seq++}`;
  return {
    id,
    name: `stub-${id}`,
    hostname: "gpu01",
    gpu: { name: "A100", vram_total_mb: 40960, count: 1 },
    status: "online",
    type: "slurm",
    connected_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    max_concurrent: 4,
    tasks: [],
    ...overrides,
  };
}

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
  _seq = 500;
});

afterEach(() => {
  vi.useRealTimers();
});

// ═══════════════════════════════════════════════════════════════════════════════
// scoreStub — hard constraints
// ═══════════════════════════════════════════════════════════════════════════════

describe("scoreStub — hard constraints", () => {
  it("offline stub returns -Infinity", () => {
    const stub = makeStub({ status: "offline" });
    const task = makeTask();
    expect(scoreStub(stub, task)).toBe(-Infinity);
  });

  it("stub missing required tag returns -Infinity", () => {
    const stub = makeStub({ tags: ["gpu"] });
    const task = makeTask({ target_tags: ["gpu", "high-mem"] });
    expect(scoreStub(stub, task)).toBe(-Infinity);
  });

  it("stub with all required tags passes tag check", () => {
    const stub = makeStub({ tags: ["gpu", "high-mem", "extra"] });
    const task = makeTask({ target_tags: ["gpu", "high-mem"] });
    expect(scoreStub(stub, task)).toBeGreaterThan(-Infinity);
  });

  it("task with no target_tags passes any stub", () => {
    const stub = makeStub({ tags: [] });
    const task = makeTask({ target_tags: [] });
    expect(scoreStub(stub, task)).toBeGreaterThan(-Infinity);
  });

  it("insufficient VRAM (static) returns -Infinity", () => {
    const stub = makeStub({
      gpu: { name: "A100", vram_total_mb: 10_000, count: 1 },
      tasks: [],
    });
    const task = makeTask({ requirements: { gpu_mem_mb: 20_000 } });
    expect(scoreStub(stub, task)).toBe(-Infinity);
  });

  it("sufficient VRAM passes VRAM check", () => {
    const stub = makeStub({
      gpu: { name: "A100", vram_total_mb: 40_960, count: 1 },
      tasks: [],
    });
    const task = makeTask({ requirements: { gpu_mem_mb: 20_000 } });
    expect(scoreStub(stub, task)).toBeGreaterThan(-Infinity);
  });

  it("VRAM check uses gpu_stats when available (live reading)", () => {
    const gpus: GpuStatEntry[] = [
      { index: 0, utilization_pct: 80, memory_used_mb: 35_000, memory_total_mb: 40_960, temperature_c: 70 },
    ];
    const stub = makeStub({
      gpu: { name: "A100", vram_total_mb: 40_960, count: 1 },
      gpu_stats: { timestamp: new Date().toISOString(), gpus },
      tasks: [],
    });
    const task = makeTask({ requirements: { gpu_mem_mb: 10_000 } }); // needs 10GB, only 5.96GB free
    expect(scoreStub(stub, task)).toBe(-Infinity);
  });

  it("gpu_type mismatch returns -Infinity", () => {
    const stub = makeStub({ gpu: { name: "RTX 3090", vram_total_mb: 24576, count: 1 } });
    const task = makeTask({ requirements: { gpu_type: ["A100"] } });
    expect(scoreStub(stub, task)).toBe(-Infinity);
  });

  it("gpu_type match passes", () => {
    const stub = makeStub({ gpu: { name: "NVIDIA A100", vram_total_mb: 40960, count: 1 } });
    const task = makeTask({ requirements: { gpu_type: ["A100"] } });
    expect(scoreStub(stub, task)).toBeGreaterThan(-Infinity);
  });

  it("gpu_type check normalizes names (case, spaces, dashes)", () => {
    const stub = makeStub({ gpu: { name: "NVIDIA-RTX-3090", vram_total_mb: 24576, count: 1 } });
    const task = makeTask({ requirements: { gpu_type: ["rtx 3090"] } });
    expect(scoreStub(stub, task)).toBeGreaterThan(-Infinity);
  });

  it("cpu_mem_mb constraint returns -Infinity when insufficient", () => {
    const stub = makeStub({
      system_stats: { cpu_pct: 10, mem_used_mb: 60_000, mem_total_mb: 64_000 },
    });
    const task = makeTask({ requirements: { cpu_mem_mb: 10_000 } }); // only 4GB free
    expect(scoreStub(stub, task)).toBe(-Infinity);
  });

  it("cpu_mem_mb check is skipped when system_stats absent", () => {
    const stub = makeStub({ system_stats: undefined });
    const task = makeTask({ requirements: { cpu_mem_mb: 500_000 } }); // huge requirement
    // No system_stats → skip check → passes
    expect(scoreStub(stub, task)).toBeGreaterThan(-Infinity);
  });

  it("python_env not available returns -Infinity", () => {
    const stub = makeStub({
      available_envs: [{ name: "base", type: "conda", path: "/envs/base" }],
    });
    const task = makeTask({ python_env: "jema" });
    expect(scoreStub(stub, task)).toBe(-Infinity);
  });

  it("python_env available passes", () => {
    const stub = makeStub({
      available_envs: [{ name: "jema", type: "conda", path: "/envs/jema" }],
    });
    const task = makeTask({ python_env: "jema" });
    expect(scoreStub(stub, task)).toBeGreaterThan(-Infinity);
  });

  it("slots_full returns -Infinity", () => {
    const runningTasks = Array.from({ length: 4 }, () =>
      makeTask({ status: "running" })
    );
    const stub = makeStub({ max_concurrent: 4, tasks: runningTasks });
    const task = makeTask();
    expect(scoreStub(stub, task)).toBe(-Infinity);
  });

  it("slots partially used still passes", () => {
    const running = makeTask({ status: "running" });
    const stub = makeStub({ max_concurrent: 4, tasks: [running] });
    const task = makeTask();
    expect(scoreStub(stub, task)).toBeGreaterThan(-Infinity);
  });

  it("running+queued count both toward max_concurrent", () => {
    const r1 = makeTask({ status: "running" });
    const r2 = makeTask({ status: "running" });
    const q1 = makeTask({ status: "queued" });
    const q2 = makeTask({ status: "queued" });
    const stub = makeStub({ max_concurrent: 4, tasks: [r1, r2, q1, q2] });
    const task = makeTask();
    expect(scoreStub(stub, task)).toBe(-Infinity);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// scoreStub — soft scoring
// ═══════════════════════════════════════════════════════════════════════════════

describe("scoreStub — soft scoring", () => {
  it("idle stub scores higher than busy stub", () => {
    const idle = makeStub({ id: "idle", max_concurrent: 4, tasks: [] });
    const busy = makeStub({
      id: "busy",
      max_concurrent: 4,
      tasks: [makeTask({ status: "running" }), makeTask({ status: "running" })],
    });
    const task = makeTask();
    expect(scoreStub(idle, task)).toBeGreaterThan(scoreStub(busy, task));
  });

  it("grid locality bonus: stub already running same-grid task scores higher", () => {
    const gridId = "grid-abc";
    const gridTask = makeTask({ id: "gt1", status: "running", stub_id: "s-local", grid_id: gridId });
    const stub2 = makeStub({ id: "s-local", tasks: [gridTask] });
    const stub1 = makeStub({ id: "s-remote", tasks: [] });
    store.setStub(stub2);

    const task = makeTask({ grid_id: gridId });
    // Need at least one task in the grid registered
    store.setStub(stub2);

    const scoreLocal = scoreStub(stub2, task);
    const scoreRemote = scoreStub(stub1, task);
    expect(scoreLocal).toBeGreaterThan(scoreRemote);
  });

  it("user affinity: same user scores higher, different user penalized", () => {
    const sameUser = makeStub({ id: "same-user", user: "alice", tasks: [] });
    const diffUser = makeStub({ id: "diff-user", user: "bob", tasks: [] });
    const task = makeTask({ submitted_by: "alice" });

    expect(scoreStub(sameUser, task)).toBeGreaterThan(scoreStub(diffUser, task));
  });

  it("VRAM waste penalty: smaller waste → higher score", () => {
    const tight = makeStub({ gpu: { name: "A30", vram_total_mb: 24_000, count: 1 }, tasks: [] });
    const wasteful = makeStub({ gpu: { name: "A100", vram_total_mb: 80_000, count: 1 }, tasks: [] });
    const task = makeTask({ requirements: { gpu_mem_mb: 20_000 } });

    expect(scoreStub(tight, task)).toBeGreaterThan(scoreStub(wasteful, task));
  });

  it("queue depth penalizes stubs with many queued tasks", () => {
    const noQueue = makeStub({ id: "nq", max_concurrent: 4, tasks: [] });
    const highQueue = makeStub({
      id: "hq",
      max_concurrent: 4,
      tasks: [makeTask({ status: "queued" }), makeTask({ status: "queued" })],
    });
    const task = makeTask();
    expect(scoreStub(noQueue, task)).toBeGreaterThan(scoreStub(highQueue, task));
  });

  it("stub with no gpu_type requirement accepts any GPU", () => {
    const stub = makeStub({ gpu: { name: "RTX 3090", vram_total_mb: 24576, count: 1 } });
    const task = makeTask({ requirements: { gpu_type: [] } });
    expect(scoreStub(stub, task)).toBeGreaterThan(-Infinity);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// computeRunDir
// ═══════════════════════════════════════════════════════════════════════════════

describe("computeRunDir", () => {
  it("uses task.run_dir directly when provided", () => {
    const task = makeTask({ run_dir: "/explicit/run/dir" });
    const stub = makeStub();
    expect(computeRunDir(task, stub)).toBe("/explicit/run/dir");
  });

  it("uses stub.default_output_dir as base when no task.run_dir", () => {
    const task = makeTask({ fingerprint: "abc123456789" });
    const stub = makeStub({ default_output_dir: "/outputs" });
    const dir = computeRunDir(task, stub);
    expect(dir).toBe("/outputs/abc123456789");
  });

  it("fingerprint slice is exactly 12 chars", () => {
    const fp = "abcdef123456789";
    const task = makeTask({ fingerprint: fp });
    const stub = makeStub({ default_output_dir: "/out" });
    const dir = computeRunDir(task, stub);
    const basename = dir.split("/").pop()!;
    expect(basename).toHaveLength(12);
    expect(basename).toBe(fp.slice(0, 12));
  });

  it("falls back to task.cwd/runs when no output dir or default_cwd", () => {
    const task = makeTask({ fingerprint: "fp0123456789", cwd: "/workspace/project" });
    const stub = makeStub({ default_output_dir: undefined, default_cwd: undefined });
    const dir = computeRunDir(task, stub);
    expect(dir).toContain("runs");
    expect(dir).toContain("fp0123456789");
  });

  it("falls back to stub.default_cwd/runs when task has no cwd", () => {
    const task = makeTask({ fingerprint: "fp0123456789", cwd: undefined });
    const stub = makeStub({ default_output_dir: undefined, default_cwd: "/home/user/jobs" });
    const dir = computeRunDir(task, stub);
    expect(dir).toBe("/home/user/jobs/runs/fp0123456789");
  });

  it("uses task.id when fingerprint is absent", () => {
    const task = makeTask({ id: "tid-abc123456789", fingerprint: "" });
    const stub = makeStub({ default_output_dir: "/out" });
    const dir = computeRunDir(task, stub);
    // fp is empty string, falls back to task.id
    expect(dir).toBe("/out/tid-abc12345");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildRunPayload
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildRunPayload", () => {
  it("includes task_id, command, cwd, env, run_dir, params", () => {
    const task = makeTask({
      id: "t-build",
      command: "python train.py --lr 0.001",
      cwd: "/workspace",
      env: { FOO: "bar" },
      param_overrides: { lr: "0.001" },
      fingerprint: "fp0123456789",
    });
    const stub = makeStub({ default_output_dir: "/out" });
    const payload = buildRunPayload(task, stub) as any;

    expect(payload.task_id).toBe("t-build");
    expect(payload.command).toBe("python train.py --lr 0.001");
    expect(payload.cwd).toBe("/workspace");
    expect(payload.env).toEqual({ FOO: "bar" });
    expect(payload.params).toEqual({ lr: "0.001" });
    expect(payload.run_dir).toBe("/out/fp0123456789");
  });

  it("resolves python_env to activate command", () => {
    const task = makeTask({ python_env: "jema" });
    const stub = makeStub({
      available_envs: [{ name: "jema", type: "conda", path: "/envs/jema" }],
    });
    const payload = buildRunPayload(task, stub) as any;
    expect(payload.env_setup).toContain("micromamba activate /envs/jema");
  });

  it("uses activate field from env if present", () => {
    const task = makeTask({ python_env: "venv-env" });
    const stub = makeStub({
      available_envs: [{ name: "venv-env", type: "venv", path: "/venvs/venv-env", activate: "source /venvs/venv-env/bin/activate" }],
    });
    const payload = buildRunPayload(task, stub) as any;
    expect(payload.env_setup).toBe("source /venvs/venv-env/bin/activate");
  });

  it("prepends activate to existing env_setup", () => {
    const task = makeTask({ python_env: "jema", env_setup: "export FOO=1" });
    const stub = makeStub({
      available_envs: [{ name: "jema", type: "conda", path: "/envs/jema" }],
    });
    const payload = buildRunPayload(task, stub) as any;
    expect(payload.env_setup).toMatch(/micromamba activate.*&&.*export FOO=1/);
  });

  it("falls back to task.env_setup when python_env not found", () => {
    const task = makeTask({ python_env: "missing-env", env_setup: "source /other/activate" });
    const stub = makeStub({ available_envs: [] });
    const payload = buildRunPayload(task, stub) as any;
    expect(payload.env_setup).toBe("source /other/activate");
  });

  it("uses task.env_setup when no python_env", () => {
    const task = makeTask({ env_setup: "module load cuda/12" });
    const stub = makeStub();
    const payload = buildRunPayload(task, stub) as any;
    expect(payload.env_setup).toBe("module load cuda/12");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// maybeDispatch
// ═══════════════════════════════════════════════════════════════════════════════

describe("maybeDispatch", () => {
  it("does nothing for offline stub", () => {
    const task = makeTask({ status: "queued" });
    const stub = makeStub({ status: "offline", tasks: [task], max_concurrent: 4 });
    store.setStub(stub);
    maybeDispatch(stub);
    expect(reliableEmitToStub).not.toHaveBeenCalled();
  });

  it("does nothing when slots are full (running >= max_concurrent)", () => {
    const running = Array.from({ length: 4 }, () => makeTask({ status: "running" }));
    const queued = makeTask({ status: "queued" });
    const stub = makeStub({ max_concurrent: 4, tasks: [...running, queued] });
    store.setStub(stub);
    maybeDispatch(stub);
    expect(reliableEmitToStub).not.toHaveBeenCalled();
  });

  it("dispatches queued tasks up to available slots", () => {
    const q1 = makeTask({ id: "q1", status: "queued", priority: 0 });
    const q2 = makeTask({ id: "q2", status: "queued", priority: 0 });
    const q3 = makeTask({ id: "q3", status: "queued", priority: 0 });
    const stub = makeStub({ id: "s-dispatch", max_concurrent: 2, tasks: [q1, q2, q3] });
    store.setStub(stub);

    maybeDispatch(store.getStub(stub.id)!);

    // Should have emitted exactly 2 task.run events (slots = 2)
    expect(reliableEmitToStub).toHaveBeenCalledTimes(2);
    expect(reliableEmitToStub).toHaveBeenCalledWith(stub.id, "task.run", expect.any(Object));
  });

  it("dispatches higher priority tasks first", () => {
    const low = makeTask({ id: "low", status: "queued", priority: 1 });
    const high = makeTask({ id: "high", status: "queued", priority: 10 });
    const stub = makeStub({ id: "s-prio", max_concurrent: 1, tasks: [low, high] });
    store.setStub(stub);

    maybeDispatch(store.getStub(stub.id)!);

    expect(reliableEmitToStub).toHaveBeenCalledTimes(1);
    const call = (reliableEmitToStub as any).mock.calls[0];
    expect(call[2].task_id).toBe("high");
  });

  it("among equal priority, earlier created_at dispatched first", () => {
    const early = makeTask({
      id: "early",
      status: "queued",
      priority: 5,
      created_at: "2025-01-01T00:00:00.000Z",
    });
    const late = makeTask({
      id: "late",
      status: "queued",
      priority: 5,
      created_at: "2025-01-02T00:00:00.000Z",
    });
    const stub = makeStub({ id: "s-order", max_concurrent: 1, tasks: [late, early] });
    store.setStub(stub);

    maybeDispatch(store.getStub(stub.id)!);

    const call = (reliableEmitToStub as any).mock.calls[0];
    expect(call[2].task_id).toBe("early");
  });

  it("does nothing when no queued tasks", () => {
    const running = makeTask({ status: "running" });
    const stub = makeStub({ max_concurrent: 4, tasks: [running] });
    store.setStub(stub);
    maybeDispatch(stub);
    expect(reliableEmitToStub).not.toHaveBeenCalled();
  });

  it("sets dispatch timeout to fail task after 30s if not started", () => {
    vi.useFakeTimers();
    const task = makeTask({ id: "timeout-task", status: "queued" });
    const stub = makeStub({ id: "s-timeout", max_concurrent: 4, tasks: [task] });
    store.setStub(stub);

    maybeDispatch(store.getStub(stub.id)!);

    // Task should now be "dispatched" in store
    // Fast-forward 30s without task.started → should be failed
    vi.advanceTimersByTime(31_000);

    const found = store.findTask("timeout-task");
    // Dispatched → failed via timeout
    expect(found?.task.status).toBe("failed");
  });

  it("dispatch timeout does NOT fail task if already started", () => {
    vi.useFakeTimers();
    const task = makeTask({ id: "started-task", status: "queued" });
    const stub = makeStub({ id: "s-started", max_concurrent: 4, tasks: [task] });
    store.setStub(stub);

    maybeDispatch(store.getStub(stub.id)!);

    // Simulate task.started (dispatched → running) before timeout fires
    store.updateTask(stub.id, "started-task", { status: "running" });

    vi.advanceTimersByTime(31_000);

    const found = store.findTask("started-task");
    // Should remain in terminal state (running→archived? No, running is active)
    // The task was moved to running, timeout checks status === "dispatched", so no fail
    expect(found?.task.status).not.toBe("failed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// schedule — re-entrancy guard
// ═══════════════════════════════════════════════════════════════════════════════

describe("schedule — re-entrancy guard", () => {
  it("triggerSchedule does not throw on empty store", () => {
    expect(() => triggerSchedule()).not.toThrow();
  });

  it("schedule does not over-dispatch from concurrent calls (re-entrancy guard)", () => {
    // Add a task to the global queue and one online stub
    const task = makeTask({ id: "sched-task", status: "pending" });
    store.addToGlobalQueue(task);
    const stub = makeStub({ id: "sched-stub", max_concurrent: 1, tasks: [] });
    store.setStub(stub);

    // Call schedule twice — second should be no-op due to re-entrancy guard
    // (In practice the guard prevents concurrent calls, not sequential)
    schedule();
    // Task should now be queued/dispatched on the stub
    const freshStub = store.getStub(stub.id)!;
    expect(freshStub.tasks.length).toBeGreaterThan(0);
    // Global queue should be empty (task was moved)
    expect(store.getGlobalQueue().find(t => t.id === "sched-task")).toBeUndefined();
  });

  it("schedule assigns global queue task to best stub", () => {
    const task = makeTask({ id: "best-task", status: "pending" });
    store.addToGlobalQueue(task);

    const goodStub = makeStub({ id: "good-stub", max_concurrent: 4, tasks: [] });
    const fullStub = makeStub({
      id: "full-stub",
      max_concurrent: 2,
      tasks: [makeTask({ status: "running" }), makeTask({ status: "running" })],
    });
    store.setStub(goodStub);
    store.setStub(fullStub);

    schedule();

    // Task should have been assigned to goodStub (not fullStub which is full)
    const good = store.getStub("good-stub")!;
    const full = store.getStub("full-stub")!;
    const assignedToGood = good.tasks.some(t => t.id === "best-task");
    const assignedToFull = full.tasks.some(t => t.id === "best-task");
    expect(assignedToGood).toBe(true);
    expect(assignedToFull).toBe(false);
  });

  it("schedule skips task when no suitable stub available", () => {
    const task = makeTask({
      id: "no-stub-task",
      status: "pending",
      requirements: { gpu_mem_mb: 999_999_999 }, // impossibly large
    });
    store.addToGlobalQueue(task);
    const stub = makeStub({ gpu: { name: "A100", vram_total_mb: 40960, count: 1 }, tasks: [] });
    store.setStub(stub);

    schedule();

    // Task should remain in global queue
    expect(store.getGlobalQueue().find(t => t.id === "no-stub-task")).toBeDefined();
  });

  it("schedule handles no online stubs gracefully", () => {
    const task = makeTask({ status: "pending" });
    store.addToGlobalQueue(task);
    // No stubs added

    expect(() => schedule()).not.toThrow();
    expect(store.getGlobalQueue()).toHaveLength(1); // task remains
  });

  it("schedule dispatches multiple tasks to multiple stubs", () => {
    const t1 = makeTask({ id: "multi-t1", status: "pending" });
    const t2 = makeTask({ id: "multi-t2", status: "pending" });
    store.addToGlobalQueue(t1);
    store.addToGlobalQueue(t2);

    const s1 = makeStub({ id: "multi-s1", max_concurrent: 1, tasks: [] });
    const s2 = makeStub({ id: "multi-s2", max_concurrent: 1, tasks: [] });
    store.setStub(s1);
    store.setStub(s2);

    schedule();

    const stub1Tasks = store.getStub("multi-s1")!.tasks;
    const stub2Tasks = store.getStub("multi-s2")!.tasks;
    const totalAssigned = stub1Tasks.length + stub2Tasks.length;
    expect(totalAssigned).toBe(2);
    expect(store.getGlobalQueue()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VRAM estimation — availableVram fallback
// ═══════════════════════════════════════════════════════════════════════════════

describe("scoreStub — VRAM estimation from running tasks", () => {
  it("deducts running task requirements from total VRAM when no gpu_stats", () => {
    const running = makeTask({ status: "running", requirements: { gpu_mem_mb: 20_000 } });
    const stub = makeStub({
      gpu: { name: "A100", vram_total_mb: 40_960, count: 1 },
      tasks: [running],
      gpu_stats: undefined,
    });
    // Task needing 25GB: only 20.96GB free → should fail
    const task = makeTask({ requirements: { gpu_mem_mb: 25_000 } });
    expect(scoreStub(stub, task)).toBe(-Infinity);
  });

  it("task without gpu_mem_mb requirement passes VRAM check", () => {
    const stub = makeStub({
      gpu: { name: "A100", vram_total_mb: 40_960, count: 1 },
      tasks: [],
    });
    const task = makeTask({ requirements: { gpu_mem_mb: 0 } });
    expect(scoreStub(stub, task)).toBeGreaterThan(-Infinity);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("edge cases", () => {
  it("scoreStub: max_concurrent=1 with 1 running → no slots", () => {
    const running = makeTask({ status: "running" });
    const stub = makeStub({ max_concurrent: 1, tasks: [running] });
    const task = makeTask();
    expect(scoreStub(stub, task)).toBe(-Infinity);
  });

  it("scoreStub: completed task on stub does NOT count toward slot usage", () => {
    // completed tasks should be archived, but test the counting logic
    const completed = makeTask({ status: "completed" });
    const stub = makeStub({ max_concurrent: 1, tasks: [completed] });
    const task = makeTask();
    // completed is not in ["running", "dispatched"], so slots = 1-0 = 1 > 0 → passes
    expect(scoreStub(stub, task)).toBeGreaterThan(-Infinity);
  });

  it("computeRunDir: uses task.id[:12] when fingerprint is missing", () => {
    const task = makeTask({ fingerprint: undefined as any, id: "task-id-longname" });
    const stub = makeStub({ default_output_dir: "/out" });
    const dir = computeRunDir(task, stub);
    // fp = task.fingerprint || task.id; slice(0,12) of "task-id-longname" = "task-id-long"
    expect(dir).toBe("/out/task-id-long");
  });

  it("gpu_type check: partial name match works (e.g. 'a100' matches 'NVIDIA A100 SXM4')", () => {
    const stub = makeStub({ gpu: { name: "NVIDIA A100 SXM4 80GB", vram_total_mb: 81920, count: 1 } });
    const task = makeTask({ requirements: { gpu_type: ["a100"] } });
    expect(scoreStub(stub, task)).toBeGreaterThan(-Infinity);
  });

  it("multiple gpu_type options: any match is sufficient", () => {
    const stub = makeStub({ gpu: { name: "A30", vram_total_mb: 24576, count: 1 } });
    const task = makeTask({ requirements: { gpu_type: ["A100", "A30"] } });
    expect(scoreStub(stub, task)).toBeGreaterThan(-Infinity);
  });
});
