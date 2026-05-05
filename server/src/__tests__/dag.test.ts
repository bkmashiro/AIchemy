/**
 * dag.test.ts — Unit tests for DAG resolution engine.
 *
 * Tests: validateDag (cycle detection, ref validation), template resolution,
 * dependency checks, promotion, and cascading cancellation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("../log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Shared state for mock store
const _globalQueue: any[] = [];
const _experiments = new Map<string, any>();

vi.mock("../store", () => ({
  store: {
    findTask: (taskId: string) => {
      const task = _globalQueue.find((t) => t.id === taskId);
      return task ? { task, archived: false } : undefined;
    },
    getBlockedTasksDependingOn: (taskId: string) => {
      return _globalQueue.filter(
        (t) => t.status === "blocked" && t.depends_on?.includes(taskId)
      );
    },
    updateGlobalQueueTask: (taskId: string, update: any) => {
      const idx = _globalQueue.findIndex((t) => t.id === taskId);
      if (idx === -1) return undefined;
      Object.assign(_globalQueue[idx], update);
      return _globalQueue[idx];
    },
    getExperiment: (id: string) => _experiments.get(id),
  },
}));

vi.mock("../scheduler", () => ({
  triggerSchedule: vi.fn(),
}));

vi.mock("../api/tasks", () => ({
  assembleCommand: (t: any) => `cmd:${t.script} ${JSON.stringify(t.args || {})}`,
  generateDisplayName: (t: any) => t.name || t.script || "task",
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import {
  validateDag,
  promoteBlockedTasks,
  cascadeCancellation,
} from "../dag";
import { triggerSchedule } from "../scheduler";
import { TaskSpec } from "../types";

// Fake socket.io namespace
function fakeNs() {
  return { emit: vi.fn() } as any;
}

// Helper to push a task into the mock global queue
function addTask(overrides: Partial<any> = {}) {
  const task = {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    status: "pending",
    depends_on: undefined,
    args: {},
    args_template: undefined,
    script: "test.py",
    raw_args: undefined,
    cwd: undefined,
    env_setup: undefined,
    env: undefined,
    exports: undefined,
    experiment_id: undefined,
    ref: undefined,
    name: undefined,
    ...overrides,
  };
  _globalQueue.push(task);
  return task;
}

beforeEach(() => {
  _globalQueue.length = 0;
  _experiments.clear();
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. validateDag
// ═══════════════════════════════════════════════════════════════════════════

describe("validateDag", () => {
  it("accepts a simple linear pipeline", () => {
    const specs: TaskSpec[] = [
      { ref: "train", script: "train.py" },
      { ref: "eval", script: "eval.py", depends_on: ["train"] },
      { ref: "report", script: "report.py", depends_on: ["eval"] },
    ];
    expect(validateDag(specs)).toEqual({ valid: true });
  });

  it("accepts fan-out / fan-in", () => {
    const specs: TaskSpec[] = [
      { ref: "data", script: "data.py" },
      { ref: "a", script: "a.py", depends_on: ["data"] },
      { ref: "b", script: "b.py", depends_on: ["data"] },
      { ref: "merge", script: "merge.py", depends_on: ["a", "b"] },
    ];
    expect(validateDag(specs)).toEqual({ valid: true });
  });

  it("accepts single node (no deps)", () => {
    expect(validateDag([{ ref: "solo", script: "solo.py" }])).toEqual({ valid: true });
  });

  it("rejects a 2-node cycle", () => {
    const specs: TaskSpec[] = [
      { ref: "a", script: "a.py", depends_on: ["b"] },
      { ref: "b", script: "b.py", depends_on: ["a"] },
    ];
    const result = validateDag(specs);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/cycle/i);
  });

  it("rejects a 3-node cycle", () => {
    const specs: TaskSpec[] = [
      { ref: "a", script: "a.py", depends_on: ["c"] },
      { ref: "b", script: "b.py", depends_on: ["a"] },
      { ref: "c", script: "c.py", depends_on: ["b"] },
    ];
    expect(validateDag(specs).valid).toBe(false);
  });

  it("rejects self-dependency", () => {
    const specs: TaskSpec[] = [
      { ref: "loop", script: "loop.py", depends_on: ["loop"] },
    ];
    expect(validateDag(specs).valid).toBe(false);
  });

  it("rejects unknown ref in depends_on", () => {
    const specs: TaskSpec[] = [
      { ref: "a", script: "a.py", depends_on: ["ghost"] },
    ];
    const result = validateDag(specs);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/unknown ref "ghost"/);
  });

  it("rejects partial cycle in larger graph", () => {
    const specs: TaskSpec[] = [
      { ref: "root", script: "root.py" },
      { ref: "a", script: "a.py", depends_on: ["root", "c"] },
      { ref: "b", script: "b.py", depends_on: ["a"] },
      { ref: "c", script: "c.py", depends_on: ["b"] },
    ];
    expect(validateDag(specs).valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. promoteBlockedTasks
// ═══════════════════════════════════════════════════════════════════════════

describe("promoteBlockedTasks", () => {
  it("promotes a blocked task when its single dep completes", () => {
    const upstream = addTask({ id: "up-1", status: "completed" });
    const blocked = addTask({ id: "down-1", status: "blocked", depends_on: ["up-1"], script: "eval.py" });

    const ns = fakeNs();
    promoteBlockedTasks("up-1", ns);

    expect(blocked.status).toBe("pending");
    expect(ns.emit).toHaveBeenCalledWith("task.update", expect.objectContaining({ id: "down-1", status: "pending" }));
    expect(triggerSchedule).toHaveBeenCalled();
  });

  it("does not promote when not all deps are satisfied", () => {
    addTask({ id: "dep-a", status: "completed" });
    addTask({ id: "dep-b", status: "running" });
    const blocked = addTask({ id: "fan-in", status: "blocked", depends_on: ["dep-a", "dep-b"] });

    promoteBlockedTasks("dep-a", fakeNs());
    expect(blocked.status).toBe("blocked");
  });

  it("promotes fan-in task when last dep completes", () => {
    addTask({ id: "dep-a", status: "completed" });
    addTask({ id: "dep-b", status: "completed" });
    const blocked = addTask({ id: "fan-in", status: "blocked", depends_on: ["dep-a", "dep-b"] });

    promoteBlockedTasks("dep-b", fakeNs());
    expect(blocked.status).toBe("pending");
  });

  it("resolves args_template from upstream exports", () => {
    const expId = "exp-1";
    const upstream = addTask({
      id: "train-1", status: "completed", ref: "train",
      exports: { checkpoint: "/runs/ckpt.pt", loss: "0.01" },
    });
    const blocked = addTask({
      id: "eval-1", status: "blocked", depends_on: ["train-1"],
      ref: "eval", script: "eval.py",
      args_template: { "--checkpoint": "{{deps.train.exports.checkpoint}}" },
      experiment_id: expId,
    });

    _experiments.set(expId, {
      id: expId, task_refs: { train: "train-1", eval: "eval-1" },
    });

    promoteBlockedTasks("train-1", fakeNs());

    expect(blocked.status).toBe("pending");
    expect((blocked.args as any)["--checkpoint"]).toBe("/runs/ckpt.pt");
  });

  it("no-ops when completed task has no downstream", () => {
    addTask({ id: "lone", status: "completed" });
    const ns = fakeNs();
    promoteBlockedTasks("lone", ns);
    expect(ns.emit).not.toHaveBeenCalled();
    expect(triggerSchedule).not.toHaveBeenCalled();
  });

  it("skips already-promoted task", () => {
    addTask({ id: "up", status: "completed" });
    addTask({ id: "down", status: "pending", depends_on: ["up"] }); // already promoted

    const ns = fakeNs();
    promoteBlockedTasks("up", ns);
    expect(ns.emit).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. cascadeCancellation
// ═══════════════════════════════════════════════════════════════════════════

describe("cascadeCancellation", () => {
  it("cancels direct downstream blocked task", () => {
    addTask({ id: "fail-1", status: "failed" });
    const down = addTask({ id: "down-1", status: "blocked", depends_on: ["fail-1"] });

    const ns = fakeNs();
    cascadeCancellation("fail-1", ns);

    expect(down.status).toBe("cancelled");
    expect((down as any).error_message).toMatch(/fail-1/);
    expect(ns.emit).toHaveBeenCalledWith("task.update", expect.objectContaining({ id: "down-1", status: "cancelled" }));
  });

  it("recursively cancels transitive downstream", () => {
    addTask({ id: "root", status: "failed" });
    const mid = addTask({ id: "mid", status: "blocked", depends_on: ["root"] });
    const leaf = addTask({ id: "leaf", status: "blocked", depends_on: ["mid"] });

    cascadeCancellation("root", fakeNs());

    expect(mid.status).toBe("cancelled");
    expect(leaf.status).toBe("cancelled");
  });

  it("does not cancel non-blocked tasks", () => {
    addTask({ id: "fail", status: "failed" });
    const running = addTask({ id: "running-1", status: "running", depends_on: ["fail"] });

    cascadeCancellation("fail", fakeNs());
    expect(running.status).toBe("running");
  });

  it("no-ops when no downstream tasks", () => {
    addTask({ id: "lonely-fail", status: "failed" });
    const ns = fakeNs();
    cascadeCancellation("lonely-fail", ns);
    expect(ns.emit).not.toHaveBeenCalled();
  });

  it("cancels fan-out correctly", () => {
    addTask({ id: "fail", status: "failed" });
    const a = addTask({ id: "a", status: "blocked", depends_on: ["fail"] });
    const b = addTask({ id: "b", status: "blocked", depends_on: ["fail"] });

    cascadeCancellation("fail", fakeNs());
    expect(a.status).toBe("cancelled");
    expect(b.status).toBe("cancelled");
  });
});
