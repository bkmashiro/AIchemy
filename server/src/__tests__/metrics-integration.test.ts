/**
 * Integration test: metrics endpoint returns data after push.
 * Verifies that metricsStore receives data from the stub socket handler
 * and that the REST endpoint returns it correctly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { store } from "../store";
import { metricsStore } from "../metrics";
import { createTestServer, TestContext, createTestToken, connectStubClient } from "./helpers/setup";
import { setupStubNamespace } from "../socket/stub";
import { setupWebNamespace } from "../socket/web";

describe("Metrics integration", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
    setupWebNamespace(ctx.webNs);
    setupStubNamespace(ctx.stubNs, ctx.webNs);

    // Mount metrics endpoints matching index.ts
    const api = express.Router();
    api.get("/stubs/:id/metrics", (req, res) => {
      const hours = req.query.hours !== undefined ? parseFloat(req.query.hours as string) : 1;
      const points = metricsStore.getStubMetrics(req.params.id, hours);
      res.json({ stub_id: req.params.id, hours, points });
    });
    api.get("/tasks/:id/metrics", (req, res) => {
      const points = metricsStore.getTaskMetrics(req.params.id);
      res.json({ task_id: req.params.id, points });
    });
    api.get("/metrics/summary", (_req, res) => {
      const latest = metricsStore.getLatestStubMetrics();
      res.json({ stubs: latest, cached_at: new Date().toISOString() });
    });

    ctx.app.use("/api", api);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("returns empty metrics for unknown stub", async () => {
    const token = createTestToken();
    const res = await fetch(`${ctx.baseUrl}/api/stubs/nonexistent-stub/metrics`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.points).toEqual([]);
  });

  it("records and returns gpu_stats pushed via socket", async () => {
    const token = createTestToken();

    // Connect stub
    const client = connectStubClient(ctx.port);
    client.connect();

    const stubId = await new Promise<string>((resolve) => {
      client.on("registered", (data: any) => resolve(data.stub_id));
      client.emit("register", {
        hostname: "metrics-host",
        gpu: { name: "A40", vram_total_mb: 49152, count: 1 },
        max_concurrent: 2,
        token: token.token,
      });
    });

    // Send gpu_stats via socket
    client.emit("gpu_stats", {
      timestamp: new Date().toISOString(),
      gpus: [
        { index: 0, utilization_pct: 75, memory_used_mb: 20000, memory_total_mb: 49152, temperature_c: 65 },
      ],
    });

    // Wait for processing
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`${ctx.baseUrl}/api/stubs/${stubId}/metrics?hours=1`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.stub_id).toBe(stubId);
    expect(body.points.length).toBeGreaterThanOrEqual(1);

    const point = body.points[0];
    expect(point.values["gpu0.utilization_pct"]).toBe(75);
    expect(point.values["gpu0.memory_used_mb"]).toBe(20000);
    expect(point.values["gpu0.temperature_c"]).toBe(65);

    client.disconnect();
  });

  it("records task metrics after sdk/report push", async () => {
    const token = createTestToken();
    const { v4: uuidv4 } = await import("uuid");

    // Create a stub with a running task
    const { createMockStub } = await import("./helpers/setup");
    const stub = createMockStub({ token: token.token });
    const taskId = uuidv4();
    stub.tasks.push({
      id: taskId,
      stub_id: stub.id,
      command: "python train.py",
      status: "running",
      created_at: new Date().toISOString(),
      log_buffer: [],
    });
    store.setStub(stub);

    // Push task metrics directly to metricsStore (as the /api/sdk/report endpoint does)
    metricsStore.pushTaskMetrics(taskId, 100, 0.25, { accuracy: 0.85 });

    const res = await fetch(`${ctx.baseUrl}/api/tasks/${taskId}/metrics`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.task_id).toBe(taskId);
    expect(body.points.length).toBe(1);
    expect(body.points[0].values.step).toBe(100);
    expect(body.points[0].values.loss).toBe(0.25);
    expect(body.points[0].values.accuracy).toBe(0.85);
  });

  it("returns metrics summary with latest stub point", async () => {
    const { v4: uuidv4 } = await import("uuid");
    const stubId = uuidv4();

    // Push two stub metric points
    metricsStore.pushStubMetrics(stubId, [
      { index: 0, utilization_pct: 10, memory_used_mb: 1000, memory_total_mb: 49152, temperature_c: 30 },
    ]);
    metricsStore.pushStubMetrics(stubId, [
      { index: 0, utilization_pct: 90, memory_used_mb: 40000, memory_total_mb: 49152, temperature_c: 75 },
    ]);

    const res = await fetch(`${ctx.baseUrl}/api/metrics/summary`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.stubs[stubId]).toBeDefined();
    // Should be the LAST (most recent) point
    expect(body.stubs[stubId].values["gpu0.utilization_pct"]).toBe(90);
  });
});
