import { describe, expect, it } from "vitest";
import type { ExperimentRecommendation, ExperimentTreeNode } from "../../../lib/api";
import {
  recommendationBadgeClass,
  recommendationLabel,
  formatMetricDelta,
  diffChipLabels,
} from "../experimentDetailUtils";

function mkRecommendation(overrides: Partial<ExperimentRecommendation>): ExperimentRecommendation {
  return {
    action: null,
    verdict: null,
    reason: null,
    metric: null,
    value: null,
    baseline_value: null,
    delta: null,
    direction: null,
    ...overrides,
  };
}

function briefNode(
  overrides: Partial<ExperimentTreeNode> & { id: string; name: string },
): ExperimentTreeNode {
  return {
    status: "running",
    family: null,
    parent_id: null,
    decision: null,
    fork_reason: null,
    goal_metric: null,
    goal_direction: null,
    recommendation: null,
    diff_summary: null,
    created_at: "2026-06-06T00:00:00Z",
    children: [],
    ...overrides,
  } as ExperimentTreeNode;
}

describe("recommendationBadgeClass", () => {
  it("maps known recommendation actions/verdicts to decision colors", () => {
    expect(recommendationBadgeClass("keep")).toBe("bg-green-900/30 text-green-400 border-green-700/40");
    expect(recommendationBadgeClass("DROP")).toBe("bg-red-900/30 text-red-400 border-red-700/40");
    expect(recommendationBadgeClass("  rerun  ")).toBe("bg-blue-900/30 text-blue-400 border-blue-700/40");
  });

  it("falls back to cyan recommendation chip for unknown values", () => {
    expect(recommendationBadgeClass("maybe"))
      .toBe("bg-cyan-900/30 text-cyan-400 border-cyan-700/40");
    expect(recommendationBadgeClass(""))
      .toBe("bg-cyan-900/30 text-cyan-400 border-cyan-700/40");
    expect(recommendationBadgeClass(null)).toBe("bg-cyan-900/30 text-cyan-400 border-cyan-700/40");
  });
});

describe("recommendationLabel", () => {
  it("prefers action when present", () => {
    const rec = mkRecommendation({
      action: "Fork this run",
      verdict: "keep",
    });
    expect(recommendationLabel(rec)).toBe("Fork this run");
  });

  it("falls back to verdict only when action is absent", () => {
    const rec = mkRecommendation({
      action: "   ",
      verdict: "drop",
    });
    expect(recommendationLabel(rec)).toBe("drop");
  });

  it("returns null when no action or verdict exists", () => {
    expect(recommendationLabel(null)).toBeNull();
    expect(recommendationLabel(mkRecommendation({}))).toBeNull();
  });
});

describe("formatMetricDelta", () => {
  it("adds directional arrows and stable precision", () => {
    expect(formatMetricDelta(1.23456, "max")).toBe("↑ +1.2346");
    expect(formatMetricDelta(-0.25, "min")).toBe("↓ -0.2500");
  });

  it("uses sign for unknown directions", () => {
    expect(formatMetricDelta(0.1)).toBe("+0.1000");
    expect(formatMetricDelta(-0.1)).toBe("-0.1000");
  });

  it("returns null for null/invalid deltas", () => {
    expect(formatMetricDelta(null)).toBeNull();
    expect(formatMetricDelta(Number.NaN)).toBeNull();
    expect(formatMetricDelta(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("diffChipLabels", () => {
  it("builds compact labels for diff summary fields", () => {
    const node = briefNode({
      id: "child-1",
      name: "child",
      status: "passed",
      diff_summary: {
        config_changed: true,
        config_change_count: 3,
        metric_delta: -0.4,
        metric: "loss",
        direction: "min",
        status_changed_from_parent: true,
        parent_status: "running",
      },
    });

    expect(diffChipLabels(node)).toEqual([
      "loss: ↓ -0.4000",
      "config +3",
      "status running→passed",
    ]);
  });

  it("returns an empty list when no diff summary exists", () => {
    expect(diffChipLabels(briefNode({ id: "root", name: "root" }))).toEqual([]);
  });

  it("omits optional diff fields that are absent", () => {
    const node = briefNode({
      id: "child-2",
      name: "child2",
      diff_summary: {
        config_changed: false,
        config_change_count: 0,
        metric_delta: null,
        metric: null,
        direction: null,
        status_changed_from_parent: null,
        parent_status: null,
      },
    });

    expect(diffChipLabels(node)).toEqual([]);
  });
});
