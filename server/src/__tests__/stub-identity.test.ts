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
 * Python formula: sha256(f"{hostname}|{gpu_name}|{gpu_count}|{default_cwd}|{slurm_job_id or ''}")[:12]
 */
function pythonStubId(
  hostname: string,
  gpuName: string,
  gpuCount: number,
  defaultCwd: string,
  slurmJobId?: string,
): string {
  const raw = `${hostname}|${gpuName}|${gpuCount}|${defaultCwd}|${slurmJobId || ""}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

describe("computeStubId", () => {
  it("produces a 12-char hex string", () => {
    const id = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "/vol/cwd");
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is deterministic (same inputs → same output)", () => {
    const a = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "/vol/cwd");
    const b = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "/vol/cwd");
    expect(a).toBe(b);
  });

  it("differs when hostname changes", () => {
    const a = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "/vol/cwd");
    const b = computeStubId("gpu33", { name: "NVIDIA A40", count: 1 }, "/vol/cwd");
    expect(a).not.toBe(b);
  });

  it("differs when gpu name changes", () => {
    const a = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "/vol/cwd");
    const b = computeStubId("gpu32", { name: "NVIDIA A100", count: 1 }, "/vol/cwd");
    expect(a).not.toBe(b);
  });

  it("differs when gpu count changes", () => {
    const a = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "/vol/cwd");
    const b = computeStubId("gpu32", { name: "NVIDIA A40", count: 2 }, "/vol/cwd");
    expect(a).not.toBe(b);
  });

  it("differs when cwd changes", () => {
    const a = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "/vol/cwd1");
    const b = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "/vol/cwd2");
    expect(a).not.toBe(b);
  });

  it("differs when slurm_job_id changes", () => {
    const a = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "/vol/cwd", "12345");
    const b = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "/vol/cwd", "67890");
    expect(a).not.toBe(b);
  });

  it("treats undefined and missing cwd the same", () => {
    const a = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, undefined);
    const b = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 });
    expect(a).toBe(b);
  });

  it("treats undefined and missing slurm_job_id the same", () => {
    const a = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "/vol/cwd", undefined);
    const b = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "/vol/cwd");
    expect(a).toBe(b);
  });

  // Cross-language consistency: server formula must match Python stub formula
  it("matches Python stub _compute_identity_hash for workstation", () => {
    const serverId = computeStubId("gpu32", { name: "NVIDIA A40", count: 1 }, "/vol/bitbucket/ys25/jema");
    const stubId = pythonStubId("gpu32", "NVIDIA A40", 1, "/vol/bitbucket/ys25/jema");
    expect(serverId).toBe(stubId);
  });

  it("matches Python stub _compute_identity_hash for SLURM job", () => {
    const serverId = computeStubId("gpu33", { name: "NVIDIA A100-SXM4-80GB", count: 2 }, "/vol/cwd", "9876543");
    const stubId = pythonStubId("gpu33", "NVIDIA A100-SXM4-80GB", 2, "/vol/cwd", "9876543");
    expect(serverId).toBe(stubId);
  });

  it("matches Python stub _compute_identity_hash for CPU-only", () => {
    const serverId = computeStubId("dipper", { name: "CPU-only", count: 0 }, "/home/user/work");
    const stubId = pythonStubId("dipper", "CPU-only", 0, "/home/user/work");
    expect(serverId).toBe(stubId);
  });

  it("matches Python stub _compute_identity_hash with empty cwd", () => {
    const serverId = computeStubId("node01", { name: "NVIDIA A30", count: 4 }, "");
    const stubId = pythonStubId("node01", "NVIDIA A30", 4, "");
    expect(serverId).toBe(stubId);
  });
});
