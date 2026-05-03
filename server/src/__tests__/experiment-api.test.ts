import { describe, it, expect, beforeEach, vi } from "vitest";
import { store } from "../store";
import { evaluateCriteria } from "../criteria";
import { deriveExperimentStatus } from "../api/experiments";
import { Experiment, Grid, Task } from "../types";

// Mock store for isolation — we use the real store but reset it
beforeEach(() => {
  store.reset();
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    seq: store.nextSeq(),
    fingerprint: "fp-test",
    display_name: "test task",
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

describe("Experiment creation + grid task count", () => {
  it("creates experiment with correct grid and task count", () => {
    // Simulate what POST /experiments does
    const gridId = "grid-test-1";
    const grid: Grid = {
      id: gridId,
      display_name: "test grid",
      script: "train.py",
      param_space: { seed: [1, 2], ctx: [16, 32] },
      task_ids: [],
      status: "pending",
      created_at: new Date().toISOString(),
      max_retries: 0,
    };

    // Create 4 tasks (2 seeds x 2 ctx)
    const tasks: Task[] = [];
    for (const seed of [1, 2]) {
      for (const ctx of [16, 32]) {
        const task = makeTask({
          grid_id: gridId,
          param_overrides: { seed, ctx },
        });
        tasks.push(task);
        store.addToGlobalQueue(task);
      }
    }

    grid.task_ids = tasks.map((t) => t.id);
    store.setGrid(grid);

    const experiment: Experiment = {
      id: "exp-test-1",
      name: "test_experiment",
      criteria: { silhouette: "> 0.3" },
      grid_id: gridId,
      status: "running",
      results: {},
      created_at: new Date().toISOString(),
    };

    store.setExperiment(experiment);

    expect(store.getExperiment("exp-test-1")).toBeDefined();
    expect(store.getGrid(gridId)!.task_ids).toHaveLength(4);
    expect(store.getExperimentByGridId(gridId)!.id).toBe("exp-test-1");
  });
});

describe("Eval metrics + criteria check", () => {
  it("evaluates criteria when eval metrics arrive", () => {
    const gridId = "grid-eval-1";
    const taskId = "task-eval-1";

    const grid: Grid = {
      id: gridId,
      display_name: "eval grid",
      script: "train.py",
      param_space: { seed: [42] },
      task_ids: [taskId],
      status: "running",
      created_at: new Date().toISOString(),
      max_retries: 0,
    };
    store.setGrid(grid);

    const experiment: Experiment = {
      id: "exp-eval-1",
      name: "eval_test",
      criteria: { silhouette: "> 0.3", nmi: "> 0.1" },
      grid_id: gridId,
      status: "running",
      results: {},
      created_at: new Date().toISOString(),
    };
    store.setExperiment(experiment);

    // Simulate eval metrics arriving
    const metrics = { silhouette: 0.5, nmi: 0.4 };
    const result = evaluateCriteria(experiment.criteria, metrics);

    expect(result.passed).toBe(true);
    expect(result.details.silhouette.ok).toBe(true);
    expect(result.details.nmi.ok).toBe(true);

    // Update experiment results
    experiment.results[taskId] = {
      passed: result.passed,
      checked_at: new Date().toISOString(),
      details: result.details,
    };
    experiment.status = deriveExperimentStatus(experiment);
    store.setExperiment(experiment);

    // 1 task, 1 passed result → passed count matches total → "passed"
    expect(experiment.status).toBe("passed");
  });

  it("derives passed status when all tasks complete and pass criteria", () => {
    const gridId = "grid-pass-1";
    const taskIds = ["t1", "t2"];

    // Need a stub to host tasks
    store.setStub({
      id: "stub-1",
      name: "test-stub",
      hostname: "localhost",
      gpu: { name: "test", vram_total_mb: 1000, count: 1 },
      status: "online",
      type: "workstation",
      connected_at: new Date().toISOString(),
      last_heartbeat: new Date().toISOString(),
      max_concurrent: 2,
      tasks: taskIds.map((id) => makeTask({
        id,
        grid_id: gridId,
        status: "completed",
        finished_at: new Date().toISOString(),
      })),
    });

    const grid: Grid = {
      id: gridId,
      display_name: "pass grid",
      script: "train.py",
      param_space: { seed: [1, 2] },
      task_ids: taskIds,
      status: "completed",
      created_at: new Date().toISOString(),
      max_retries: 0,
    };
    store.setGrid(grid);

    const experiment: Experiment = {
      id: "exp-pass-1",
      name: "pass_test",
      criteria: { loss: "< 1.0" },
      grid_id: gridId,
      status: "running",
      results: {
        t1: { passed: true, checked_at: new Date().toISOString(), details: { loss: { value: 0.5, threshold: "< 1.0", ok: true } } },
        t2: { passed: true, checked_at: new Date().toISOString(), details: { loss: { value: 0.3, threshold: "< 1.0", ok: true } } },
      },
      created_at: new Date().toISOString(),
    };
    store.setExperiment(experiment);

    const status = deriveExperimentStatus(experiment);
    expect(status).toBe("passed");
  });

  it("derives partial status when some pass and some fail", () => {
    const gridId = "grid-partial-1";
    const taskIds = ["t1", "t2"];

    store.setStub({
      id: "stub-2",
      name: "test-stub-2",
      hostname: "localhost",
      gpu: { name: "test", vram_total_mb: 1000, count: 1 },
      status: "online",
      type: "workstation",
      connected_at: new Date().toISOString(),
      last_heartbeat: new Date().toISOString(),
      max_concurrent: 2,
      tasks: taskIds.map((id) => makeTask({
        id,
        grid_id: gridId,
        status: "completed",
        finished_at: new Date().toISOString(),
      })),
    });

    const grid: Grid = {
      id: gridId,
      display_name: "partial grid",
      script: "train.py",
      param_space: { seed: [1, 2] },
      task_ids: taskIds,
      status: "completed",
      created_at: new Date().toISOString(),
      max_retries: 0,
    };
    store.setGrid(grid);

    const experiment: Experiment = {
      id: "exp-partial-1",
      name: "partial_test",
      criteria: { loss: "< 0.5" },
      grid_id: gridId,
      status: "running",
      results: {
        t1: { passed: true, checked_at: new Date().toISOString(), details: { loss: { value: 0.3, threshold: "< 0.5", ok: true } } },
        t2: { passed: false, checked_at: new Date().toISOString(), details: { loss: { value: 0.8, threshold: "< 0.5", ok: false } } },
      },
      created_at: new Date().toISOString(),
    };
    store.setExperiment(experiment);

    const status = deriveExperimentStatus(experiment);
    expect(status).toBe("partial");
  });
});
