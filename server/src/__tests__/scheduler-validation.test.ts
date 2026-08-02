import { describe, expect, it } from "vitest";
import { evaluateStubEligibility } from "../scheduler";
import type { Stub, Task } from "../types";

function onlineA30Stub(): Stub {
  return {
    id: "stub-a30",
    name: "a30",
    hostname: "gpu-a30",
    gpu: { name: "NVIDIA A30", vram_total_mb: 24576, count: 1 },
    status: "online",
    type: "slurm",
    connected_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    max_concurrent: 1,
    tasks: [],
  };
}

function pendingTask(): Task {
  return {
    id: "task-invalid-gpu-type",
    seq: 1,
    fingerprint: "invalid-gpu-type",
    display_name: "invalid gpu type",
    script: "/tmp/train.py",
    command: "/tmp/train.py",
    status: "pending",
    priority: 5,
    created_at: new Date().toISOString(),
    log_buffer: [],
    retry_count: 0,
    max_retries: 0,
    should_stop: false,
    should_checkpoint: false,
    kill_requested: false,
  };
}

describe("scheduler runtime input defense", () => {
  it("rejects a persisted scalar gpu_type without throwing", () => {
    const task = pendingTask();
    task.requirements = { gpu_type: "A30" } as unknown as Task["requirements"];

    const result = evaluateStubEligibility(onlineA30Stub(), task);

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("invalid_resource_requirement");
  });
});
