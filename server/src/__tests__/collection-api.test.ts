import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExperimentsRouter } from "../api/experiments";
import { createGridsRouter } from "../api/grids";
import { store } from "../store";
import type { Experiment, Grid, Task } from "../types";

function task(id: string, gridId: string, status: Task["status"], seq: number): Task {
  return {
    id,
    seq,
    fingerprint: `fp-${id}`,
    script: "/tmp/train.py",
    display_name: id,
    command: "python /tmp/train.py",
    status,
    priority: 5,
    grid_id: gridId,
    created_at: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
    log_buffer: [],
    retry_count: 0,
    max_retries: 0,
  } as unknown as Task;
}

function grid(id: string, taskIds: string[]): Grid {
  return {
    id,
    display_name: id,
    script: "/tmp/train.py",
    base_args: {},
    param_space: {},
    task_ids: taskIds,
    status: "pending",
    created_at: "2026-01-01T00:00:00Z",
    max_retries: 0,
  };
}

function experiment(id: string, gridId: string): Experiment {
  return {
    id,
    name: id,
    grid_id: gridId,
    created_at: "2026-01-01T00:00:00Z",
    criteria: {},
    results: {},
    status: "running",
  };
}

beforeEach(() => store.reset());

describe("collection API performance contracts", () => {
  it("returns a paginated brief experiment envelope without per-experiment task scans", async () => {
    for (let index = 0; index < 3; index += 1) {
      const gridId = `grid-${index}`;
      const taskId = `task-${index}`;
      store.setGrid(grid(gridId, [taskId]));
      store.addToGlobalQueue(task(taskId, gridId, "completed", index + 1));
      store.setExperiment(experiment(`exp-${index}`, gridId));
    }
    const scan = vi.spyOn(store, "getGridTasks");
    const app = express();
    app.use(express.json());
    app.use("/experiments", createExperimentsRouter({} as any, {} as any));

    const response = await request(app).get("/experiments?brief=true&limit=2&offset=1");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 3, limit: 2, offset: 1 });
    expect(response.body.items).toHaveLength(2);
    expect(response.body.items[0]).not.toHaveProperty("results");
    expect(scan).not.toHaveBeenCalled();
  });

  it("returns a paginated grid envelope using one aggregate pass", async () => {
    for (let index = 0; index < 3; index += 1) {
      const gridId = `grid-${index}`;
      const taskId = `task-${index}`;
      store.setGrid(grid(gridId, [taskId]));
      store.addToGlobalQueue(task(taskId, gridId, index === 0 ? "running" : "completed", index + 1));
    }
    const scan = vi.spyOn(store, "getGridTasks");
    const app = express();
    app.use(express.json());
    app.use("/grids", createGridsRouter({} as any, {} as any));

    const response = await request(app).get("/grids?limit=2&offset=0");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 3, limit: 2, offset: 0 });
    expect(response.body.items).toHaveLength(2);
    expect(scan).not.toHaveBeenCalled();
  });
});
