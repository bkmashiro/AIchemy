import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCapacityRouter } from "../api/capacity";
import { store } from "../store";
import type { DeployFileConfig, DeployResult } from "../types";
import type { CampaignDriver } from "../campaigns/reconciler";

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

  it("explains why configured candidates were rejected", async () => {
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config));

    const response = await request(app).post("/capacity/recommend").send({
      resources: { gpu_mem_mb: 32768, qos: "normal" }, snapshot: { partitions: [] },
    }).expect(409);

    expect(response.body.rejections).toEqual([
      expect.objectContaining({ target_id: "slurm-a16", reasons: expect.arrayContaining([expect.stringContaining("gpu_mem_mb")]) }),
    ]);
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
    await request(app).post(`/capacity/campaigns/${created.body.alias}/advance`)
      .send({ to: "wait_stub", actor: "tester", allocation_id: "alloc-forged" }).expect(409);
    const owned = store.createSlurmAllocation({
      idempotency_key: "campaign-owned-allocation",
      campaign_id: created.body.id,
      capacity_lease_id: created.body.capacity_lease_id,
      managed_target_id: "slurm-a16",
      requested_resources: {},
      job_name: "campaign-owned",
      owner: "tester",
      managed_by: "alchemy",
      pinned: false,
      state: "requested",
      requested_at: new Date().toISOString(),
    });
    const advanced = await request(app).post(`/capacity/campaigns/${created.body.alias}/advance`)
      .send({ to: "wait_stub", actor: "tester", allocation_id: owned.id }).expect(200);
    expect(advanced.body.state).toBe("wait_stub");
    expect(advanced.body.attempts).toBe(1);
    expect(advanced.body.history).toHaveLength(1);
    expect(store.getCapacityCampaign(created.body.id)?.state).toBe("wait_stub");
  });

  it("requires the audited reconciler for destructive campaign transitions", async () => {
    const campaign = store.createCapacityCampaign({
      name: "draining", state: "drain", target_id: "slurm-a16", frozen_spec_hash: "sha256:x",
      capacity_lease_id: "lease-drain", max_attempts: 3, attempts: 0, max_runtime_seconds: 3600,
    });
    const app = express(); app.use(express.json()); app.use("/capacity", createCapacityRouter(config));

    const response = await request(app).post(`/capacity/campaigns/${campaign.id}/advance`)
      .send({ to: "release", actor: "tester" }).expect(409);
    expect(response.body.error).toMatch(/reconciler/i);
    expect(store.getCapacityCampaign(campaign.id)?.state).toBe("drain");
  });

  it("keeps policy reconciliation recommend-only without a server-owned automatic policy", async () => {
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config));
    const response = await request(app).post("/capacity/policy/reconcile").send({
      recommendation: {
        recommendation_id: "plan-1",
        target: { id: "slurm-a16", aliases: ["a16"], partition: "a16", tags: [], enabled: true },
        resources: { partition: "a16", qos: "normal" },
        validated_snapshots: 100,
      },
    }).expect(200);

    expect(response.body.mode).toBe("recommend");
    expect(response.body.actions[0]).toMatchObject({ kind: "acquire", applied: false, reason: "recommend_only" });

    const events = await request(app).get("/capacity/policy/events").expect(200);
    expect(events.body).toEqual([
      expect.objectContaining({ kind: "acquire", applied: false, reason: "recommend_only", actor: "capacity_policy" }),
    ]);
  });

  it("never trusts a client-supplied recommendation for automatic acquisition", async () => {
    const acquire = vi.fn(async () => ({ id: "alloc-new" }));
    const release = vi.fn(async () => ({ ok: true }));
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config, {
      automation: {
        policy: { pool_id: "general", mode: "automatic", enabled: true, min_validated_snapshots: 1, max_total: 3, max_pending: 2, cooldown_seconds: 0 },
        acquire,
        release,
      },
    }));

    await request(app).post("/capacity/policy/reconcile").send({
      recommendation: {
        recommendation_id: "forged",
        target: { id: "attacker-target", aliases: [], partition: "forged", tags: [], enabled: true },
        resources: { partition: "forged", qos: "admin" },
        validated_snapshots: 999,
      },
    }).expect(503);

    expect(acquire).not.toHaveBeenCalled();

    const forgedProviderApp = express(); forgedProviderApp.use(express.json());
    forgedProviderApp.use("/capacity", createCapacityRouter(config, {
      automation: {
        policy: { pool_id: "general", mode: "automatic", enabled: true, min_validated_snapshots: 1, max_total: 3, max_pending: 2, cooldown_seconds: 0 },
        recommendationProvider: async () => ({
          recommendation_id: "forged-provider",
          target: { id: "unknown-target", aliases: [], tags: [], enabled: true },
          resources: { qos: "admin" },
          validated_snapshots: 2,
        }),
        acquire,
        release,
      },
    }));
    await request(forgedProviderApp).post("/capacity/policy/reconcile").send({}).expect(503);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("provides a one-way runtime kill switch back to recommend-only", async () => {
    const policy = { pool_id: "general", mode: "automatic" as const, enabled: true, min_validated_snapshots: 1, max_total: 3, max_pending: 2, cooldown_seconds: 0 };
    const acquire = vi.fn(async () => ({ id: "new" }));
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config, {
      automation: {
        policy,
        recommendationProvider: async () => null,
        acquire,
        release: vi.fn(),
      },
    }));

    const disabled = await request(app).post("/capacity/policy/disable").expect(200);
    expect(disabled.body).toMatchObject({ mode: "recommend", enabled: false });
    await request(app).post("/capacity/policy/reconcile").send({
      recommendation: { recommendation_id: "preview", target: config.stubs[0], resources: {}, validated_snapshots: 100 },
    }).expect(200);
    expect(acquire).not.toHaveBeenCalled();

    const restartedPolicy = { ...policy, mode: "automatic" as const, enabled: true };
    const restartedApp = express(); restartedApp.use(express.json());
    restartedApp.use("/capacity", createCapacityRouter(config, {
      automation: {
        policy: restartedPolicy,
        recommendationProvider: async () => ({
          recommendation_id: "would-acquire",
          target: { id: "slurm-a16", aliases: [], partition: "gpu-small", qos: "normal", gres: "gpu:a16:1", gpu_class: "A16", tags: [], enabled: true },
          resources: { partition: "gpu-small", qos: "normal" },
          validated_snapshots: 100,
        }),
        acquire,
        release: vi.fn(),
      },
    }));
    const afterRestart = await request(restartedApp).post("/capacity/policy/reconcile").send({}).expect(200);
    expect(afterRestart.body.mode).toBe("recommend");
    expect(acquire).not.toHaveBeenCalled();
  });

  it("reconciles a campaign through the restart-safe driver endpoint", async () => {
    const campaignDriver = {
      acquire: vi.fn(async () => ({ allocation_id: "allocation-1" })),
      observeStub: vi.fn(), runSmoke: vi.fn(), submitDag: vi.fn(), observeDag: vi.fn(),
      drain: vi.fn(), release: vi.fn(), closeout: vi.fn(), cleanup: vi.fn(),
    } as unknown as CampaignDriver;
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config, { campaignDriver }));
    const created = await request(app).post("/capacity/campaigns").send({
      name: "automated", target_id: "slurm-a16", frozen_spec_hash: "sha256:abc",
    }).expect(201);

    const response = await request(app).post(`/capacity/campaigns/${created.body.id}/reconcile`).expect(200);

    expect(response.body.state).toBe("wait_stub");
    expect(campaignDriver.acquire).toHaveBeenCalledOnce();
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
