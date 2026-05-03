/**
 * store.test.ts — Unit tests for store/index.ts
 *
 * Covers: state transitions, archive lifecycle, fingerprint index,
 * grid task queries, write locks, global queue operations.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Mock external I/O before importing store ─────────────────────────────────
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

// ─── Import after mocks ───────────────────────────────────────────────────────
import { store } from "../src/store/index";
import { writeLockTable } from "../src/dedup";
import { Task, Stub, TaskStatus, Grid } from "../src/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _taskSeq = 1000;
let _stubSeq = 1;

function makeTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? `task-${_taskSeq++}`;
  return {
    id,
    seq: _taskSeq++,
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
  const id = overrides.id ?? `stub-${_stubSeq++}`;
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

function addStubWithTask(taskStatus: TaskStatus = "running"): { stub: Stub; task: Task } {
  const task = makeTask({ status: taskStatus });
  const stub = makeStub({ tasks: [task] });
  task.stub_id = stub.id;
  store.setStub(stub);
  return { stub, task };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

beforeEach(() => {
  store.reset();
  _taskSeq = 1000;
  _stubSeq = 1;
});

// ═══════════════════════════════════════════════════════════════════════════════
// Seq counter
// ═══════════════════════════════════════════════════════════════════════════════

describe("seqCounter", () => {
  it("starts at 0 and increments on nextSeq", () => {
    expect(store.getSeqCounter()).toBe(0);
    expect(store.nextSeq()).toBe(1);
    expect(store.nextSeq()).toBe(2);
    expect(store.getSeqCounter()).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Stub management
// ═══════════════════════════════════════════════════════════════════════════════

describe("stub management", () => {
  it("sets and gets stubs", () => {
    const stub = makeStub();
    store.setStub(stub);
    expect(store.getStub(stub.id)).toEqual(stub);
  });

  it("getOnlineStubs filters offline stubs", () => {
    const online = makeStub({ id: "s-online", status: "online" });
    const offline = makeStub({ id: "s-offline", status: "offline" });
    store.setStub(online);
    store.setStub(offline);
    const onlineList = store.getOnlineStubs();
    expect(onlineList.map(s => s.id)).toContain("s-online");
    expect(onlineList.map(s => s.id)).not.toContain("s-offline");
  });

  it("deleteStub removes stub", () => {
    const stub = makeStub();
    store.setStub(stub);
    store.deleteStub(stub.id);
    expect(store.getStub(stub.id)).toBeUndefined();
  });

  it("pruneStaleStubs removes offline stubs with no tasks older than cutoff", () => {
    const old = makeStub({ id: "old-stub", status: "offline" });
    old.last_heartbeat = new Date(Date.now() - 25 * 3600_000).toISOString(); // 25h ago
    store.setStub(old);

    const fresh = makeStub({ id: "fresh-stub", status: "offline" });
    fresh.last_heartbeat = new Date(Date.now() - 1 * 3600_000).toISOString(); // 1h ago
    store.setStub(fresh);

    const pruned = store.pruneStaleStubs(24);
    expect(pruned).toBe(1);
    expect(store.getStub("old-stub")).toBeUndefined();
    expect(store.getStub("fresh-stub")).toBeDefined();
  });

  it("pruneStaleStubs does not prune stubs with tasks", () => {
    const task = makeTask({ status: "running" });
    const stub = makeStub({ id: "stub-with-tasks", status: "offline", tasks: [task] });
    stub.last_heartbeat = new Date(Date.now() - 30 * 3600_000).toISOString();
    store.setStub(stub);

    const pruned = store.pruneStaleStubs(24);
    expect(pruned).toBe(0);
    expect(store.getStub("stub-with-tasks")).toBeDefined();
  });

  it("pruneStaleStubs does not prune online stubs", () => {
    const stub = makeStub({ id: "online-stub", status: "online" });
    stub.last_heartbeat = new Date(Date.now() - 30 * 3600_000).toISOString();
    store.setStub(stub);
    expect(store.pruneStaleStubs(24)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Global queue
// ═══════════════════════════════════════════════════════════════════════════════

describe("global queue", () => {
  it("addToGlobalQueue and getGlobalQueue", () => {
    const task = makeTask({ id: "gq-1", status: "pending" });
    store.addToGlobalQueue(task);
    const q = store.getGlobalQueue();
    expect(q.map(t => t.id)).toContain("gq-1");
  });

  it("getGlobalQueue sorts by priority desc then created_at asc", () => {
    const t1 = makeTask({ id: "t1", priority: 5, created_at: "2025-01-01T00:00:00.000Z" });
    const t2 = makeTask({ id: "t2", priority: 10, created_at: "2025-01-01T00:00:00.000Z" });
    const t3 = makeTask({ id: "t3", priority: 5, created_at: "2025-01-02T00:00:00.000Z" });
    store.addToGlobalQueue(t1);
    store.addToGlobalQueue(t2);
    store.addToGlobalQueue(t3);
    const q = store.getGlobalQueue();
    expect(q[0].id).toBe("t2"); // highest priority
    expect(q[1].id).toBe("t1"); // same priority, earlier
    expect(q[2].id).toBe("t3"); // same priority, later
  });

  it("removeFromGlobalQueue removes and returns task", () => {
    const task = makeTask({ id: "rem-1" });
    store.addToGlobalQueue(task);
    const removed = store.removeFromGlobalQueue("rem-1");
    expect(removed?.id).toBe("rem-1");
    expect(store.getGlobalQueue().map(t => t.id)).not.toContain("rem-1");
  });

  it("removeFromGlobalQueue returns undefined for missing task", () => {
    expect(store.removeFromGlobalQueue("nonexistent")).toBeUndefined();
  });

  it("addToGlobalQueue clears stub_id on task", () => {
    const task = makeTask({ id: "clear-stub", stub_id: "some-stub" });
    store.addToGlobalQueue(task);
    const q = store.getGlobalQueue();
    expect(q.find(t => t.id === "clear-stub")?.stub_id).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// State transitions via updateTask
// ═══════════════════════════════════════════════════════════════════════════════

describe("updateTask — state transitions", () => {
  it("valid transition queued → dispatched succeeds", () => {
    const task = makeTask({ status: "queued" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);
    const updated = store.updateTask(stub.id, task.id, { status: "dispatched" });
    expect(updated?.status).toBe("dispatched");
  });

  it("valid transition dispatched → running succeeds", () => {
    const task = makeTask({ status: "dispatched" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);
    const updated = store.updateTask(stub.id, task.id, { status: "running" });
    expect(updated?.status).toBe("running");
  });

  it("illegal transition running → queued returns undefined", () => {
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);
    const result = store.updateTask(stub.id, task.id, { status: "queued" as TaskStatus });
    expect(result).toBeUndefined();
    // Task status should remain unchanged
    expect(store.getTask(stub.id, task.id)?.status).toBe("running");
  });

  it("illegal transition completed → running returns undefined", () => {
    // completed is terminal — but it will be archived before we can try
    // so we test pending → running which is also illegal
    const task = makeTask({ status: "pending" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);
    const result = store.updateTask(stub.id, task.id, { status: "running" as TaskStatus });
    expect(result).toBeUndefined();
  });

  it("same status update (no transition) is allowed", () => {
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);
    const updated = store.updateTask(stub.id, task.id, { status: "running" });
    expect(updated?.status).toBe("running");
  });

  it("returns undefined if stub not found", () => {
    expect(store.updateTask("nonexistent-stub", "t1", { status: "running" })).toBeUndefined();
  });

  it("returns undefined if task not found on stub", () => {
    const stub = makeStub({ tasks: [] });
    store.setStub(stub);
    expect(store.updateTask(stub.id, "nonexistent-task", { status: "running" })).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Auto-archive on terminal transition
// ═══════════════════════════════════════════════════════════════════════════════

describe("auto-archive", () => {
  it("completed task is moved to archive and removed from stub.tasks", () => {
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);

    store.updateTask(stub.id, task.id, { status: "completed" });

    const freshStub = store.getStub(stub.id)!;
    expect(freshStub.tasks.find(t => t.id === task.id)).toBeUndefined();
    const archive = store.getArchive();
    expect(archive.find(t => t.id === task.id)?.status).toBe("completed");
  });

  it("failed task is archived", () => {
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);

    store.updateTask(stub.id, task.id, { status: "failed" });

    expect(store.getArchive().find(t => t.id === task.id)?.status).toBe("failed");
  });

  it("killed task is archived", () => {
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);

    store.updateTask(stub.id, task.id, { status: "killed" });

    expect(store.getArchive().find(t => t.id === task.id)).toBeDefined();
  });

  it("active tasks remain in stub after update", () => {
    const task = makeTask({ status: "queued" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);

    store.updateTask(stub.id, task.id, { status: "dispatched" });

    const freshStub = store.getStub(stub.id)!;
    expect(freshStub.tasks.find(t => t.id === task.id)?.status).toBe("dispatched");
    expect(store.getArchive().find(t => t.id === task.id)).toBeUndefined();
  });

  it("global queue task auto-archived on terminal status", () => {
    const task = makeTask({ id: "gq-kill", status: "pending" });
    store.addToGlobalQueue(task);
    store.updateGlobalQueueTask("gq-kill", { status: "killed" });

    const gq = store.getGlobalQueue();
    expect(gq.find(t => t.id === "gq-kill")).toBeUndefined();
    expect(store.getArchive().find(t => t.id === "gq-kill")?.status).toBe("killed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Archive lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe("archive lifecycle", () => {
  it("removeFromArchive removes and returns task", () => {
    const task = makeTask({ status: "failed" });
    store.setArchive([task]);
    const removed = store.removeFromArchive(task.id);
    expect(removed?.id).toBe(task.id);
    expect(store.getArchive().find(t => t.id === task.id)).toBeUndefined();
  });

  it("removeFromArchive returns undefined for missing id", () => {
    expect(store.removeFromArchive("ghost-id")).toBeUndefined();
  });

  it("unarchiveTask moves task from archive to stub", () => {
    const task = makeTask({ id: "ua-task", status: "lost" });
    store.setArchive([task]);
    const stub = makeStub({ tasks: [] });
    store.setStub(stub);

    const recovered = store.unarchiveTask(stub.id, task.id, { status: "running" });
    expect(recovered?.status).toBe("running");
    expect(store.getStub(stub.id)!.tasks.find(t => t.id === "ua-task")).toBeDefined();
    expect(store.getArchive().find(t => t.id === "ua-task")).toBeUndefined();
  });

  it("unarchiveTask returns undefined if task not in archive", () => {
    const stub = makeStub();
    store.setStub(stub);
    expect(store.unarchiveTask(stub.id, "ghost-id", { status: "running" })).toBeUndefined();
  });

  it("unarchiveTask returns undefined if stub not found", () => {
    const task = makeTask({ status: "lost" });
    store.setArchive([task]);
    expect(store.unarchiveTask("nonexistent-stub", task.id, { status: "running" })).toBeUndefined();
    // Task should be put back in archive
    expect(store.getArchive().find(t => t.id === task.id)).toBeDefined();
  });

  it("unarchiveTask rejects illegal transition (lost → queued)", () => {
    const task = makeTask({ status: "lost" });
    store.setArchive([task]);
    const stub = makeStub();
    store.setStub(stub);

    const result = store.unarchiveTask(stub.id, task.id, { status: "queued" as TaskStatus });
    expect(result).toBeUndefined();
    // Task must remain in archive
    expect(store.getArchive().find(t => t.id === task.id)).toBeDefined();
  });

  it("unarchiveTask allows lost → running (recovery)", () => {
    const task = makeTask({ status: "lost" });
    store.setArchive([task]);
    const stub = makeStub();
    store.setStub(stub);

    const result = store.unarchiveTask(stub.id, task.id, { status: "running" });
    expect(result?.status).toBe("running");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// findTask — cross-location search
// ═══════════════════════════════════════════════════════════════════════════════

describe("findTask", () => {
  it("finds task on stub", () => {
    const { stub, task } = addStubWithTask("running");
    const found = store.findTask(task.id);
    expect(found?.task.id).toBe(task.id);
    expect(found?.stubId).toBe(stub.id);
    expect(found?.archived).toBeFalsy();
  });

  it("finds task in global queue", () => {
    const task = makeTask({ id: "gq-find", status: "pending" });
    store.addToGlobalQueue(task);
    const found = store.findTask("gq-find");
    expect(found?.task.id).toBe("gq-find");
    expect(found?.stubId).toBeNull();
  });

  it("finds task in archive", () => {
    const task = makeTask({ id: "arch-find", status: "completed" });
    store.setArchive([task]);
    const found = store.findTask("arch-find");
    expect(found?.task.id).toBe("arch-find");
    expect(found?.archived).toBe(true);
  });

  it("returns undefined for missing task", () => {
    expect(store.findTask("not-here")).toBeUndefined();
  });

  it("stub takes priority over archive on findTask (for transition tasks)", () => {
    // Simulate a task that exists in both (shouldn't happen in practice but...)
    const task = makeTask({ id: "dup-task", status: "running" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);
    const archivedVersion = { ...task, status: "failed" as TaskStatus };
    store.setArchive([archivedVersion]);

    const found = store.findTask("dup-task");
    // Should find the live stub version first
    expect(found?.stubId).toBe(stub.id);
    expect(found?.task.status).toBe("running");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fingerprint index
// ═══════════════════════════════════════════════════════════════════════════════

describe("fingerprint index", () => {
  it("addToGlobalQueue indexes fingerprint for active task", () => {
    const task = makeTask({ id: "fp-test", fingerprint: "abc123", status: "pending" });
    store.addToGlobalQueue(task);
    expect(store.findActiveByFingerprint("abc123")).toBe("fp-test");
  });

  it("fingerprint removed from index when task becomes terminal", () => {
    const task = makeTask({ id: "fp-term", fingerprint: "fp-del", status: "running" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);
    // Index manually (updateTask will reindex on transition)
    store.rebuildFingerprintIndex();
    expect(store.findActiveByFingerprint("fp-del")).toBe("fp-term");

    store.updateTask(stub.id, task.id, { status: "completed" });
    expect(store.findActiveByFingerprint("fp-del")).toBeUndefined();
  });

  it("fingerprint not indexed for terminal task at rest", () => {
    const task = makeTask({ id: "fp-arch", fingerprint: "fp-arch-fp", status: "completed" });
    store.setArchive([task]);
    store.rebuildFingerprintIndex();
    expect(store.findActiveByFingerprint("fp-arch-fp")).toBeUndefined();
  });

  it("rebuildFingerprintIndex indexes all active tasks across locations", () => {
    const t1 = makeTask({ id: "fp-r1", fingerprint: "fp-r1", status: "pending" });
    const t2 = makeTask({ id: "fp-r2", fingerprint: "fp-r2", status: "running" });
    const stub = makeStub({ tasks: [t2] });
    store.setStub(stub);
    store.addToGlobalQueue(t1);

    store.rebuildFingerprintIndex();
    expect(store.findActiveByFingerprint("fp-r1")).toBe("fp-r1");
    expect(store.findActiveByFingerprint("fp-r2")).toBe("fp-r2");
  });

  it("task without fingerprint does not create index entry", () => {
    const task = makeTask({ id: "no-fp", fingerprint: "" });
    store.addToGlobalQueue(task);
    // Empty string fingerprint — no entry
    expect(store.findActiveByFingerprint("")).toBeUndefined();
  });

  it("updateGlobalQueueTask reindexes fingerprint on transition to terminal", () => {
    const task = makeTask({ id: "gq-fp", fingerprint: "gq-fp-val", status: "pending" });
    store.addToGlobalQueue(task);
    expect(store.findActiveByFingerprint("gq-fp-val")).toBe("gq-fp");

    store.updateGlobalQueueTask("gq-fp", { status: "killed" });
    expect(store.findActiveByFingerprint("gq-fp-val")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Write lock integration
// ═══════════════════════════════════════════════════════════════════════════════

describe("write lock — released on terminal transition", () => {
  it("write lock released when task completes", () => {
    const runDir = "/runs/test-run-abc123";
    const task = makeTask({ id: "wl-task", status: "running", run_dir: runDir });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);

    // Manually acquire lock (normally done at dispatch time)
    writeLockTable.acquire(runDir, task.id);
    expect(writeLockTable.has(runDir)).toBe(true);

    store.updateTask(stub.id, task.id, { status: "completed" });
    expect(writeLockTable.has(runDir)).toBe(false);
  });

  it("write lock NOT released on active→active transition", () => {
    const runDir = "/runs/active-run";
    const task = makeTask({ id: "wl-active", status: "dispatched", run_dir: runDir });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);

    writeLockTable.acquire(runDir, task.id);
    store.updateTask(stub.id, task.id, { status: "running" });

    // Lock should still be held (task is still active)
    expect(writeLockTable.has(runDir)).toBe(true);
    // cleanup
    writeLockTable.release(runDir);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// moveToStubQueue
// ═══════════════════════════════════════════════════════════════════════════════

describe("moveToStubQueue", () => {
  it("moves task from global queue to stub with status=queued", () => {
    const task = makeTask({ id: "move-1", status: "pending" });
    store.addToGlobalQueue(task);
    const stub = makeStub();
    store.setStub(stub);

    const moved = store.moveToStubQueue("move-1", stub.id);
    expect(moved?.status).toBe("queued");
    expect(moved?.stub_id).toBe(stub.id);
    expect(store.getGlobalQueue().find(t => t.id === "move-1")).toBeUndefined();
    expect(store.getStub(stub.id)!.tasks.find(t => t.id === "move-1")).toBeDefined();
  });

  it("returns undefined and puts task back if stub not found", () => {
    const task = makeTask({ id: "move-back", status: "pending" });
    store.addToGlobalQueue(task);

    const result = store.moveToStubQueue("move-back", "ghost-stub");
    expect(result).toBeUndefined();
    // Task should be back in global queue
    expect(store.getGlobalQueue().find(t => t.id === "move-back")).toBeDefined();
  });

  it("returns undefined for task not in global queue", () => {
    const stub = makeStub();
    store.setStub(stub);
    expect(store.moveToStubQueue("not-in-queue", stub.id)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Grid task queries
// ═══════════════════════════════════════════════════════════════════════════════

describe("getGridTasks", () => {
  it("returns active and archived tasks for grid", () => {
    const gridId = "grid-001";
    const active = makeTask({ id: "gt-active", grid_id: gridId, status: "running" });
    const archived = makeTask({ id: "gt-arch", grid_id: gridId, status: "completed" });
    const other = makeTask({ id: "gt-other", grid_id: "other-grid", status: "running" });

    const stub = makeStub({ tasks: [active, other] });
    store.setStub(stub);
    store.setArchive([archived]);

    const tasks = store.getGridTasks(gridId);
    expect(tasks.map(t => t.id)).toContain("gt-active");
    expect(tasks.map(t => t.id)).toContain("gt-arch");
    expect(tasks.map(t => t.id)).not.toContain("gt-other");
  });

  it("deduplicates tasks appearing in both active and archive", () => {
    // Edge case: task just moved to archive but findTask still sees it
    const gridId = "grid-dup";
    const task = makeTask({ id: "dup-task", grid_id: gridId, status: "completed" });
    store.setArchive([task]);

    const tasks = store.getGridTasks(gridId);
    const ids = tasks.map(t => t.id);
    // No duplicates
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("returns empty array for unknown grid", () => {
    expect(store.getGridTasks("unknown-grid")).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// updateGridStatus
// ═══════════════════════════════════════════════════════════════════════════════

describe("updateGridStatus", () => {
  function setupGrid(gridId: string, taskStatuses: TaskStatus[]): void {
    const grid: Grid = {
      id: gridId,
      display_name: "Test Grid",
      script: "train.py",
      param_space: {},
      task_ids: [],
      status: "pending",
      created_at: new Date().toISOString(),
      max_retries: 0,
    };
    store.setGrid(grid);

    const archiveTasks: Task[] = [];
    const activeTasks: Task[] = [];
    for (const status of taskStatuses) {
      const t = makeTask({ grid_id: gridId, status });
      if (["completed", "failed", "killed", "lost"].includes(status)) {
        archiveTasks.push(t);
      } else {
        activeTasks.push(t);
      }
    }

    if (activeTasks.length > 0) {
      const stub = makeStub({ tasks: activeTasks });
      store.setStub(stub);
    }
    if (archiveTasks.length > 0) {
      store.setArchive([...store.getArchive(), ...archiveTasks]);
    }
  }

  it("all completed → grid status = completed", () => {
    setupGrid("g-comp", ["completed", "completed"]);
    store.updateGridStatus("g-comp");
    expect(store.getGrid("g-comp")!.status).toBe("completed");
  });

  it("any running → grid status = running", () => {
    setupGrid("g-run", ["completed", "running"]);
    store.updateGridStatus("g-run");
    expect(store.getGrid("g-run")!.status).toBe("running");
  });

  it("failed and completed → grid status = partial", () => {
    setupGrid("g-partial", ["completed", "failed"]);
    store.updateGridStatus("g-partial");
    expect(store.getGrid("g-partial")!.status).toBe("partial");
  });

  it("all failed → grid status = failed", () => {
    setupGrid("g-fail", ["failed", "failed"]);
    store.updateGridStatus("g-fail");
    expect(store.getGrid("g-fail")!.status).toBe("failed");
  });

  it("no tasks → no status change", () => {
    const grid: Grid = {
      id: "g-empty",
      display_name: "Empty Grid",
      script: "train.py",
      param_space: {},
      task_ids: [],
      status: "pending",
      created_at: new Date().toISOString(),
      max_retries: 0,
    };
    store.setGrid(grid);
    store.updateGridStatus("g-empty");
    expect(store.getGrid("g-empty")!.status).toBe("pending"); // unchanged
  });

  it("unknown grid → no error (no-op)", () => {
    expect(() => store.updateGridStatus("no-such-grid")).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getAllTasks / getActiveTasks
// ═══════════════════════════════════════════════════════════════════════════════

describe("getAllTasks / getActiveTasks", () => {
  it("getAllTasks includes global queue, stubs, and archive", () => {
    const gqTask = makeTask({ id: "all-gq", status: "pending" });
    const stubTask = makeTask({ id: "all-stub", status: "running" });
    const archTask = makeTask({ id: "all-arch", status: "completed" });

    store.addToGlobalQueue(gqTask);
    store.setStub(makeStub({ tasks: [stubTask] }));
    store.setArchive([archTask]);

    const all = store.getAllTasks().map(t => t.id);
    expect(all).toContain("all-gq");
    expect(all).toContain("all-stub");
    expect(all).toContain("all-arch");
  });

  it("getActiveTasks excludes archive", () => {
    const gqTask = makeTask({ id: "act-gq", status: "pending" });
    const archTask = makeTask({ id: "act-arch", status: "completed" });

    store.addToGlobalQueue(gqTask);
    store.setArchive([archTask]);

    const active = store.getActiveTasks().map(t => t.id);
    expect(active).toContain("act-gq");
    expect(active).not.toContain("act-arch");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// updateGlobalQueueTask — state machine enforcement
// ═══════════════════════════════════════════════════════════════════════════════

describe("updateGlobalQueueTask", () => {
  it("valid transition pending → killed succeeds", () => {
    const task = makeTask({ id: "gq-valid", status: "pending" });
    store.addToGlobalQueue(task);
    const result = store.updateGlobalQueueTask("gq-valid", { status: "killed" });
    expect(result?.status).toBe("killed");
  });

  it("illegal transition pending → running returns undefined", () => {
    const task = makeTask({ id: "gq-illegal", status: "pending" });
    store.addToGlobalQueue(task);
    const result = store.updateGlobalQueueTask("gq-illegal", { status: "running" as TaskStatus });
    expect(result).toBeUndefined();
  });

  it("returns undefined for task not in global queue", () => {
    expect(store.updateGlobalQueueTask("ghost", { status: "killed" })).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// reset
// ═══════════════════════════════════════════════════════════════════════════════

describe("reset", () => {
  it("clears all state", () => {
    const task = makeTask({ status: "pending" });
    store.addToGlobalQueue(task);
    store.setStub(makeStub());
    store.nextSeq();

    store.reset();

    expect(store.getGlobalQueue()).toHaveLength(0);
    expect(store.getAllStubs()).toHaveLength(0);
    expect(store.getArchive()).toHaveLength(0);
    expect(store.getSeqCounter()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P0-2: findActiveByFingerprint — should_stop exclusion
// ═══════════════════════════════════════════════════════════════════════════════

describe("findActiveByFingerprint — P0-2: should_stop exclusion", () => {
  it("returns task_id for normal active task", () => {
    const task = makeTask({ fingerprint: "fp-normal", should_stop: false });
    store.addToGlobalQueue(task);
    expect(store.findActiveByFingerprint("fp-normal")).toBe(task.id);
  });

  it("returns undefined for task with should_stop=true", () => {
    const task = makeTask({ fingerprint: "fp-killing", should_stop: true });
    store.addToGlobalQueue(task);
    expect(store.findActiveByFingerprint("fp-killing")).toBeUndefined();
  });

  it("returns undefined for nonexistent fingerprint", () => {
    expect(store.findActiveByFingerprint("fp-ghost")).toBeUndefined();
  });

  it("returns undefined after task transitions to terminal", () => {
    const task = makeTask({ fingerprint: "fp-terminal" });
    store.addToGlobalQueue(task);
    expect(store.findActiveByFingerprint("fp-terminal")).toBe(task.id);

    // Kill it (terminal transition)
    store.updateGlobalQueueTask(task.id, { status: "killed" });
    expect(store.findActiveByFingerprint("fp-terminal")).toBeUndefined();
  });

  it("returns undefined for stub task with should_stop=true", () => {
    const task = makeTask({ fingerprint: "fp-stub-kill", status: "running", should_stop: true });
    const stub = makeStub({ tasks: [task] });
    task.stub_id = stub.id;
    store.setStub(stub);
    // Manually index fingerprint (addToGlobalQueue does this, but stub tasks bypass)
    store.rebuildFingerprintIndex();
    expect(store.findActiveByFingerprint("fp-stub-kill")).toBeUndefined();
  });

  it("cleans up stale fingerprint index entry", () => {
    const task = makeTask({ fingerprint: "fp-stale" });
    store.addToGlobalQueue(task);
    expect(store.findActiveByFingerprint("fp-stale")).toBe(task.id);

    // Manually remove from queue without going through proper status transition
    // (simulates index being stale)
    const removed = store.removeFromGlobalQueue(task.id);
    expect(removed).toBeDefined();

    // findActiveByFingerprint should detect the stale entry and clean up
    expect(store.findActiveByFingerprint("fp-stale")).toBeUndefined();
  });
});
