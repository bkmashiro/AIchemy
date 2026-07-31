import { Router, Request, Response } from "express";
import { createHash, randomUUID } from "crypto";
import { deployStub, type SlurmSubmitOptions } from "../deploy";
import { store } from "../store";
import type { CapacityTarget, DeployFileConfig, DeployResult, SlurmAllocation, StubTarget } from "../types";
import { frozenCampaignManifestHash, parseFrozenCampaignManifest } from "../campaigns/manifest";
import { reconcileCampaign, type CampaignDriver } from "../campaigns/reconciler";
import {
  reconcileCapacityPolicy,
  type CapacityAutomationPolicy,
  type CapacityPolicyAction,
  type ValidatedRecommendation,
} from "../capacity/automation";

export type CapacitySubmitter = (
  target: StubTarget,
  serverUrl: string,
  token: string,
  sshKeyPath?: string,
  stubLocalPath?: string,
  overrides?: SlurmSubmitOptions,
) => Promise<DeployResult>;
export type CapacityCanceller = (jobId: string) => Promise<{ ok: boolean; error?: string }>;

export function sanitizeSlurmJobName(value: string): string {
  const normalized = value.trim().toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 64);
  return normalized || "alchemy-stub";
}

export function capacityTargets(config: DeployFileConfig | null): CapacityTarget[] {
  if (!config) return [];
  return config.stubs.filter((target) => target.type === "slurm").map((target) => ({
    id: target.name,
    aliases: target.aliases ?? [target.name.replace(/^slurm-/, "")],
    partition: target.partition,
    gres: target.gres,
    gpu_class: target.gpu_class ?? target.name.replace(/^.*slurm-/, "").toUpperCase(),
    gpu_mem_mb: target.gpu_mem_mb,
    qos: target.qos,
    default_mem: target.mem,
    default_walltime: target.time,
    tags: (target.tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
    enabled: target.enabled !== false,
    controller_capability: target.controller_capability ?? "slurm",
  }));
}

function findTarget(config: DeployFileConfig | null, ref: string): StubTarget | undefined {
  return config?.stubs.find((target) => target.type === "slurm" && (
    target.name === ref || (target.aliases ?? [target.name.replace(/^slurm-/, "")]).includes(ref)
  ));
}

export interface CapacityRecommendation {
  target: CapacityTarget;
  score: number;
  reasons: string[];
  observed: Record<string, unknown>;
}

export interface CapacityRejection {
  target_id: string;
  reasons: string[];
}

export function capacityTargetRejections(
  target: CapacityTarget,
  resources: Record<string, unknown>,
): string[] {
  const reasons: string[] = [];
  const explicitPartition = typeof resources.partition === "string" ? resources.partition : undefined;
  const explicitQos = typeof resources.qos === "string" ? resources.qos : undefined;
  const gpuClass = typeof resources.gpu_class === "string" ? resources.gpu_class.toUpperCase() : undefined;
  const minMemory = Number(resources.gpu_mem_mb ?? 0);
  const allowed = new Set(["partition", "qos", "gpu_class", "gpu_mem_mb", "gres", "gpus", "mem", "time"]);
  for (const key of Object.keys(resources)) if (!allowed.has(key)) reasons.push(`unsupported resource field ${key}`);
  if (target.enabled === false) reasons.push("target disabled");
  if (explicitPartition && target.partition !== explicitPartition) reasons.push(`partition ${target.partition ?? "unspecified"} != ${explicitPartition}`);
  if (explicitQos && target.qos !== explicitQos) reasons.push(`qos ${target.qos ?? "default"} != ${explicitQos}`);
  if (gpuClass && target.gpu_class?.toUpperCase() !== gpuClass) reasons.push(`gpu_class ${target.gpu_class ?? "unknown"} != ${gpuClass}`);
  if (minMemory && (target.gpu_mem_mb ?? 0) < minMemory) reasons.push(`gpu_mem_mb ${target.gpu_mem_mb ?? 0} < ${minMemory}`);
  if (resources.gres !== undefined && resources.gres !== target.gres) reasons.push(`gres ${String(resources.gres)} != ${target.gres ?? "unspecified"}`);
  const configuredGpus = Number(target.gres?.match(/:(\d+)$/)?.[1] ?? 1);
  if (resources.gpus !== undefined && Number(resources.gpus) !== configuredGpus) reasons.push(`gpus ${String(resources.gpus)} != ${configuredGpus}`);
  if (resources.mem !== undefined && resources.mem !== target.default_mem) reasons.push(`mem ${String(resources.mem)} != ${target.default_mem ?? "unspecified"}`);
  if (resources.time !== undefined && resources.time !== target.default_walltime) reasons.push(`time ${String(resources.time)} != ${target.default_walltime ?? "unspecified"}`);
  return reasons;
}

export function recommendCapacity(
  targets: CapacityTarget[],
  resources: Record<string, unknown>,
  snapshot: { partitions?: Array<Record<string, unknown>> },
): CapacityRecommendation[] {
  const explicitQos = typeof resources.qos === "string" ? resources.qos : undefined;
  const partitions = new Map((snapshot.partitions ?? []).map((item) => [String(item.name), item]));

  return targets.filter((target) => capacityTargetRejections(target, resources).length === 0)
    .map((target) => {
      const observed = partitions.get(String(target.partition)) ?? {};
      const available = Number(observed.available_gpus ?? 0);
      const pending = Number(observed.pending_jobs ?? 0);
      return {
        target,
        score: available * 100 - pending * 10,
        reasons: [
          `matches gpu_class=${target.gpu_class ?? "unknown"}`,
          `preserves partition=${target.partition ?? "unspecified"}`,
          `observed available_gpus=${available}, pending_jobs=${pending}`,
          explicitQos ? `preserves explicit qos=${explicitQos}` : `uses configured qos=${target.qos ?? "default"}`,
        ],
        observed,
      };
    })
    .sort((a, b) => b.score - a.score || a.target.id.localeCompare(b.target.id));
}

export function reconcileSlurmAllocations(
  jobs: Array<{ job_id?: string; state?: string; partition?: string; name?: string; reason?: string; predicted_start_at?: string; eligible_at?: string }>,
  complete: boolean,
): { reconciled: Array<ReturnType<typeof store.updateSlurmAllocation>>; observed_jobs: number; observed_at: string } {
  const jobsById = new Map(jobs.filter((job) => job.job_id).map((job) => [String(job.job_id), job]));
  const jobsByName = new Map(jobs.filter((job) => job.name).map((job) => [String(job.name), job]));
  const now = new Date().toISOString();
  const reconciled = store.getSlurmAllocations().map((allocation) => {
    const job = allocation.job_id ? jobsById.get(allocation.job_id) : jobsByName.get(allocation.job_name);
    let state = allocation.state;
    if (job) {
      const slurmState = String(job.state ?? "").toUpperCase();
      if (slurmState === "RUNNING") state = "running";
      else if (["PENDING", "CONFIGURING", "COMPLETING"].includes(slurmState)) state = "pending";
      else if (["COMPLETED", "CANCELLED", "FAILED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL"].includes(slurmState)) state = "released";
    } else if (complete && ["pending", "running", "stub_online", "draining"].includes(state)) {
      state = "released";
    } else if (complete && !allocation.job_id && ["requested", "failed"].includes(state)) {
      state = "failed";
    }
    const observedJobId = job?.job_id ? String(job.job_id) : allocation.job_id;
    const stub = observedJobId
      ? store.getAllStubs().find((candidate) => candidate.slurm_job_id === observedJobId)
      : undefined;
    if (state === "running" && stub?.status === "online") state = "stub_online";
    if (stub && ["released", "failed"].includes(state)) {
      stub.released = true;
      stub.status = "offline";
      stub.max_concurrent = 0;
      stub.slurm_allocation_id = undefined;
      stub.capacity_lease_id = undefined;
      stub.campaign_id = undefined;
      store.setStub(stub);
    } else if (stub && stub.slurm_allocation_id !== allocation.id) {
      stub.slurm_allocation_id = allocation.id;
      stub.capacity_lease_id = allocation.capacity_lease_id;
      stub.campaign_id = allocation.campaign_id;
      store.setStub(stub);
    }
    return store.updateSlurmAllocation(allocation.id, {
      state,
      job_id: observedJobId,
      partition: job?.partition ?? allocation.partition,
      stub_id: stub?.id ?? allocation.stub_id,
      last_observed_at: now,
      raw_state: job?.state ?? allocation.raw_state,
      queue_reason: job?.reason ?? allocation.queue_reason,
      predicted_start_at: job?.predicted_start_at ?? allocation.predicted_start_at,
      eligible_at: job?.eligible_at ?? allocation.eligible_at,
      error: !job && complete && !allocation.job_id && ["requested", "failed"].includes(allocation.state)
        ? "controller_verified_absent" : allocation.error,
    });
  });
  return { reconciled, observed_jobs: jobs.length, observed_at: now };
}

function releaseBlockReason(allocation: SlurmAllocation): string | undefined {
  if (allocation.pinned) return "pinned";
  if (allocation.managed_by !== "alchemy") return "manual";
  if (!allocation.job_id || ["released", "failed"].includes(allocation.state)) return "inactive_or_missing_job";
  const busy = store.getActiveTasks().some((task) =>
    (allocation.stub_id && task.stub_id === allocation.stub_id)
    || (allocation.capacity_lease_id && task.capacity_lease_id === allocation.capacity_lease_id),
  );
  if (busy) return "busy";
  const unresolved = store.getCapacityCampaigns().some((campaign) =>
    campaign.state !== "completed" && (campaign.allocation_id === allocation.id
      || Boolean(allocation.capacity_lease_id && campaign.capacity_lease_id === allocation.capacity_lease_id)),
  );
  return unresolved ? "campaign_unresolved" : undefined;
}

function auditSafeResources(resources?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!resources) return undefined;
  const allowed = new Set(["partition", "qos", "gres", "gpu_class", "gpu_mem_mb", "gpus", "mem", "time"]);
  return Object.fromEntries(Object.entries(resources).filter(([key]) => allowed.has(key)));
}

export function createCapacityRouter(
  config: DeployFileConfig | null,
  dependencies: {
    submit?: CapacitySubmitter;
    cancel?: CapacityCanceller;
    prepareRelease?: (allocation: SlurmAllocation) => Promise<void>;
    campaignDriver?: CampaignDriver;
    automation?: {
      policy: CapacityAutomationPolicy;
      recommendationProvider?: () => Promise<ValidatedRecommendation | null>;
      acquire: (recommendation: ValidatedRecommendation, idempotencyKey: string) => Promise<unknown>;
      release: (allocation: SlurmAllocation, idempotencyKey: string) => Promise<unknown>;
      prepareRelease?: (allocation: SlurmAllocation) => Promise<boolean>;
    };
  } = {},
): Router {
  const router = Router();
  const submit = dependencies.submit ?? deployStub;
  if (dependencies.automation && store.isCapacityPolicyDisabled(dependencies.automation.policy.pool_id)) {
    dependencies.automation.policy.enabled = false;
    dependencies.automation.policy.mode = "recommend";
  } else if (dependencies.automation && !dependencies.automation.policy.last_action_at) {
    dependencies.automation.policy.last_action_at = store
      .getLatestAppliedCapacityPolicyEvent(dependencies.automation.policy.pool_id)?.created_at;
  }

  router.get("/targets", (_req: Request, res: Response) => {
    res.json(capacityTargets(config));
  });

  router.post("/recommend", (req: Request, res: Response) => {
    const resources = req.body?.resources && typeof req.body.resources === "object" ? req.body.resources : {};
    const snapshot = req.body?.snapshot && typeof req.body.snapshot === "object" ? req.body.snapshot : {};
    const targets = capacityTargets(config);
    const recommendations = recommendCapacity(targets, resources, snapshot);
    const rejections: CapacityRejection[] = targets
      .map((target) => ({ target_id: target.id, reasons: capacityTargetRejections(target, resources) }))
      .filter((item) => item.reasons.length > 0);
    if (recommendations.length === 0) {
      res.status(409).json({ error: "No managed target satisfies the explicit resource constraints", resources, rejections });
      return;
    }
    res.json({ recommendation: recommendations[0], alternatives: recommendations.slice(1), rejections, mode: "recommend_only" });
  });

  router.get("/policy/events", (req: Request, res: Response) => {
    const limit = Number(req.query.limit ?? 200);
    res.json(store.getCapacityPolicyEvents(Number.isFinite(limit) ? limit : 200));
  });

  router.post("/policy/disable", (_req: Request, res: Response) => {
    if (!dependencies.automation) {
      res.status(404).json({ error: "No automatic capacity policy configured" });
      return;
    }
    store.disableCapacityPolicy(dependencies.automation.policy.pool_id);
    dependencies.automation.policy.enabled = false;
    dependencies.automation.policy.mode = "recommend";
    res.json({ pool_id: dependencies.automation.policy.pool_id, mode: "recommend", enabled: false });
  });

  router.post("/policy/reconcile", async (req: Request, res: Response): Promise<void> => {
    try {
      const automatic = dependencies.automation?.policy.enabled
        && dependencies.automation.policy.mode === "automatic";
      if (automatic && !dependencies.automation?.recommendationProvider) {
        res.status(503).json({ error: "Server-owned automatic recommendation provider unavailable" });
        return;
      }
      let recommendation = automatic
        ? await dependencies.automation!.recommendationProvider!()
        : req.body?.recommendation as ValidatedRecommendation | null | undefined;
      if (automatic && recommendation) {
        const trustedTarget = capacityTargets(config).find((target) => target.id === recommendation!.target.id && target.enabled);
        const rejections = trustedTarget ? capacityTargetRejections(trustedTarget, recommendation.resources) : ["unknown or disabled target"];
        if (!trustedTarget || rejections.length > 0) {
          throw new Error(`Automatic recommendation failed server catalog validation: ${rejections.join("; ")}`);
        }
        recommendation = { ...recommendation, target: trustedTarget };
      }
      const policyMode = automatic ? "automatic" as const : "recommend" as const;
      const appendActionEvent = (action: CapacityPolicyAction) => store.appendCapacityPolicyEvents([{
        kind: action.kind,
        applied: action.applied,
        reason: action.reason,
        actor: action.actor,
        mode: policyMode,
        pool_id: dependencies.automation?.policy.pool_id,
        target_id: action.target_id,
        allocation_id: action.allocation_id,
        resources: auditSafeResources(action.resources),
        idempotency_key: action.idempotency_key,
      }]);
      const result = await reconcileCapacityPolicy({
        recommendation: recommendation ?? null,
        allocations: store.getSlurmAllocations(),
        activeTasks: store.getActiveTasks(),
        campaigns: store.getCapacityCampaigns(),
        policy: dependencies.automation?.policy,
        acquire: dependencies.automation?.acquire ?? (async () => { throw new Error("Automatic acquisition backend unavailable"); }),
        release: dependencies.automation?.release ?? (async () => { throw new Error("Automatic release backend unavailable"); }),
        prepareRelease: dependencies.automation?.prepareRelease,
        beforeApply: appendActionEvent,
        applyFailed: appendActionEvent,
        now: new Date(),
      });
      store.appendCapacityPolicyEvents(result.actions.map((action) => ({
        kind: action.kind,
        applied: action.applied,
        reason: action.reason,
        actor: action.actor,
        mode: result.mode,
        pool_id: dependencies.automation?.policy.pool_id,
        target_id: action.target_id,
        allocation_id: action.allocation_id,
        resources: auditSafeResources(action.resources),
        idempotency_key: action.idempotency_key,
      })));
      res.json(result);
    } catch (error) {
      res.status(503).json({ error: String(error) });
    }
  });

  router.get("/campaigns", (_req: Request, res: Response) => {
    res.json(store.getCapacityCampaigns());
  });

  router.get("/campaigns/:id", (req: Request, res: Response) => {
    const campaign = store.getCapacityCampaign(req.params.id);
    if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }
    res.json(campaign);
  });

  router.post("/campaigns", (req: Request, res: Response) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const targetId = typeof req.body?.target_id === "string" ? req.body.target_id : "";
    const manifest = parseFrozenCampaignManifest(req.body?.frozen_manifest);
    const legacyHash = typeof req.body?.frozen_spec_hash === "string" && req.body.frozen_spec_hash.startsWith("sha256:")
      ? req.body.frozen_spec_hash : undefined;
    if (!name || !targetId || (!manifest && !legacyHash)) {
      res.status(400).json({ error: "name, target_id, and either a version-1 frozen_manifest or legacy frozen_spec_hash are required" });
      return;
    }
    if (req.body?.capacity_lease_id !== undefined) {
      res.status(400).json({ error: "capacity_lease_id is server-owned and cannot be supplied by callers" });
      return;
    }
    const target = capacityTargets(config).find((candidate) => candidate.id === targetId || candidate.aliases.includes(targetId));
    if (!target || !target.enabled) {
      res.status(404).json({ error: "Managed target not found or disabled", target_id: targetId });
      return;
    }
    const frozenSpecHash = manifest ? frozenCampaignManifestHash(manifest) : legacyHash!;
    if (manifest && req.body?.frozen_spec_hash !== undefined && req.body.frozen_spec_hash !== frozenSpecHash) {
      res.status(409).json({ error: "frozen_spec_hash does not match frozen_manifest", expected: frozenSpecHash });
      return;
    }
    const campaign = store.createCapacityCampaign({
      name,
      state: "acquire",
      target_id: target.id,
      frozen_spec_hash: frozenSpecHash,
      frozen_manifest: manifest,
      capacity_lease_id: randomUUID(),
      max_attempts: Math.max(1, Number(req.body?.max_attempts) || 3),
      attempts: 0,
      max_runtime_seconds: Math.max(60, Number(req.body?.max_runtime_seconds) || 86_400),
    });
    res.status(201).json(campaign);
  });

  router.post("/campaigns/:id/start", async (req: Request, res: Response): Promise<void> => {
    if (!dependencies.campaignDriver) {
      res.status(503).json({ error: "Campaign driver unavailable" });
      return;
    }
    try {
      res.json(await reconcileCampaign(req.params.id, dependencies.campaignDriver));
    } catch (error) {
      const message = String(error);
      res.status(message.toLowerCase().includes("not found") ? 404 : 500).json({ error: message });
    }
  });

  router.post("/campaigns/:id/cancel", (req: Request, res: Response) => {
    const campaign = store.getCapacityCampaign(req.params.id);
    if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }
    if (campaign.state === "completed") {
      res.status(409).json({ error: "Completed campaign cannot be cancelled" });
      return;
    }
    if (campaign.state === "failed") { res.status(200).json({ ...campaign, reused: true }); return; }
    const reason = typeof req.body?.reason === "string" && req.body.reason.trim()
      ? req.body.reason.trim() : "operator cancellation";
    const cleanupRequired = store.getSlurmAllocations().some((allocation) =>
      !["released", "failed"].includes(allocation.state)
      && allocation.managed_by === "alchemy"
      && allocation.campaign_id === campaign.id
      && allocation.capacity_lease_id === campaign.capacity_lease_id
      && allocation.managed_target_id === campaign.target_id,
    );
    const at = new Date().toISOString();
    const cancelled = store.updateCapacityCampaign(campaign.id, {
      state: "failed",
      cleanup_required: cleanupRequired,
      last_error: reason,
      history: [...campaign.history, { at, from: campaign.state, to: "failed", actor: "operator", reason }],
    });
    res.status(cleanupRequired ? 202 : 200).json(cancelled);
  });

  router.get("/campaigns/:id/events", (req: Request, res: Response) => {
    const campaign = store.getCapacityCampaign(req.params.id);
    if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }
    res.json(campaign.history);
  });

  router.post("/campaigns/:id/advance", (req: Request, res: Response) => {
    const campaign = store.getCapacityCampaign(req.params.id);
    if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }
    const transitions: Record<string, string> = {
      acquire: "wait_stub", wait_stub: "cuda_smoke", cuda_smoke: "submit_dag",
      submit_dag: "wait_dag", wait_dag: "drain", drain: "release",
      release: "closeout", closeout: "completed",
    };
    const to = String(req.body?.to ?? "");
    if (campaign.state === to) { res.json({ ...campaign, reused: true }); return; }
    if (to !== "failed") {
      res.status(409).json({ error: "Forward campaign transitions require the audited reconciler", from: campaign.state, requested: to });
      return;
    }
    const failure = to === "failed" && typeof req.body?.reason === "string" && Boolean(req.body.reason.trim());
    if (transitions[campaign.state] !== to && !failure) {
      res.status(409).json({ error: "Invalid campaign transition", from: campaign.state, expected: transitions[campaign.state], requested: to });
      return;
    }
    if (["release", "closeout", "completed"].includes(to)) {
      res.status(409).json({ error: "Destructive campaign transitions require the audited reconciler", from: campaign.state, requested: to });
      return;
    }
    if (typeof req.body?.allocation_id === "string") {
      const allocation = store.getSlurmAllocation(req.body.allocation_id);
      if (!allocation
        || allocation.managed_by !== "alchemy"
        || allocation.campaign_id !== campaign.id
        || allocation.capacity_lease_id !== campaign.capacity_lease_id) {
        res.status(409).json({ error: "Allocation is not canonically owned by this campaign and lease" });
        return;
      }
    }
    if (typeof req.body?.stub_id === "string") {
      const stub = store.getStub(req.body.stub_id);
      if (!stub || stub.capacity_lease_id !== campaign.capacity_lease_id) {
        res.status(409).json({ error: "Stub is not canonically bound to this campaign lease" });
        return;
      }
    }
    if (typeof req.body?.smoke_task_id === "string") {
      const task = store.getAllTasks().find((item) => item.id === req.body.smoke_task_id);
      if (!task || task.capacity_lease_id !== campaign.capacity_lease_id) {
        res.status(409).json({ error: "Smoke task is not canonically bound to this campaign lease" });
        return;
      }
    }
    if (typeof req.body?.experiment_id === "string" && !store.getExperiment(req.body.experiment_id)) {
      res.status(409).json({ error: "Experiment must be an existing canonical experiment ID" });
      return;
    }
    const at = new Date().toISOString();
    const cleanupRequired = failure && store.getSlurmAllocations().some((allocation) =>
      !["released", "failed"].includes(allocation.state)
      && (allocation.id === (req.body?.allocation_id ?? campaign.allocation_id)
        || allocation.campaign_id === campaign.id
        || Boolean(allocation.capacity_lease_id && allocation.capacity_lease_id === campaign.capacity_lease_id)),
    );
    const updated = store.updateCapacityCampaign(campaign.id, {
      state: "failed",
      attempts: campaign.attempts,
      last_error: failure ? String(req.body.reason) : campaign.last_error,
      cleanup_required: failure ? cleanupRequired : campaign.cleanup_required,
      history: [...campaign.history, {
        at, from: campaign.state, to: to as typeof campaign.state,
        actor: typeof req.body?.actor === "string" ? req.body.actor : "unknown",
        reason: typeof req.body?.reason === "string" ? req.body.reason : undefined,
      }],
    });
    res.json(updated);
  });

  router.post("/campaigns/:id/reconcile", async (req: Request, res: Response): Promise<void> => {
    if (!dependencies.campaignDriver) {
      res.status(503).json({ error: "Campaign driver unavailable" });
      return;
    }
    try {
      res.json(await reconcileCampaign(req.params.id, dependencies.campaignDriver));
    } catch (error) {
      const message = String(error);
      res.status(message.toLowerCase().includes("not found") ? 404 : 500)
        .json({ error: message });
    }
  });

  router.get("/allocations", (_req: Request, res: Response) => {
    res.json(store.getSlurmAllocations());
  });

  router.get("/allocations/:id", (req: Request, res: Response) => {
    const allocation = store.getSlurmAllocation(req.params.id)
      ?? store.getSlurmAllocations().find((item) => item.alias === req.params.id || item.job_id === req.params.id);
    if (!allocation) { res.status(404).json({ error: "Allocation not found" }); return; }
    res.json(allocation);
  });

  router.post("/allocations/cancel", async (req: Request, res: Response): Promise<void> => {
    const refs = Array.isArray(req.body?.allocations) ? req.body.allocations.map(String) : [];
    const apply = req.body?.apply === true;
    const selected = store.getSlurmAllocations().filter((allocation) => refs.length === 0
      || refs.includes(allocation.id) || (allocation.alias ? refs.includes(allocation.alias) : false)
      || (allocation.job_id ? refs.includes(allocation.job_id) : false));
    const eligibility = selected.map((allocation) => ({ allocation, reason: releaseBlockReason(allocation) }));
    const eligible = eligibility.filter((item) => !item.reason).map((item) => item.allocation);
    const skipped: Array<{ id: string; reason: string }> = eligibility.filter((item) => item.reason)
      .map((item) => ({ id: item.allocation.id, reason: item.reason! }));
    if (!apply) { res.json({ dry_run: true, eligible, skipped }); return; }
    if (!dependencies.cancel) {
      res.status(503).json({ error: "SLURM cancellation backend unavailable", dry_run: false, eligible, skipped });
      return;
    }
    if (!dependencies.prepareRelease) {
      res.status(503).json({ error: "Release admission barrier unavailable", dry_run: false, eligible, skipped });
      return;
    }
    const cancelled = [];
    for (const allocation of eligible) {
      try {
        await dependencies.prepareRelease(allocation);
      } catch {
        const reason = "release_admission_unavailable";
        skipped.push({ id: allocation.id, reason });
        res.status(503).json({ error: "Release admission barrier unavailable", dry_run: false, cancelled, skipped });
        return;
      }
      const current = store.getSlurmAllocation(allocation.id);
      const postBarrierReason = current ? releaseBlockReason(current) : "allocation_missing";
      if (!current || postBarrierReason) {
        skipped.push({ id: allocation.id, reason: postBarrierReason ?? "release_blocked" });
        continue;
      }
      let result: Awaited<ReturnType<CapacityCanceller>>;
      try {
        result = await dependencies.cancel(current.job_id!);
      } catch {
        const reason = "cancel_backend_unavailable";
        skipped.push({ id: allocation.id, reason });
        res.status(503).json({ error: "SLURM cancellation backend unavailable", dry_run: false, cancelled, skipped });
        return;
      }
      if (result.ok) {
        cancelled.push(store.updateSlurmAllocation(allocation.id, {
          state: "released", released_at: new Date().toISOString(),
        }));
      } else {
        skipped.push({ id: allocation.id, reason: result.error ?? "cancel_failed" });
      }
    }
    res.json({ dry_run: false, cancelled, skipped });
  });

  router.post("/allocations/submit", async (req: Request, res: Response): Promise<void> => {
    const targetRef = typeof req.body?.target === "string" ? req.body.target : "";
    const target = findTarget(config, targetRef);
    if (!target || target.enabled === false) {
      res.status(404).json({ error: "Managed SLURM target not found or disabled", target: targetRef });
      return;
    }
    const idempotencyKey = typeof req.body?.idempotency_key === "string" ? req.body.idempotency_key.trim() : "";
    if (!idempotencyKey) {
      res.status(400).json({ error: "idempotency_key is required" });
      return;
    }
    const existing = store.getSlurmAllocationByIdempotencyKey(idempotencyKey);
    const controllerVerifiedRetry = existing?.state === "failed" && existing.error === "controller_verified_absent";
    if (existing && !controllerVerifiedRetry) {
      res.status(200).json({
        ok: existing.state !== "failed",
        target: existing.managed_target_id,
        job_id: existing.job_id,
        allocation: existing,
        reused: true,
      });
      return;
    }
    const serverUrl = req.body?.server_url || process.env.ALCHEMY_SERVER_URL;
    const token = req.body?.token || process.env.ALCHEMY_TOKEN;
    if (!serverUrl || !token) {
      res.status(400).json({ error: "server_url and token are required for submission" });
      return;
    }
    const nameSuffix = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 10);
    const jobName = existing?.job_name ?? sanitizeSlurmJobName(`${req.body?.job_name || `alchemy-${target.name}`}-${nameSuffix}`);
    const allocation = existing
      ? store.updateSlurmAllocation(existing.id, { state: "requested", error: undefined, last_observed_at: undefined })!
      : store.createSlurmAllocation({
      idempotency_key: idempotencyKey,
      campaign_id: req.body?.campaign_id,
      capacity_lease_id: req.body?.capacity_lease_id,
      managed_target_id: target.name,
      gpu_class: target.gpu_class,
      partition: target.partition,
      qos: req.body?.qos ?? target.qos,
      gres: req.body?.gres ?? target.gres,
      requested_resources: {
        mem: req.body?.mem ?? target.mem,
        time: req.body?.time ?? target.time,
        idle_timeout: req.body?.idle_timeout ?? target.idle_timeout,
      },
      job_name: jobName,
      owner: typeof req.body?.owner === "string" ? req.body.owner : "unknown",
      managed_by: "alchemy",
      pinned: req.body?.pinned === true,
      state: "requested",
    });

    const result = await submit(
      target,
      serverUrl,
      token,
      config?.ssh?.key_path,
      config?.stub_package?.local_path,
      {
        mem: req.body?.mem,
        time: req.body?.time,
        idle_timeout: req.body?.idle_timeout,
        default_output_dir: req.body?.default_output_dir,
        job_name: jobName,
      },
    );
    const now = new Date().toISOString();
    const updated = result.ok
      ? store.updateSlurmAllocation(allocation.id, {
          job_id: result.job_id,
          state: "submitted",
          submitted_at: now,
        })
      : store.updateSlurmAllocation(allocation.id, {
          state: "failed",
          error: result.error ?? `Submission failed during ${result.step ?? "unknown step"}`,
          last_observed_at: now,
        });
    res.status(result.ok ? 201 : 502).json({
      ...result,
      target: target.name,
      job_id: updated?.job_id,
      allocation: updated,
      reused: false,
    });
  });

  router.post("/reconcile", (req: Request, res: Response) => {
    const jobs = Array.isArray(req.body?.jobs) ? req.body.jobs : [];
    res.json(reconcileSlurmAllocations(jobs, req.body?.complete === true));
  });

  return router;
}
