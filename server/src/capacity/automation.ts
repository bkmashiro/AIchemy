import type { CapacityTarget, SlurmAllocation } from "../types";
import { createHash } from "crypto";

export interface CapacityAutomationPolicy {
  pool_id: string;
  mode: "recommend" | "automatic";
  enabled: boolean;
  min_validated_snapshots: number;
  max_total: number;
  max_pending: number;
  cooldown_seconds: number;
  last_action_at?: string;
}

export interface ValidatedRecommendation {
  recommendation_id?: string;
  target: CapacityTarget;
  resources: Record<string, unknown>;
  validated_snapshots: number;
}

function recommendationIdentity(recommendation: ValidatedRecommendation): string {
  const resources = Object.fromEntries(
    Object.entries(recommendation.resources).sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash("sha256")
    .update(JSON.stringify({
      recommendation_id: recommendation.recommendation_id,
      target_id: recommendation.target.id,
      resources,
    }))
    .digest("hex")
    .slice(0, 16);
}

export interface CapacityPolicyAction {
  kind: "acquire" | "release";
  allocation_id?: string;
  target_id?: string;
  resources?: Record<string, unknown>;
  applied: boolean;
  reason: string;
  actor: "capacity_policy";
  at: string;
  idempotency_key?: string;
}

interface AutomationInput {
  recommendation: ValidatedRecommendation | null;
  allocations: SlurmAllocation[];
  activeTasks?: Array<{ id: string; stub_id?: string; capacity_lease_id?: string }>;
  campaigns?: Array<{ id: string; state: string; allocation_id?: string; capacity_lease_id?: string }>;
  policy?: CapacityAutomationPolicy;
  acquire: (recommendation: ValidatedRecommendation, idempotencyKey: string) => Promise<unknown>;
  release: (allocation: SlurmAllocation, idempotencyKey: string) => Promise<unknown>;
  beforeApply?: (action: CapacityPolicyAction) => void;
  applyFailed?: (action: CapacityPolicyAction) => void;
  now: Date;
}

function active(allocation: SlurmAllocation): boolean {
  return !["released", "failed"].includes(allocation.state);
}

function cooldownActive(policy: CapacityAutomationPolicy, now: Date): boolean {
  if (!policy.last_action_at) return false;
  return now.getTime() - new Date(policy.last_action_at).getTime() < policy.cooldown_seconds * 1000;
}

/** Computes and optionally applies at most one ownership-safe capacity mutation. */
export async function reconcileCapacityPolicy(input: AutomationInput): Promise<{
  mode: "recommend" | "automatic";
  actions: CapacityPolicyAction[];
}> {
  const policy = input.policy;
  const mode = policy?.enabled && policy.mode === "automatic" ? "automatic" : "recommend";
  const at = input.now.toISOString();
  const allocations = input.allocations.filter(active);
  const pending = allocations.filter((item) => ["requested", "submitted", "pending"].includes(item.state));

  if (input.recommendation) {
    const recommendation = input.recommendation;
    const action: CapacityPolicyAction = {
      kind: "acquire", target_id: recommendation.target.id,
      resources: { ...recommendation.resources }, applied: false,
      reason: "recommend_only", actor: "capacity_policy", at,
    };
    if (mode !== "automatic") return { mode, actions: [action] };
    if (recommendation.validated_snapshots < (policy?.min_validated_snapshots ?? 0)) {
      action.reason = "recommendation_not_validated";
      return { mode, actions: [action] };
    }
    if (allocations.length >= policy!.max_total || pending.length >= policy!.max_pending) {
      action.reason = "policy_cap_reached";
      return { mode, actions: [action] };
    }
    if (cooldownActive(policy!, input.now)) {
      action.reason = "cooldown_active";
      return { mode, actions: [action] };
    }
    const key = `${policy!.pool_id}:acquire:${recommendationIdentity(recommendation)}`;
    action.idempotency_key = key;
    action.reason = "apply_intent";
    input.beforeApply?.({ ...action });
    try {
      await input.acquire(recommendation, key);
    } catch (error) {
      input.applyFailed?.({ ...action, reason: "apply_failed" });
      throw error;
    }
    action.applied = true;
    action.reason = "validated_recommendation";
    policy!.last_action_at = at;
    return { mode, actions: [action] };
  }

  const ownedIdle = allocations.find((allocation) => {
    const hasActiveTask = (input.activeTasks ?? []).some((task) =>
      (allocation.stub_id && task.stub_id === allocation.stub_id)
      || (allocation.capacity_lease_id && task.capacity_lease_id === allocation.capacity_lease_id),
    );
    const hasUnresolvedCampaign = (input.campaigns ?? []).some((campaign) =>
      campaign.state !== "completed"
      && (campaign.allocation_id === allocation.id
        || Boolean(allocation.capacity_lease_id && campaign.capacity_lease_id === allocation.capacity_lease_id)),
    );
    return allocation.managed_by === "alchemy"
      && !allocation.pinned
      && !hasActiveTask
      && !hasUnresolvedCampaign;
  });
  if (!ownedIdle) return { mode, actions: [] };

  const action: CapacityPolicyAction = {
    kind: "release", allocation_id: ownedIdle.id, applied: false,
    reason: mode === "automatic" ? "idle_owned_capacity" : "recommend_only",
    actor: "capacity_policy", at,
  };
  if (mode !== "automatic" || cooldownActive(policy!, input.now)) {
    if (mode === "automatic") action.reason = "cooldown_active";
    return { mode, actions: [action] };
  }
  const key = `${policy!.pool_id}:release:${ownedIdle.id}`;
  action.idempotency_key = key;
  action.reason = "apply_intent";
  input.beforeApply?.({ ...action });
  try {
    await input.release(ownedIdle, key);
  } catch (error) {
    input.applyFailed?.({ ...action, reason: "apply_failed" });
    throw error;
  }
  action.applied = true;
  action.reason = "idle_owned_capacity";
  policy!.last_action_at = at;
  return { mode, actions: [action] };
}
