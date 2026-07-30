import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileActiveCampaigns, reconcileCampaign, startCampaignReconciler, type CampaignDriver } from "../campaigns/reconciler";
import { store } from "../store";

function createCampaign(overrides: Record<string, unknown> = {}) {
  const campaign = store.createCapacityCampaign({
    name: "safe-campaign",
    state: "acquire",
    target_id: "slurm-a16",
    frozen_spec_hash: "sha256:manifest",
    capacity_lease_id: "lease-1",
    max_attempts: 2,
    attempts: 0,
    max_runtime_seconds: 3600,
    ...overrides,
  });
  store.createSlurmAllocation({
    id: "allocation-1", idempotency_key: "campaign-acquire", campaign_id: campaign.id,
    capacity_lease_id: campaign.capacity_lease_id, managed_target_id: campaign.target_id,
    requested_resources: {}, job_name: "campaign", owner: "tester", managed_by: "alchemy",
    pinned: false, state: "requested",
  });
  return campaign;
}

function driver(overrides: Partial<CampaignDriver> = {}): CampaignDriver {
  return {
    acquire: vi.fn(async () => ({ allocation_id: "allocation-1" })),
    observeStub: vi.fn(async () => ({ online: false })),
    runSmoke: vi.fn(async () => ({ task_id: "smoke-1", status: "running" as const })),
    submitDag: vi.fn(async () => ({ experiment_id: "experiment-1" })),
    observeDag: vi.fn(async () => ({ status: "running" as const, active_task_ids: ["task-1"] })),
    drain: vi.fn(async () => ({ drained: true, active_task_ids: [] })),
    release: vi.fn(async (campaign) => {
      if (campaign.allocation_id) store.updateSlurmAllocation(campaign.allocation_id, { state: "released", released_at: new Date().toISOString() });
      return { released: true };
    }),
    closeout: vi.fn(async () => ({ closed: true, active_task_ids: [], allocations_terminal: true })),
    cleanup: vi.fn(async () => ({ cleaned: true })),
    ...overrides,
  };
}

beforeEach(() => store.reset());

describe("restart-safe campaign reconciliation", () => {
  it("drives the declared lifecycle with stable idempotency keys", async () => {
    const campaign = createCampaign();
    const d = driver();

    expect((await reconcileCampaign(campaign.id, d)).state).toBe("wait_stub");
    expect(d.acquire).toHaveBeenCalledWith(expect.objectContaining({ id: campaign.id }), `${campaign.id}:acquire`);

    vi.mocked(d.observeStub).mockResolvedValue({ online: true, stub_id: "stub-1" });
    expect((await reconcileCampaign(campaign.id, d)).state).toBe("cuda_smoke");
    expect((await reconcileCampaign(campaign.id, d)).state).toBe("cuda_smoke");
    expect(d.runSmoke).toHaveBeenCalledWith(expect.anything(), `${campaign.id}:cuda_smoke`);

    vi.mocked(d.runSmoke).mockResolvedValue({ task_id: "smoke-1", status: "completed" });
    expect((await reconcileCampaign(campaign.id, d)).state).toBe("submit_dag");
    expect((await reconcileCampaign(campaign.id, d)).state).toBe("wait_dag");
    expect(d.submitDag).toHaveBeenCalledWith(expect.anything(), `${campaign.id}:submit_dag`);

    vi.mocked(d.observeDag).mockResolvedValue({ status: "completed", active_task_ids: [] });
    expect((await reconcileCampaign(campaign.id, d)).state).toBe("drain");
    expect((await reconcileCampaign(campaign.id, d)).state).toBe("release");
    expect((await reconcileCampaign(campaign.id, d)).state).toBe("closeout");
    expect((await reconcileCampaign(campaign.id, d)).state).toBe("completed");
  });

  it("rejects an allocation returned for another campaign", async () => {
    const campaign = createCampaign();
    store.createSlurmAllocation({
      id: "foreign", idempotency_key: "foreign", campaign_id: "other", capacity_lease_id: "other-lease",
      managed_target_id: campaign.target_id, requested_resources: {}, job_name: "foreign", owner: "tester",
      managed_by: "alchemy", pinned: false, state: "requested",
    });
    const d = driver({ acquire: vi.fn(async () => ({ allocation_id: "foreign" })) });

    const result = await reconcileCampaign(campaign.id, d);

    expect(result.state).toBe("acquire");
    expect(result.last_error).toMatch(/ownership/i);
  });

  it("bounds retries and performs owned cleanup after a side-effect failure", async () => {
    const campaign = createCampaign({ max_attempts: 1 });
    const d = driver({ acquire: vi.fn(async () => { throw new Error("controller unavailable"); }) });

    const result = await reconcileCampaign(campaign.id, d);

    expect(result.state).toBe("failed");
    expect(result.attempts).toBe(1);
    expect(result.last_error).toContain("controller unavailable");
    expect(d.cleanup).toHaveBeenCalledWith(expect.objectContaining({ id: campaign.id }), `${campaign.id}:cleanup`);
  });

  it("reuses the same acquire key after an ambiguous timeout", async () => {
    const campaign = createCampaign();
    const d = driver();
    vi.mocked(d.acquire)
      .mockRejectedValueOnce(new Error("timeout after submit"))
      .mockResolvedValueOnce({ allocation_id: "allocation-1" });

    expect((await reconcileCampaign(campaign.id, d)).state).toBe("acquire");
    expect((await reconcileCampaign(campaign.id, d)).state).toBe("wait_stub");
    expect(vi.mocked(d.acquire).mock.calls.map((call) => call[1])).toEqual([
      `${campaign.id}:acquire`, `${campaign.id}:acquire`,
    ]);
  });

  it("retries persisted cleanup obligations without replaying the campaign", async () => {
    const campaign = createCampaign({ state: "failed", cleanup_required: true, last_error: "cleanup incomplete" });
    const d = driver({ cleanup: vi.fn(async () => ({ cleaned: true })) });

    const reconciled = await reconcileCampaign(campaign.id, d);

    expect(reconciled.state).toBe("failed");
    expect(reconciled.cleanup_required).toBe(false);
    expect(d.cleanup).toHaveBeenCalledWith(expect.objectContaining({ id: campaign.id }), `${campaign.id}:cleanup`);
    expect(d.acquire).not.toHaveBeenCalled();
  });

  it("persists unresolved cleanup obligations on failure", async () => {
    const campaign = createCampaign({ max_attempts: 1, allocation_id: "allocation-1" });
    const d = driver({
      acquire: vi.fn(async () => { throw new Error("controller unavailable"); }),
      cleanup: vi.fn(async () => ({ cleaned: false })),
    });

    const result = await reconcileCampaign(campaign.id, d);

    expect(result.state).toBe("failed");
    expect(result.cleanup_required).toBe(true);
  });

  it("fails expired campaigns without launching another side effect", async () => {
    const campaign = createCampaign({ max_runtime_seconds: 60 });
    store.updateCapacityCampaign(campaign.id, { created_at: "2000-01-01T00:00:00.000Z" });
    const d = driver();

    const result = await reconcileCampaign(campaign.id, d, new Date("2026-07-30T00:00:00.000Z"));

    expect(result.state).toBe("failed");
    expect(result.last_error).toContain("runtime limit");
    expect(d.acquire).not.toHaveBeenCalled();
    expect(d.cleanup).toHaveBeenCalledOnce();
  });

  it("never releases when drain still reports active canonical tasks", async () => {
    const campaign = createCampaign({ state: "drain" });
    const d = driver({ drain: vi.fn(async () => ({ drained: false, active_task_ids: ["task-live"] })) });

    const result = await reconcileCampaign(campaign.id, d);

    expect(result.state).toBe("drain");
    expect(d.release).not.toHaveBeenCalled();
  });

  it("automatically retries failed campaigns with cleanup obligations", async () => {
    createCampaign({ state: "failed", cleanup_required: true, last_error: "cleanup incomplete" });
    const d = driver({ cleanup: vi.fn(async () => ({ cleaned: true })) });

    const reconciled = await reconcileActiveCampaigns(d);

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].cleanup_required).toBe(false);
    expect(d.cleanup).toHaveBeenCalledOnce();
  });

  it("runs automated reconciliation serially and can be stopped", async () => {
    vi.useFakeTimers();
    createCampaign();
    let resolveAcquire!: (value: { allocation_id: string }) => void;
    const acquire = vi.fn(() => new Promise<{ allocation_id: string }>((resolve) => { resolveAcquire = resolve; }));
    const stop = startCampaignReconciler(driver({ acquire }), 100);
    await vi.advanceTimersByTimeAsync(500);
    expect(acquire).toHaveBeenCalledOnce();
    resolveAcquire({ allocation_id: "allocation-1" });
    await vi.runOnlyPendingTimersAsync();
    stop();
    vi.useRealTimers();
  });
});
