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
 * Python formula: sha256(f"{hostname}|{user}|{instance_id}|{slurm_job_id}")[:12]
 */
function pythonStubId(
  hostname: string,
  user: string = "",
  instanceId: string = "",
  slurmJobId: string = "",
): string {
  const raw = `${hostname}|${user}|${instanceId}|${slurmJobId}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

describe("computeStubId", () => {
  it("produces a 12-char hex string", () => {
    const id = computeStubId("gpu32");
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is deterministic (same inputs → same output)", () => {
    const a = computeStubId("gpu32", "ys25", "0");
    const b = computeStubId("gpu32", "ys25", "0");
    expect(a).toBe(b);
  });

  it("differs when hostname changes", () => {
    const a = computeStubId("gpu32", "ys25", "0");
    const b = computeStubId("gpu33", "ys25", "0");
    expect(a).not.toBe(b);
  });

  it("differs when user changes (multi-user same node)", () => {
    const a = computeStubId("clapper", "ys25", "0");
    const b = computeStubId("clapper", "hw2025", "0");
    expect(a).not.toBe(b);
  });

  it("differs when workstation instance changes (same user same node multi-stub)", () => {
    const a = computeStubId("gpu32", "ys25", "0");
    const b = computeStubId("gpu32", "ys25", "1");
    expect(a).not.toBe(b);
  });

  it("differs when slurm_job_id changes (multi-job same user same node)", () => {
    const a = computeStubId("dipper", "hw2025", "12345", "12345");
    const b = computeStubId("dipper", "hw2025", "12346", "12346");
    expect(a).not.toBe(b);
  });

  it("treats undefined and empty user the same", () => {
    const a = computeStubId("gpu32", undefined);
    const b = computeStubId("gpu32");
    expect(a).toBe(b);
  });

  // Cross-language consistency: server formula must match Python stub formula
  it("matches Python stub _compute_identity_hash for workstation", () => {
    const serverId = computeStubId("gpu32", "ys25", "0");
    const stubId = pythonStubId("gpu32", "ys25", "0");
    expect(serverId).toBe(stubId);
  });

  it("matches Python stub _compute_identity_hash for SLURM job", () => {
    const serverId = computeStubId("gpu33", "ys25", "238291", "238291");
    const stubId = pythonStubId("gpu33", "ys25", "238291", "238291");
    expect(serverId).toBe(stubId);
  });

  it("matches Python stub _compute_identity_hash for no-user case", () => {
    const serverId = computeStubId("dipper");
    const stubId = pythonStubId("dipper", "");
    expect(serverId).toBe(stubId);
  });

  it("matches Python stub _compute_identity_hash with empty slurm_job_id", () => {
    const serverId = computeStubId("node01", "ys25", "", "");
    const stubId = pythonStubId("node01", "ys25", "", "");
    expect(serverId).toBe(stubId);
  });
});
