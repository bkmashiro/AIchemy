import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
    evidence_quality: "weak",
    evidence_reason: "Signal is still noisy and sample count is low.",
    sample_count: 1,
    baseline_source: "parent",
    comparable_count: 1,
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
    expect(screen.getByText("Plan replication with larger cohort")).toBeInTheDocument();
  });

  it("uses user-facing copy for rerun decisions", () => {
    const exp = makeExperiment({ decision: "rerun" });
    const summary = makeSummary({
      decision: "rerun",
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    expect(screen.getByText("Plan replication")).toBeInTheDocument();
    expect(screen.getByText("needs stronger evidence")).toBeInTheDocument();
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
    expect(screen.getByText("weak")).toBeInTheDocument();
    expect(screen.getByText(/baseline: parent/)).toBeInTheDocument();
    expect(screen.getByText(/Samples: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Comparables: 1/)).toBeInTheDocument();
  });

  it("renders recommendation action rerun as needs stronger evidence", () => {
    const exp = makeExperiment({});
    const summary = makeSummary({
      recommendation: makeRecommendation({
        action: "rerun",
        verdict: null,
        reason: "Noisy signal.",
      }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    const labels = screen.getAllByText("Needs stronger evidence");
    expect(labels).toHaveLength(2);
  });

  it("renders a dry-run replication plan preview for rerun recommendations", () => {
    const exp = makeExperiment({});
    const summary = makeSummary({
      recommendation: makeRecommendation({
        action: "rerun",
        verdict: null,
        reason: "Need higher confidence before shipping",
      }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    expect(screen.getByText("Replication plan")).toBeInTheDocument();
    expect(screen.getByText(/Replication plan preview for stronger evidence/)).toBeInTheDocument();
    expect(
      screen.getByText("alch experiments replication-plan research-call --reason 'Need higher confidence before shipping'"),
    ).toBeInTheDocument();
    expect(screen.getByText((content) => /Explicit submit required\./.test(content))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy CLI/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download plan JSON/i })).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes("client.replication_plan(\"research-call\""))).toBeInTheDocument();
  });

  it("copies replication plan CLI hint to clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const exp = makeExperiment({});
    const summary = makeSummary({
      recommendation: makeRecommendation({
        action: "rerun",
        verdict: null,
        reason: "Need higher confidence before shipping",
      }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    fireEvent.click(screen.getByRole("button", { name: /Copy CLI/i }));

    expect(writeText).toHaveBeenCalledWith(
      "alch experiments replication-plan research-call --reason 'Need higher confidence before shipping'",
    );
    expect(await screen.findByText((content) => content.includes("CLI copied to clipboard."))).toBeInTheDocument();
  });

  it("shows an error if copying CLI hint fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const exp = makeExperiment({});
    const summary = makeSummary({
      recommendation: makeRecommendation({
        action: "rerun",
        verdict: null,
        reason: "Need higher confidence before shipping",
      }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    fireEvent.click(screen.getByRole("button", { name: /Copy CLI/i }));

    expect(await screen.findByText("denied")).toBeInTheDocument();
  });

  it("downloads a replication-plan manifest JSON with explicit safeguards", async () => {
    const exp = makeExperiment({
      parent_id: "parent-exp",
      parent_name: "Parent Experiment",
      family: "research",
      goal_metric: "val_loss",
      goal_direction: "min",
    });
    const summary = makeSummary({
      goal_metric: "val_loss",
      goal_direction: "min",
      parent: {
        id: "parent-exp",
        name: "Parent Experiment",
        status: "running",
        family: "research",
        parent_id: null,
        decision: null,
        fork_reason: null,
        goal_metric: null,
        goal_direction: null,
        created_at: "2026-06-01T00:00:00.000Z",
      },
      recommendation: makeRecommendation({
        action: "rerun",
        verdict: null,
        reason: "Need higher confidence before shipping",
      }),
    });

    let manifestBlob: any = null;
    const originalCreateObjectURL = (URL as any).createObjectURL;
    const originalRevokeObjectURL = (URL as any).revokeObjectURL;
    const OriginalBlob = (globalThis as any).Blob;
    const anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    (globalThis as any).Blob = class {
      chunks: any[];

      constructor(chunks: any[]) {
        this.chunks = chunks;
      }

      text() {
        return Promise.resolve(this.chunks.join(""));
      }
    };
    (URL as any).createObjectURL = (value: any) => {
      manifestBlob = value;
      return "blob:mock-manifest";
    };
    (URL as any).revokeObjectURL = () => undefined;

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    fireEvent.click(screen.getByRole("button", { name: /Download plan JSON/i }));

    const payloadText = manifestBlob ? await manifestBlob.text() : "{}";
    const payload = JSON.parse(payloadText);

    expect(payload.kind).toBe("replication-plan");
    expect(payload.dry_run).toBe(true);
    expect(payload.experiment).toMatchObject({
      id: "exp-a",
      name: "research-call",
    });
    expect(payload.parent).toMatchObject({
      id: "parent-exp",
      name: "Parent Experiment",
      family: "research",
    });
    expect(payload.goal_metric).toBe("val_loss");
    expect(payload.goal_direction).toBe("min");
    expect(payload.recommendation).toMatchObject({
      action: "Needs stronger evidence",
      verdict: null,
      reason: "Need higher confidence before shipping",
      metric: "val_loss",
      value: 0.9012,
      baseline: 0.9123,
      delta: -0.0111,
      evidence: "weak",
    });
    expect(payload.cli).toContain("--reason");
    expect(payload.safeguards).toContain("This manifest is dry_run=true and does not submit any task by itself.");
    expect(payload.safeguards).toContain("Explicit submit is required before running replication");

    (URL as any).createObjectURL = originalCreateObjectURL;
    (URL as any).revokeObjectURL = originalRevokeObjectURL;
    (globalThis as any).Blob = OriginalBlob;
    anchorClickSpy.mockRestore();
  });

  it("shell-quotes replication plan reasons with embedded single quotes", () => {
    const exp = makeExperiment({});
    const summary = makeSummary({
      recommendation: makeRecommendation({
        action: "rerun",
        verdict: null,
        reason: "Need 'higher' confidence",
      }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    expect(
      screen.getByText("alch experiments replication-plan research-call --reason 'Need '\\''higher'\\'' confidence'"),
    ).toBeInTheDocument();
  });

  it.each(["keep", "drop", "fork"])(
    "does not render a replication plan for recommendation %s",
    (recAction) => {
      const exp = makeExperiment({});
      const summary = makeSummary({
        recommendation: makeRecommendation({
          action: recAction,
          verdict: null,
          reason: "Steady signal.",
        }),
      });

      render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

      expect(screen.queryByText("Replication plan")).not.toBeInTheDocument();
    },
  );

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
