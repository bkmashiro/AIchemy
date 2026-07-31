import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTask } from "../api/tasks";
import { frozenCampaignManifestHash } from "../campaigns/manifest";
import { createProductionCampaignDriver, type CampaignSideEffects } from "../campaigns/production-driver";
import { store } from "../store";
import type { CapacityCampaign, FrozenCampaignManifest, SlurmAllocation } from "../types";

const manifest: FrozenCampaignManifest = {
  version: 1,
  smoke_task: { script: "/opt/python", argv: ["-c", "import torch"] },
  dag: { name: "formal", task_specs: [{ ref: "train", script: "/opt/python", argv: ["train.py"] }] },
};

function campaign(overrides: Partial<CapacityCampaign> = {}): CapacityCampaign {
  return store.createCapacityCampaign({
    name: "production-campaign", state: "acquire", target_id: "slurm-a16",
    frozen_spec_hash: frozenCampaignManifestHash(manifest), frozen_manifest: manifest,
    capacity_lease_id: "lease-1", max_attempts: 3, attempts: 0, max_runtime_seconds: 3600,
    ...overrides,
  });
}

function allocation(owner: CapacityCampaign, overrides: Partial<SlurmAllocation> = {}): SlurmAllocation {
  return store.createSlurmAllocation({
    id: "allocation-1", idempotency_key: "campaign-acquire", campaign_id: owner.id,
    capacity_lease_id: owner.capacity_lease_id, managed_target_id: owner.target_id,
    requested_resources: {}, job_name: "campaign", owner: "tester", managed_by: "alchemy",
    pinned: false, state: "stub_online", stub_id: "stub-1", job_id: "9001", ...overrides,
  });
}

function sideEffects(overrides: Partial<CampaignSideEffects> = {}): CampaignSideEffects {
  return {
    acquire: vi.fn(), submitSmoke: vi.fn(), submitDag: vi.fn(),
    drain: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => store.reset());

describe("production campaign driver", () => {
  it("recovers a persisted frozen smoke without resubmitting it", async () => {
    const owner = campaign({ state: "cuda_smoke", allocation_id: "allocation-1", stub_id: "stub-1" });
    allocation(owner);
    const task = createTask({
      script: "/opt/python", argv: ["-c", "import torch"], capacity_lease_id: owner.capacity_lease_id,
      target_stub_id: owner.stub_id, idempotency_key: `${owner.id}:cuda_smoke`,
    });
    store.addToGlobalQueue(task);
    const effects = sideEffects({ submitSmoke: vi.fn(async () => ({ task_id: task.id })) });
    const driver = createProductionCampaignDriver(effects);

    expect(await driver.runSmoke(owner, `${owner.id}:cuda_smoke`)).toMatchObject({ task_id: task.id, status: "running" });
    const persisted = store.updateCapacityCampaign(owner.id, { smoke_task_id: task.id })!;
    expect(await driver.runSmoke(persisted, `${owner.id}:cuda_smoke`)).toMatchObject({ task_id: task.id, status: "running" });
    expect(effects.submitSmoke).not.toHaveBeenCalled();
  });

  it("rejects execution fields omitted from the frozen smoke spec", async () => {
    const owner = campaign({ state: "cuda_smoke", stub_id: "stub-1" });
    const task = createTask({
      script: "/opt/python", argv: ["-c", "import torch"], env: { EXTRA: "forged" },
      capacity_lease_id: owner.capacity_lease_id, target_stub_id: owner.stub_id,
    });
    store.addToGlobalQueue(task);
    const effects = sideEffects({ submitSmoke: vi.fn(async () => ({ task_id: task.id })) });

    await expect(createProductionCampaignDriver(effects).runSmoke(owner, `${owner.id}:cuda_smoke`))
      .rejects.toThrow(/frozen execution spec/i);
  });

  it("rejects a smoke task outside the campaign lease before advancing", async () => {
    const owner = campaign({ state: "cuda_smoke", stub_id: "stub-1" });
    const task = createTask({ script: "/opt/python", capacity_lease_id: "foreign", target_stub_id: "stub-1" });
    store.addToGlobalQueue(task);
    const effects = sideEffects({ submitSmoke: vi.fn(async () => ({ task_id: task.id })) });

    await expect(createProductionCampaignDriver(effects).runSmoke(owner, `${owner.id}:cuda_smoke`))
      .rejects.toThrow(/ownership/i);
  });

  it("recovers a persisted frozen DAG without resubmitting it", async () => {
    const owner = campaign({ state: "submit_dag", stub_id: "stub-1" });
    const task = createTask({ script: "/opt/python", argv: ["train.py"], capacity_lease_id: owner.capacity_lease_id, target_stub_id: owner.stub_id, ref: "train" });
    store.addToGlobalQueue(task);
    store.setExperiment({
      id: "experiment-1", name: "formal", criteria: {}, grid_id: "", status: "running", results: {},
      created_at: new Date().toISOString(), task_refs: { train: task.id }, task_specs: manifest.dag.task_specs as any,
      sdk_spec: { campaign: { id: owner.id, capacity_lease_id: owner.capacity_lease_id, frozen_spec_hash: owner.frozen_spec_hash } },
    });
    const effects = sideEffects({ submitDag: vi.fn(async () => ({ experiment_id: "experiment-1" })) });
    const driver = createProductionCampaignDriver(effects);

    expect(await driver.submitDag(owner, `${owner.id}:submit_dag`)).toEqual({ experiment_id: "experiment-1" });
    expect(effects.submitDag).not.toHaveBeenCalled();
  });

  it("discovers a late exact-owned allocation even before its id reaches the campaign row", async () => {
    const owner = campaign({ state: "failed", cleanup_required: true });
    const allocation = store.createSlurmAllocation({
      idempotency_key: "late", campaign_id: owner.id, capacity_lease_id: owner.capacity_lease_id,
      managed_target_id: owner.target_id, requested_resources: {}, job_name: "late", owner: "tester",
      managed_by: "alchemy", pinned: false, state: "running",
    });
    const effects = sideEffects({
      release: vi.fn(async (_campaign, candidate) => {
        store.updateSlurmAllocation(candidate.id, { state: "released" });
      }),
    });

    await expect(createProductionCampaignDriver(effects).cleanup(owner, `${owner.id}:cleanup`))
      .resolves.toEqual({ cleaned: true });
    expect(effects.release).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: allocation.id }), `${owner.id}:cleanup:release:${allocation.id}`);
  });

  it("does not release while unrelated work remains active on the campaign stub", async () => {
    const owner = campaign({ state: "failed", allocation_id: "allocation-1", stub_id: "stub-1", cleanup_required: true });
    store.createSlurmAllocation({
      id: "allocation-1", idempotency_key: "owned", campaign_id: owner.id, capacity_lease_id: owner.capacity_lease_id,
      managed_target_id: owner.target_id, requested_resources: {}, job_name: "owned", owner: "tester",
      managed_by: "alchemy", pinned: false, state: "stub_online", stub_id: "stub-1",
    });
    const unrelated = createTask({ script: "/tmp/unrelated.py", target_stub_id: "stub-1" });
    unrelated.status = "running";
    unrelated.stub_id = "stub-1";
    store.addToGlobalQueue(unrelated);
    const effects = sideEffects();

    await expect(createProductionCampaignDriver(effects).cleanup(owner, `${owner.id}:cleanup`))
      .resolves.toEqual({ cleaned: false });
    expect(effects.drain).toHaveBeenCalledOnce();
    expect(effects.release).not.toHaveBeenCalled();
  });

  it("never drains or releases a pinned campaign allocation", async () => {
    const owner = campaign({ state: "failed", allocation_id: "allocation-1", stub_id: "stub-1", cleanup_required: true });
    allocation(owner, { pinned: true });
    const effects = sideEffects();
    const driver = createProductionCampaignDriver(effects);

    await expect(driver.cleanup?.(owner, "cleanup-key")).rejects.toThrow("not releasable");
    expect(effects.drain).not.toHaveBeenCalled();
    expect(effects.release).not.toHaveBeenCalled();
  });

  it("validates allocation ownership before cleanup side effects", async () => {
    const owner = campaign({ state: "failed", allocation_id: "allocation-1", stub_id: "stub-1", cleanup_required: true });
    allocation(owner, { campaign_id: "foreign" });
    const effects = sideEffects();

    await expect(createProductionCampaignDriver(effects).cleanup(owner, `${owner.id}:cleanup`))
      .rejects.toThrow(/ownership/i);
    expect(effects.drain).not.toHaveBeenCalled();
    expect(effects.release).not.toHaveBeenCalled();
  });
});
