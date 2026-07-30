import { beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createRefsRouter } from "../api/refs";
import { createExperimentsRouter } from "../api/experiments";
import { store } from "../store";
import type { Experiment, Task } from "../types";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use("/refs", createRefsRouter());
  return instance;
}

beforeEach(() => store.reset());

describe("GET /refs/:ref", () => {
  it("resolves an experiment alias to canonical metadata", async () => {
    const experiment: Experiment = {
      id: "76f65100-0473-49e0-aadd-63ef19695323",
      name: "mnemonic trial",
      criteria: {},
      grid_id: "grid-alias",
      status: "running",
      results: {},
      created_at: "2026-07-30T00:00:00.000Z",
    };
    store.setExperiment(experiment);

    const response = await request(app()).get(`/refs/${experiment.alias}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: experiment.id,
      alias: experiment.alias,
      kind: "experiment",
      name: experiment.name,
    });
  });

  it("can constrain resolution by kind", async () => {
    const task: Task = {
      id: "8730382b-bd75-4124-a3d0-a792a05c4acd",
      seq: store.nextSeq(),
      fingerprint: "fp-ref-task",
      display_name: "ref task",
      script: "run.py",
      command: "python run.py",
      status: "pending",
      priority: 0,
      created_at: "2026-07-30T00:00:00.000Z",
      log_buffer: [],
      retry_count: 0,
      max_retries: 0,
      should_stop: false,
      should_checkpoint: false,
    };
    store.addToGlobalQueue(task);

    expect((await request(app()).get(`/refs/${task.alias}?kind=task`)).status).toBe(200);
    expect((await request(app()).get(`/refs/${task.alias}?kind=experiment`)).status).toBe(404);
  });

  it("rejects unsupported kinds", async () => {
    const response = await request(app()).get("/refs/anything?kind=stub");
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("kind");
  });
});

describe("GET /experiments/resolve", () => {
  function experimentApp() {
    const instance = express();
    instance.use(express.json());
    instance.use("/experiments", createExperimentsRouter({} as any, {} as any));
    return instance;
  }

  it("resolves a mnemonic alias without loading the experiment collection", async () => {
    const experiment: Experiment = {
      id: "6dc437aa-c637-40bc-91e6-9710dbc75b43",
      name: "direct-resolver",
      grid_id: "grid-resolve",
      created_at: "2026-07-30T00:00:00.000Z",
      criteria: {},
      results: {},
      status: "running",
    };
    store.setExperiment(experiment);

    const response = await request(experimentApp()).get(`/experiments/resolve?ref=${experiment.alias}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: experiment.id, alias: experiment.alias, name: experiment.name });
  });

  it("rejects ambiguous human names", async () => {
    for (const id of ["4e78f087-9901-4469-bf01-46d5cebbf4ba", "5c796112-cbd9-4adf-93d8-a6fd997bba49"]) {
      store.setExperiment({ id, name: "duplicate", grid_id: `grid-${id}`, created_at: id, criteria: {}, results: {}, status: "running" });
    }

    const response = await request(experimentApp()).get("/experiments/resolve?ref=duplicate");

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("ambiguous experiment ref");
  });
});
