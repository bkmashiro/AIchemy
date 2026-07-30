import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileCampaign, startCampaignReconciler, type CampaignDriver } from "../campaigns/reconciler";
import { store } from "../store";

function createCampaign(overrides: Record<string, unknown> = {}) {
  return store.createCapacityCampaign({
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
}

function driver(overrides: Partial<CampaignDriver> = {}): CampaignDriver {
  return {
    acquire: vi.fn(async () => ({ allocation_id: "allocation-1" })),
    observeStub: vi.fn(async () => ({ online: false })),
    runSmoke: vi.fn(async () => ({ task_id: "smoke-1", status: "running" as const })),
    submitDag: vi.fn(async () => ({ experiment_id: "experiment-1" })),
    observeDag: vi.fn(async () => ({ status: "running" as const, active_task_ids: ["task-1"] })),
    drain: vi.fn(async () => ({ drained: true, active_task_ids: [] })),
    release: vi.fn(async () => ({ released: true })),
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
    expect(d.acquire).toHaveBeenCalledWith(expect.objectContaining({ id: campaign.id }), `${campaign.id}:acquire:1`);

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

  it("bounds retries and performs owned cleanup after a side-effect failure", async () => {
    const campaign = createCampaign({ max_attempts: 1 });
    const d = driver({ acquire: vi.fn(async () => { throw new Error("controller unavailable"); }) });

    const result = await reconcileCampaign(campaign.id, d);

    expect(result.state).toBe("failed");
    expect(result.attempts).toBe(1);
    expect(result.last_error).toContain("controller unavailable");
    expect(d.cleanup).toHaveBeenCalledWith(expect.objectContaining({ id: campaign.id }), `${campaign.id}:cleanup`);
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
