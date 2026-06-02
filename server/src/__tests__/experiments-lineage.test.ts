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

function makeApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/experiments", createExperimentsRouter({} as any, { emit: vi.fn() } as any));
  return app;
}

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
});

describe("experiment lineage API", () => {
  it("stores intent fields and creates an initial timeline event", async () => {
    const app = makeApp();

    const res = await request(app)
      .post("/experiments")
      .send({
        name: "lineage-intent",
        hypothesis: "curiosity improves zn",
        expected_outcome: "zn up, loss stable",
        family: "pretrain_nh",
        task_specs: [{ ref: "train", script: "train.py" }],
      })
      .expect(201);

    expect(res.body.hypothesis).toBe("curiosity improves zn");
    expect(res.body.expected_outcome).toBe("zn up, loss stable");
    expect(res.body.family).toBe("pretrain_nh");

    const timeline = await request(app).get(`/experiments/${res.body.id}/timeline`).expect(200);
    expect(timeline.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "created", message: "Created experiment", actor: "operator" }),
      ]),
    );
  });

  it("appends note events without trusting request actor", async () => {
    const app = makeApp();
    const created = await request(app)
      .post("/experiments")
      .send({ name: "lineage-note", task_specs: [{ ref: "train", script: "train.py" }] })
      .expect(201);

    const note = await request(app)
      .post(`/experiments/${created.body.id}/events`)
      .send({ kind: "note", message: "A30 OOM; resumed on T4", actor: "mallory", data: { stub: "t4" } })
      .expect(201);

    expect(note.body.actor).toBe("operator");
    expect(note.body.message).toBe("A30 OOM; resumed on T4");

    const timeline = await request(app).get(`/experiments/${created.body.id}/timeline`).expect(200);
    expect(timeline.body.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "note", actor: "operator" })]),
    );
  });

  it("sets decisions, records decision events, and rejects bad payloads", async () => {
    const app = makeApp();
    const created = await request(app)
      .post("/experiments")
      .send({ name: "lineage-decision", task_specs: [{ ref: "train", script: "train.py" }] })
      .expect(201);

    await request(app)
      .patch(`/experiments/${created.body.id}/decision`)
      .send({ decision: "ship", reason: "bad enum" })
      .expect(400);

    const decided = await request(app)
      .patch(`/experiments/${created.body.id}/decision`)
      .send({ decision: "keep", reason: "best zn so far" })
      .expect(200);

    expect(decided.body.decision).toBe("keep");
    expect(decided.body.decision_reason).toBe("best zn so far");
    expect(decided.body.decision_at).toBeTruthy();

    await request(app)
      .post(`/experiments/${created.body.id}/events`)
      .send({ kind: "note", message: "x", data: "not-object" })
      .expect(400);

    const timeline = await request(app).get(`/experiments/${created.body.id}/timeline`).expect(200);
    expect(timeline.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "decision", message: "Marked keep: best zn so far" }),
      ]),
    );
  });

  it("accepts artifact/checkpoint events with a path and rejects empty locators", async () => {
    const app = makeApp();
    const created = await request(app)
      .post("/experiments")
      .send({ name: "lineage-artifact", task_specs: [{ ref: "train", script: "train.py" }] })
      .expect(201);

    // Reject without path/uri.
    await request(app)
      .post(`/experiments/${created.body.id}/events`)
      .send({ kind: "checkpoint", message: "ckpt 100", data: { step: 100 } })
      .expect(400);

    // Reject with empty string path.
    await request(app)
      .post(`/experiments/${created.body.id}/events`)
      .send({ kind: "artifact", message: "x", data: { path: "  " } })
      .expect(400);

    // Reject invalid artifact_type.
    await request(app)
      .post(`/experiments/${created.body.id}/events`)
      .send({ kind: "artifact", message: "x", data: { path: "/p", artifact_type: "spaceship" } })
      .expect(400);

    const ok = await request(app)
      .post(`/experiments/${created.body.id}/events`)
      .send({
        kind: "checkpoint",
        message: "ckpt step 1000",
        data: { path: "/runs/abc/ckpt-1000.pt", artifact_type: "checkpoint", step: 1000, name: "best" },
        actor: "mallory",
      })
      .expect(201);

    expect(ok.body.actor).toBe("operator");
    expect(ok.body.data.path).toBe("/runs/abc/ckpt-1000.pt");
    expect(ok.body.data.step).toBe(1000);

    const tb = await request(app)
      .post(`/experiments/${created.body.id}/events`)
      .send({
        kind: "artifact",
        message: "tb",
        data: { uri: "s3://bucket/tb", artifact_type: "tensorboard" },
      })
      .expect(201);
    expect(tb.body.data.uri).toBe("s3://bucket/tb");

    const fallbackUri = await request(app)
      .post(`/experiments/${created.body.id}/events`)
      .send({
        kind: "artifact",
        message: "tb fallback",
        data: { path: "  ", uri: "s3://bucket/tb-fallback", artifact_type: "tensorboard" },
      })
      .expect(201);
    expect(fallbackUri.body.data.uri).toBe("s3://bucket/tb-fallback");
  });

  it("filters list by family, decision, and status", async () => {
    const app = makeApp();
    await request(app)
      .post("/experiments")
      .send({ name: "fam-a-1", family: "alpha", task_specs: [{ ref: "t", script: "t.py" }] })
      .expect(201);
    const beta = await request(app)
      .post("/experiments")
      .send({ name: "fam-b-1", family: "beta", task_specs: [{ ref: "t", script: "t.py" }] })
      .expect(201);
    await request(app)
      .patch(`/experiments/${beta.body.id}/decision`)
      .send({ decision: "keep", reason: "looks good" })
      .expect(200);

    const familyAlpha = await request(app).get("/experiments?family=alpha").expect(200);
    expect(familyAlpha.body.map((e: any) => e.name)).toEqual(["fam-a-1"]);

    const decisionKeep = await request(app).get("/experiments?decision=keep").expect(200);
    expect(decisionKeep.body.map((e: any) => e.name)).toEqual(["fam-b-1"]);

    const undecided = await request(app).get("/experiments?decision=none").expect(200);
    expect(undecided.body.map((e: any) => e.name)).toContain("fam-a-1");
    expect(undecided.body.map((e: any) => e.name)).not.toContain("fam-b-1");
  });

  it("filters list by status=running for freshly-created experiments", async () => {
    const app = makeApp();
    // Newly-created experiments derive to "running" because their tasks are
    // still pending. Use that as the public-API path to exercise status filter.
    await request(app)
      .post("/experiments")
      .send({ name: "status-r-1", task_specs: [{ ref: "t", script: "t.py" }] })
      .expect(201);
    await request(app)
      .post("/experiments")
      .send({ name: "status-r-2", task_specs: [{ ref: "t", script: "t.py" }] })
      .expect(201);

    const running = await request(app).get("/experiments?status=running").expect(200);
    const names = running.body.map((e: any) => e.name).sort();
    expect(names).toEqual(["status-r-1", "status-r-2"]);
    for (const exp of running.body) {
      expect(exp.status).toBe("running");
    }

    // A non-existent rollup status returns an empty list rather than 4xx — the
    // server treats status as a passthrough string filter.
    const passed = await request(app).get("/experiments?status=passed").expect(200);
    expect(passed.body).toEqual([]);
  });

  it("filters list by terminal status using store-level setup", async () => {
    const app = makeApp();
    // Drive an experiment to a terminal status without depending on the task
    // runner: seed the store directly with a grid + completed task + matching
    // results, then assert the HTTP filter surfaces it.
    const created = await request(app)
      .post("/experiments")
      .send({
        name: "status-failed-1",
        criteria: { loss: "< 0.5" },
        task_specs: [{ ref: "t", script: "t.py" }],
      })
      .expect(201);
    const exp = store.getExperiment(created.body.id)!;
    const tasks = store.getGridTasks(exp.grid_id);
    expect(tasks.length).toBeGreaterThan(0);
    const archivedTasks = [];
    for (const task of tasks) {
      const removed = store.removeFromGlobalQueue(task.id);
      expect(removed).toBeDefined();
      const completed = {
        ...removed!,
        status: "completed" as const,
        finished_at: new Date().toISOString(),
      };
      archivedTasks.push(completed);
      exp.results[task.id] = {
        passed: false,
        checked_at: new Date().toISOString(),
        details: { loss: { value: 0.9, threshold: "< 0.5", ok: false } },
      };
    }
    store.setArchive([...store.getArchive(), ...archivedTasks]);
    store.setExperiment(exp);

    // Sanity: the unfiltered list should now report this experiment as failed.
    const all = await request(app).get("/experiments").expect(200);
    const seenExp = all.body.find((e: any) => e.id === exp.id);
    expect(seenExp?.status).toBe("failed");

    const failed = await request(app).get("/experiments?status=failed").expect(200);
    expect(failed.body.map((e: any) => e.id)).toContain(exp.id);
    const running = await request(app).get("/experiments?status=running").expect(200);
    expect(running.body.map((e: any) => e.id)).not.toContain(exp.id);
  });

  it("accepts artifact with valid uri when path is the empty string", async () => {
    const app = makeApp();
    const created = await request(app)
      .post("/experiments")
      .send({ name: "lineage-locator", task_specs: [{ ref: "train", script: "train.py" }] })
      .expect(201);

    // path: "" + uri set → accepted (uri carries the locator).
    const uriOnly = await request(app)
      .post(`/experiments/${created.body.id}/events`)
      .send({
        kind: "artifact",
        message: "tb",
        data: { path: "", uri: "s3://bucket/tb", artifact_type: "tensorboard" },
      })
      .expect(201);
    expect(uriOnly.body.data.uri).toBe("s3://bucket/tb");

    // path set + uri: "" → accepted (path carries the locator).
    const pathOnly = await request(app)
      .post(`/experiments/${created.body.id}/events`)
      .send({
        kind: "artifact",
        message: "log",
        data: { path: "/runs/abc/train.log", uri: "", artifact_type: "log" },
      })
      .expect(201);
    expect(pathOnly.body.data.path).toBe("/runs/abc/train.log");

    // Both blank → rejected.
    await request(app)
      .post(`/experiments/${created.body.id}/events`)
      .send({ kind: "checkpoint", message: "no locator", data: { path: "", uri: "  " } })
      .expect(400);
  });

  it("preserves events when experiment record is deleted", async () => {
    const app = makeApp();
    const created = await request(app)
      .post("/experiments")
      .send({ name: "lineage-delete", task_specs: [{ ref: "train", script: "train.py" }] })
      .expect(201);

    await request(app)
      .post(`/experiments/${created.body.id}/events`)
      .send({ kind: "note", message: "keep audit history" })
      .expect(201);

    await request(app).delete(`/experiments/${created.body.id}`).expect(200);

    expect(store.getExperiment(created.body.id)).toBeUndefined();
    expect(store.getExperimentEvents(created.body.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "note", message: "keep audit history" })]),
    );
  });
});
