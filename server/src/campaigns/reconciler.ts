import { store } from "../store";
import type { CapacityCampaign, CampaignState } from "../types";

export interface CampaignDriver {
  acquire(campaign: CapacityCampaign, idempotencyKey: string): Promise<{ allocation_id: string }>;
  observeStub(campaign: CapacityCampaign): Promise<{ online: boolean; stub_id?: string }>;
  runSmoke(campaign: CapacityCampaign, idempotencyKey: string): Promise<{ task_id: string; status: "running" | "completed" | "failed"; error?: string }>;
  submitDag(campaign: CapacityCampaign, idempotencyKey: string): Promise<{ experiment_id: string }>;
  observeDag(campaign: CapacityCampaign): Promise<{ status: "running" | "completed" | "failed"; active_task_ids: string[]; error?: string }>;
  drain(campaign: CapacityCampaign, idempotencyKey: string): Promise<{ drained: boolean; active_task_ids: string[] }>;
  release(campaign: CapacityCampaign, idempotencyKey: string): Promise<{ released: boolean }>;
  closeout(campaign: CapacityCampaign): Promise<{ closed: boolean; active_task_ids: string[]; allocations_terminal: boolean }>;
  cleanup(campaign: CapacityCampaign, idempotencyKey: string): Promise<{ cleaned: boolean }>;
}

function update(
  campaign: CapacityCampaign,
  to: CampaignState,
  patch: Partial<CapacityCampaign> = {},
  reason?: string,
): CapacityCampaign {
  if (campaign.state === to && Object.keys(patch).length === 0) return campaign;
  const at = new Date().toISOString();
  return store.updateCapacityCampaign(campaign.id, {
    ...patch,
    state: to,
    history: campaign.state === to ? campaign.history : [...campaign.history, {
      at,
      from: campaign.state,
      to,
      actor: "campaign_reconciler",
      reason,
    }],
  })!;
}

async function fail(
  campaign: CapacityCampaign,
  driver: CampaignDriver,
  reason: string,
  attempts = campaign.attempts,
): Promise<CapacityCampaign> {
  let cleanupError: string | undefined;
  let cleanupRequired = true;
  try {
    const result = await driver.cleanup(campaign, `${campaign.id}:cleanup`);
    cleanupRequired = !result.cleaned;
    if (cleanupRequired) cleanupError = "; cleanup incomplete";
  } catch (error) {
    cleanupError = `; cleanup failed: ${String(error)}`;
  }
  return update(campaign, "failed", {
    attempts,
    cleanup_required: cleanupRequired,
    last_error: `${reason}${cleanupError ?? ""}`,
  }, reason);
}

/** Performs at most one persisted campaign state transition. Safe to call after restart. */
export async function reconcileCampaign(
  campaignRef: string,
  driver: CampaignDriver,
  now = new Date(),
): Promise<CapacityCampaign> {
  const campaign = store.getCapacityCampaign(campaignRef);
  if (!campaign) throw new Error(`Campaign not found: ${campaignRef}`);
  if (campaign.state === "completed") return campaign;
  if (campaign.state === "failed") {
    if (!campaign.cleanup_required) return campaign;
    try {
      const result = await driver.cleanup(campaign, `${campaign.id}:cleanup`);
      return result.cleaned
        ? store.updateCapacityCampaign(campaign.id, { cleanup_required: false })!
        : campaign;
    } catch (error) {
      return store.updateCapacityCampaign(campaign.id, {
        last_error: `${campaign.last_error ?? "Campaign failed"}; cleanup retry failed: ${String(error)}`,
      })!;
    }
  }

  const ageMs = now.getTime() - new Date(campaign.created_at).getTime();
  if (!Number.isFinite(ageMs) || ageMs >= campaign.max_runtime_seconds * 1000) {
    return fail(campaign, driver, `Campaign runtime limit exceeded (${campaign.max_runtime_seconds}s)`);
  }

  try {
    switch (campaign.state) {
      case "acquire": {
        const attempt = campaign.attempts + 1;
        if (attempt > campaign.max_attempts) return fail(campaign, driver, "Campaign retry limit exceeded");
        const result = await driver.acquire(campaign, `${campaign.id}:acquire`);
        return update(campaign, "wait_stub", { allocation_id: result.allocation_id, attempts: attempt });
      }
      case "wait_stub": {
        const observation = await driver.observeStub(campaign);
        return observation.online && observation.stub_id
          ? update(campaign, "cuda_smoke", { stub_id: observation.stub_id })
          : campaign;
      }
      case "cuda_smoke": {
        const result = await driver.runSmoke(campaign, `${campaign.id}:cuda_smoke`);
        if (result.status === "failed") return fail(campaign, driver, result.error ?? "CUDA smoke failed");
        if (result.status === "completed") return update(campaign, "submit_dag", { smoke_task_id: result.task_id });
        if (campaign.smoke_task_id !== result.task_id) {
          return update(campaign, "cuda_smoke", { smoke_task_id: result.task_id });
        }
        return campaign;
      }
      case "submit_dag": {
        const result = await driver.submitDag(campaign, `${campaign.id}:submit_dag`);
        return update(campaign, "wait_dag", { experiment_id: result.experiment_id });
      }
      case "wait_dag": {
        const result = await driver.observeDag(campaign);
        if (result.status === "failed") return fail(campaign, driver, result.error ?? "Campaign DAG failed");
        return result.status === "completed" && result.active_task_ids.length === 0
          ? update(campaign, "drain")
          : campaign;
      }
      case "drain": {
        const result = await driver.drain(campaign, `${campaign.id}:drain`);
        return result.drained && result.active_task_ids.length === 0 ? update(campaign, "release") : campaign;
      }
      case "release": {
        const result = await driver.release(campaign, `${campaign.id}:release`);
        return result.released ? update(campaign, "closeout") : campaign;
      }
      case "closeout": {
        const result = await driver.closeout(campaign);
        return result.closed && result.active_task_ids.length === 0 && result.allocations_terminal
          ? update(campaign, "completed")
          : campaign;
      }
      default:
        return fail(campaign, driver, `Unsupported campaign state: ${String(campaign.state)}`);
    }
  } catch (error) {
    const attempts = campaign.attempts + 1;
    if (attempts >= campaign.max_attempts) return fail(campaign, driver, String(error), attempts);
    return store.updateCapacityCampaign(campaign.id, { attempts, last_error: String(error) })!;
  }
}

export async function reconcileActiveCampaigns(driver: CampaignDriver): Promise<CapacityCampaign[]> {
  const results: CapacityCampaign[] = [];
  for (const campaign of store.getCapacityCampaigns().filter((item) => !["completed", "failed"].includes(item.state))) {
    results.push(await reconcileCampaign(campaign.id, driver));
  }
  return results;
}

/** Starts a serial, non-overlapping campaign loop. */
export function startCampaignReconciler(
  driver: CampaignDriver,
  intervalMs = 5_000,
  onError: (error: unknown) => void = () => undefined,
): () => void {
  let stopped = false;
  let running = false;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await reconcileActiveCampaigns(driver);
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref?.();
  void run();
  return () => { stopped = true; clearInterval(timer); };
}
