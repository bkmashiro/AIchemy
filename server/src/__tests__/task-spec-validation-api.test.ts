import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../scheduler", () => ({
  triggerSchedule: vi.fn(),
  diagnoseTaskAssignment: vi.fn(),
}));

vi.mock("../git-tracking", () => ({
  initExperimentManifest: vi.fn().mockResolvedValue(undefined),
  readExperimentManifest: vi.fn().mockResolvedValue(""),
}));

import { createExperimentsRouter } from "../api/experiments";
import { createGridsRouter } from "../api/grids";
import { store } from "../store";

function makeApp() {
  const app = express();
  app.use(express.json());
  const webNs = { emit: vi.fn() } as any;
  app.use("/experiments", createExperimentsRouter({} as any, webNs));
  app.use("/grids", createGridsRouter({} as any, webNs));
  return app;
}

beforeEach(() => store.reset());

describe("experiment task execution spec validation", () => {
  it("rejects malformed GPU requirements before materializing DAG tasks", async () => {
    const res = await request(makeApp()).post("/experiments").send({
      name: "invalid-gpu-type",
      task_specs: [{ ref: "train", script: "/opt/python", requirements: { gpu_type: "A30" } }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Task ref \"train\": requirements.gpu_type must be an array");
    expect(store.getAllTasks()).toHaveLength(0);
  });

  it("rejects interpreter paths used as DAG python environment selectors", async () => {
    const res = await request(makeApp()).post("/experiments").send({
      name: "invalid-python-env",
      task_specs: [{
        ref: "train",
        script: "/opt/python",
        python_env: "/vol/bitbucket/ys25/conda-envs/jema/bin/python",
      }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Task ref \"train\": python_env must be a registered environment name");
    expect(store.getAllTasks()).toHaveLength(0);
  });

  it("rejects malformed GPU requirements before materializing grid tasks", async () => {
    const res = await request(makeApp()).post("/grids").send({
      name: "invalid-grid-gpu-type",
      script: "/opt/python",
      param_space: { seed: [0, 1] },
      requirements: { gpu_type: "A30" },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("requirements.gpu_type must be an array");
    expect(store.getAllTasks()).toHaveLength(0);
    expect(store.getAllGrids()).toHaveLength(0);
  });

  it("rejects malformed GPU requirements before materializing legacy matrix tasks", async () => {
    const res = await request(makeApp()).post("/experiments").send({
      name: "invalid-legacy-matrix-gpu-type",
      script: "/opt/python",
      criteria: { score: "> 0" },
      matrix: { seed: [0, 1] },
      requirements: { gpu_type: "A30" },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("requirements.gpu_type must be an array");
    expect(store.getAllTasks()).toHaveLength(0);
    expect(store.getAllGrids()).toHaveLength(0);
    expect(store.getAllExperiments()).toHaveLength(0);
  });
});
