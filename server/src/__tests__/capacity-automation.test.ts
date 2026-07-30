import { describe, expect, it, vi } from "vitest";
import { reconcileCapacityPolicy } from "../capacity/automation";
import type { CapacityTarget, SlurmAllocation } from "../types";

const target: CapacityTarget = {
  id: "slurm-a16", aliases: ["a16"], partition: "gpu-small", qos: "normal",
  gres: "gpu:nvidia_a16:1", gpu_class: "A16", gpu_mem_mb: 16384, tags: [], enabled: true,
};

function allocation(overrides: Partial<SlurmAllocation> = {}): SlurmAllocation {
  return {
    id: "alloc-1", idempotency_key: "key", managed_target_id: "slurm-a16",
    requested_resources: {}, job_name: "job", owner: "tester", managed_by: "alchemy",
    pinned: false, state: "running", requested_at: "2026-07-30T00:00:00.000Z", ...overrides,
  };
}

describe("policy-gated capacity automation", () => {
  it("defaults to recommend-only and preserves explicit Slurm resources", async () => {
    const acquire = vi.fn();
    const result = await reconcileCapacityPolicy({
      recommendation: { target, resources: { partition: "gpu-small", qos: "normal", gres: "gpu:nvidia_a16:1", mem: "32G" }, validated_snapshots: 20 },
      allocations: [], policy: undefined, acquire, release: vi.fn(), now: new Date("2026-07-30T00:00:00Z"),
    });
    expect(result.mode).toBe("recommend");
    expect(result.actions[0]).toMatchObject({ kind: "acquire", applied: false, resources: { partition: "gpu-small", qos: "normal", gres: "gpu:nvidia_a16:1", mem: "32G" } });
    expect(acquire).not.toHaveBeenCalled();
  });

  it("requires validation, pool enablement, and managed ownership before applying", async () => {
    const acquire = vi.fn(async () => ({ id: "new" }));
    const policy = { pool_id: "general", mode: "automatic" as const, enabled: true, min_validated_snapshots: 5, max_total: 3, max_pending: 2, cooldown_seconds: 0 };
    const blocked = await reconcileCapacityPolicy({
      recommendation: { target, resources: { partition: "gpu-small", qos: "normal" }, validated_snapshots: 4 },
      allocations: [], policy, acquire, release: vi.fn(), now: new Date("2026-07-30T00:00:00Z"),
    });
    expect(blocked.actions[0]).toMatchObject({ applied: false, reason: "recommendation_not_validated" });
    expect(acquire).not.toHaveBeenCalled();

    const applied = await reconcileCapacityPolicy({
      recommendation: { target, resources: { partition: "gpu-small", qos: "normal" }, validated_snapshots: 5 },
      allocations: [], policy, acquire, release: vi.fn(), now: new Date("2026-07-30T00:00:00Z"),
    });
    expect(applied.actions).toHaveLength(1);
    expect(applied.actions[0].applied).toBe(true);
    expect(acquire).toHaveBeenCalledOnce();
  });

  it("uses a stable recommendation identity for idempotent repeated acquisition", async () => {
    const acquire = vi.fn(async () => ({ id: "new" }));
    const policy = { pool_id: "general", mode: "automatic" as const, enabled: true, min_validated_snapshots: 1, max_total: 3, max_pending: 2, cooldown_seconds: 0 };
    const recommendation = { target, resources: { partition: "gpu-small" }, validated_snapshots: 3, recommendation_id: "plan-42" };

    await reconcileCapacityPolicy({ recommendation, allocations: [], policy, acquire, release: vi.fn(), now: new Date("2026-07-30T00:00:00Z") });
    await reconcileCapacityPolicy({ recommendation, allocations: [], policy, acquire, release: vi.fn(), now: new Date("2026-07-30T00:05:00Z") });

    const keys = acquire.mock.calls as unknown as Array<[unknown, string]>;
    expect(keys.map((call) => call[1])).toEqual(["general:acquire:plan-42", "general:acquire:plan-42"]);
  });

  it("never auto-releases manual, pinned, busy, or campaign-cleanup allocations", async () => {
    const release = vi.fn(async () => ({ ok: true }));
    const allocations = [
      allocation({ id: "manual", managed_by: "manual" }),
      allocation({ id: "pinned", pinned: true }),
      allocation({ id: "busy", active_task_ids: ["task-1"] } as Partial<SlurmAllocation>),
      allocation({ id: "cleanup", campaign_cleanup_required: true } as Partial<SlurmAllocation>),
      allocation({ id: "owned-idle" }),
    ];
    const result = await reconcileCapacityPolicy({
      recommendation: null, allocations,
      policy: { pool_id: "general", mode: "automatic", enabled: true, min_validated_snapshots: 0, max_total: 3, max_pending: 2, cooldown_seconds: 0 },
      acquire: vi.fn(), release, now: new Date("2026-07-30T00:00:00Z"),
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ id: "owned-idle" }), expect.any(String));
    expect(result.actions.filter((action) => action.applied)).toHaveLength(1);
  });
});
