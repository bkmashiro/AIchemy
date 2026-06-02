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

  it("returns a composite research-bundle that aligns with /summary, /diff, /timeline", async () => {
    const app = makeApp();
    const created = await request(app)
      .post("/experiments")
      .send({
        name: "bundle-export",
        family: "pretrain",
        hypothesis: "curiosity helps",
        task_specs: [{ ref: "train", script: "train.py" }],
      })
      .expect(201);

    const expId = created.body.id;

    await request(app)
      .post(`/experiments/${expId}/events`)
      .send({ kind: "note", message: "first observation" })
      .expect(201);

    await request(app)
      .post(`/experiments/${expId}/events`)
      .send({
        kind: "checkpoint",
        message: "ckpt step 1000",
        data: { path: "/runs/abc/ckpt-1000.pt", artifact_type: "checkpoint", step: 1000 },
      })
      .expect(201);

    await request(app)
      .post(`/experiments/${expId}/events`)
      .send({
        kind: "artifact",
        message: "tb logs",
        data: { uri: "s3://bucket/tb", artifact_type: "tensorboard" },
      })
      .expect(201);

    await request(app)
      .patch(`/experiments/${expId}/decision`)
      .send({ decision: "keep", reason: "best zn so far" })
      .expect(200);

    const bundle = await request(app)
      .get(`/experiments/${expId}/research-bundle`)
      .expect(200);

    expect(bundle.body.experiment.id).toBe(expId);
    expect(bundle.body.experiment.status).toBeDefined();
    expect(bundle.body.experiment.tasks).toBeDefined();

    // Summary should align with /summary endpoint output.
    const summary = await request(app).get(`/experiments/${expId}/summary`).expect(200);
    expect(bundle.body.summary).toEqual(summary.body);

    // Diff should align with /diff endpoint output.
    const diff = await request(app).get(`/experiments/${expId}/diff`).expect(200);
    expect(bundle.body.diff).toEqual(diff.body);

    // Timeline events should match /timeline ordering (same helper).
    const timeline = await request(app).get(`/experiments/${expId}/timeline`).expect(200);
    expect(bundle.body.timeline).toEqual(timeline.body);

    // Decision block.
    expect(bundle.body.decision).toEqual({
      decision: "keep",
      reason: "best zn so far",
      decided_at: expect.any(String),
    });

    // Artifacts: only artifact/checkpoint kinds, preserving locator.
    const kinds = bundle.body.artifacts.map((e: any) => e.kind).sort();
    expect(kinds).toEqual(["artifact", "checkpoint"]);
    const ckpt = bundle.body.artifacts.find((e: any) => e.kind === "checkpoint");
    expect(ckpt.data.path).toBe("/runs/abc/ckpt-1000.pt");
    const tb = bundle.body.artifacts.find((e: any) => e.kind === "artifact");
    expect(tb.data.uri).toBe("s3://bucket/tb");

    // Manifest defaults to not_enabled when git_tracking is off.
    expect(bundle.body.manifest).toEqual({
      enabled: false,
      content: null,
      status: "not_enabled",
      error: null,
    });

    expect(typeof bundle.body.generated_at).toBe("string");
  });

  it("research-bundle returns 404 when the experiment is missing", async () => {
    const app = makeApp();
    await request(app).get("/experiments/ghost/research-bundle").expect(404);
  });

  it("research-bundle is read-only and does not append events", async () => {
    const app = makeApp();
    const created = await request(app)
      .post("/experiments")
      .send({ name: "bundle-readonly", task_specs: [{ ref: "t", script: "t.py" }] })
      .expect(201);

    const before = store.getExperimentEvents(created.body.id).length;
    await request(app).get(`/experiments/${created.body.id}/research-bundle`).expect(200);
    await request(app).get(`/experiments/${created.body.id}/research-bundle`).expect(200);
    const after = store.getExperimentEvents(created.body.id).length;
    expect(after).toBe(before);
  });

  it("research-report filters and counts by family/decision/status", async () => {
    const app = makeApp();

    const alpha1 = await request(app)
      .post("/experiments")
      .send({ name: "rep-alpha-1", family: "alpha", task_specs: [{ ref: "t", script: "t.py" }] })
      .expect(201);
    await request(app)
      .post("/experiments")
      .send({ name: "rep-alpha-2", family: "alpha", task_specs: [{ ref: "t", script: "t.py" }] })
      .expect(201);
    const beta1 = await request(app)
      .post("/experiments")
      .send({ name: "rep-beta-1", family: "beta", task_specs: [{ ref: "t", script: "t.py" }] })
      .expect(201);

    await request(app)
      .patch(`/experiments/${alpha1.body.id}/decision`)
      .send({ decision: "keep", reason: "best so far" })
      .expect(200);

    // family=alpha → 2 alpha experiments
    const famAlpha = await request(app).get("/experiments/research-report?family=alpha").expect(200);
    expect(famAlpha.body.filters).toEqual({ family: "alpha", decision: null, status: null, limit: 50 });
    expect(famAlpha.body.counts.total).toBe(2);
    expect(famAlpha.body.experiments.map((e: any) => e.name).sort()).toEqual(["rep-alpha-1", "rep-alpha-2"]);
    expect(famAlpha.body.counts.by_decision.keep).toBe(1);
    expect(famAlpha.body.counts.by_decision.none).toBe(1);
    expect(famAlpha.body.counts.by_status.running).toBe(2);

    // decision=none excludes the keep experiment
    const undecided = await request(app).get("/experiments/research-report?decision=none").expect(200);
    const undecidedNames = undecided.body.experiments.map((e: any) => e.name).sort();
    expect(undecidedNames).toEqual(["rep-alpha-2", "rep-beta-1"]);
    expect(undecided.body.counts.by_decision).toEqual({ none: 2 });

    // decision=keep selects only alpha1
    const decisionKeep = await request(app).get("/experiments/research-report?decision=keep").expect(200);
    expect(decisionKeep.body.experiments.map((e: any) => e.id)).toEqual([alpha1.body.id]);

    // invalid decision/status rejected
    await request(app).get("/experiments/research-report?decision=ship").expect(400);
    await request(app).get("/experiments/research-report?status=done").expect(400);

    // invalid limit rejected
    await request(app).get("/experiments/research-report?limit=0").expect(400);
    await request(app).get("/experiments/research-report?limit=").expect(400);
    await request(app).get("/experiments/research-report?limit=abc").expect(400);

    // limit caps at 200 and is clamped
    const capped = await request(app).get("/experiments/research-report?limit=999").expect(200);
    expect(capped.body.filters.limit).toBe(200);

    // limit caps returned experiment briefs, not rollup counts.
    for (const name of ["rep-gamma-1", "rep-gamma-2", "rep-gamma-3"]) {
      await request(app)
        .post("/experiments")
        .send({ name, family: "gamma", task_specs: [{ ref: "t", script: "t.py" }] })
        .expect(201);
    }
    const limitedGamma = await request(app).get("/experiments/research-report?family=gamma&limit=2").expect(200);
    expect(limitedGamma.body.counts.total).toBe(3);
    expect(limitedGamma.body.experiments).toHaveLength(2);

    // invalid repeated scalar params rejected rather than silently ignored.
    await request(app).get("/experiments/research-report?decision=ship&decision=keep").expect(400);
    await request(app).get("/experiments/research-report?status=done&status=running").expect(400);
    await request(app).get("/experiments/research-report?limit=abc&limit=10").expect(400);

    // beta filter shape
    const beta = await request(app).get("/experiments/research-report?family=beta").expect(200);
    expect(beta.body.experiments).toHaveLength(1);
    expect(beta.body.experiments[0].id).toBe(beta1.body.id);
    expect(beta.body.experiments[0]).toEqual(
      expect.objectContaining({
        id: beta1.body.id,
        name: "rep-beta-1",
        family: "beta",
        decision: null,
        parent_id: null,
        children: [],
        artifact_count: 0,
        checkpoint_count: 0,
        recent_events: expect.any(Array),
        task_counts: expect.any(Object),
        primary_metric: null,
      }),
    );
  });

  it("research-report leaderboard orders by goal_direction (min/max)", async () => {
    const app = makeApp();
    // Seed three experiments and drive each through a "completed" task with a
    // numeric result. Direct store mutation mirrors the pattern used for the
    // status=failed test above — POST /experiments does not accept goal_metric.
    const names = ["rep-rank-a", "rep-rank-b", "rep-rank-c"];
    const created: any[] = [];
    for (const name of names) {
      const res = await request(app)
        .post("/experiments")
        .send({ name, family: "rankfam", criteria: { loss: "< 0.5" }, task_specs: [{ ref: "t", script: "t.py" }] })
        .expect(201);
      created.push(res.body);
    }

    const lossValues: Record<string, number> = {
      "rep-rank-a": 0.42,
      "rep-rank-b": 0.10,
      "rep-rank-c": 0.31,
    };
    for (const c of created) {
      const exp = store.getExperiment(c.id)!;
      exp.goal_metric = "loss";
      exp.goal_direction = "min";
      const tasks = store.getGridTasks(exp.grid_id);
      const archived: any[] = [];
      for (const task of tasks) {
        const removed = store.removeFromGlobalQueue(task.id);
        expect(removed).toBeDefined();
        archived.push({ ...removed!, status: "completed" as const, finished_at: new Date().toISOString() });
        exp.results[task.id] = {
          passed: lossValues[exp.name] < 0.5,
          checked_at: new Date().toISOString(),
          details: { loss: { value: lossValues[exp.name], threshold: "< 0.5", ok: lossValues[exp.name] < 0.5 } },
        };
      }
      store.setArchive([...store.getArchive(), ...archived]);
      store.setExperiment(exp);
    }

    const minReport = await request(app).get("/experiments/research-report?family=rankfam").expect(200);
    expect(minReport.body.metric).toEqual({ name: "loss", direction: "min" });
    expect(minReport.body.leaderboard.map((r: any) => [r.name, r.rank])).toEqual([
      ["rep-rank-b", 1],
      ["rep-rank-c", 2],
      ["rep-rank-a", 3],
    ]);
    for (const row of minReport.body.leaderboard) {
      expect(row.metric).toBe("loss");
      expect(typeof row.value).toBe("number");
    }

    // Flip every experiment to direction=max — leaderboard order should reverse.
    for (const c of created) {
      const exp = store.getExperiment(c.id)!;
      exp.goal_direction = "max";
      store.setExperiment(exp);
    }
    const maxReport = await request(app).get("/experiments/research-report?family=rankfam").expect(200);
    expect(maxReport.body.metric).toEqual({ name: "loss", direction: "max" });
    expect(maxReport.body.leaderboard.map((r: any) => r.name)).toEqual(["rep-rank-a", "rep-rank-c", "rep-rank-b"]);
  });

  it("research-report leaderboard empty when no experiment declares a goal metric", async () => {
    const app = makeApp();
    await request(app)
      .post("/experiments")
      .send({ name: "rep-nogoal", family: "ng", task_specs: [{ ref: "t", script: "t.py" }] })
      .expect(201);
    const report = await request(app).get("/experiments/research-report?family=ng").expect(200);
    expect(report.body.metric).toBeNull();
    expect(report.body.leaderboard).toEqual([]);
  });

  it("research-report is read-only: no events appended, no manifest call", async () => {
    const { readExperimentManifest } = await import("../git-tracking");
    const app = makeApp();
    const created = await request(app)
      .post("/experiments")
      .send({
        name: "rep-readonly",
        family: "ro",
        task_specs: [{ ref: "t", script: "t.py" }],
        git_tracking: true,
        git_repo_path: "/tmp/repo",
      })
      .expect(201);

    const before = store.getExperimentEvents(created.body.id).length;
    await request(app).get("/experiments/research-report?family=ro").expect(200);
    await request(app).get("/experiments/research-report?family=ro").expect(200);
    const after = store.getExperimentEvents(created.body.id).length;
    expect(after).toBe(before);
    expect(vi.mocked(readExperimentManifest)).not.toHaveBeenCalled();
  });

  it("research-report route is registered before /:id and not captured by it", async () => {
    const app = makeApp();
    // No experiment with id "research-report" exists, so if /:id captured this
    // path the response would be a 404 from the detail handler. The endpoint
    // must instead serve the report shape with empty experiments.
    const res = await request(app).get("/experiments/research-report").expect(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        filters: { family: null, decision: null, status: null, limit: 50 },
        counts: { total: 0, by_status: {}, by_decision: {} },
        leaderboard: [],
        experiments: [],
      }),
    );
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
