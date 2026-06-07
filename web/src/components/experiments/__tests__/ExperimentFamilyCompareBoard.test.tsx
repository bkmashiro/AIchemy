import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type {
  ExperimentRecommendation,
  ExperimentResearchReportBlock,
  ExperimentResearchReportLeaderEntry,
  ExperimentResearchReportResponse,
} from "../../../lib/api";
import { ExperimentFamilyCompareBoard } from "../ExperimentFamilyCompareBoard";

type BlockWithExtras = ExperimentResearchReportBlock & {
  recommendation?: ExperimentRecommendation | null;
  config_count?: number | null;
};

function leader(
  overrides: Partial<ExperimentResearchReportLeaderEntry> = {},
): ExperimentResearchReportLeaderEntry {
  return {
    rank: 1,
    id: "exp-baseline",
    name: "exp/baseline",
    status: "passed",
    decision: null,
    value: 0.2,
    metric: "loss",
    ...overrides,
  };
}

function block(overrides: Partial<BlockWithExtras> = {}): BlockWithExtras {
  return {
    id: "exp-baseline",
    name: "exp/baseline",
    family: "fam-a",
    status: "passed",
    decision: "keep",
    decision_reason: null,
    decision_at: null,
    created_at: "2026-06-01T00:00:00Z",
    parent_id: null,
    children: [],
    task_counts: { passed: 2, failed: 1 },
    primary_metric: { metric: "loss", direction: "min", best: 0.2 },
    artifact_count: 2,
    checkpoint_count: 1,
    recent_events: [],
    recommendation: {
      action: "keep",
      verdict: "best",
      reason: null,
      metric: "loss",
      value: 0.2,
      baseline_value: 0.2,
      delta: 0,
      direction: "min",
    },
    config_count: 4,
    ...overrides,
  };
}

function makeReport(
  overrides: Partial<ExperimentResearchReportResponse> = {},
): ExperimentResearchReportResponse {
  const baseline = block();
  const regression = block({
    id: "exp-regression",
    name: "exp/regression",
    decision: "drop",
    task_counts: { passed: 1, failed: 2 },
    primary_metric: { metric: "loss", direction: "min", best: 0.55 },
    recommendation: {
      action: "rerun",
      verdict: "rerun",
      reason: null,
      metric: "loss",
      value: 0.55,
      baseline_value: 0.2,
      delta: 0.35,
      direction: "min",
    },
    config_count: 1,
  });
  return {
    filters: { family: "fam-a", decision: null, status: null, limit: 50 },
    generated_at: "2026-06-01T00:00:00Z",
    counts: { total: 2, by_status: {}, by_decision: {} },
    metric: { name: "loss", direction: "min" },
    leaderboard: [
      leader(),
      leader({ rank: 2, id: "exp-regression", name: "exp/regression", value: 0.55 }),
    ],
    experiments: [baseline, regression],
    ...overrides,
  };
}

function renderBoard(
  report: ExperimentResearchReportResponse,
  onSelectExperiment?: (id: string) => void,
) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ExperimentFamilyCompareBoard
        report={report}
        onSelectExperiment={onSelectExperiment}
        selectedId="exp-regression"
      />
    </MemoryRouter>,
  );
}

describe("ExperimentFamilyCompareBoard", () => {
  it("renders empty state for missing family or experiments", () => {
    renderBoard(
      makeReport({
        filters: { family: null, decision: null, status: null, limit: 50 },
        experiments: [],
        leaderboard: [],
      }),
    );

    expect(screen.getByText("Family compare")).toBeInTheDocument();
    expect(screen.getByText(/select a family/i)).toBeInTheDocument();
  });

  it("renders winner and regression rows", () => {
    renderBoard(makeReport(), vi.fn());

    const winnerRow = screen.getByRole("button", { name: /Select exp\/baseline for family compare/i });
    const regressionRow = screen.getByRole("button", { name: /Select exp\/regression for family compare/i });

    expect(winnerRow).toHaveAttribute("data-row-kind", "winner");
    expect(regressionRow).toHaveAttribute("data-row-kind", "regression");
  });

  it("shows recommendation, metric, delta, task, and config columns", () => {
    renderBoard(makeReport(), vi.fn());

    ["Experiment", "Status", "Recommendation", "Best", "Δ best", "Δ baseline", "Config", "Tasks", "Decision"].forEach(
      (header) => expect(screen.getByText(header)).toBeInTheDocument(),
    );

    const winnerRow = screen.getByRole("button", { name: /Select exp\/baseline for family compare/i });
    const regressionRow = screen.getByRole("button", { name: /Select exp\/regression for family compare/i });

    expect(screen.getByTestId("recommendation-exp-baseline")).toHaveTextContent("keep");
    expect(screen.getByTestId("recommendation-exp-regression")).toHaveTextContent("Needs stronger evidence");

    expect(screen.getByTestId("recommendation-exp-baseline")).toHaveClass("bg-green-900/30");
    expect(screen.getByTestId("recommendation-exp-regression")).toHaveClass("bg-blue-900/30");

    expect(within(winnerRow).getByText("0.2")).toBeInTheDocument();
    expect(within(regressionRow).getByText("0.55")).toBeInTheDocument();
    expect(within(winnerRow).getByText("4")).toBeInTheDocument();
    expect(within(regressionRow).getByText("1")).toBeInTheDocument();
    expect(within(winnerRow).getByText("3")).toBeInTheDocument();
    expect(within(regressionRow).getByText("3")).toBeInTheDocument();
  });

  it("calls onSelectExperiment when a row is clicked", () => {
    const onSelectExperiment = vi.fn();
    renderBoard(makeReport(), onSelectExperiment);

    fireEvent.click(screen.getByRole("button", { name: /Select exp\/baseline for family compare/i }));

    expect(onSelectExperiment).toHaveBeenCalledTimes(1);
    expect(onSelectExperiment).toHaveBeenCalledWith("exp-baseline");
  });
});
