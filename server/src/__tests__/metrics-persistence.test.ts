import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../metrics", () => ({
  metricsStore: {
    getStubMetrics: vi.fn(() => []),
    getTaskMetrics: vi.fn(() => []),
    getTaskMetricsDirect: vi.fn(() => ({})),
  },
}));

import { store } from "../store";
import { createTask } from "../api/tasks";
import { createMetricsRouter } from "../api/metrics";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(createMetricsRouter());
  return app;
}

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
});

describe("task metric persistence", () => {
  it("serves task metrics_buffer from persisted task state when ring buffer is empty", async () => {
    const task = createTask({ script: "train.py" });
    store.addToGlobalQueue({
      ...task,
      metrics_buffer: {
        loss: [{ step: 1, value: 0.5, ts: "2026-07-01T00:00:00.000Z" }],
      },
    });

    const res = await request(makeApp()).get(`/tasks/${task.id}/metrics`).expect(200);

    expect(res.body).toEqual({
      task_id: task.id,
      source: "persistent_task_snapshot",
      metrics_buffer: {
        loss: [{ step: 1, value: 0.5, ts: "2026-07-01T00:00:00.000Z" }],
      },
      points: [],
    });
  });

  it("labels task log tails as bounded persistent snapshots", async () => {
    const task = createTask({ script: "train.py" });
    store.addToGlobalQueue({ ...task, log_buffer: ["a", "b", "c"] });

    const res = await request(makeApp()).get(`/tasks/${task.id}/logs?tail=2`).expect(200);

    expect(res.body).toEqual({
      task_id: task.id,
      source: "persistent_task_snapshot",
      truncated: true,
      tail: 2,
      lines: ["b", "c"],
    });
  });

  it("rejects invalid log tail requests instead of returning unbounded blobs", async () => {
    const task = createTask({ script: "train.py" });
    store.addToGlobalQueue(task);

    await request(makeApp()).get(`/tasks/${task.id}/logs?tail=99999`).expect(400);
    await request(makeApp()).get(`/tasks/${task.id}/logs?tail=0`).expect(400);
  });
});
