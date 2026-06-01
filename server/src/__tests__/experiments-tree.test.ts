import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../scheduler", () => ({
  triggerSchedule: vi.fn(),
}));

vi.mock("../git-tracking", () => ({
  initExperimentManifest: vi.fn().mockResolvedValue(undefined),
  readExperimentManifest: vi.fn().mockResolvedValue(""),
}));

import { store } from "../store";
import { createExperimentsRouter } from "../api/experiments";
import { Experiment, Grid, Task } from "../types";

function makeApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/experiments", createExperimentsRouter({} as any, { emit: vi.fn() } as any));
  return app;
}

function makeExperiment(overrides: Partial<Experiment>): Experiment {
  const id = overrides.id ?? `exp-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    name: overrides.name ?? id,
    criteria: overrides.criteria ?? {},
    grid_id: overrides.grid_id ?? `grid-${id}`,
    status: "running",
    results: {},
    created_at: overrides.created_at ?? new Date().toISOString(),
    ...overrides,
  };
}

function makeGrid(id: string, task_ids: string[] = []): Grid {
  return {
    id,
    display_name: `grid ${id}`,
    script: "train.py",
    param_space: {},
    task_ids,
    status: "pending",
    created_at: new Date().toISOString(),
    max_retries: 0,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? `task-${Math.random().toString(36).slice(2, 8)}`,
    seq: store.nextSeq(),
    fingerprint: "fp",
    display_name: "task",
    script: "train.py",
    command: "python train.py",
    status: "pending",
    priority: 5,
    created_at: new Date().toISOString(),
    log_buffer: [],
    retry_count: 0,
    max_retries: 0,
    should_stop: false,
    should_checkpoint: false,
    ...overrides,
  };
}

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
});

describe("GET /experiments/tree", () => {
  it("returns a forest with deterministic ordering and nests children", async () => {
    const app = makeApp();

    const root1 = makeExperiment({
      id: "r1", name: "root-a", created_at: "2025-01-01T00:00:00.000Z",
    });
    const root2 = makeExperiment({
      id: "r2", name: "root-b", created_at: "2025-01-02T00:00:00.000Z",
    });
    const child1 = makeExperiment({
      id: "c1", name: "child-1", parent_id: "r1",
      created_at: "2025-01-03T00:00:00.000Z",
    });
    const child2 = makeExperiment({
      id: "c2", name: "child-2", parent_id: "r1",
      created_at: "2025-01-04T00:00:00.000Z",
    });
    // child of child1 to test deep nesting
    const grand = makeExperiment({
      id: "g1", name: "grand", parent_id: "c1",
      created_at: "2025-01-05T00:00:00.000Z",
    });
    // orphan: parent_id present but parent missing → treated as root
    const orphan = makeExperiment({
      id: "o1", name: "orphan", parent_id: "missing-parent",
      created_at: "2025-01-06T00:00:00.000Z",
    });

    for (const e of [root1, root2, child1, child2, grand, orphan]) {
      store.setGrid(makeGrid(e.grid_id));
      store.setExperiment(e);
    }

    const res = await request(app).get("/experiments/tree").expect(200);
    expect(res.body.roots).toHaveLength(3);
    const [first, second, third] = res.body.roots;
    expect(first.id).toBe("r1");
    expect(second.id).toBe("r2");
    expect(third.id).toBe("o1"); // orphan
    expect(first.children.map((c: any) => c.id)).toEqual(["c1", "c2"]);
    expect(first.children[0].children.map((c: any) => c.id)).toEqual(["g1"]);
    expect(first.status).toBe("running");
    expect(first).toMatchObject({ family: null, decision: null, parent_id: null });
  });

  it("does not match /:id when path is 'tree'", async () => {
    const app = makeApp();
    const res = await request(app).get("/experiments/tree").expect(200);
    expect(res.body).toHaveProperty("roots");
  });
});

describe("GET /experiments/compare", () => {
  it("400s when ids query missing or empty", async () => {
    const app = makeApp();
    await request(app).get("/experiments/compare").expect(400);
    await request(app).get("/experiments/compare?ids=").expect(400);
    await request(app).get("/experiments/compare?ids=,,").expect(400);
  });

  it("404s when any id is missing and reports them", async () => {
    const app = makeApp();
    const exp = makeExperiment({ id: "e1", name: "e1" });
    store.setGrid(makeGrid(exp.grid_id));
    store.setExperiment(exp);

    const res = await request(app).get("/experiments/compare?ids=e1,e2,e3").expect(404);
    expect(res.body.missing).toEqual(["e2", "e3"]);
  });

  it("returns experiments in requested order with metrics + criteria + pass_fail", async () => {
    const app = makeApp();
    const expA = makeExperiment({
      id: "A", name: "A", criteria: { loss: "< 1.0" }, config: { lr: 0.01 },
      results: {
        t1: { passed: true, checked_at: "x", details: { loss: { value: 0.2, threshold: "< 1.0", ok: true } } },
        t2: { passed: false, checked_at: "x", details: { loss: { value: 1.5, threshold: "< 1.0", ok: false } } },
      },
    });
    const expB = makeExperiment({
      id: "B", name: "B", criteria: { acc: "> 0.9" }, config: { lr: 0.02 },
      results: {
        t1: { passed: true, checked_at: "x", details: { acc: { value: 0.95, threshold: "> 0.9", ok: true } } },
      },
    });
    for (const e of [expA, expB]) {
      store.setGrid(makeGrid(e.grid_id));
      store.setExperiment(e);
    }

    const res = await request(app).get("/experiments/compare?ids=B,A").expect(200);
    expect(res.body.ids).toEqual(["B", "A"]);
    expect(res.body.experiments.map((e: any) => e.id)).toEqual(["B", "A"]);
    const [b, a] = res.body.experiments;
    expect(b.config).toEqual({ lr: 0.02 });
    expect(a.config).toEqual({ lr: 0.01 });
    expect(a.metrics.loss.count).toBe(2);
    expect(a.metrics.loss.best).toBe(0.2); // best for "<" is min
    expect(a.metrics.loss.passed).toBe(1);
    expect(a.metrics.loss.failed).toBe(1);
    expect(b.metrics.acc.best).toBe(0.95); // best for ">" is max
    expect(a.criteria).toEqual({ loss: "< 1.0" });
    expect(a.pass_fail).toEqual({ total: 2, passed: 1, failed: 1 });
    expect(b.pass_fail).toEqual({ total: 1, passed: 1, failed: 0 });
  });
});

describe("GET /experiments/:id/summary", () => {
  it("404s when experiment missing", async () => {
    const app = makeApp();
    await request(app).get("/experiments/nope/summary").expect(404);
  });

  it("returns full summary with parent, children, task counts, metrics", async () => {
    const app = makeApp();
    const parent = makeExperiment({
      id: "p", name: "parent", family: "fam-1",
      created_at: "2025-01-01T00:00:00.000Z",
    });
    const exp = makeExperiment({
      id: "e", name: "exp", parent_id: "p", family: "fam-1",
      hypothesis: "hyp", expected_outcome: "good", fork_reason: "trying",
      criteria: { loss: "< 1.0" },
      config: { lr: 0.01 }, config_diff: { lr: { old: 0.02, new: 0.01 } },
      results: {
        t1: { passed: true, checked_at: "x", details: { loss: { value: 0.3, threshold: "< 1.0", ok: true } } },
        t2: { passed: false, checked_at: "x", details: { loss: { value: 1.2, threshold: "< 1.0", ok: false } } },
      },
      created_at: "2025-01-02T00:00:00.000Z",
    });
    const child = makeExperiment({
      id: "c", name: "child", parent_id: "e",
      created_at: "2025-01-03T00:00:00.000Z",
    });

    for (const e of [parent, exp, child]) {
      store.setGrid(makeGrid(e.grid_id));
      store.setExperiment(e);
    }

    // Attach tasks to the experiment's grid for task counts
    const t1 = makeTask({ id: "t1", grid_id: exp.grid_id, status: "completed" });
    const t2 = makeTask({ id: "t2", grid_id: exp.grid_id, status: "failed" });
    store.addToGlobalQueue(t1);
    store.addToGlobalQueue(t2);
    const grid = store.getGrid(exp.grid_id)!;
    grid.task_ids = [t1.id, t2.id];
    store.setGrid(grid);

    // Add a timeline event so event count > 0
    store.addExperimentEvent({
      id: "evt1", experiment_id: exp.id, kind: "note", message: "hello",
      created_at: new Date().toISOString(),
    });

    const res = await request(app).get(`/experiments/${exp.id}/summary`).expect(200);
    expect(res.body.id).toBe("e");
    expect(res.body.name).toBe("exp");
    expect(res.body.hypothesis).toBe("hyp");
    expect(res.body.expected_outcome).toBe("good");
    expect(res.body.fork_reason).toBe("trying");
    expect(res.body.parent).toMatchObject({ id: "p", name: "parent" });
    expect(res.body.children.map((c: any) => c.id)).toEqual(["c"]);
    expect(res.body.task_counts).toEqual({ completed: 1, failed: 1 });
    expect(res.body.validation).toEqual({ total: 2, passed: 1, failed: 1 });
    expect(res.body.best_metrics).toEqual({ loss: 0.3 });
    expect(res.body.timeline_event_count).toBe(1);
    expect(res.body.config).toEqual({ lr: 0.01 });
    expect(res.body.config_diff).toEqual({ lr: { old: 0.02, new: 0.01 } });
  });

  it("returns null parent when experiment has no parent_id", async () => {
    const app = makeApp();
    const exp = makeExperiment({ id: "solo", name: "solo" });
    store.setGrid(makeGrid(exp.grid_id));
    store.setExperiment(exp);

    const res = await request(app).get(`/experiments/${exp.id}/summary`).expect(200);
    expect(res.body.parent).toBeNull();
    expect(res.body.children).toEqual([]);
  });
});
