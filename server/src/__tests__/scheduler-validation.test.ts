import { describe, expect, it } from "vitest";
import { computeRunDir, evaluateStubEligibility } from "../scheduler";
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

describe("run_dir allocation", () => {
  it("uses full task IDs for implicit output isolation, not fingerprints", () => {
    const stub = onlineA30Stub();
    stub.default_output_dir = "/shared/results";
    const first = { ...pendingTask(), id: "task-uuid-1", fingerprint: "same-content" };
    const second = { ...pendingTask(), id: "task-uuid-2", fingerprint: "same-content" };

    expect(computeRunDir(first, stub)).toBe("/shared/results/task-uuid-1");
    expect(computeRunDir(second, stub)).toBe("/shared/results/task-uuid-2");
  });

  it("preserves explicitly selected run directories", () => {
    const task = { ...pendingTask(), run_dir: "/shared/legacy-resume" };
    expect(computeRunDir(task, onlineA30Stub())).toBe("/shared/legacy-resume");
  });
});
