import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type {
  ExperimentDetail,
  ExperimentRecommendation,
  ExperimentSummaryResponse,
} from "../../../lib/api";
import { ExperimentResearchCallCard } from "../ExperimentResearchCallCard";

function makeExperiment(
  overrides: Partial<ExperimentDetail> = {},
): ExperimentDetail {
  return {
    id: "exp-a",
    name: "research-call",
    criteria: {},
    grid_id: "grid-a",
    status: "running",
    results: {},
    created_at: "2026-06-01T00:00:00.000Z",
    description: "",
    ...overrides,
  };
}

function makeSummary(
  overrides: Partial<ExperimentSummaryResponse> = {},
): ExperimentSummaryResponse {
  return {
    id: "exp-a",
    name: "research-call",
    status: "running",
    family: null,
    hypothesis: null,
    expected_outcome: null,
    fork_reason: null,
    goal_metric: null,
    goal_direction: null,
    decision: null,
    decision_reason: null,
    decision_at: null,
    created_at: "2026-06-01T00:00:00.000Z",
    parent: null,
    children: [],
    task_counts: {},
    validation: { passed: 2, failed: 1, total: 3 },
    best_metrics: { loss: 0.1234 },
    primary_metric: null,
    recommendation: null,
    timeline_event_count: 0,
    config: null,
    config_diff: null,
    ...overrides,
  };
}

function makeRecommendation(
  overrides: Partial<ExperimentRecommendation> = {},
): ExperimentRecommendation {
  return {
    action: "Rerun with larger cohort",
    verdict: "rerun",
    reason: "Signal is still noisy and sample count is low.",
    metric: "val_loss",
    value: 0.9012,
    baseline_value: 0.9123,
    delta: -0.0111,
    direction: "down",
    ...overrides,
  };
}

describe("ExperimentResearchCallCard", () => {
  it("uses explicit decision action when present even if recommendation exists", () => {
    const exp = makeExperiment({ decision: "drop" });
    const summary = makeSummary({
      decision: "drop",
      recommendation: makeRecommendation({ action: "Rerun with larger cohort" }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    expect(screen.getByText("Fold into background")).toBeInTheDocument();
    expect(screen.getByText("Rerun with larger cohort")).toBeInTheDocument();
  });

  it("uses user-facing copy for rerun decisions", () => {
    const exp = makeExperiment({ decision: "rerun" });
    const summary = makeSummary({
      decision: "rerun",
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    expect(screen.getByText("Run replication")).toBeInTheDocument();
    expect(screen.getByText("needs replication")).toBeInTheDocument();
  });

  it("falls back to summary recommendation when no explicit decision exists", () => {
    const exp = makeExperiment({ fork_reason: "from null" });
    const summary = makeSummary({
      recommendation: makeRecommendation({ action: "Rerun with larger cohort" }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    expect(screen.getAllByText("Signal is still noisy and sample count is low.")).toHaveLength(2);
    expect(screen.getByText("val_loss")).toBeInTheDocument();
    expect(screen.getByText(/\b0\.9012\b/)).toBeInTheDocument();
    expect(screen.getByText(/\b0\.9123\b/)).toBeInTheDocument();
    expect(screen.getByText(/-0\.0111/)).toBeInTheDocument();
  });

  it("renders recommendation action rerun as needs replication", () => {
    const exp = makeExperiment({});
    const summary = makeSummary({
      recommendation: makeRecommendation({
        action: "rerun",
        verdict: null,
        reason: "Noisy signal.",
      }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    const labels = screen.getAllByText("Needs replication");
    expect(labels).toHaveLength(2);
  });

  it("renders recommendation card defensively when partially missing fields", () => {
    const exp = makeExperiment();
    const summary = makeSummary({
      recommendation: makeRecommendation({
        action: null,
        verdict: null,
        reason: null,
        metric: null,
        value: null,
        baseline_value: null,
        delta: null,
        direction: null,
      }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    expect(screen.getByText("No action")).toBeInTheDocument();
    expect(screen.getByText("No verdict")).toBeInTheDocument();
  });
});
