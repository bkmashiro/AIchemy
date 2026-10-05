import { describe, expect, it } from "vitest";
import { evaluateStubEligibility, getStubCapacity } from "../scheduler";
import type { Stub, Task } from "../types";

const baseStub = (): Stub => ({
  id: "slurm-100",
  name: "slurm-100",
  hostname: "shared-node",
  gpu: { name: "Unknown GPU allocation", vram_total_mb: 0, count: 0, allocation_known: false },
  status: "online",
  type: "slurm",
  slurm_job_id: "100",
  connected_at: new Date().toISOString(),
  last_heartbeat: new Date().toISOString(),
  max_concurrent: 2,
  tasks: [],
  system_stats: { cpu_pct: 0, mem_used_mb: 0, mem_total_mb: 512000 },
});

const task = (requirements?: Task["requirements"]): Task => ({
  id: "task-1",
  seq: 1,
  fingerprint: "task-1",
  display_name: "task",
  script: "train.py",
  command: "train.py",
  requirements,
  status: "pending",
  priority: 1,
  created_at: new Date().toISOString(),
  log_buffer: [],
  retry_count: 0,
  max_retries: 0,
  should_stop: false,
  should_checkpoint: false,
});

describe("Slurm GPU allocation capacity", () => {
  it("does not expose host GPU totals or admit GPU work when allocation mapping is unknown", () => {
    const stub = baseStub();
    expect(getStubCapacity(stub).gpu).toMatchObject({ total_mb: 0, allocation_known: false });
    const gpuResult = evaluateStubEligibility(stub, task({ gpu_mem_mb: 1000 }));
    expect(gpuResult.eligible).toBe(false);
    expect(gpuResult.reasons).toContain("gpu_allocation_unknown");
  });

  it("does not block CPU-only tasks solely because GPU allocation mapping is unknown", () => {
    const result = evaluateStubEligibility(baseStub(), task({ cpu_mem_mb: 1000 }));
    expect(result.eligible).toBe(true);
    expect(result.reasons).not.toContain("gpu_allocation_unknown");
  });

  it("uses only the explicitly reported Slurm allocation capacity", () => {
    const stub = baseStub();
    stub.gpu = { name: "NVIDIA A100", vram_total_mb: 40000, count: 1, allocation_known: true };
    stub.gpu_stats = {
      timestamp: new Date().toISOString(),
      allocation_known: true,
      gpus: [{ index: 3, utilization_pct: 10, memory_used_mb: 0, memory_total_mb: 40000, temperature_c: 40 }],
    };
    const result = evaluateStubEligibility(stub, task({ gpu_mem_mb: 1000 }));
    expect(result.eligible).toBe(true);
    expect(result.capacity.gpu).toMatchObject({ total_mb: 40000, allocation_known: true });
  });
});
