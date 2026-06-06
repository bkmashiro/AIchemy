import { describe, expect, it } from "vitest";
import type {
  ExperimentDiffSummary,
  ExperimentRecommendation,
  ExperimentResearchReportBlock,
  ExperimentResearchReportResponse,
} from "../../../lib/api";
import {
  buildFamilyCompareRows,
  FamilyCompareDirection,
  formatFamilyCompareMetric,
  getReportDirection,
} from "../experimentFamilyCompareUtils";

function mkBlock(overrides: {
  id: string;
  name: string;
  status?: ExperimentResearchReportResponse["experiments"][number]["status"];
  decision?: ExperimentResearchReportResponse["experiments"][number]["decision"];
  primary_metric?: ExperimentResearchReportBlock["primary_metric"] | null;
  task_counts?: ExperimentResearchReportBlock["task_counts"];
  recommendation?: ExperimentRecommendation | null;
  diff_summary?: ExperimentDiffSummary | null;
}): ExperimentResearchReportBlock {
  return {
    id: overrides.id,
    name: overrides.name,
    status: overrides.status ?? "passed",
    family: null,
    parent_id: null,
    decision: overrides.decision ?? null,
    recommendation: overrides.recommendation,
    diff_summary: overrides.diff_summary,
    decision_reason: null,
    decision_at: null,
    created_at: "2026-06-06T00:00:00Z",
    children: [],
    primary_metric: overrides.primary_metric ?? {
      metric: "loss",
      direction: "min",
      best: 1.0,
    },
    artifact_count: 0,
    checkpoint_count: 0,
    task_counts: overrides.task_counts ?? {},
    recent_events: [],
  };
}

function mkReport(overrides: {
  metric?: { name: string; direction: FamilyCompareDirection } | null;
  leaderboard?: ExperimentResearchReportResponse["leaderboard"];
  experiments: Array<ReturnType<typeof mkBlock>>;
}): ExperimentResearchReportResponse {
  return {
    filters: {
      family: null,
      decision: null,
      status: null,
      limit: 50,
    },
    generated_at: "2026-06-06T00:00:00Z",
    counts: {
      total: overrides.experiments.length,
      by_status: {},
      by_decision: {},
    },
    metric: Object.prototype.hasOwnProperty.call(overrides, "metric")
      ? (overrides.metric ?? null)
      : {
          name: "loss",
          direction: "min",
        },
    leaderboard: overrides.leaderboard ?? [],
    experiments: overrides.experiments,
  };
}

describe("getReportDirection", () => {
  it("normalizes missing or invalid directions to min", () => {
    const report = mkReport({
      metric: null,
      experiments: [mkBlock({ id: "a", name: "a", primary_metric: null })],
    });

    expect(getReportDirection(report)).toBe("min");
  });
});

describe("buildFamilyCompareRows", () => {
  it("computes best-row deltas for min direction and uses leaderboard ranking", () => {
    const rows = buildFamilyCompareRows(
      mkReport({
        metric: { name: "loss", direction: "min" },
        leaderboard: [
          {
            rank: 1,
            id: "exp-b",
            name: "beta",
            status: "passed",
            decision: null,
            value: 0.4,
            metric: "loss",
          },
          {
            rank: 2,
            id: "exp-a",
            name: "alpha",
            status: "passed",
            decision: null,
            value: 1.2,
            metric: "loss",
          },
        ],
        experiments: [
          mkBlock({
            id: "exp-a",
            name: "alpha",
            primary_metric: { metric: "loss", direction: "min", best: 1.2 },
            task_counts: { passed: 2, failed: 1 },
            recommendation: {
              action: null,
              verdict: null,
              reason: null,
              metric: "loss",
              value: null,
              baseline_value: null,
              delta: 0.25,
              direction: "min",
            },
          }),
          mkBlock({
            id: "exp-b",
            name: "beta",
            primary_metric: { metric: "loss", direction: "min", best: 0.4 },
            recommendation: {
              action: null,
              verdict: null,
              reason: null,
              metric: "loss",
              value: null,
              baseline_value: null,
              delta: -0.15,
              direction: "min",
            },
          }),
        ],
      }),
    );

    expect(rows.map((row) => row.id)).toEqual(["exp-b", "exp-a"]);
    expect(rows[0].deltaVsBest).toBe(0);
    expect(rows[1].deltaVsBest).toBeGreaterThan(0);
    expect(rows[1].deltaVsBaseline).toBe(0.25);
    expect(rows[1].taskCount).toBe(3);
  });

  it("respects max direction when computing comparison signs", () => {
    const rows = buildFamilyCompareRows(
      mkReport({
        metric: { name: "acc", direction: "max" },
        leaderboard: [
          {
            rank: 1,
            id: "exp-b",
            name: "beta",
            status: "passed",
            decision: null,
            value: 0.9,
            metric: "acc",
          },
          {
            rank: 2,
            id: "exp-a",
            name: "alpha",
            status: "passed",
            decision: null,
            value: 0.2,
            metric: "acc",
          },
        ],
        experiments: [
          mkBlock({ id: "exp-a", name: "alpha", primary_metric: { metric: "acc", direction: "max", best: 0.2 } }),
          mkBlock({ id: "exp-b", name: "beta", primary_metric: { metric: "acc", direction: "max", best: 0.9 } }),
        ],
      }),
    );

    expect(rows.map((row) => row.id)).toEqual(["exp-b", "exp-a"]);
    expect(rows[1].deltaVsBest).toBe(-0.7);
  });

  it("returns null deltas and an em dash when metric data is missing", () => {
    const rows = buildFamilyCompareRows(
      mkReport({
        metric: null,
        leaderboard: [
          {
            rank: 1,
            id: "exp-a",
            name: "alpha",
            status: "running",
            decision: null,
            value: 1,
            metric: "loss",
          },
        ],
        experiments: [
          mkBlock({
            id: "exp-a",
            name: "alpha",
            primary_metric: null,
            recommendation: null,
          }),
        ],
      }),
    );

    expect(rows[0].bestMetric).toBe("—");
    expect(rows[0].deltaVsBest).toBeNull();
    expect(rows[0].deltaVsBaseline).toBeNull();
  });

  it("does not reuse recommendation deltas from a different metric", () => {
    const rows = buildFamilyCompareRows(
      mkReport({
        metric: { name: "loss", direction: "min" },
        leaderboard: [
          {
            rank: 1,
            id: "exp-a",
            name: "alpha",
            status: "passed",
            decision: null,
            value: 0.4,
            metric: "loss",
          },
        ],
        experiments: [
          mkBlock({
            id: "exp-a",
            name: "alpha",
            primary_metric: { metric: "loss", direction: "min", best: 0.4 },
            recommendation: {
              action: "keep",
              verdict: "best",
              reason: null,
              metric: "accuracy",
              value: 0.9,
              baseline_value: 0.8,
              delta: 0.1,
              direction: "max",
            },
          }),
        ],
      }),
    );

    expect(rows[0].deltaVsBaseline).toBeNull();
    expect(rows[0].deltaVsBaselineFormatted).toBe("—");
  });

  it("sorts deterministically by experiment name/id when no leaderboard ranking exists", () => {
    const rows = buildFamilyCompareRows(
      mkReport({
        leaderboard: [],
        experiments: [
          mkBlock({ id: "z3", name: "zeta", primary_metric: { metric: "loss", direction: "min", best: 2 } }),
          mkBlock({ id: "a1", name: "zeta", primary_metric: { metric: "loss", direction: "min", best: 1 } }),
          mkBlock({ id: "m2", name: "mu", primary_metric: { metric: "loss", direction: "min", best: 3 } }),
          mkBlock({ id: "a0", name: "alpha", primary_metric: { metric: "loss", direction: "min", best: 4 } }),
        ],
      }),
    );

    expect(rows.map((row) => [row.experiment, row.id])).toEqual([
      ["alpha", "a0"],
      ["mu", "m2"],
      ["zeta", "a1"],
      ["zeta", "z3"],
    ]);
  });
});

describe("formatFamilyCompareMetric", () => {
  it("uses stable compact formatting with an em dash for nulls", () => {
    expect(formatFamilyCompareMetric(null)).toBe("—");
    expect(formatFamilyCompareMetric(12345)).toBe("12345");
    expect(formatFamilyCompareMetric(0.0004)).toBe("4e-4");
  });
});
