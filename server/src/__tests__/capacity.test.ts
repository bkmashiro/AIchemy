import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCapacityRouter } from "../api/capacity";
import { store } from "../store";
import type { DeployFileConfig, DeployResult } from "../types";

const config: DeployFileConfig = {
  stubs: [{
    name: "slurm-a16",
    aliases: ["a16"],
    type: "slurm",
    ssh_host: "cluster",
    ssh_user: "tester",
    remote_dir: "/tmp/stub",
    python_path: "/opt/python",
    max_concurrent: 1,
    partition: "gpu-small",
    gres: "gpu:nvidia_a16:1",
    gpu_class: "A16",
    gpu_mem_mb: 16384,
    mem: "32G",
    time: "12:00:00",
    qos: "normal",
    tags: "a16,slurm",
    enabled: true,
    controller_capability: "slurm",
  }],
};

beforeEach(() => store.reset());

describe("capacity target catalog and allocation submission", () => {
  it("exposes configured GPU targets without a hard-coded model list", async () => {
    const app = express(); app.use(express.json());
    app.use("/api/capacity", createCapacityRouter(config));

    const response = await request(app).get("/api/capacity/targets").expect(200);
    expect(response.body).toEqual([expect.objectContaining({
      id: "slurm-a16",
      aliases: ["a16"],
      gpu_class: "A16",
      gpu_mem_mb: 16384,
      partition: "gpu-small",
      gres: "gpu:nvidia_a16:1",
      enabled: true,
    })]);
  });

  it("persists before submit and deduplicates retries by idempotency key", async () => {
    const submit = vi.fn(async (): Promise<DeployResult> => {
      expect(store.getSlurmAllocations()).toHaveLength(1);
      expect(store.getSlurmAllocations()[0].state).toBe("requested");
      return { ok: true, target: "slurm-a16", job_id: "4242" };
    });
    const app = express(); app.use(express.json());
    app.use("/api/capacity", createCapacityRouter(config, { submit }));
    const body = {
      target: "a16",
      idempotency_key: "campaign-x/card-0",
      job_name: "JEMA D1 smoke / unsafe chars",
      server_url: "https://example.invalid",
      token: "test-token",
      owner: "tester",
    };

    const first = await request(app).post("/api/capacity/allocations/submit").send(body).expect(201);
    const second = await request(app).post("/api/capacity/allocations/submit").send(body).expect(200);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(first.body.allocation.id).toBe(second.body.allocation.id);
    expect(first.body.allocation.job_id).toBe("4242");
    expect(first.body.allocation.state).toBe("submitted");
    expect(first.body.allocation.job_name).toBe("jema-d1-smoke-unsafe-chars");
    expect(first.body.allocation.alias).toMatch(/^alloc-/);
    expect(second.body.reused).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(store.getSlurmAllocations()).toHaveLength(1);
  });

  it("bulk cancellation is dry-run by default and excludes manual or pinned jobs", async () => {
    const cancel = vi.fn(async () => ({ ok: true }));
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config, { cancel }));
    for (const [id, managedBy, pinned] of [
      ["managed", "alchemy", false], ["manual", "manual", false], ["pinned", "alchemy", true],
    ] as const) {
      store.createSlurmAllocation({
        idempotency_key: id, managed_target_id: "slurm-a16", requested_resources: {},
        job_name: id, owner: "tester", managed_by: managedBy, pinned, state: "running", job_id: `job-${id}`,
      });
    }
    const preview = await request(app).post("/capacity/allocations/cancel").send({ allocations: [] }).expect(200);
    expect(preview.body.dry_run).toBe(true);
    expect(preview.body.eligible).toHaveLength(1);
    expect(preview.body.skipped.map((item: any) => item.reason).sort()).toEqual(["manual", "pinned"]);
    expect(cancel).not.toHaveBeenCalled();

    const applied = await request(app).post("/capacity/allocations/cancel")
      .send({ allocations: ["job-managed"], apply: true }).expect(200);
    expect(applied.body.cancelled).toHaveLength(1);
    expect(cancel).toHaveBeenCalledWith("job-managed");
  });

  it("persists campaign transitions and rejects skipped states", async () => {
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config));
    const created = await request(app).post("/capacity/campaigns").send({
      name: "jema-d1", target_id: "slurm-a16", frozen_spec_hash: "sha256:abc",
      max_attempts: 2, max_runtime_seconds: 3600,
    }).expect(201);
    expect(created.body.state).toBe("acquire");
    expect(created.body.alias).toMatch(/^camp-/);

    await request(app).post(`/capacity/campaigns/${created.body.alias}/advance`)
      .send({ to: "submit_dag", actor: "tester" }).expect(409);
    const advanced = await request(app).post(`/capacity/campaigns/${created.body.alias}/advance`)
      .send({ to: "wait_stub", actor: "tester", allocation_id: "alloc-1" }).expect(200);
    expect(advanced.body.state).toBe("wait_stub");
    expect(advanced.body.attempts).toBe(1);
    expect(advanced.body.history).toHaveLength(1);
    expect(store.getCapacityCampaign(created.body.id)?.state).toBe("wait_stub");
  });

  it("reconciles persisted allocation state from a complete SLURM snapshot", async () => {
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config));
    store.createSlurmAllocation({
      idempotency_key: "reconcile-card-1",
      managed_target_id: "slurm-a16",
      requested_resources: {},
      job_name: "jema-card-1",
      owner: "tester",
      managed_by: "alchemy",
      pinned: false,
      state: "submitted",
      job_id: "9001",
    });

    const pending = await request(app).post("/capacity/reconcile").send({
      complete: true,
      jobs: [{ job_id: "9001", state: "PENDING", partition: "gpu-small" }],
    });
    expect(pending.status).toBe(200);
    expect(pending.body.reconciled[0].state).toBe("pending");

    const ended = await request(app).post("/capacity/reconcile").send({ complete: true, jobs: [] });
    expect(ended.body.reconciled[0].state).toBe("released");
  });
});
