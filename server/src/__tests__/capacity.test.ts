import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { capacityTargets, cancelManagedSlurmAllocation, collectManagedSlurmJobs, createCapacityRouter, reconcileManagedSlurmSnapshot, startManagedSlurmReconciler } from "../api/capacity";
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
    backend_capability: "slurm",
  }],
};

const frozenManifest = {
  version: 1,
  smoke_task: { script: "/opt/python", argv: ["-c", "import torch; assert torch.cuda.is_available()"] },
  dag: { name: "formal-dag", task_specs: [{ ref: "train", script: "/opt/python", argv: ["train.py"] }] },
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
      backend_capability: "slurm",
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
    expect(first.body.allocation.job_name).toMatch(/^jema-d1-smoke-unsafe-chars-[a-f0-9]{10}$/);
    expect(first.body.allocation.alias).toMatch(/^alloc-/);
    expect(second.body.reused).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(store.getSlurmAllocations()).toHaveLength(1);
  });

  it("retries legacy Controller-verified failed allocations through the SSH backend", async () => {
    const existing = store.createSlurmAllocation({
      idempotency_key: "legacy-controller-retry", managed_target_id: "slurm-a16", requested_resources: {},
      job_name: "legacy-controller-retry", owner: "tester", managed_by: "alchemy", pinned: false,
      state: "failed", error: "controller_verified_absent",
    });
    const submit = vi.fn(async (): Promise<DeployResult> => ({ ok: true, target: "slurm-a16", job_id: "4242" }));
    const app = express(); app.use(express.json());
    app.use("/api/capacity", createCapacityRouter(config, { submit }));

    const response = await request(app).post("/api/capacity/allocations/submit").send({
      target: "slurm-a16",
      idempotency_key: existing.idempotency_key,
      job_name: existing.job_name,
      server_url: "https://example.invalid",
      token: "test-token",
      owner: "tester",
    }).expect(201);

    expect(response.body.allocation).toMatchObject({ id: existing.id, state: "submitted", job_id: "4242" });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("marks a managed queue snapshot incomplete when any unique SSH backend fails", async () => {
    const multiTargetConfig: DeployFileConfig = {
      ...config,
      stubs: [
        config.stubs[0],
        { ...config.stubs[0], name: "slurm-a30", ssh_host: "gpucluster4" },
      ],
    };
    const list = vi.fn(async (target: DeployFileConfig["stubs"][number]) => {
      if (target.name === "slurm-a30") throw new Error("ssh unavailable");
      return [{ job_id: "4242", state: "RUNNING", partition: "gpgpu", name: "managed" }];
    });

    const snapshot = await collectManagedSlurmJobs(multiTargetConfig, list);

    expect(snapshot).toEqual({
      endpoints: [
        {
          target_ids: ["slurm-a16"],
          jobs: [{ job_id: "4242", state: "RUNNING", partition: "gpgpu", name: "managed" }],
          complete: true,
        },
        { target_ids: ["slurm-a30"], jobs: [], complete: false },
      ],
      jobs: [{ job_id: "4242", state: "RUNNING", partition: "gpgpu", name: "managed" }],
      complete: false,
      failed_targets: ["slurm-a30"],
    });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("scopes identical SLURM job IDs to their managed SSH endpoint", async () => {
    const scopedConfig: DeployFileConfig = {
      ...config,
      stubs: [
        config.stubs[0],
        { ...config.stubs[0], name: "slurm-a30", ssh_host: "gpucluster4" },
      ],
    };
    const first = store.createSlurmAllocation({
      idempotency_key: "scope-a16", managed_target_id: "slurm-a16", requested_resources: {},
      job_name: "scope-a16", owner: "tester", managed_by: "alchemy", pinned: false,
      state: "submitted", job_id: "4242",
    });

    store.setStub({
      id: "stub-a30-4242", name: "gpu-a30-4242", hostname: "gpu-a30", gpu: { name: "A30", count: 1, memory_total_mb: 24576 },
      slurm_job_id: "4242", tags: ["alchemy-target=slurm-a30"], status: "online", type: "slurm",
      connected_at: new Date().toISOString(), last_heartbeat: new Date().toISOString(), max_concurrent: 1, tasks: [],
    } as any);

    await reconcileManagedSlurmSnapshot(scopedConfig, async (target) => [{
      job_id: "4242",
      state: target.name === "slurm-a16" ? "RUNNING" : "PENDING",
      partition: "gpgpu",
      name: target.name,
    }]);

    expect(store.getSlurmAllocation(first.id)?.state).toBe("running");
    expect(store.getSlurmAllocation(first.id)?.stub_id).toBeUndefined();
    expect(store.getStub("stub-a30-4242")?.status).toBe("online");
    expect(store.getStub("stub-a30-4242")?.slurm_allocation_id).toBeUndefined();
  });

  it("does not release allocations for unqueryable targets", async () => {
    const scopedConfig: DeployFileConfig = {
      ...config,
      stubs: [
        config.stubs[0],
        { ...config.stubs[0], name: "slurm-unqueryable", ssh_host: undefined },
      ],
    };
    const enabled = store.createSlurmAllocation({
      idempotency_key: "enabled-target", managed_target_id: "slurm-a16", requested_resources: {},
      job_name: "enabled-target", owner: "tester", managed_by: "alchemy", pinned: false,
      state: "running", job_id: "4242",
    });
    const unqueryable = store.createSlurmAllocation({
      idempotency_key: "unqueryable-target", managed_target_id: "slurm-unqueryable", requested_resources: {},
      job_name: "unqueryable-target", owner: "tester", managed_by: "alchemy", pinned: false,
      state: "running", job_id: "4343",
    });
    const list = vi.fn(async () => []);

    const result = await reconcileManagedSlurmSnapshot(scopedConfig, list);

    expect(store.getSlurmAllocation(enabled.id)?.state).toBe("released");
    expect(store.getSlurmAllocation(unqueryable.id)?.state).toBe("running");
    expect(result.snapshot.failed_targets).toContain("slurm-unqueryable");
    expect(list).toHaveBeenCalledOnce();
  });

  it("continues observing disabled targets with configured SSH", async () => {
    const disabledConfig: DeployFileConfig = {
      ...config,
      stubs: [{ ...config.stubs[0], name: "slurm-disabled", ssh_host: "gpucluster4", enabled: false }],
    };
    const allocation = store.createSlurmAllocation({
      idempotency_key: "disabled-target", managed_target_id: "slurm-disabled", requested_resources: {},
      job_name: "disabled-target", owner: "tester", managed_by: "alchemy", pinned: false,
      state: "submitted", job_id: "4343",
    });
    const list = vi.fn(async () => [{
      job_id: "4343", state: "RUNNING", partition: "gpgpu", name: "disabled-target",
    }]);

    const result = await reconcileManagedSlurmSnapshot(disabledConfig, list);

    expect(store.getSlurmAllocation(allocation.id)?.state).toBe("running");
    expect(result.snapshot.complete).toBe(true);
    expect(list).toHaveBeenCalledOnce();
  });

  it("does not overlap managed SSH reconciliation ticks", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((jobs: []) => void) | undefined;
    const list = vi.fn(() => new Promise<[]>(resolve => { resolveFirst = resolve; }));
    const stop = startManagedSlurmReconciler(config, 10, () => undefined, list);

    try {
      await vi.advanceTimersByTimeAsync(50);
      expect(list).toHaveBeenCalledOnce();

      resolveFirst?.([]);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10);
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("does not release an absent allocation when the managed SSH snapshot fails", async () => {
    const allocation = store.createSlurmAllocation({
      idempotency_key: "snapshot-failure", managed_target_id: "slurm-a16", requested_resources: {},
      job_name: "snapshot-failure", owner: "tester", managed_by: "alchemy", pinned: false,
      state: "running", job_id: "4242",
    });

    const result = await reconcileManagedSlurmSnapshot(config, async () => {
      throw new Error("ssh unavailable");
    });

    expect(result.snapshot.complete).toBe(false);
    expect(store.getSlurmAllocation(allocation.id)?.state).toBe("running");
  });

  it("routes managed cancellation through the configured target SSH backend", async () => {
    const allocation = store.createSlurmAllocation({
      idempotency_key: "managed-ssh-cancel", managed_target_id: "slurm-a16", requested_resources: {},
      job_name: "managed-ssh-cancel", owner: "tester", managed_by: "alchemy", pinned: false,
      state: "running", job_id: "4242",
    });
    const stop = vi.fn(async () => ({ ok: true, target: "slurm-a16", job_id: "4242" }));

    const result = await cancelManagedSlurmAllocation(config, allocation, stop);

    expect(result).toEqual({ ok: true });
    expect(stop).toHaveBeenCalledWith(config.stubs[0], config.ssh?.key_path, "4242");
  });

  it("rejects non-numeric job IDs before invoking the managed SSH backend", async () => {
    const allocation = store.createSlurmAllocation({
      idempotency_key: "unsafe-job-id", managed_target_id: "slurm-a16", requested_resources: {},
      job_name: "unsafe-job-id", owner: "tester", managed_by: "alchemy", pinned: false,
      state: "running", job_id: "4242; touch /tmp/pwned",
    });
    const stop = vi.fn();

    const result = await cancelManagedSlurmAllocation(config, allocation, stop);

    expect(result).toEqual({ ok: false, error: "Invalid SLURM job ID" });
    expect(stop).not.toHaveBeenCalled();
  });

  it("does not reinterpret a persisted target ID through another target alias", async () => {
    const allocation = store.createSlurmAllocation({
      idempotency_key: "retired-target", managed_target_id: "retired-target", requested_resources: {},
      job_name: "retired-target", owner: "tester", managed_by: "alchemy", pinned: false,
      state: "running", job_id: "4242",
    });
    const replacementConfig: DeployFileConfig = {
      ...config,
      stubs: [{ ...config.stubs[0], name: "replacement-target", aliases: ["retired-target"] }],
    };
    const stop = vi.fn();

    const result = await cancelManagedSlurmAllocation(replacementConfig, allocation, stop);

    expect(result).toEqual({ ok: false, error: "Managed SLURM target unavailable" });
    expect(stop).not.toHaveBeenCalled();
  });

  it("rejects managed cancellation when the canonical target is unavailable", async () => {
    const allocation = store.createSlurmAllocation({
      idempotency_key: "missing-target", managed_target_id: "missing-target", requested_resources: {},
      job_name: "missing-target", owner: "tester", managed_by: "alchemy", pinned: false,
      state: "running", job_id: "job-missing-target",
    });
    const stop = vi.fn();

    const result = await cancelManagedSlurmAllocation(config, allocation, stop);

    expect(result).toEqual({ ok: false, error: "Managed SLURM target unavailable" });
    expect(stop).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous job-ID cancellation reference across targets", async () => {
    const first = store.createSlurmAllocation({
      idempotency_key: "cancel-collision-a", managed_target_id: "slurm-a16", requested_resources: {},
      job_name: "cancel-collision-a", owner: "tester", managed_by: "alchemy", pinned: false,
      state: "running", job_id: "4242",
    });
    const second = { ...first, id: "cancel-collision-b", idempotency_key: "cancel-collision-b", managed_target_id: "slurm-a30" };
    const allocations = vi.spyOn(store, "getSlurmAllocations").mockReturnValue([first, second]);
    const cancel = vi.fn(async () => ({ ok: true }));
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config, {
      cancel,
      prepareRelease: vi.fn(async () => undefined),
    }));

    try {
      const response = await request(app).post("/capacity/allocations/cancel")
        .send({ allocations: ["4242"], apply: true }).expect(409);
      expect(response.body.error).toBe("Ambiguous allocation reference");
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      allocations.mockRestore();
    }
  });

  it("bulk cancellation is dry-run by default and excludes manual or pinned jobs", async () => {
    const cancel = vi.fn(async () => ({ ok: true }));
    const prepareRelease = vi.fn(async () => undefined);
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config, { cancel, prepareRelease }));
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
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ job_id: "job-managed", managed_target_id: "slurm-a16" }));
  });

  it("returns 503 without releasing an allocation when the cancellation backend rejects", async () => {
    const allocation = store.createSlurmAllocation({
      idempotency_key: "backend-offline", managed_target_id: "slurm-a16", requested_resources: {},
      job_name: "backend-offline", owner: "tester", managed_by: "alchemy", pinned: false,
      state: "running", job_id: "job-backend-offline",
    });
    const cancel = vi.fn(async () => {
      throw new Error("SSH backend unavailable");
    });
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config, {
      cancel,
      prepareRelease: vi.fn(async () => undefined),
    }));

    const response = await request(app).post("/capacity/allocations/cancel")
      .send({ allocations: [allocation.id], apply: true }).expect(503);

    expect(response.body).toEqual(expect.objectContaining({
      error: "SLURM cancellation backend unavailable",
      dry_run: false,
      cancelled: [],
      skipped: [{ id: allocation.id, reason: "cancel_backend_unavailable" }],
    }));
    expect(JSON.stringify(response.body)).not.toContain("SSH backend unavailable");
    expect(store.getSlurmAllocation(allocation.id)?.state).toBe("running");
  });

  it("returns 503 without cancelling when the release admission barrier rejects", async () => {
    const allocation = store.createSlurmAllocation({
      idempotency_key: "drain-offline", managed_target_id: "slurm-a16", requested_resources: {},
      job_name: "drain-offline", owner: "tester", managed_by: "alchemy", pinned: false,
      state: "running", job_id: "job-drain-offline",
    });
    const cancel = vi.fn(async () => ({ ok: true }));
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config, {
      cancel,
      prepareRelease: vi.fn(async () => {
        throw new Error("Stub acknowledgement timeout");
      }),
    }));

    const response = await request(app).post("/capacity/allocations/cancel")
      .send({ allocations: [allocation.id], apply: true }).expect(503);

    expect(response.body).toEqual(expect.objectContaining({
      error: "Release admission barrier unavailable",
      dry_run: false,
      cancelled: [],
      skipped: [{ id: allocation.id, reason: "release_admission_unavailable" }],
    }));
    expect(JSON.stringify(response.body)).not.toContain("Stub acknowledgement timeout");
    expect(cancel).not.toHaveBeenCalled();
    expect(store.getSlurmAllocation(allocation.id)?.state).toBe("running");
  });

  it("blocks release while an owned campaign is unresolved", async () => {
    const allocation = store.createSlurmAllocation({
      idempotency_key: "busy-campaign", managed_target_id: "slurm-a16", requested_resources: {},
      job_name: "busy", owner: "tester", managed_by: "alchemy", pinned: false, state: "running", job_id: "job-busy",
      capacity_lease_id: "lease-busy",
    });
    store.createCapacityCampaign({
      name: "busy", state: "wait_dag", target_id: "slurm-a16", frozen_spec_hash: "sha256:x",
      capacity_lease_id: "lease-busy", allocation_id: allocation.id, attempts: 0, max_attempts: 2, max_runtime_seconds: 60,
    });
    const cancel = vi.fn(async () => ({ ok: true }));
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config, { cancel, prepareRelease: vi.fn(async () => undefined) }));

    const preview = await request(app).post("/capacity/allocations/cancel").send({ allocations: [allocation.id] }).expect(200);
    expect(preview.body.eligible).toHaveLength(0);
    expect(preview.body.skipped[0].reason).toBe("campaign_unresolved");
    await request(app).post("/capacity/allocations/cancel").send({ allocations: [allocation.id], apply: true }).expect(200);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("persists campaign transitions and rejects skipped states", async () => {
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config));
    const created = await request(app).post("/capacity/campaigns").send({
      name: "jema-d1", target_id: "slurm-a16", frozen_manifest: frozenManifest,
      max_attempts: 2, max_runtime_seconds: 3600,
    }).expect(201);
    expect(created.body.state).toBe("acquire");
    expect(created.body.alias).toMatch(/^camp-/);
    await request(app).post(`/capacity/campaigns/${created.body.id}/advance`)
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
    await request(app).post(`/capacity/campaigns/${created.body.alias}/advance`)
      .send({ to: "wait_stub", actor: "tester", allocation_id: owned.id }).expect(409);
    const failed = await request(app).post(`/capacity/campaigns/${created.body.alias}/advance`)
      .send({ to: "failed", actor: "tester", reason: "operator stop" }).expect(200);
    expect(failed.body.cleanup_required).toBe(true);
    expect(store.getCapacityCampaign(created.body.id)?.state).toBe("failed");
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

    const forgedResourcesApp = express(); forgedResourcesApp.use(express.json());
    forgedResourcesApp.use("/capacity", createCapacityRouter(config, {
      automation: {
        policy: { pool_id: "general", mode: "automatic", enabled: true, min_validated_snapshots: 1, max_total: 3, max_pending: 2, cooldown_seconds: 0 },
        recommendationProvider: async () => ({
          recommendation_id: "forged-resources", target: capacityTargets(config)[0],
          resources: { partition: "gpu-small", qos: "normal", gres: "gpu:h100:8" }, validated_snapshots: 2,
        }),
        acquire, release,
      },
    }));
    await request(forgedResourcesApp).post("/capacity/policy/reconcile").send({}).expect(503);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("records immutable intent and outcome around automatic mutations", async () => {
    const acquire = vi.fn(async () => ({ ok: true }));
    const automaticApp = express(); automaticApp.use(express.json());
    automaticApp.use("/capacity", createCapacityRouter(config, {
      automation: {
        policy: { pool_id: "general", mode: "automatic", enabled: true, min_validated_snapshots: 1, max_total: 2, max_pending: 2, cooldown_seconds: 0 },
        recommendationProvider: async () => ({
          recommendation_id: "verified-plan", target: capacityTargets(config)[0],
          resources: { partition: "gpu-small", qos: "normal" }, validated_snapshots: 5,
        }),
        acquire,
        release: vi.fn(),
      },
    }));

    await request(automaticApp).post("/capacity/policy/reconcile").send({}).expect(200);
    const events = store.getCapacityPolicyEvents();
    expect(events.map((event) => event.reason)).toEqual(["validated_recommendation", "apply_intent"]);
    expect(events[0]).toMatchObject({ applied: true, pool_id: "general", idempotency_key: expect.any(String) });
    expect(events[1]).toMatchObject({ applied: false, pool_id: "general", idempotency_key: events[0].idempotency_key });
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

  it("preserves capacity audit state and aliases across backup restore", () => {
    const allocation = store.createSlurmAllocation({
      idempotency_key: "backup-allocation", managed_target_id: "slurm-a16", requested_resources: {},
      job_name: "backup", owner: "tester", managed_by: "alchemy", pinned: false, state: "pending",
    });
    const campaign = store.createCapacityCampaign({
      name: "backup-campaign", state: "wait_stub", target_id: "slurm-a16", frozen_spec_hash: "sha256:backup",
      capacity_lease_id: "lease-backup", allocation_id: allocation.id, attempts: 0, max_attempts: 2,
      max_runtime_seconds: 60,
    });
    store.appendCapacityPolicyEvents([{
      kind: "acquire", applied: false, reason: "backup-test", actor: "capacity_policy", mode: "recommend",
      target_id: "slurm-a16",
    }]);
    store.disableCapacityPolicy("general");
    const state = store.exportState();

    store.reset();
    store.loadFromState(state);

    expect(store.resolveObjectRef(allocation.alias!, "slurm_allocation")).toMatchObject({ id: allocation.id });
    expect(store.getSlurmAllocation(allocation.id)).toMatchObject({ id: allocation.id });
    expect(store.getCapacityCampaign(campaign.alias!)).toMatchObject({ id: campaign.id });
    expect(store.getCapacityPolicyEvents()).toHaveLength(1);
    expect(store.isCapacityPolicyDisabled("general")).toBe(true);
  });

  it("validates restore before mutation and never rolls back an active kill switch", () => {
    store.createSlurmAllocation({
      idempotency_key: "existing", managed_target_id: "slurm-a16", requested_resources: {},
      job_name: "existing", owner: "tester", managed_by: "alchemy", pinned: false, state: "pending",
    });
    const before = store.exportState();
    expect(() => store.loadFromState({ ...before, stubs: "broken" } as any)).toThrow(/invalid backup/i);
    expect(store.exportState().slurm_allocations).toEqual(before.slurm_allocations);

    const preDisableBackup = store.exportState();
    store.disableCapacityPolicy("general");
    store.loadFromState(preDisableBackup);
    expect(store.isCapacityPolicyDisabled("general")).toBe(true);
  });

  it("persists a frozen campaign manifest under its canonical content hash", async () => {
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config));

    const created = await request(app).post("/capacity/campaigns").send({
      name: "frozen", target_id: "slurm-a16", frozen_manifest: frozenManifest,
    }).expect(201);

    expect(created.body.frozen_spec_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(created.body.frozen_manifest).toEqual(frozenManifest);
    expect(store.getCapacityCampaign(created.body.id)?.frozen_manifest).toEqual(frozenManifest);
  });

  it("keeps legacy hash-only creation compatible, canonicalizes target aliases, and owns the lease", async () => {
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config));

    const legacy = await request(app).post("/capacity/campaigns").send({
      name: "legacy", target_id: "a16", frozen_spec_hash: "sha256:legacy",
    }).expect(201);
    expect(legacy.body).toMatchObject({ target_id: "slurm-a16", frozen_spec_hash: "sha256:legacy" });
    expect(legacy.body.capacity_lease_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(legacy.body.frozen_manifest).toBeUndefined();

    await request(app).post("/capacity/campaigns").send({
      name: "forged-lease", target_id: "a16", frozen_manifest: frozenManifest, capacity_lease_id: "caller-owned",
    }).expect(400);
  });

  it("enforces globally unique immutable campaign lease identities", () => {
    store.createCapacityCampaign({
      name: "first", state: "acquire", target_id: "slurm-a16", frozen_spec_hash: "sha256:first",
      capacity_lease_id: "unique-lease", attempts: 0, max_attempts: 1, max_runtime_seconds: 60,
    });
    expect(() => store.createCapacityCampaign({
      name: "second", state: "acquire", target_id: "slurm-a16", frozen_spec_hash: "sha256:second",
      capacity_lease_id: "unique-lease", attempts: 0, max_attempts: 1, max_runtime_seconds: 60,
    })).toThrow(/already belongs/i);
  });

  it("rejects a caller hash that does not match the frozen manifest", async () => {
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config));

    await request(app).post("/capacity/campaigns").send({
      name: "forged", target_id: "slurm-a16", frozen_manifest: frozenManifest,
      frozen_spec_hash: `sha256:${"0".repeat(64)}`,
    }).expect(409);
    expect(store.getCapacityCampaigns()).toHaveLength(0);
  });

  it("exposes start, cancellation, and immutable transition events", async () => {
    const campaignDriver = {
      acquire: vi.fn(async () => ({ allocation_id: "allocation-start" })),
      observeStub: vi.fn(), runSmoke: vi.fn(), submitDag: vi.fn(), observeDag: vi.fn(),
      drain: vi.fn(), release: vi.fn(), closeout: vi.fn(), cleanup: vi.fn(async () => ({ cleaned: false })),
    } as unknown as CampaignDriver;
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config, { campaignDriver }));
    const created = await request(app).post("/capacity/campaigns").send({
      name: "lifecycle", target_id: "slurm-a16", frozen_manifest: frozenManifest,
    }).expect(201);
    store.createSlurmAllocation({
      id: "allocation-start", idempotency_key: "start", campaign_id: created.body.id,
      capacity_lease_id: created.body.capacity_lease_id, managed_target_id: "slurm-a16", requested_resources: {},
      job_name: "start", owner: "tester", managed_by: "alchemy", pinned: false, state: "requested",
    });

    const started = await request(app).post(`/capacity/campaigns/${created.body.id}/start`).expect(200);
    expect(started.body.state).toBe("wait_stub");
    const cancelled = await request(app).post(`/capacity/campaigns/${created.body.id}/cancel`)
      .send({ reason: "operator stop" }).expect(202);
    expect(cancelled.body).toMatchObject({ state: "failed", cleanup_required: true });
    const events = await request(app).get(`/capacity/campaigns/${created.body.id}/events`).expect(200);
    expect(events.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "acquire", to: "wait_stub", actor: "campaign_reconciler" }),
      expect.objectContaining({ from: "wait_stub", to: "failed", actor: "operator", reason: "operator stop" }),
    ]));
  });

  it("retains a cleanup obligation when an owned allocation is pinned", async () => {
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config));
    const created = await request(app).post("/capacity/campaigns").send({
      name: "pinned-lifecycle", target_id: "slurm-a16", frozen_manifest: frozenManifest,
    }).expect(201);
    store.createSlurmAllocation({
      idempotency_key: "pinned-campaign", campaign_id: created.body.id,
      capacity_lease_id: created.body.capacity_lease_id, managed_target_id: "slurm-a16", requested_resources: {},
      job_name: "pinned", owner: "tester", managed_by: "alchemy", pinned: true, state: "running", job_id: "9002",
    });

    const cancelled = await request(app).post(`/capacity/campaigns/${created.body.id}/cancel`).expect(202);
    expect(cancelled.body).toMatchObject({ state: "failed", cleanup_required: true });
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
      name: "automated", target_id: "slurm-a16", frozen_manifest: frozenManifest,
    }).expect(201);
    store.createSlurmAllocation({
      id: "allocation-1", idempotency_key: "automated-acquire", campaign_id: created.body.id,
      capacity_lease_id: created.body.capacity_lease_id, managed_target_id: "slurm-a16", requested_resources: {},
      job_name: "automated", owner: "tester", managed_by: "alchemy", pinned: false, state: "requested",
    });

    const response = await request(app).post(`/capacity/campaigns/${created.body.id}/reconcile`).expect(200);

    expect(response.body.state).toBe("wait_stub");
    expect(campaignDriver.acquire).toHaveBeenCalledOnce();
  });

  it("rejects client-supplied global SLURM snapshots", async () => {
    const app = express(); app.use(express.json());
    app.use("/capacity", createCapacityRouter(config));
    const allocation = store.createSlurmAllocation({
      idempotency_key: "client-reconcile-rejected",
      campaign_id: "campaign-9001",
      capacity_lease_id: "lease-9001",
      managed_target_id: "slurm-a16",
      requested_resources: {},
      job_name: "jema-card-1",
      owner: "tester",
      managed_by: "alchemy",
      pinned: false,
      state: "running",
      job_id: "9001",
    });

    await request(app).post("/capacity/reconcile").send({ complete: true, jobs: [] }).expect(404);

    expect(store.getSlurmAllocation(allocation.id)?.state).toBe("running");
  });
});
