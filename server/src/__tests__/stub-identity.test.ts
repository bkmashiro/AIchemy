/**
 * Unit tests for stub identity computation and reconnection logic.
 *
 * Validates that server computeStubId produces deterministic, consistent
 * results and that the formula matches the Python stub implementation.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { computeStubId } from "../socket/stub";

/**
 * Reference implementation of the Python stub's _compute_identity_hash.
 * Used to verify cross-language consistency.
 *
 * Python formula: sha256(f"{hostname}|{cuda_visible_devices}|{gpu_name}|{gpu_count}|{user}|{slurm_job_id}")[:12]
 */
function pythonStubId(
  hostname: string,
  gpuName: string,
  gpuCount: number,
  cudaVisibleDevices: string = "",
  user: string = "",
  slurmJobId: string = "",
): string {
  const raw = `${hostname}|${cudaVisibleDevices}|${gpuName}|${gpuCount}|${user}|${slurmJobId}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

describe("computeStubId", () => {
  it("produces a 12-char hex string", () => {
    const id = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "0");
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is deterministic (same inputs → same output)", () => {
    const a = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "0");
    const b = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "0");
    expect(a).toBe(b);
  });

  it("differs when hostname changes", () => {
    const a = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "0");
    const b = computeStubId("gpu33", { name: "NVIDIA A40", count: 1 }, "0");
    expect(a).not.toBe(b);
  });

  it("differs when gpu name changes", () => {
    const a = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "0");
    const b = computeStubId("gpu32", { name: "NVIDIA A100", count: 1 }, "0");
    expect(a).not.toBe(b);
  });

  it("differs when gpu count changes", () => {
    const a = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "0");
    const b = computeStubId("gpu32", { name: "NVIDIA A40", count: 2 }, "0");
    expect(a).not.toBe(b);
  });

  it("differs when CUDA_VISIBLE_DEVICES changes", () => {
    const a = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "0");
    const b = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "1");
    expect(a).not.toBe(b);
  });

  it("differs when user changes (multi-user same node)", () => {
    const a = computeStubId("clapper", { name: "NVIDIA A30", count: 1 }, "0", "ys25");
    const b = computeStubId("clapper", { name: "NVIDIA A30", count: 1 }, "0", "hw2025");
    expect(a).not.toBe(b);
  });

  it("differs when slurm_job_id changes (multi-job same user same node)", () => {
    const a = computeStubId("dipper", { name: "NVIDIA A30", count: 1 }, "0", "hw2025", "12345");
    const b = computeStubId("dipper", { name: "NVIDIA A30", count: 1 }, "0", "hw2025", "12346");
    expect(a).not.toBe(b);
  });

  it("workstation stubs (no user/slurm) remain stable", () => {
    const a = computeStubId("gpu32", { name: "NVIDIA RTX 4080", count: 1 }, "0");
    const b = computeStubId("gpu32", { name: "NVIDIA RTX 4080", count: 1 }, "0");
    expect(a).toBe(b);
  });

  it("treats undefined and missing CUDA_VISIBLE_DEVICES the same", () => {
    const a = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, undefined);
    const b = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 });
    expect(a).toBe(b);
  });

  // Cross-language consistency: server formula must match Python stub formula
  it("matches Python stub _compute_identity_hash for workstation", () => {
    const serverId = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "0,1");
    const stubId = pythonStubId("gpu32", "NVIDIA A40", 1, "0,1");
    expect(serverId).toBe(stubId);
  });

  it("matches Python stub _compute_identity_hash for SLURM job", () => {
    const serverId = computeStubId("gpu33", { name: "NVIDIA A100-SXM4-80GB", count: 2 }, "0,1", "ys25", "238291");
    const stubId = pythonStubId("gpu33", "NVIDIA A100-SXM4-80GB", 2, "0,1", "ys25", "238291");
    expect(serverId).toBe(stubId);
  });

  it("matches Python stub _compute_identity_hash for CPU-only", () => {
    const serverId = computeStubId("dipper", { name: "CPU-only", count: 0 });
    const stubId = pythonStubId("dipper", "CPU-only", 0, "");
    expect(serverId).toBe(stubId);
  });

  it("matches Python stub _compute_identity_hash with empty CUDA_VISIBLE_DEVICES", () => {
    const serverId = computeStubId("node01", { name: "NVIDIA A30", count: 4 }, "");
    const stubId = pythonStubId("node01", "NVIDIA A30", 4, "");
    expect(serverId).toBe(stubId);
  });
});
