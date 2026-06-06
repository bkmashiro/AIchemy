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
    expect(first).toMatchObject({
      family: null,
      decision: null,
      parent_id: null,
      fork_reason: null,
      goal_metric: null,
      goal_direction: null,
    });
  });

  it("does not match /:id when path is 'tree'", async () => {
    const app = makeApp();
    const res = await request(app).get("/experiments/tree").expect(200);
    expect(res.body).toHaveProperty("roots");
  });

  it("orders same-created_at siblings by name then id", async () => {
    const app = makeApp();
    // Two roots with identical created_at — should fall back to name then id
    const rootA = makeExperiment({
      id: "z-id", name: "alpha", created_at: "2025-03-01T00:00:00.000Z",
    });
    const rootB = makeExperiment({
      id: "a-id", name: "beta", created_at: "2025-03-01T00:00:00.000Z",
    });
    // Two roots with identical created_at AND identical name — fall back to id
    const dupNameA = makeExperiment({
      id: "id-2", name: "gamma", created_at: "2025-03-02T00:00:00.000Z",
    });
    const dupNameB = makeExperiment({
      id: "id-1", name: "gamma", created_at: "2025-03-02T00:00:00.000Z",
    });
    // Two children with identical created_at — also fall back to name then id
    const child1 = makeExperiment({
      id: "c-zz", name: "ka", parent_id: "z-id",
      created_at: "2025-03-10T00:00:00.000Z",
    });
    const child2 = makeExperiment({
      id: "c-aa", name: "kb", parent_id: "z-id",
      created_at: "2025-03-10T00:00:00.000Z",
    });
    // Two same-name same-created_at siblings — fall back to id
    const child3 = makeExperiment({
      id: "c-yy", name: "kc", parent_id: "z-id",
      created_at: "2025-03-10T00:00:00.000Z",
    });
    const child4 = makeExperiment({
      id: "c-bb", name: "kc", parent_id: "z-id",
      created_at: "2025-03-10T00:00:00.000Z",
    });

    for (const e of [rootA, rootB, dupNameA, dupNameB, child1, child2, child3, child4]) {
      store.setGrid(makeGrid(e.grid_id));
      store.setExperiment(e);
    }

    const res = await request(app).get("/experiments/tree").expect(200);
    // Roots first ordered by created_at; within the second created_at, by name then id
    expect(res.body.roots.map((r: any) => r.id)).toEqual([
      "z-id", "a-id", "id-1", "id-2",
    ]);
    const firstRootChildren = res.body.roots[0].children;
    expect(firstRootChildren.map((c: any) => c.id)).toEqual([
      "c-zz", // ka < kb < kc
      "c-aa",
      "c-bb", // same created_at + name → id ascending
      "c-yy",
    ]);
  });

  it("includes fork_reason, goal_metric, goal_direction in brief nodes", async () => {
    const app = makeApp();
    const root = makeExperiment({
      id: "r", name: "root", goal_metric: "zn", goal_direction: "max",
      created_at: "2025-02-01T00:00:00.000Z",
    });
    const child = makeExperiment({
      id: "c", name: "child", parent_id: "r", fork_reason: "baseline plateaued",
      created_at: "2025-02-02T00:00:00.000Z",
    });
    for (const e of [root, child]) {
      store.setGrid(makeGrid(e.grid_id));
      store.setExperiment(e);
    }

    const res = await request(app).get("/experiments/tree").expect(200);
    expect(res.body.roots[0]).toMatchObject({
      id: "r", goal_metric: "zn", goal_direction: "max", fork_reason: null,
    });
    expect(res.body.roots[0].children[0]).toMatchObject({
      id: "c", fork_reason: "baseline plateaued", goal_metric: null, goal_direction: null,
    });
  });

  it("includes recommendation and diff_summary on tree nodes", async () => {
    const app = makeApp();
    const exp = makeExperiment({
      id: "root-rec", name: "root-rec", created_at: "2025-02-01T00:00:00.000Z",
      goal_metric: "loss", goal_direction: "min", status: "running",
      config_diff: { lr: { old: 0.02, new: 0.01 }, bs: { old: 64, new: 128 } },
    });
    store.setGrid(makeGrid(exp.grid_id));
    store.setExperiment(exp);

    const res = await request(app).get("/experiments/tree").expect(200);
    expect(res.body.roots[0]).toMatchObject({
      id: "root-rec",
      recommendation: {
        action: "rerun",
        verdict: "running",
        metric: "loss",
        direction: "min",
      },
      diff_summary: {
        config_changed: true,
        config_change_count: 2,
        metric: "loss",
        direction: "min",
        parent_status: null,
        status_changed_from_parent: null,
      },
    });
  });

  it("includes diff_summary in compare payloads", async () => {
    const app = makeApp();
    const parent = makeExperiment({
      id: "cmp-parent", name: "cmp-parent", created_at: "2025-02-01T00:00:00.000Z",
      config_diff: { lr: { old: 0.01, new: 0.02 } },
    });
    const child = makeExperiment({
      id: "cmp-child", name: "cmp-child", parent_id: "cmp-parent", created_at: "2025-02-02T00:00:00.000Z",
      config_diff: { lr: { old: 0.02, new: 0.03 } },
    });

    for (const e of [parent, child]) {
      store.setGrid(makeGrid(e.grid_id));
      store.setExperiment(e);
    }

    const res = await request(app).get("/experiments/compare?ids=cmp-child,cmp-parent").expect(200);
    expect(res.body.experiments.map((e: any) => e.id)).toEqual(["cmp-child", "cmp-parent"]);
    expect(res.body.experiments[0]).toMatchObject({
      id: "cmp-child",
      diff_summary: { config_changed: true, config_change_count: 1 },
    });
    expect(res.body.experiments[1]).toMatchObject({
      id: "cmp-parent",
      diff_summary: { config_changed: true, config_change_count: 1 },
    });
  });

  it("child nodes include parent_status and status_changed_from_parent", async () => {
    const app = makeApp();

    const parent = makeExperiment({
      id: "parent", name: "parent", created_at: "2025-01-01T00:00:00.000Z",
    });
    const child = makeExperiment({
      id: "child", name: "child", parent_id: "parent", created_at: "2025-01-02T00:00:00.000Z",
    });

    const parentTask = makeTask({ id: "p-task", grid_id: parent.grid_id, status: "completed" });
    const childTask = makeTask({ id: "c-task", grid_id: child.grid_id, status: "failed" });

    store.addToGlobalQueue(parentTask);
    store.addToGlobalQueue(childTask);

    parent.results = {
      [parentTask.id]: { passed: true, checked_at: "x", details: { loss: { value: 0.2, threshold: "< 1.0", ok: true } } },
    };
    child.results = {
      [childTask.id]: { passed: false, checked_at: "x", details: { loss: { value: 1.3, threshold: "< 1.0", ok: false } } },
    };

    const parentGrid = makeGrid(parent.grid_id, [parentTask.id]);
    const childGrid = makeGrid(child.grid_id, [childTask.id]);
    store.setGrid(parentGrid);
    store.setGrid(childGrid);
    store.setExperiment(parent);
    store.setExperiment(child);

    const res = await request(app).get("/experiments/tree").expect(200);
    const childNode = res.body.roots.find((r: any) => r.id === "parent").children[0];
    expect(childNode.diff_summary).toMatchObject({
      parent_status: "passed",
      status_changed_from_parent: true,
      metric: null,
      direction: null,
      metric_delta: null,
      config_change_count: 0,
      config_changed: false,
    });
  });
});

describe("GET /experiments/compare", () => {
  it("400s when ids query missing or empty", async () => {
    const app = makeApp();
    await request(app).get("/experiments/compare").expect(400);
    await request(app).get("/experiments/compare?ids=").expect(400);
    await request(app).get("/experiments/compare?ids=,,").expect(400);
  });

  it("400s when more than 6 unique ids are requested", async () => {
    const app = makeApp();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const exp = makeExperiment({ id: `m${i}`, name: `m${i}` });
      store.setGrid(makeGrid(exp.grid_id));
      store.setExperiment(exp);
      ids.push(exp.id);
    }
    // 6 unique → OK
    await request(app).get(`/experiments/compare?ids=${ids.slice(0, 6).join(",")}`).expect(200);
    // 7 unique → 400
    await request(app).get(`/experiments/compare?ids=${ids.join(",")}`).expect(400);
  });

  it("deduplicates repeated ids in ids/found/experiments/metric_deltas", async () => {
    const app = makeApp();
    const expA = makeExperiment({
      id: "A", name: "A", criteria: { loss: "< 1.0" },
      results: {
        t1: { passed: true, checked_at: "x", details: { loss: { value: 0.5, threshold: "< 1.0", ok: true } } },
      },
    });
    const expB = makeExperiment({
      id: "B", name: "B", criteria: { loss: "< 1.0" },
      results: {
        t1: { passed: true, checked_at: "x", details: { loss: { value: 0.3, threshold: "< 1.0", ok: true } } },
      },
    });
    for (const e of [expA, expB]) {
      store.setGrid(makeGrid(e.grid_id));
      store.setExperiment(e);
    }

    // Duplicates and surrounding whitespace must collapse to first-seen order.
    const res = await request(app)
      .get("/experiments/compare?ids=A,B,A, B ,A")
      .expect(200);
    expect(res.body.ids).toEqual(["A", "B"]);
    expect(res.body.found).toEqual(["A", "B"]);
    expect(res.body.missing).toEqual([]);
    expect(res.body.experiments.map((e: any) => e.id)).toEqual(["A", "B"]);
    // metric_deltas rows must not duplicate either
    expect(res.body.metric_deltas.loss.map((r: any) => r.id)).toEqual(["A", "B"]);
  });

  it("reports missing ids without dropping found experiments", async () => {
    const app = makeApp();
    const exp = makeExperiment({ id: "e1", name: "e1", config: { lr: 0.01 } });
    store.setGrid(makeGrid(exp.grid_id));
    store.setExperiment(exp);

    const res = await request(app).get("/experiments/compare?ids=e1,e2,e3").expect(200);
    expect(res.body.ids).toEqual(["e1", "e2", "e3"]);
    expect(res.body.found).toEqual(["e1"]);
    expect(res.body.missing).toEqual(["e2", "e3"]);
    expect(res.body.experiments.map((e: any) => e.id)).toEqual(["e1"]);
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
    expect(a.primary_metric).toBeNull();
    expect(b.primary_metric).toBeNull();
    expect(res.body.found).toEqual(["B", "A"]);
    expect(res.body.missing).toEqual([]);
    expect(res.body.shared_config_keys).toEqual(["lr"]);
    expect(res.body.differing_config_keys).toEqual(["lr"]);
    expect(res.body.metric_deltas.acc).toEqual([
      { id: "B", best: 0.95, delta: 0 },
      { id: "A", best: null, delta: null },
    ]);
    expect(res.body.metric_deltas.loss).toEqual([
      { id: "B", best: null, delta: null },
      { id: "A", best: 0.2, delta: 0 },
    ]);
  });

  it("metric_deltas keys are sorted and per-metric rows follow requested id order with null for missing data", async () => {
    const app = makeApp();
    // X has loss + acc; Y has only loss; Z has only zeta.
    const expX = makeExperiment({
      id: "X", name: "X", criteria: { loss: "< 1.0", acc: "> 0.5" },
      results: {
        t1: { passed: true, checked_at: "x", details: {
          loss: { value: 0.25, threshold: "< 1.0", ok: true },
          acc: { value: 0.875, threshold: "> 0.5", ok: true },
        }},
      },
    });
    const expY = makeExperiment({
      id: "Y", name: "Y", criteria: { loss: "< 1.0" },
      results: {
        t1: { passed: true, checked_at: "x", details: {
          loss: { value: 0.5, threshold: "< 1.0", ok: true },
        }},
      },
    });
    const expZ = makeExperiment({
      id: "Z", name: "Z", criteria: { zeta: "> 0.1" },
      results: {
        t1: { passed: true, checked_at: "x", details: {
          zeta: { value: 0.9, threshold: "> 0.1", ok: true },
        }},
      },
    });
    for (const e of [expX, expY, expZ]) {
      store.setGrid(makeGrid(e.grid_id));
      store.setExperiment(e);
    }

    // Request in non-sorted order to verify ids ordering propagates to rows.
    const res = await request(app).get("/experiments/compare?ids=Y,Z,X").expect(200);
    expect(res.body.found).toEqual(["Y", "Z", "X"]);
    // Keys deterministic and sorted alphabetically.
    expect(Object.keys(res.body.metric_deltas)).toEqual(["acc", "loss", "zeta"]);
    // Per-metric row ids follow requested order (which equals `found` here).
    for (const metric of ["acc", "loss", "zeta"]) {
      expect(res.body.metric_deltas[metric].map((r: any) => r.id)).toEqual(["Y", "Z", "X"]);
    }
    // acc: only X has it → reference is X's value, X's delta is 0.
    expect(res.body.metric_deltas.acc).toEqual([
      { id: "Y", best: null, delta: null },
      { id: "Z", best: null, delta: null },
      { id: "X", best: 0.875, delta: 0 },
    ]);
    // loss: Y (reference) then X. Z null. delta vs first found-with-metric.
    expect(res.body.metric_deltas.loss).toEqual([
      { id: "Y", best: 0.5, delta: 0 },
      { id: "Z", best: null, delta: null },
      { id: "X", best: 0.25, delta: -0.25 },
    ]);
    // zeta: only Z has it.
    expect(res.body.metric_deltas.zeta).toEqual([
      { id: "Y", best: null, delta: null },
      { id: "Z", best: 0.9, delta: 0 },
      { id: "X", best: null, delta: null },
    ]);
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
      criteria: { loss: "< 1.0" }, goal_metric: "loss", goal_direction: "min",
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
    expect(res.body.goal_metric).toBe("loss");
    expect(res.body.goal_direction).toBe("min");
    expect(res.body.primary_metric).toEqual({ metric: "loss", direction: "min", best: 0.3 });
    expect(res.body.timeline_event_count).toBe(1);
    expect(res.body.config).toEqual({ lr: 0.01 });
    expect(res.body.config_diff).toEqual({ lr: { old: 0.02, new: 0.01 } });
  });

  it("primary_metric is null when goal_metric is set but goal_direction is missing", async () => {
    const app = makeApp();
    // goal_metric set, but no goal_direction. Also: criteria mentions "loss" with
    // a "<" operator, and the metric name "loss" itself suggests minimization —
    // neither should be used to infer direction.
    const exp = makeExperiment({
      id: "no-dir", name: "no-dir",
      goal_metric: "loss",
      criteria: { loss: "< 1.0" },
      results: {
        t1: { passed: true, checked_at: "x", details: {
          loss: { value: 0.3, threshold: "< 1.0", ok: true },
        }},
      },
    });
    store.setGrid(makeGrid(exp.grid_id));
    store.setExperiment(exp);

    const res = await request(app).get(`/experiments/${exp.id}/summary`).expect(200);
    expect(res.body.goal_metric).toBe("loss");
    expect(res.body.goal_direction).toBeNull();
    expect(res.body.primary_metric).toBeNull();
    // Sanity: best_metrics still computed via criteria-derived best.
    expect(res.body.best_metrics).toEqual({ loss: 0.3 });
  });

  it("parent and children briefs include lineage fields ordered deterministically", async () => {
    const app = makeApp();
    const parent = makeExperiment({
      id: "P", name: "parent", family: "fam",
      decision: "keep", decision_reason: "good", decision_at: "2025-04-01T00:00:00.000Z",
      goal_metric: "loss", goal_direction: "min", fork_reason: "explore",
      created_at: "2025-04-01T00:00:00.000Z",
    });
    const exp = makeExperiment({
      id: "E", name: "exp", parent_id: "P", family: "fam",
      created_at: "2025-04-02T00:00:00.000Z",
    });
    // Two children with same created_at and same name → must fall back to id.
    const childA = makeExperiment({
      id: "c-b", name: "kid", parent_id: "E",
      decision: "drop", fork_reason: "diverged",
      goal_metric: "acc", goal_direction: "max",
      created_at: "2025-04-03T00:00:00.000Z",
    });
    const childB = makeExperiment({
      id: "c-a", name: "kid", parent_id: "E",
      decision: "fork", fork_reason: "branch",
      goal_metric: "f1", goal_direction: "max",
      created_at: "2025-04-03T00:00:00.000Z",
    });
    for (const e of [parent, exp, childA, childB]) {
      store.setGrid(makeGrid(e.grid_id));
      store.setExperiment(e);
    }

    const res = await request(app).get(`/experiments/${exp.id}/summary`).expect(200);
    expect(res.body.parent).toMatchObject({
      id: "P",
      name: "parent",
      family: "fam",
      decision: "keep",
      fork_reason: "explore",
      goal_metric: "loss",
      goal_direction: "min",
      parent_id: null,
    });
    // Deterministic same-created_at + same-name fallback to id ascending.
    expect(res.body.children.map((c: any) => c.id)).toEqual(["c-a", "c-b"]);
    expect(res.body.children[0]).toMatchObject({
      id: "c-a",
      decision: "fork",
      fork_reason: "branch",
      goal_metric: "f1",
      goal_direction: "max",
      parent_id: "E",
    });
    expect(res.body.children[1]).toMatchObject({
      id: "c-b",
      decision: "drop",
      fork_reason: "diverged",
      goal_metric: "acc",
      goal_direction: "max",
      parent_id: "E",
    });
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
