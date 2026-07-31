import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTask } from "../api/tasks";
import { diagnoseTaskAssignment, evaluateStubEligibility } from "../scheduler";
import { bindStubCapacityOwnership } from "../socket/stub";
import { store } from "../store";
import type { Stub } from "../types";

beforeEach(() => store.reset());

describe("logical capacity lease routing diagnosis", () => {
  it("reports capacity_pending instead of a dead transient stub when its owned allocation is pending", () => {
    const task = createTask({ script: "/opt/python", capacity_lease_id: "lease-1" });
    store.createSlurmAllocation({
      idempotency_key: "lease-pending", campaign_id: "campaign-1", capacity_lease_id: "lease-1",
      managed_target_id: "slurm-a16", requested_resources: {}, job_name: "pending",
      owner: "tester", managed_by: "alchemy", pinned: false, state: "pending", job_id: "9001",
    });

    expect(diagnoseTaskAssignment(task, [])).toMatchObject({
      blocker: "capacity_pending", summary_code: "capacity_pending", next_action: "wait_for_capacity_lease_stub",
    });
  });

  it("reports capacity_failed with campaign ownership after the lease allocation fails", () => {
    const task = createTask({ script: "/opt/python", capacity_lease_id: "lease-1" });
    store.createSlurmAllocation({
      idempotency_key: "lease-failed", campaign_id: "campaign-1", capacity_lease_id: "lease-1",
      managed_target_id: "slurm-a16", requested_resources: {}, job_name: "failed",
      owner: "tester", managed_by: "alchemy", pinned: false, state: "failed", error: "controller_verified_absent",
    });

    expect(diagnoseTaskAssignment(task, [])).toMatchObject({
      blocker: "capacity_failed", summary_code: "capacity_failed", next_action: "inspect_capacity_campaign",
    });
  });

  it("binds a newly registered exact SLURM job to its allocation, lease, and campaign", () => {
    const allocation = store.createSlurmAllocation({
      idempotency_key: "lease-bind", campaign_id: "campaign-1", capacity_lease_id: "lease-1",
      managed_target_id: "slurm-a16", requested_resources: {}, job_name: "bind",
      owner: "tester", managed_by: "alchemy", pinned: false, state: "running", job_id: "9001",
    });
    const stub = {
      id: "stub-1", name: "gpu-9001", hostname: "gpu", gpu: { name: "A16", count: 1, memory_total_mb: 16384 },
      slurm_job_id: "9001", tags: ["alchemy-target=slurm-a16"], status: "online", type: "slurm", connected_at: new Date().toISOString(),
      last_heartbeat: new Date().toISOString(), max_concurrent: 1, tasks: [],
    } as unknown as Stub;

    bindStubCapacityOwnership(stub);

    expect(stub).toMatchObject({ slurm_allocation_id: allocation.id, capacity_lease_id: "lease-1", campaign_id: "campaign-1" });
    expect(store.getSlurmAllocation(allocation.id)).toMatchObject({ stub_id: stub.id, state: "stub_online" });
  });
  it("reserves a leased stub against unrelated unleased tasks", () => {
    const stub = {
      id: "stub-reserved", name: "reserved", hostname: "gpu", gpu: { name: "A16", count: 1, memory_total_mb: 16384 },
      capacity_lease_id: "lease-1", campaign_id: "campaign-1", status: "online", type: "slurm",
      connected_at: new Date().toISOString(), last_heartbeat: new Date().toISOString(), max_concurrent: 1, tasks: [],
    } as unknown as Stub;
    const unleased = createTask({ script: "/tmp/unrelated.py" });

    expect(evaluateStubEligibility(stub, unleased)).toMatchObject({ eligible: false, reasons: ["capacity_lease_mismatch"] });
  });

  it("does not bind a same-numbered job from another managed target", () => {
    const allocation = store.createSlurmAllocation({
      idempotency_key: "target-a", campaign_id: "campaign-1", capacity_lease_id: "lease-1",
      managed_target_id: "slurm-a16", requested_resources: {}, job_name: "target-a",
      owner: "tester", managed_by: "alchemy", pinned: false, state: "released", job_id: "9002",
    });
    const stub = {
      id: "stub-other-target", name: "gpu-9002", hostname: "gpu", gpu: { name: "A30", count: 1, memory_total_mb: 24576 },
      slurm_job_id: "9002", tags: ["alchemy-target=slurm-a30"], status: "online", type: "slurm",
      connected_at: new Date().toISOString(), last_heartbeat: new Date().toISOString(), max_concurrent: 1, tasks: [],
    } as unknown as Stub;

    expect(bindStubCapacityOwnership(stub)).toBe(true);

    expect(stub).toMatchObject({ status: "online", max_concurrent: 1 });
    expect(stub.slurm_allocation_id).toBeUndefined();
    expect(store.getSlurmAllocation(allocation.id)?.stub_id).toBeUndefined();
  });

  it("filters same-numbered allocations by target before checking ambiguity", () => {
    const first = store.createSlurmAllocation({
      idempotency_key: "collision-a", managed_target_id: "slurm-a16", requested_resources: {}, job_name: "collision-a",
      owner: "tester", managed_by: "alchemy", pinned: false, state: "released", job_id: "9010",
    });
    const second = { ...first, id: "allocation-a30", idempotency_key: "collision-b", managed_target_id: "slurm-a30" };
    const allocations = vi.spyOn(store, "getSlurmAllocations").mockReturnValue([first, second]);
    const stub = {
      id: "stub-collision-a30", name: "gpu-9010", hostname: "gpu", gpu: { name: "A30", count: 1, memory_total_mb: 24576 },
      slurm_job_id: "9010", tags: ["alchemy-target=slurm-a30"], status: "online", type: "slurm",
      connected_at: new Date().toISOString(), last_heartbeat: new Date().toISOString(), max_concurrent: 1, tasks: [],
    } as unknown as Stub;

    try {
      expect(bindStubCapacityOwnership(stub)).toBe(false);
      expect(stub).toMatchObject({ status: "offline", max_concurrent: 0 });
    } finally {
      allocations.mockRestore();
    }
  });

  it("prefers an existing legacy binding before same-job ambiguity", () => {
    const first = store.createSlurmAllocation({
      idempotency_key: "legacy-bound-a", managed_target_id: "slurm-a16", requested_resources: {}, job_name: "legacy-bound-a",
      owner: "tester", managed_by: "alchemy", pinned: false, state: "released", job_id: "9011",
    });
    const second = { ...first, id: "allocation-legacy-b", idempotency_key: "legacy-bound-b", managed_target_id: "slurm-a30" };
    const allocations = vi.spyOn(store, "getSlurmAllocations").mockReturnValue([first, second]);
    const stub = {
      id: "stub-legacy-bound", name: "gpu-9011", hostname: "gpu", gpu: { name: "A16", count: 1, memory_total_mb: 16384 },
      slurm_job_id: "9011", slurm_allocation_id: first.id, status: "online", type: "slurm",
      connected_at: new Date().toISOString(), last_heartbeat: new Date().toISOString(), max_concurrent: 1, tasks: [],
    } as unknown as Stub;

    try {
      expect(bindStubCapacityOwnership(stub)).toBe(false);
      expect(stub).toMatchObject({ status: "offline", max_concurrent: 0 });
    } finally {
      allocations.mockRestore();
    }
  });

  it("quarantines a reconnecting stub whose exact allocation is terminal", () => {
    const allocation = store.createSlurmAllocation({
      idempotency_key: "terminal", campaign_id: "campaign-1", capacity_lease_id: "lease-1",
      managed_target_id: "slurm-a16", requested_resources: {}, job_name: "terminal",
      owner: "tester", managed_by: "alchemy", pinned: false, state: "released", job_id: "9002",
    });
    const stub = {
      id: "stub-terminal", name: "gpu-9002", hostname: "gpu", gpu: { name: "A16", count: 1, memory_total_mb: 16384 },
      slurm_job_id: "9002", slurm_allocation_id: allocation.id, capacity_lease_id: "lease-1", campaign_id: "campaign-1",
      status: "online", type: "slurm", connected_at: new Date().toISOString(), last_heartbeat: new Date().toISOString(),
      max_concurrent: 1, tasks: [],
    } as unknown as Stub;

    bindStubCapacityOwnership(stub);

    expect(stub).toMatchObject({ released: true, status: "offline", max_concurrent: 0 });
    expect(stub.capacity_lease_id).toBeUndefined();
    expect(stub.campaign_id).toBeUndefined();
    expect(stub.slurm_allocation_id).toBeUndefined();
  });

});
