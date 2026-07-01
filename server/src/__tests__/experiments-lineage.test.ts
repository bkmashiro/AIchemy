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
import { createTask } from "../api/tasks";
import { createExperimentsRouter } from "../api/experiments";

function makeApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/experiments", createExperimentsRouter({} as any, { emit: vi.fn() } as any));
  return app;
}

function completeExperiment(expId: string, metric: string, value: number, opts: { threshold?: string; passed?: boolean } = {}) {
  const exp = store.getExperiment(expId);
  expect(exp).toBeDefined();
  if (!exp) return;
  const tasks = store.getGridTasks(exp.grid_id);
  const archived: any[] = [];
  const checkedAt = new Date().toISOString();
  for (const task of tasks) {
    const removed = store.removeFromGlobalQueue(task.id);
    expect(removed).toBeDefined();
    archived.push({
      ...removed!,
      status: "completed" as const,
      finished_at: checkedAt,
    });
    exp.results[task.id] = {
      passed: opts.passed ?? true,
      checked_at: checkedAt,
      details: {
        [metric]: {
          value,
          threshold: opts.threshold ?? "< 1.0",
          ok: opts.passed ?? true,
        },
      },
    };
  }
  store.setArchive([...store.getArchive(), ...archived]);
  store.setExperiment(exp);
}

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
});

describe("experiment lineage API", () => {
  it("aggregates an experiment series into useful result rows and best metrics", async () => {
    const app = makeApp();
    const first = await request(app)
      .post("/experiments")
      .send({
        name: "series-a",
        family: "world-rule",
        param_points: [{ seed: 1, variant: "base" }],
        task_specs: [{ ref: "eval", script: "eval.py", metric_schema: { score: "max", loss: "min" }, result_schema: { score: "number", loss: "number" } }],
      })
      .expect(201);
    const second = await request(app)
      .post("/experiments")
      .send({
        name: "series-b",
        family: "world-rule",
        param_points: [{ seed: 2, variant: "ablate" }],
        task_specs: [{ ref: "eval", script: "eval.py", metric_schema: { score: "max", loss: "min" }, result_schema: { score: "number", loss: "number" } }],
      })
      .expect(201);

    const firstTask = store.findTask(first.body.task_refs.eval)!;
    const secondTask = store.findTask(second.body.task_refs.eval)!;
    store.updateGlobalQueueTask(firstTask.task.id, {
      exports: { result_path: "/runs/a/results.json", result: { score: 0.7, loss: 0.4 }, result_schema: { score: "number", loss: "number" } },
    });
    store.updateGlobalQueueTask(secondTask.task.id, {
      exports: { result_path: "/runs/b/results.json", result: { score: 0.9, loss: 0.6 }, result_schema: { score: "number", loss: "number" } },
    });

    const res = await request(app).get("/experiments/series/world-rule/summary").expect(200);

    expect(res.body.series).toBe("world-rule");
    expect(res.body.counts).toEqual({ experiments: 2, result_rows: 2 });
    expect(res.body.schema).toEqual({ metrics: { score: "max", loss: "min" }, results: { score: "number", loss: "number" } });
    expect(res.body.best_metrics).toEqual({
      score: { value: 0.9, direction: "max", experiment_id: second.body.id, experiment_name: "series-b", task_ref: "eval" },
      loss: { value: 0.4, direction: "min", experiment_id: first.body.id, experiment_name: "series-a", task_ref: "eval" },
    });
    expect(res.body.rows).toEqual([
      expect.objectContaining({ experiment_id: first.body.id, experiment_name: "series-a", task_ref: "eval", params: { seed: 1, variant: "base" }, result: { score: 0.7, loss: 0.4 }, result_path: "/runs/a/results.json" }),
      expect.objectContaining({ experiment_id: second.body.id, experiment_name: "series-b", task_ref: "eval", params: { seed: 2, variant: "ablate" }, result: { score: 0.9, loss: 0.6 }, result_path: "/runs/b/results.json" }),
    ]);
  });

  it("appends series-scoped decisions and comments to family members", async () => {
    const app = makeApp();
    const one = await request(app)
      .post("/experiments")
      .send({ name: "series-decision-a", family: "series-decide", task_specs: [{ ref: "train", script: "train.py" }] })
      .expect(201);
    const two = await request(app)
      .post("/experiments")
      .send({ name: "series-decision-b", family: "series-decide", task_specs: [{ ref: "train", script: "train.py" }] })
      .expect(201);

    const decision = await request(app)
      .post("/experiments/series/series-decide/events")
      .send({ kind: "decision", decision: "try-more", reason: "need seeds 1234/4242/7777" })
      .expect(201);

    expect(decision.body.created).toBe(2);
    expect(decision.body.events).toHaveLength(2);
    expect(decision.body.events[0].data).toEqual(expect.objectContaining({ scope: "series", family: "series-decide", decision: "try_more" }));

    await request(app)
      .post("/experiments/series/series-decide/events")
      .send({ kind: "note", message: "random500 improved Pong but not Freeway" })
      .expect(201);

    const firstTimeline = await request(app).get(`/experiments/${one.body.id}/timeline`).expect(200);
    const secondTimeline = await request(app).get(`/experiments/${two.body.id}/timeline`).expect(200);
    for (const timeline of [firstTimeline, secondTimeline]) {
      expect(timeline.body.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "decision", message: "Series decision try_more: need seeds 1234/4242/7777" }),
        expect.objectContaining({ kind: "note", message: "random500 improved Pong but not Freeway" }),
      ]));
    }
    const summary = await request(app).get("/experiments/series/series-decide/summary").expect(200);
    expect(summary.body.latest_series_events).toEqual([
      expect.objectContaining({ kind: "note", message: "random500 improved Pong but not Freeway" }),
      expect.objectContaining({ kind: "decision", message: "Series decision try_more: need seeds 1234/4242/7777" }),
    ]);
  });

  it("roundtrips SDK-authored spec fields through create, list, detail, and store reload", async () => {
    const app = makeApp();
    const sdkSpec = {
      code_id: "jema.sdk.spec.roundtrip.v1",
      name: "sdk-spec-roundtrip",
      storage: { root: "/tmp/alchemy-runs", artifact_root: "/tmp/alchemy-artifacts" },
      param_space: { seed: [1, 2] },
      param_points: [{ seed: 1 }, { seed: 2 }],
      tasks: [
        {
          ref: "train-1",
          ref_template: "train-{seed}",
          param_point: { seed: 1 },
          script: "train.py",
          metric_schema: { loss: "min" },
          result_schema: { score: "number" },
        },
      ],
    };

    const created = await request(app)
      .post("/experiments")
      .send({
        name: "sdk-spec-roundtrip",
        code_id: sdkSpec.code_id,
        storage: sdkSpec.storage,
        sdk_spec: sdkSpec,
        param_space: sdkSpec.param_space,
        param_points: sdkSpec.param_points,
        task_specs: sdkSpec.tasks,
      })
      .expect(201);

    expect(created.body.code_id).toBe(sdkSpec.code_id);
    expect(created.body.storage).toEqual(sdkSpec.storage);
    expect(created.body.sdk_spec).toEqual(sdkSpec);
    expect(created.body.param_space).toEqual(sdkSpec.param_space);
    expect(created.body.param_points).toEqual(sdkSpec.param_points);
    expect(created.body.task_specs[0]).toMatchObject({
      ref_template: "train-{seed}",
      param_point: { seed: 1 },
      metric_schema: { loss: "min" },
      result_schema: { score: "number" },
    });

    const listed = await request(app).get("/experiments").expect(200);
    expect(listed.body[0].sdk_spec).toEqual(sdkSpec);

    const detail = await request(app).get(`/experiments/${created.body.id}`).expect(200);
    expect(detail.body.storage).toEqual(sdkSpec.storage);
    expect(detail.body.sdk_spec).toEqual(sdkSpec);

    const exported = store.exportState();
    store.reset();
    store.loadFromState(exported);
    const reloaded = await request(app).get(`/experiments/${created.body.id}`).expect(200);
    expect(reloaded.body.sdk_spec).toEqual(sdkSpec);
    expect(reloaded.body.storage).toEqual(sdkSpec.storage);
    expect(reloaded.body.code_id).toBe(sdkSpec.code_id);
  });

  it("rejects duplicate code_id aliases for new SDK-first experiments", async () => {
    const app = makeApp();
    await request(app)
      .post("/experiments")
      .send({
        name: "first",
        code_id: "jema.duplicate.v1",
        task_specs: [{ ref: "train", script: "train.py" }],
      })
      .expect(201);

    const duplicate = await request(app)
      .post("/experiments")
      .send({
        name: "second",
        code_id: "jema.duplicate.v1",
        task_specs: [{ ref: "train", script: "train.py" }],
      })
      .expect(409);

    expect(duplicate.body.error).toContain("code_id already exists");
  });

  it("fetches experiment detail by code_id alias", async () => {
    const app = makeApp();
    const created = await request(app)
      .post("/experiments")
      .send({
        name: "code-id-detail",
        code_id: "jema.lookup.v1",
        task_specs: [{ ref: "train", script: "train.py" }],
      })
      .expect(201);

    const detail = await request(app).get("/experiments/by-code/jema.lookup.v1").expect(200);

    expect(detail.body.id).toBe(created.body.id);
    expect(detail.body.code_id).toBe("jema.lookup.v1");
  });

  it("summarizes SDK result artifacts and best declared result metrics by task ref", async () => {
    const app = makeApp();
    const created = await request(app)
      .post("/experiments")
      .send({
        name: "sdk-result-summary",
        task_specs: [
          { ref: "train-a", script: "train.py", metric_schema: { loss: "min", score: "max" }, result_schema: { loss: "number", score: "number" } },
          { ref: "train-b", script: "train.py", metric_schema: { loss: "min", score: "max" }, result_schema: { loss: "number", score: "number" } },
        ],
      })
      .expect(201);

    const refs = created.body.task_refs;
    const first = store.findTask(refs["train-a"]);
    const second = store.findTask(refs["train-b"]);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    store.updateGlobalQueueTask(first!.task.id, {
      exports: { result_path: "/runs/a/results.json", result: { loss: 0.4, score: 0.7 }, result_schema: { loss: "number", score: "number" } },
    });
    store.updateGlobalQueueTask(second!.task.id, {
      exports: { result_path: "/runs/b/results.json", result: { loss: 0.2, score: 0.6 }, result_schema: { loss: "number", score: "number" } },
    });

    const summary = await request(app).get(`/experiments/${created.body.id}/summary`).expect(200);
    expect(summary.body.result_artifacts).toEqual([
      {
        task_id: first!.task.id,
        ref: "train-a",
        path: "/runs/a/results.json",
        result: { loss: 0.4, score: 0.7 },
        schema: { loss: "number", score: "number" },
      },
      {
        task_id: second!.task.id,
        ref: "train-b",
        path: "/runs/b/results.json",
        result: { loss: 0.2, score: 0.6 },
        schema: { loss: "number", score: "number" },
      },
    ]);
    expect(summary.body.best_result_metrics).toEqual({
      loss: { value: 0.2, direction: "min", task_id: second!.task.id, ref: "train-b" },
      score: { value: 0.7, direction: "max", task_id: first!.task.id, ref: "train-a" },
    });
  });

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

  it("deduplicates code-ledger event source IDs server-side", async () => {
    const app = makeApp();
    const created = await request(app)
      .post("/experiments")
      .send({ name: "ledger-event", task_specs: [{ ref: "train", script: "train.py" }] })
      .expect(201);

    const body = {
      kind: "decision",
      message: "keep: best",
      data: { source: "code-ledger", source_id: "keep-baseline", content_hash: "h1", decision: "keep" },
    };
    const first = await request(app).post(`/experiments/${created.body.id}/events`).send(body).expect(201);
    const second = await request(app).post(`/experiments/${created.body.id}/events`).send(body).expect(200);

    expect(second.body.id).toBe(first.body.id);
    await request(app)
      .post(`/experiments/${created.body.id}/events`)
      .send({ ...body, message: "keep: tampered", data: { ...body.data, content_hash: "h2" } })
      .expect(409);
    const timeline = await request(app).get(`/experiments/${created.body.id}/timeline`).expect(200);
    expect(timeline.body.events.filter((event: any) => event.data?.source_id === "keep-baseline")).toHaveLength(1);
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
      .send({ decision: "try-more", reason: "seed variance high" })
      .expect(200);

    expect(decided.body.decision).toBe("try_more");
    expect(decided.body.decision_reason).toBe("seed variance high");
    expect(decided.body.decision_at).toBeTruthy();

    const discarded = await request(app)
      .patch(`/experiments/${created.body.id}/decision`)
      .send({ decision: "drop", reason: "legacy drop alias" })
      .expect(200);
    expect(discarded.body.decision).toBe("discard");

    await request(app)
      .post(`/experiments/${created.body.id}/events`)
      .send({ kind: "note", message: "x", data: "not-object" })
      .expect(400);

    const timeline = await request(app).get(`/experiments/${created.body.id}/timeline`).expect(200);
    expect(timeline.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "decision", message: "Marked try_more: seed variance high" }),
        expect.objectContaining({ kind: "decision", message: "Marked discard: legacy drop alias" }),
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
    const alpha2 = await request(app)
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
    for (const block of famAlpha.body.experiments) {
      expect(block).toEqual(
        expect.objectContaining({
          recommendation: expect.any(Object),
          diff_summary: expect.objectContaining({ config_change_count: expect.any(Number) }),
        }),
      );
    }
    expect(famAlpha.body.experiments.map((e: any) => e.id).sort()).toEqual(
      [alpha1.body.id, alpha2.body.id].sort(),
    );

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
        recommendation: expect.any(Object),
        diff_summary: expect.objectContaining({ config_change_count: 0, config_changed: false }),
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

  it("adopts a running task without changing runtime fields", async () => {
    const app = makeApp();
    const task = createTask({ script: "/tmp/train.py", name: "running-adopt", priority: 7 });
    store.addToGlobalQueue(task);
    store.setStub({
      id: "stub-a", name: "stub-a", hostname: "host-a",
      gpu: { name: "A30", vram_total_mb: 24576, count: 1 },
      status: "online", type: "slurm",
      connected_at: "2026-01-01T00:00:00.000Z", last_heartbeat: "2026-01-01T00:00:00.000Z",
      max_concurrent: 1, tasks: [],
    });
    store.moveToStubQueue(task.id, "stub-a");
    const running = store.updateTask("stub-a", task.id, {
      status: "running",
      pid: 1234,
      started_at: "2026-01-01T00:01:00.000Z",
      run_dir: "/runs/abc",
    });
    expect(running).toBeTruthy();

    const adopted = await request(app)
      .post("/experiments/adopt")
      .send({
        name: "retro-run",
        task_ids: [task.id],
        family: "retro",
        goal_metric: "loss",
        goal_direction: "min",
        criteria: { loss: "< 1" },
      })
      .expect(201);

    const after = store.findTask(task.id)?.task;
    expect(after).toEqual(expect.objectContaining({
      status: "running",
      pid: 1234,
      stub_id: "stub-a",
      run_dir: "/runs/abc",
      experiment_id: adopted.body.id,
      grid_id: adopted.body.grid.id,
      ref: "task-1",
    }));
    expect(store.getGrid(adopted.body.grid.id)?.task_ids).toEqual([task.id]);
    expect(store.getExperimentEvents(adopted.body.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "note", message: "Adopted 1 existing task" })]),
    );
  });

  it("attaches and moves tasks between experiment grids safely", async () => {
    const app = makeApp();
    const task = createTask({ script: "/tmp/train.py", name: "attach-me" });
    store.addToGlobalQueue(task);

    const first = await request(app)
      .post("/experiments/adopt")
      .send({ name: "first-retro", task_ids: [task.id] })
      .expect(201);
    const second = await request(app)
      .post("/experiments")
      .send({ name: "second-retro", task_specs: [{ ref: "seed", script: "/tmp/seed.py" }] })
      .expect(201);

    await request(app)
      .post(`/experiments/${second.body.id}/tasks/adopt`)
      .send({ task_ids: [task.id] })
      .expect(409);

    await request(app)
      .post(`/experiments/${second.body.id}/tasks/adopt`)
      .send({ task_ids: [task.id], mode: "move" })
      .expect(200);

    expect(store.findTask(task.id)?.task.experiment_id).toBe(second.body.id);
    expect(store.getGrid(first.body.grid.id)?.task_ids).toEqual([]);
    expect(Object.values(store.getExperiment(first.body.id)?.task_refs || {})).not.toContain(task.id);
    expect(store.getExperiment(first.body.id)?.status).toBe("running");
    expect(store.getGrid(second.body.grid_id)?.task_ids).toContain(task.id);
  });

  it("rejects attach for grid-owned tasks unless move is explicit", async () => {
    const app = makeApp();
    const task = createTask({ script: "/tmp/train.py", name: "grid-owned" });
    store.addToGlobalQueue(task);
    store.setGrid({
      id: "old-grid-only",
      name: "old-grid-only",
      display_name: "old grid only",
      script: task.script,
      param_space: {},
      task_ids: [task.id],
      status: "running",
      created_at: "2026-01-01T00:00:00.000Z",
      max_retries: 0,
    });
    store.updateGlobalQueueTask(task.id, { grid_id: "old-grid-only" });
    const target = await request(app)
      .post("/experiments")
      .send({ name: "grid-owner-target", task_specs: [{ ref: "seed", script: "/tmp/seed.py" }] })
      .expect(201);

    await request(app)
      .post(`/experiments/${target.body.id}/tasks/adopt`)
      .send({ task_ids: [task.id] })
      .expect(409);
  });

  it("patches experiment research metadata only", async () => {
    const app = makeApp();
    const created = await request(app)
      .post("/experiments")
      .send({ name: "patch-me", task_specs: [{ ref: "train", script: "/tmp/train.py" }] })
      .expect(201);

    await request(app)
      .patch(`/experiments/${created.body.id}`)
      .send({ goal_direction: "sideways" })
      .expect(400);

    const patched = await request(app)
      .patch(`/experiments/${created.body.id}`)
      .send({ family: "nh", goal_metric: "score", goal_direction: "max", config: { seed: 42 }, unknown: "ignored" })
      .expect(200);

    expect(patched.body).toEqual(expect.objectContaining({
      family: "nh",
      goal_metric: "score",
      goal_direction: "max",
      config: { seed: 42 },
    }));
    expect((patched.body as any).unknown).toBeUndefined();
    expect(store.getExperimentEvents(created.body.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "note", message: expect.stringContaining("Updated experiment metadata") })]),
    );
  });

  it("makes adopt idempotent by name and task set, and rejects owned tasks for new names", async () => {
    const app = makeApp();
    const task = createTask({ script: "/tmp/train.py", name: "idempotent-adopt" });
    store.addToGlobalQueue(task);

    const first = await request(app)
      .post("/experiments/adopt")
      .send({ name: "same-retro", task_ids: [task.id] })
      .expect(201);

    const retry = await request(app)
      .post("/experiments/adopt")
      .send({ name: "same-retro", task_ids: [task.id] })
      .expect(200);

    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.idempotent).toBe(true);
    expect(store.getGrid(first.body.grid.id)?.task_ids).toEqual([task.id]);

    await request(app)
      .post("/experiments/adopt")
      .send({ name: "other-retro", task_ids: [task.id] })
      .expect(409);
  });

  it("allocates collision-free refs when adopting and moving tasks", async () => {
    const app = makeApp();
    const a = createTask({ script: "/tmp/train.py", name: "dup-a" });
    const b = createTask({ script: "/tmp/train.py", name: "dup-b" });
    store.addToGlobalQueue({ ...a, ref: "train" });
    store.addToGlobalQueue({ ...b, ref: "train" });

    const adopted = await request(app)
      .post("/experiments/adopt")
      .send({ name: "dup-retro", task_ids: [a.id, b.id] })
      .expect(201);

    expect(Object.keys(adopted.body.task_refs).sort()).toEqual(["task-2", "train"]);
    expect(new Set(Object.values(adopted.body.task_refs))).toEqual(new Set([a.id, b.id]));
  });

  it("adopts archived completed tasks and reports terminal status", async () => {
    const app = makeApp();
    const task = createTask({ script: "/tmp/train.py", name: "done-adopt" });
    store.addToGlobalQueue(task);
    store.setStub({
      id: "stub-done", name: "stub-done", hostname: "host-done",
      gpu: { name: "A30", vram_total_mb: 24576, count: 1 },
      status: "online", type: "slurm",
      connected_at: "2026-01-01T00:00:00.000Z", last_heartbeat: "2026-01-01T00:00:00.000Z",
      max_concurrent: 1, tasks: [],
    });
    store.moveToStubQueue(task.id, "stub-done");
    store.updateTask("stub-done", task.id, { status: "running", started_at: "2026-01-01T00:01:00.000Z" });
    store.updateTask("stub-done", task.id, { status: "completed", finished_at: "2026-01-01T00:02:00.000Z" });
    expect(store.findTask(task.id)?.archived).toBe(true);

    const adopted = await request(app)
      .post("/experiments/adopt")
      .send({ name: "done-retro", task_ids: [task.id] })
      .expect(201);

    expect(adopted.body.status).toBe("passed");
    expect(adopted.body.grid.status).toBe("completed");
    expect(store.findTask(task.id)?.task).toEqual(expect.objectContaining({
      status: "completed",
      experiment_id: adopted.body.id,
      grid_id: adopted.body.grid.id,
    }));
    expect((await request(app).get(`/experiments/${adopted.body.id}`).expect(200)).body.status).toBe("passed");
  });

  it("recommends keep/improved vs discard/regressed for min direction against parent", async () => {
    const app = makeApp();

    const parent = await request(app)
      .post("/experiments")
      .send({
        name: "parent-min",
        family: "family-min",
        goal_metric: "loss",
        goal_direction: "min",
        task_specs: [{ ref: "train", script: "/tmp/train.py" }],
      })
      .expect(201);
    completeExperiment(parent.body.id, "loss", 1.2);

    const improved = await request(app)
      .post("/experiments")
      .send({
        name: "child-min-improved",
        family: "family-min",
        parent_id: parent.body.id,
        goal_metric: "loss",
        goal_direction: "min",
        task_specs: [{ ref: "train", script: "/tmp/train.py" }],
      })
      .expect(201);
    completeExperiment(improved.body.id, "loss", 0.8);

    const improvedSummary = await request(app).get(`/experiments/${improved.body.id}/summary`).expect(200);
    const improvedRecommendation = await request(app).get(`/experiments/${improved.body.id}/recommendation`).expect(200);
    expect(improvedRecommendation.body).toEqual(improvedSummary.body.recommendation);
    expect(improvedSummary.body.recommendation).toEqual(
      expect.objectContaining({
        action: "keep",
        verdict: "improved",
        metric: "loss",
        baseline_value: 1.2,
        direction: "min",
        value: 0.8,
        delta: -0.4,
        evidence_quality: "moderate",
        evidence_reason: "Better than parent baseline",
        baseline_source: "parent",
        sample_count: 1,
        comparable_count: 1,
      }),
    );

    const regressed = await request(app)
      .post("/experiments")
      .send({
        name: "child-min-regressed",
        family: "family-min",
        parent_id: parent.body.id,
        goal_metric: "loss",
        goal_direction: "min",
        task_specs: [{ ref: "train", script: "/tmp/train.py" }],
      })
      .expect(201);
    completeExperiment(regressed.body.id, "loss", 1.6);

    const regressedSummary = await request(app).get(`/experiments/${regressed.body.id}/summary`).expect(200);
    const regressedRecommendation = await request(app).get(`/experiments/${regressed.body.id}/recommendation`).expect(200);
    expect(regressedRecommendation.body).toEqual(regressedSummary.body.recommendation);
    expect(regressedSummary.body.recommendation).toEqual(
      expect.objectContaining({
        action: "discard",
        verdict: "regressed",
        metric: "loss",
        baseline_value: 1.2,
        direction: "min",
        value: 1.6,
        delta: 0.4,
        evidence_quality: "moderate",
        evidence_reason: "Worse than parent baseline",
        baseline_source: "parent",
        sample_count: 1,
        comparable_count: 1,
      }),
    );
  });

  it("uses strong evidence when parent baseline has multiple validation rows", async () => {
    const app = makeApp();

    const parent = await request(app)
      .post("/experiments")
      .send({
        name: "parent-min-multi",
        family: "family-min-multi",
        goal_metric: "loss",
        goal_direction: "min",
        task_specs: [
          { ref: "train-a", script: "/tmp/train.py" },
          { ref: "train-b", script: "/tmp/train.py" },
        ],
      })
      .expect(201);
    completeExperiment(parent.body.id, "loss", 1.2);

    const child = await request(app)
      .post("/experiments")
      .send({
        name: "child-min-multi",
        family: "family-min-multi",
        parent_id: parent.body.id,
        goal_metric: "loss",
        goal_direction: "min",
        task_specs: [
          { ref: "train-a", script: "/tmp/train.py" },
          { ref: "train-b", script: "/tmp/train.py" },
        ],
      })
      .expect(201);
    completeExperiment(child.body.id, "loss", 0.8);

    const recommendation = await request(app).get(`/experiments/${child.body.id}/recommendation`).expect(200);
    expect(recommendation.body).toEqual(
      expect.objectContaining({
        action: "keep",
        verdict: "improved",
        evidence_quality: "strong",
        baseline_source: "parent",
        sample_count: 2,
        comparable_count: 1,
      }),
    );
  });

  it("recommends keep/improved for max direction against parent", async () => {
    const app = makeApp();

    const parent = await request(app)
      .post("/experiments")
      .send({
        name: "parent-max",
        family: "family-max",
        goal_metric: "accuracy",
        goal_direction: "max",
        task_specs: [{ ref: "train", script: "/tmp/train.py" }],
      })
      .expect(201);
    completeExperiment(parent.body.id, "accuracy", 0.81);

    const improved = await request(app)
      .post("/experiments")
      .send({
        name: "child-max-improved",
        family: "family-max",
        parent_id: parent.body.id,
        goal_metric: "accuracy",
        goal_direction: "max",
        task_specs: [{ ref: "train", script: "/tmp/train.py" }],
      })
      .expect(201);
    completeExperiment(improved.body.id, "accuracy", 0.88);

    const improvedSummary = await request(app).get(`/experiments/${improved.body.id}/summary`).expect(200);
    expect(improvedSummary.body.recommendation).toEqual(
      expect.objectContaining({
        action: "keep",
        verdict: "improved",
        metric: "accuracy",
        baseline_value: 0.81,
        direction: "max",
        value: 0.88,
        delta: 0.07,
        evidence_quality: "moderate",
        evidence_reason: "Better than parent baseline",
        baseline_source: "parent",
        sample_count: 1,
        comparable_count: 1,
      }),
    );
  });

  it("overrides with try_more on failed or running status", async () => {
    const app = makeApp();

    const running = await request(app)
      .post("/experiments")
      .send({
        name: "running-exp",
        goal_metric: "loss",
        goal_direction: "min",
        task_specs: [{ ref: "train", script: "/tmp/train.py" }],
      })
      .expect(201);
    const runningGrid = store.getGrid(running.body.grid_id)!;
    const assigned = store.updateGlobalQueueTask(runningGrid.task_ids[0], {
      status: "assigned",
      stub_id: "stub-running",
    });
    expect(assigned).toBeDefined();
    const started = store.updateGlobalQueueTask(runningGrid.task_ids[0], {
      status: "running",
      started_at: new Date().toISOString(),
    });
    expect(started).toBeDefined();

    const runningSummary = await request(app).get(`/experiments/${running.body.id}/summary`).expect(200);
    expect(runningSummary.body.recommendation).toEqual(
      expect.objectContaining({
        action: "try_more",
        verdict: "running",
        evidence_quality: "insufficient",
        baseline_source: "none",
        sample_count: 0,
        comparable_count: 0,
        evidence_reason: expect.stringContaining("running"),
      }),
    );

    const pending = await request(app)
      .post("/experiments")
      .send({
        name: "pending-exp",
        goal_metric: "loss",
        goal_direction: "min",
        task_specs: [{ ref: "train", script: "/tmp/train.py" }],
      })
      .expect(201);

    const pendingSummary = await request(app).get(`/experiments/${pending.body.id}/summary`).expect(200);
    expect(pendingSummary.body.status).toBe("running");
    expect(pendingSummary.body.recommendation).toEqual(
      expect.objectContaining({
        action: "try_more",
        verdict: "inconclusive",
        reason: "Goal metric not yet available",
        evidence_reason: "Goal metric not yet available",
      }),
    );

    const failed = await request(app)
      .post("/experiments")
      .send({
        name: "failed-exp",
        goal_metric: "loss",
        goal_direction: "min",
        task_specs: [{ ref: "train", script: "/tmp/train.py" }],
      })
      .expect(201);
    const failedGrid = store.getGrid(failed.body.grid_id)!;
    const failedTask = store.removeFromGlobalQueue(failedGrid.task_ids[0]);
    expect(failedTask).toBeDefined();
    store.setArchive([
      ...store.getArchive(),
      {
        ...failedTask!,
        status: "failed" as const,
        finished_at: new Date().toISOString(),
      },
    ]);

    const failedSummary = await request(app).get(`/experiments/${failed.body.id}/summary`).expect(200);
    expect(failedSummary.body.recommendation).toEqual(
      expect.objectContaining({
        action: "try_more",
        verdict: "failed",
        evidence_quality: "insufficient",
        baseline_source: "none",
        sample_count: 0,
        comparable_count: 0,
      }),
    );
  });

  it("asks to try_more when goal metric metadata is missing", async () => {
    const app = makeApp();

    const exp = await request(app)
      .post("/experiments")
      .send({
        name: "missing-goal",
        task_specs: [{ ref: "train", script: "/tmp/train.py" }],
      })
      .expect(201);
    completeExperiment(exp.body.id, "loss", 0.4);

    const summary = await request(app).get(`/experiments/${exp.body.id}/summary`).expect(200);
    expect(summary.body.recommendation).toEqual(
      expect.objectContaining({
        action: "try_more",
        verdict: "inconclusive",
        metric: null,
        direction: null,
        evidence_quality: "insufficient",
        baseline_source: "none",
        sample_count: null,
        comparable_count: 0,
      }),
    );
    expect(summary.body.recommendation.value).toBeNull();
  });

  it("does not use itself as same-family baseline", async () => {
    const app = makeApp();

    const exp = await request(app)
      .post("/experiments")
      .send({
        name: "family-solo",
        family: "solo-family",
        goal_metric: "loss",
        goal_direction: "min",
        task_specs: [{ ref: "train", script: "/tmp/train.py" }],
      })
      .expect(201);
    completeExperiment(exp.body.id, "loss", 0.4);

    const summary = await request(app).get(`/experiments/${exp.body.id}/summary`).expect(200);
    expect(summary.body.recommendation).toEqual(
      expect.objectContaining({
        action: "try_more",
        verdict: "inconclusive",
        baseline_value: null,
        value: 0.4,
        reason: "No comparable numeric baseline found",
        evidence_quality: "weak",
        baseline_source: "none",
        sample_count: 1,
        comparable_count: 0,
      }),
    );
  });

  it("uses same-family best as baseline when parent is absent", async () => {
    const app = makeApp();

    const first = await request(app)
      .post("/experiments")
      .send({
        name: "family-a",
        family: "no-parent-family",
        goal_metric: "loss",
        goal_direction: "min",
        task_specs: [{ ref: "train", script: "/tmp/train.py" }],
      })
      .expect(201);
    const second = await request(app)
      .post("/experiments")
      .send({
        name: "family-b",
        family: "no-parent-family",
        goal_metric: "loss",
        goal_direction: "min",
        task_specs: [{ ref: "train", script: "/tmp/train.py" }],
      })
      .expect(201);

    completeExperiment(first.body.id, "loss", 0.4);
    completeExperiment(second.body.id, "loss", 0.9);

    const firstSummary = await request(app).get(`/experiments/${first.body.id}/summary`).expect(200);
    const secondSummary = await request(app).get(`/experiments/${second.body.id}/summary`).expect(200);

    expect(firstSummary.body.recommendation).toEqual(
      expect.objectContaining({
        action: "keep",
        verdict: "best",
        baseline_value: 0.9,
        value: 0.4,
        evidence_quality: "weak",
        baseline_source: "family",
        sample_count: 1,
        comparable_count: 1,
      }),
    );
    expect(secondSummary.body.recommendation).toEqual(
      expect.objectContaining({
        action: "try_more",
        verdict: "inconclusive",
        baseline_value: 0.4,
        value: 0.9,
        evidence_quality: "weak",
        baseline_source: "family",
        sample_count: 1,
        comparable_count: 1,
      }),
    );
  });
});
