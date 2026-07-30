import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { deployStub, type SlurmSubmitOptions } from "../deploy";
import { store } from "../store";
import type { CapacityTarget, DeployFileConfig, DeployResult, StubTarget } from "../types";

export type CapacitySubmitter = (
  target: StubTarget,
  serverUrl: string,
  token: string,
  sshKeyPath?: string,
  stubLocalPath?: string,
  overrides?: SlurmSubmitOptions,
) => Promise<DeployResult>;

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

export function recommendCapacity(
  targets: CapacityTarget[],
  resources: Record<string, unknown>,
  snapshot: { partitions?: Array<Record<string, unknown>> },
): CapacityRecommendation[] {
  const explicitPartition = typeof resources.partition === "string" ? resources.partition : undefined;
  const explicitQos = typeof resources.qos === "string" ? resources.qos : undefined;
  const gpuClass = typeof resources.gpu_class === "string" ? resources.gpu_class.toUpperCase() : undefined;
  const minMemory = Number(resources.gpu_mem_mb ?? 0);
  const partitions = new Map((snapshot.partitions ?? []).map((item) => [String(item.name), item]));

  return targets.filter((target) => target.enabled !== false)
    .filter((target) => !explicitPartition || target.partition === explicitPartition)
    .filter((target) => !explicitQos || target.qos === explicitQos)
    .filter((target) => !gpuClass || target.gpu_class?.toUpperCase() === gpuClass)
    .filter((target) => !minMemory || (target.gpu_mem_mb ?? 0) >= minMemory)
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
  jobs: Array<{ job_id?: string; state?: string; partition?: string; name?: string }>,
  complete: boolean,
): { reconciled: Array<ReturnType<typeof store.updateSlurmAllocation>>; observed_jobs: number; observed_at: string } {
  const jobsById = new Map(jobs.filter((job) => job.job_id).map((job) => [String(job.job_id), job]));
  const now = new Date().toISOString();
  const reconciled = store.getSlurmAllocations().map((allocation) => {
    const job = allocation.job_id ? jobsById.get(allocation.job_id) : undefined;
    let state = allocation.state;
    if (job) {
      const slurmState = String(job.state ?? "").toUpperCase();
      if (slurmState === "RUNNING") state = "running";
      else if (["PENDING", "CONFIGURING", "COMPLETING"].includes(slurmState)) state = "pending";
      else if (["COMPLETED", "CANCELLED", "FAILED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL"].includes(slurmState)) state = "released";
    } else if (complete && ["pending", "running"].includes(state)) {
      state = "released";
    }
    const stub = allocation.job_id
      ? store.getAllStubs().find((candidate) => candidate.slurm_job_id === allocation.job_id)
      : undefined;
    if (stub && stub.slurm_allocation_id !== allocation.id) {
      stub.slurm_allocation_id = allocation.id;
      stub.capacity_lease_id = allocation.capacity_lease_id;
      stub.campaign_id = allocation.campaign_id;
      store.setStub(stub);
    }
    return store.updateSlurmAllocation(allocation.id, {
      state,
      stub_id: stub?.id ?? allocation.stub_id,
      last_observed_at: now,
      raw_state: job?.state ?? allocation.raw_state,
    });
  });
  return { reconciled, observed_jobs: jobs.length, observed_at: now };
}

export function createCapacityRouter(
  config: DeployFileConfig | null,
  dependencies: { submit?: CapacitySubmitter } = {},
): Router {
  const router = Router();
  const submit = dependencies.submit ?? deployStub;

  router.get("/targets", (_req: Request, res: Response) => {
    res.json(capacityTargets(config));
  });

  router.post("/recommend", (req: Request, res: Response) => {
    const resources = req.body?.resources && typeof req.body.resources === "object" ? req.body.resources : {};
    const snapshot = req.body?.snapshot && typeof req.body.snapshot === "object" ? req.body.snapshot : {};
    const recommendations = recommendCapacity(capacityTargets(config), resources, snapshot);
    if (recommendations.length === 0) {
      res.status(409).json({ error: "No managed target satisfies the explicit resource constraints", resources });
      return;
    }
    res.json({ recommendation: recommendations[0], alternatives: recommendations.slice(1), mode: "recommend_only" });
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
    const frozenSpecHash = typeof req.body?.frozen_spec_hash === "string" ? req.body.frozen_spec_hash : "";
    if (!name || !targetId || !frozenSpecHash) {
      res.status(400).json({ error: "name, target_id, and frozen_spec_hash are required" });
      return;
    }
    const campaign = store.createCapacityCampaign({
      name,
      state: "acquire",
      target_id: targetId,
      frozen_spec_hash: frozenSpecHash,
      capacity_lease_id: req.body?.capacity_lease_id || randomUUID(),
      max_attempts: Math.max(1, Number(req.body?.max_attempts) || 3),
      attempts: 0,
      max_runtime_seconds: Math.max(60, Number(req.body?.max_runtime_seconds) || 86_400),
    });
    res.status(201).json(campaign);
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
    const failure = to === "failed" && typeof req.body?.reason === "string" && Boolean(req.body.reason.trim());
    if (transitions[campaign.state] !== to && !failure) {
      res.status(409).json({ error: "Invalid campaign transition", from: campaign.state, expected: transitions[campaign.state], requested: to });
      return;
    }
    const at = new Date().toISOString();
    const updated = store.updateCapacityCampaign(campaign.id, {
      state: to as typeof campaign.state,
      allocation_id: req.body?.allocation_id ?? campaign.allocation_id,
      stub_id: req.body?.stub_id ?? campaign.stub_id,
      smoke_task_id: req.body?.smoke_task_id ?? campaign.smoke_task_id,
      experiment_id: req.body?.experiment_id ?? campaign.experiment_id,
      attempts: to === "wait_stub" ? campaign.attempts + 1 : campaign.attempts,
      last_error: failure ? String(req.body.reason) : campaign.last_error,
      history: [...campaign.history, {
        at, from: campaign.state, to: to as typeof campaign.state,
        actor: typeof req.body?.actor === "string" ? req.body.actor : "unknown",
        reason: typeof req.body?.reason === "string" ? req.body.reason : undefined,
      }],
    });
    res.json(updated);
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
    if (existing) {
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
    const jobName = sanitizeSlurmJobName(req.body?.job_name || `alchemy-${target.name}`);
    const allocation = store.createSlurmAllocation({
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
