import { store } from "../store";
import type { CapacityCampaign, FrozenCampaignManifest, SlurmAllocation, Task, TaskSpec } from "../types";
import { frozenCampaignObjectHash, requireFrozenCampaignManifest } from "./manifest";
import type { CampaignDriver } from "./reconciler";

export interface CampaignSideEffects {
  acquire(campaign: CapacityCampaign, manifest: FrozenCampaignManifest, idempotencyKey: string): Promise<{ allocation_id: string }>;
  submitSmoke(campaign: CapacityCampaign, spec: Record<string, unknown>, idempotencyKey: string): Promise<{ task_id: string }>;
  submitDag(campaign: CapacityCampaign, spec: Record<string, unknown>, idempotencyKey: string): Promise<{ experiment_id: string }>;
  drain(campaign: CapacityCampaign, allocation: SlurmAllocation, idempotencyKey: string): Promise<void>;
  release(campaign: CapacityCampaign, allocation: SlurmAllocation, idempotencyKey: string): Promise<void>;
}

function ownedAllocation(campaign: CapacityCampaign, allocationId: string): SlurmAllocation {
  const allocation = store.getSlurmAllocation(allocationId);
  if (!allocation || allocation.managed_by !== "alchemy"
    || allocation.campaign_id !== campaign.id
    || allocation.capacity_lease_id !== campaign.capacity_lease_id
    || allocation.managed_target_id !== campaign.target_id) {
    throw new Error(`Campaign allocation ownership mismatch: ${allocationId}`);
  }
  return allocation;
}

function releasableAllocation(campaign: CapacityCampaign, allocationId: string): SlurmAllocation {
  const allocation = ownedAllocation(campaign, allocationId);
  if (allocation.pinned) throw new Error(`Campaign allocation is not releasable while pinned: ${allocationId}`);
  return allocation;
}

function activeTasksForAllocation(campaign: CapacityCampaign, allocation: SlurmAllocation): Task[] {
  const stubIds = new Set([allocation.stub_id, campaign.stub_id].filter((value): value is string => Boolean(value)));
  return store.getActiveTasks().filter((task) => task.capacity_lease_id === campaign.capacity_lease_id
    || (task.stub_id ? stubIds.has(task.stub_id) : false)
    || (task.target_stub_id ? stubIds.has(task.target_stub_id) : false));
}

function campaignTask(campaign: CapacityCampaign, taskId: string): Task {
  const task = store.getAllTasks().find((candidate) => candidate.id === taskId);
  if (!task || task.capacity_lease_id !== campaign.capacity_lease_id
    || Boolean(campaign.stub_id && task.target_stub_id && task.target_stub_id !== campaign.stub_id)) {
    throw new Error(`Campaign task ownership mismatch: ${taskId}`);
  }
  return task;
}

function smokeStatus(task: Task): "running" | "completed" | "failed" {
  if (task.status === "completed") return "completed";
  if (["failed", "cancelled"].includes(task.status)) return "failed";
  return "running";
}

const FROZEN_EXECUTION_KEYS = [
  "script", "argv", "args", "raw_args", "name", "cwd", "env_setup", "env", "env_overrides",
  "requirements", "python_env", "outputs", "metric_schema", "result_schema", "resolved_config", "auto_retry_on",
  "args_template", "ref_template", "param_point", "target_tags",
] as const;

function executionProjection(value: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of FROZEN_EXECUTION_KEYS) {
    if (value[key] !== undefined) projected[key] = value[key];
  }
  projected.priority = value.priority ?? 5;
  projected.max_retries = value.max_retries ?? 0;
  return projected;
}

function requireTaskExecution(campaign: CapacityCampaign, taskId: string, spec: Record<string, unknown>): Task {
  const task = campaignTask(campaign, taskId);
  if (frozenCampaignObjectHash(executionProjection(task as unknown as Record<string, unknown>))
    !== frozenCampaignObjectHash(executionProjection(spec))) {
    throw new Error(`Campaign task ${taskId} does not match its frozen execution spec`);
  }
  return task;
}

function requireSmokeTask(campaign: CapacityCampaign, manifest: FrozenCampaignManifest, taskId: string): Task {
  return requireTaskExecution(campaign, taskId, manifest.smoke_task);
}

function requireExperiment(campaign: CapacityCampaign, manifest: FrozenCampaignManifest, experimentId: string) {
  const experiment = store.getExperiment(experimentId);
  const binding = experiment?.sdk_spec?.campaign;
  if (!experiment || binding?.id !== campaign.id
    || binding?.capacity_lease_id !== campaign.capacity_lease_id
    || binding?.frozen_spec_hash !== campaign.frozen_spec_hash) {
    throw new Error(`Campaign experiment ownership mismatch: ${experimentId}`);
  }
  const dagTaskSpecs = manifest.dag.task_specs;
  if (!Array.isArray(dagTaskSpecs)
    || frozenCampaignObjectHash(experiment.task_specs ?? []) !== frozenCampaignObjectHash(dagTaskSpecs)
    || (typeof manifest.dag.name === "string" && experiment.name !== manifest.dag.name)) {
    throw new Error(`Campaign experiment ${experimentId} does not match the frozen DAG manifest`);
  }
  const taskRefs = experiment.task_refs ?? {};
  const expectedSpecs = dagTaskSpecs as TaskSpec[];
  const expectedRefs = expectedSpecs.map((spec) => spec.ref).sort();
  const actualRefs = Object.keys(taskRefs).sort();
  if (frozenCampaignObjectHash(actualRefs) !== frozenCampaignObjectHash(expectedRefs)) {
    throw new Error(`Campaign experiment ${experimentId} canonical refs do not match the frozen DAG`);
  }
  const tasks = expectedSpecs.map((spec) => {
    const taskId = taskRefs[spec.ref];
    const task = requireTaskExecution(campaign, taskId, spec as unknown as Record<string, unknown>);
    if (task.ref !== spec.ref) throw new Error(`Campaign task ref mismatch: ${spec.ref}`);
    const expectedDependencies = (spec.depends_on ?? []).map((ref) => taskRefs[ref]);
    if (frozenCampaignObjectHash(task.depends_on ?? []) !== frozenCampaignObjectHash(expectedDependencies)) {
      throw new Error(`Campaign task dependencies do not match the frozen DAG: ${spec.ref}`);
    }
    return task;
  });
  return { experiment, tasks };
}

export function createProductionCampaignDriver(sideEffects: CampaignSideEffects): CampaignDriver {
  const manifestFor = (campaign: CapacityCampaign) =>
    requireFrozenCampaignManifest(campaign.frozen_manifest, campaign.frozen_spec_hash);

  return {
    async acquire(campaign, idempotencyKey) {
      const manifest = manifestFor(campaign);
      if (campaign.allocation_id) {
        ownedAllocation(campaign, campaign.allocation_id);
        return { allocation_id: campaign.allocation_id };
      }
      const result = await sideEffects.acquire(campaign, manifest, idempotencyKey);
      ownedAllocation(campaign, result.allocation_id);
      return result;
    },

    async observeStub(campaign) {
      if (!campaign.allocation_id) return { online: false };
      const allocation = ownedAllocation(campaign, campaign.allocation_id);
      if (!allocation.stub_id) return { online: false };
      const stub = store.getStub(allocation.stub_id);
      if (!stub || stub.capacity_lease_id !== campaign.capacity_lease_id
        || stub.campaign_id !== campaign.id || stub.slurm_allocation_id !== allocation.id) {
        throw new Error(`Campaign stub ownership mismatch: ${allocation.stub_id}`);
      }
      return { online: stub.status === "online", stub_id: stub.id };
    },

    async runSmoke(campaign, idempotencyKey) {
      const manifest = manifestFor(campaign);
      const recovered = store.getAllTasks().find((task) => task.idempotency_key === idempotencyKey);
      const taskId = campaign.smoke_task_id ?? recovered?.id
        ?? (await sideEffects.submitSmoke(campaign, manifest.smoke_task, idempotencyKey)).task_id;
      const task = requireSmokeTask(campaign, manifest, taskId);
      return { task_id: task.id, status: smokeStatus(task), error: smokeStatus(task) === "failed" ? `Task ${task.id} ${task.status}` : undefined };
    },

    async submitDag(campaign, idempotencyKey) {
      const manifest = manifestFor(campaign);
      const recovered = store.getAllExperiments().find((experiment) => {
        const binding = experiment.sdk_spec?.campaign;
        return experiment.idempotency_key === idempotencyKey
          || (binding?.id === campaign.id && binding?.frozen_spec_hash === campaign.frozen_spec_hash);
      });
      const experimentId = campaign.experiment_id ?? recovered?.id
        ?? (await sideEffects.submitDag(campaign, manifest.dag, idempotencyKey)).experiment_id;
      requireExperiment(campaign, manifest, experimentId);
      return { experiment_id: experimentId };
    },

    async observeDag(campaign) {
      if (!campaign.experiment_id) throw new Error("Campaign has no submitted experiment");
      const manifest = manifestFor(campaign);
      const { tasks } = requireExperiment(campaign, manifest, campaign.experiment_id);
      const active = tasks.filter((task) => !["completed", "failed", "cancelled"].includes(task.status));
      const failed = tasks.find((task) => ["failed", "cancelled"].includes(task.status));
      return failed
        ? { status: "failed", active_task_ids: active.map((task) => task.id), error: `Task ${failed.id} ${failed.status}` }
        : tasks.every((task) => task.status === "completed")
          ? { status: "completed", active_task_ids: [] }
          : { status: "running", active_task_ids: active.map((task) => task.id) };
    },

    async drain(campaign, idempotencyKey) {
      if (!campaign.allocation_id) throw new Error("Campaign has no allocation to drain");
      const allocation = releasableAllocation(campaign, campaign.allocation_id);
      await sideEffects.drain(campaign, allocation, idempotencyKey);
      const active = store.getActiveTasks().filter((task) =>
        task.capacity_lease_id === campaign.capacity_lease_id || Boolean(campaign.stub_id && task.stub_id === campaign.stub_id));
      const stub = campaign.stub_id ? store.getStub(campaign.stub_id) : undefined;
      return { drained: !stub || stub.max_concurrent === 0, active_task_ids: active.map((task) => task.id) };
    },

    async release(campaign, idempotencyKey) {
      if (!campaign.allocation_id) throw new Error("Campaign has no allocation to release");
      const allocation = releasableAllocation(campaign, campaign.allocation_id);
      const active = activeTasksForAllocation(campaign, allocation);
      if (active.length > 0) return { released: false };
      await sideEffects.release(campaign, allocation, idempotencyKey);
      const current = ownedAllocation(campaign, allocation.id);
      return { released: ["released", "failed"].includes(current.state) };
    },

    async closeout(campaign) {
      const active = store.getActiveTasks().filter((task) => task.capacity_lease_id === campaign.capacity_lease_id);
      const allocation = campaign.allocation_id ? ownedAllocation(campaign, campaign.allocation_id) : undefined;
      const terminal = Boolean(allocation && ["released", "failed"].includes(allocation.state));
      const manifest = manifestFor(campaign);
      const dagComplete = Boolean(campaign.experiment_id
        && requireExperiment(campaign, manifest, campaign.experiment_id).tasks.every((task) => task.status === "completed"));
      return { closed: active.length === 0 && terminal && dagComplete, active_task_ids: active.map((task) => task.id), allocations_terminal: terminal };
    },

    async cleanup(campaign, idempotencyKey) {
      const allocations = store.getSlurmAllocations().filter((allocation) =>
        allocation.managed_by === "alchemy"
        && allocation.campaign_id === campaign.id
        && allocation.capacity_lease_id === campaign.capacity_lease_id
        && allocation.managed_target_id === campaign.target_id);
      if (campaign.allocation_id && !allocations.some((allocation) => allocation.id === campaign.allocation_id)) {
        ownedAllocation(campaign, campaign.allocation_id);
      }
      let cleaned = true;
      for (const candidate of allocations) {
        let allocation = ownedAllocation(campaign, candidate.id);
        if (["released", "failed"].includes(allocation.state)) continue;
        allocation = releasableAllocation(campaign, allocation.id);
        await sideEffects.drain(campaign, allocation, `${idempotencyKey}:drain:${allocation.id}`);
        const active = activeTasksForAllocation(campaign, allocation);
        if (active.length > 0) {
          cleaned = false;
          continue;
        }
        allocation = ownedAllocation(campaign, allocation.id);
        await sideEffects.release(campaign, allocation, `${idempotencyKey}:release:${allocation.id}`);
        allocation = ownedAllocation(campaign, allocation.id);
        if (!["released", "failed"].includes(allocation.state)) cleaned = false;
      }
      return { cleaned };
    },
  };
}
