/**
 * cost.test.ts — Unit tests for GPU cost calculation.
 *
 * Covers: fuzzy GPU name matching, rate card lookup, cost computation,
 * edge cases (no timing data, running tasks).
 */

import { describe, it, expect } from "vitest";
import {
  matchGpuType,
  getGpuRate,
  computeTaskCost,
  GPU_RATE_CARD,
} from "../src/cost";
import { Task } from "../src/types";

// ─── matchGpuType ────────────────────────────────────────────────────────────

describe("matchGpuType", () => {
  it("matches full NVIDIA A100 name", () => {
    expect(matchGpuType("NVIDIA A100-SXM4-80GB")).toBe("A100");
  });

  it("matches bare A100", () => {
    expect(matchGpuType("A100")).toBe("A100");
  });

  it("matches A40", () => {
    expect(matchGpuType("NVIDIA A40")).toBe("A40");
  });

  it("matches A30", () => {
    expect(matchGpuType("NVIDIA A30")).toBe("A30");
  });

  it("matches RTX 4080 with spaces", () => {
    expect(matchGpuType("NVIDIA GeForce RTX 4080")).toBe("RTX4080");
  });

  it("matches RTX 3090 with various formats", () => {
    expect(matchGpuType("NVIDIA GeForce RTX 3090 Ti")).toBe("RTX3090");
    expect(matchGpuType("RTX3090")).toBe("RTX3090");
  });

  it("returns default for unknown GPU", () => {
    expect(matchGpuType("NVIDIA Tesla V100-SXM2-32GB")).toBe("default");
    expect(matchGpuType("AMD Radeon RX 7900")).toBe("default");
  });

  it("is case insensitive", () => {
    expect(matchGpuType("nvidia a100")).toBe("A100");
    expect(matchGpuType("a40")).toBe("A40");
  });
});

// ─── getGpuRate ──────────────────────────────────────────────────────────────

describe("getGpuRate", () => {
  it("returns correct rate for A100", () => {
    expect(getGpuRate("NVIDIA A100-SXM4-80GB")).toBe(2.0);
  });

  it("returns correct rate for A40", () => {
    expect(getGpuRate("NVIDIA A40")).toBe(1.0);
  });

  it("returns correct rate for A30", () => {
    expect(getGpuRate("NVIDIA A30")).toBe(0.7);
  });

  it("returns default rate for unknown GPU", () => {
    expect(getGpuRate("NVIDIA Tesla V100")).toBe(GPU_RATE_CARD.default);
  });
});

// ─── computeTaskCost ─────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "test-task-1",
    seq: 1,
    fingerprint: "abc123",
    display_name: "test_task",
    script: "python train.py",
    command: "python train.py",
    status: "completed",
    priority: 0,
    created_at: "2025-01-01T00:00:00Z",
    started_at: "2025-01-01T01:00:00Z",
    finished_at: "2025-01-01T03:00:00Z", // 2 hours
    log_buffer: [],
    retry_count: 0,
    max_retries: 0,
    should_stop: false,
    should_checkpoint: false,
    ...overrides,
  };
}

describe("computeTaskCost", () => {
  it("computes cost for a 2-hour task on 1 A100", () => {
    const task = makeTask();
    const cost = computeTaskCost(task, "NVIDIA A100-SXM4-80GB", 1);
    expect(cost).not.toBeNull();
    expect(cost!.gpu_hours).toBeCloseTo(2.0, 2);
    expect(cost!.cost_usd).toBeCloseTo(4.0, 2);
    expect(cost!.gpu_type).toBe("A100");
    expect(cost!.rate_per_hour).toBe(2.0);
  });

  it("multiplies by gpu_count", () => {
    const task = makeTask();
    const cost = computeTaskCost(task, "NVIDIA A40", 4);
    expect(cost).not.toBeNull();
    expect(cost!.gpu_hours).toBeCloseTo(8.0, 2); // 2h * 4 GPUs
    expect(cost!.cost_usd).toBeCloseTo(8.0, 2); // 8 gpu-hours * $1/hr
  });

  it("returns null when no started_at", () => {
    const task = makeTask({ started_at: undefined });
    expect(computeTaskCost(task, "A100", 1)).toBeNull();
  });

  it("uses default rate for unknown GPU", () => {
    const task = makeTask();
    const cost = computeTaskCost(task, "Mystery GPU 9000", 1);
    expect(cost).not.toBeNull();
    expect(cost!.rate_per_hour).toBe(GPU_RATE_CARD.default);
    expect(cost!.gpu_type).toBe("default");
  });

  it("handles running task (no finished_at) using current time", () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3_600_000);
    const task = makeTask({
      status: "running",
      started_at: oneHourAgo.toISOString(),
      finished_at: undefined,
    });
    const cost = computeTaskCost(task, "A30", 2);
    expect(cost).not.toBeNull();
    // Should be roughly 2 gpu-hours (1h * 2 GPUs), allow some tolerance for test execution time
    expect(cost!.gpu_hours).toBeGreaterThan(1.9);
    expect(cost!.gpu_hours).toBeLessThan(2.1);
  });

  it("returns null for invalid time range (end <= start)", () => {
    const task = makeTask({
      started_at: "2025-01-01T03:00:00Z",
      finished_at: "2025-01-01T01:00:00Z",
    });
    expect(computeTaskCost(task, "A100", 1)).toBeNull();
  });
});
