import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { store } from "../store";
import { createTestServer, TestContext, createMockStub } from "./helpers/setup";
import { setupWebNamespace } from "../socket/web";
import { pickBestStub, checkLossAnomaly } from "../scheduler";
import { v4 as uuidv4 } from "uuid";
import { Task } from "../types";

describe("Scheduler: pickBestStub", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
    setupWebNamespace(ctx.webNs);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("returns undefined when no stubs are online", () => {
    const result = pickBestStub();
    expect(result).toBeUndefined();
  });

  it("returns undefined when only offline stubs exist", () => {
    const stub = createMockStub({ status: "offline" });
    store.setStub(stub);
    expect(pickBestStub()).toBeUndefined();
  });

  it("skips offline/stale stubs, returns online one", () => {
    const offline = createMockStub({ status: "offline" });
    const stale = createMockStub({ status: "stale" });
    const online = createMockStub({ status: "online" });
    store.setStub(offline);
    store.setStub(stale);
    store.setStub(online);

    const result = pickBestStub();
    expect(result?.id).toBe(online.id);
  });

  it("selects stub with most free slots (fewest running tasks)", () => {
    const busy = createMockStub({
      status: "online",
      tasks: [
        { id: uuidv4(), stub_id: "", command: "cmd", status: "running", created_at: new Date().toISOString(), log_buffer: [] },
        { id: uuidv4(), stub_id: "", command: "cmd", status: "running", created_at: new Date().toISOString(), log_buffer: [] },
      ],
    });
    const idle = createMockStub({ status: "online", tasks: [] });
    store.setStub(busy);
    store.setStub(idle);

    const result = pickBestStub();
    expect(result?.id).toBe(idle.id);
  });

  it("filters by VRAM requirement", () => {
    const smallGpu = createMockStub({
      status: "online",
      gpu: { name: "A30", vram_total_mb: 24576, count: 1 },
    });
    const bigGpu = createMockStub({
      status: "online",
      gpu: { name: "A100", vram_total_mb: 81920, count: 1 },
    });
    store.setStub(smallGpu);
    store.setStub(bigGpu);

    const result = pickBestStub(40960); // needs 40GB
    expect(result?.id).toBe(bigGpu.id);
  });

  it("falls back to any stub when no stub meets VRAM requirement", () => {
    const stub = createMockStub({
      status: "online",
      gpu: { name: "A30", vram_total_mb: 24576, count: 1 },
    });
    store.setStub(stub);

    // Wants 80GB but only 24GB available — falls back
    const result = pickBestStub(81920);
    // per code: if fits is empty, falls back to stubs[0]
    expect(result?.id).toBe(stub.id);
  });

  it("prefers GPU type match", () => {
    const a30 = createMockStub({
      status: "online",
      gpu: { name: "A30", vram_total_mb: 24576, count: 1 },
    });
    const a40 = createMockStub({
      status: "online",
      gpu: { name: "A40", vram_total_mb: 49152, count: 1 },
    });
    store.setStub(a30);
    store.setStub(a40);

    const result = pickBestStub(undefined, "A40");
    expect(result?.id).toBe(a40.id);
  });
});

describe("Scheduler: checkLossAnomaly", () => {
  let ctx: TestContext;
  let stubId: string;
  let taskId: string;

  beforeEach(async () => {
    ctx = await createTestServer();
    setupWebNamespace(ctx.webNs);

    const stub = createMockStub({ status: "online" });
    const task: Task = {
      id: uuidv4(),
      stub_id: stub.id,
      command: "python train.py",
      status: "running",
      created_at: new Date().toISOString(),
      log_buffer: [],
    };
    stub.tasks.push(task);
    store.setStub(stub);
    stubId = stub.id;
    taskId = task.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("NaN loss auto-pauses task and creates alert", () => {
    checkLossAnomaly(stubId, taskId, NaN, 1.5, ctx.webNs, ctx.stubNs);

    const task = store.getTask(stubId, taskId);
    expect(task?.status).toBe("paused");

    const alerts = store.getAllAlerts();
    expect(alerts.some((a) => a.type === "loss_nan")).toBe(true);
  });

  it("Infinity loss auto-pauses task and creates alert", () => {
    checkLossAnomaly(stubId, taskId, Infinity, 1.5, ctx.webNs, ctx.stubNs);

    const task = store.getTask(stubId, taskId);
    expect(task?.status).toBe("paused");

    const alerts = store.getAllAlerts();
    expect(alerts.some((a) => a.type === "loss_nan")).toBe(true);
  });

  it("loss spike (10x) creates loss_spike alert but does not pause", () => {
    checkLossAnomaly(stubId, taskId, 10.5, 1.0, ctx.webNs, ctx.stubNs);

    const task = store.getTask(stubId, taskId);
    expect(task?.status).toBe("running"); // not paused

    const alerts = store.getAllAlerts();
    expect(alerts.some((a) => a.type === "loss_spike")).toBe(true);
  });

  it("normal loss change does not create alerts", () => {
    checkLossAnomaly(stubId, taskId, 1.4, 1.5, ctx.webNs, ctx.stubNs);

    const task = store.getTask(stubId, taskId);
    expect(task?.status).toBe("running");

    const alerts = store.getAllAlerts();
    expect(alerts.length).toBe(0);
  });

  it("undefined loss is a no-op", () => {
    checkLossAnomaly(stubId, taskId, undefined, undefined, ctx.webNs, ctx.stubNs);

    const task = store.getTask(stubId, taskId);
    expect(task?.status).toBe("running");
    expect(store.getAllAlerts().length).toBe(0);
  });
});
