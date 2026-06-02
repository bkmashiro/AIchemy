import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  experimentsApi,
  type ExperimentResearchReportResponse,
  type ExperimentResearchReportLeaderEntry,
  type ExperimentResearchReportBlock,
} from "../../../lib/api";
import {
  ExperimentReviewWorkspace,
  buildReportCommand,
  buildBundleCommand,
  buildForkPlanCommand,
  filenameSuffix,
  renderResearchReportMarkdown,
} from "../ExperimentReviewWorkspace";

const REPORT_LIMIT = 50;

function leader(
  overrides: Partial<ExperimentResearchReportLeaderEntry> = {},
): ExperimentResearchReportLeaderEntry {
  return {
    rank: 1,
    id: "exp-1",
    name: "exp/baseline",
    status: "running" as any,
    decision: null,
    value: 0.81234,
    metric: "loss",
    ...overrides,
  };
}

function block(
  overrides: Partial<ExperimentResearchReportBlock> = {},
): ExperimentResearchReportBlock {
  return {
    id: "exp-1",
    name: "exp/baseline",
    family: "fam",
    status: "running" as any,
    decision: null,
    decision_reason: null,
    decision_at: null,
    created_at: "2026-06-01T00:00:00Z",
    parent_id: null,
    children: [],
    task_counts: { running: 1 },
    primary_metric: { metric: "loss", direction: "min", best: 0.5 },
    artifact_count: 2,
    checkpoint_count: 1,
    recent_events: [],
    ...overrides,
  };
}

function makeReport(
  overrides: Partial<ExperimentResearchReportResponse> = {},
): ExperimentResearchReportResponse {
  return {
    filters: { family: "fam", decision: null, status: null, limit: REPORT_LIMIT },
    generated_at: "2026-06-01T00:00:00Z",
    counts: { total: 2, by_status: { running: 1, completed: 1 }, by_decision: {} },
    metric: { name: "loss", direction: "min" },
    leaderboard: [leader(), leader({ rank: 2, id: "exp-2", name: "exp/v2", value: 0.91 })],
    experiments: [block(), block({ id: "exp-2", name: "exp/v2" })],
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getReportSpy: any;

beforeEach(() => {
  getReportSpy = vi.spyOn(experimentsApi, "getResearchReport");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("buildReportCommand", () => {
  it("quotes family/decision/status/output with spaces and metacharacters", () => {
    const cmd = buildReportCommand({
      family: "my family",
      decision: "keep&run",
      status: "needs review",
      format: "markdown",
      output: "report file.md",
    });
    expect(cmd).toBe(
      "alch experiments report --family 'my family' --decision 'keep&run' --status 'needs review' --format markdown --output 'report file.md'",
    );
  });

  it("escapes embedded single quotes", () => {
    const cmd = buildReportCommand({ family: "it's a fam" });
    expect(cmd).toBe("alch experiments report --family 'it'\\''s a fam'");
  });

  it("leaves safe argument unquoted", () => {
    const cmd = buildReportCommand({ family: "baseline-v1" });
    expect(cmd).toBe("alch experiments report --family baseline-v1");
  });
});

describe("buildBundleCommand", () => {
  it("quotes ref with whitespace and metacharacters", () => {
    expect(buildBundleCommand("ref with;rm -rf")).toBe(
      "alch experiments bundle 'ref with;rm -rf'",
    );
  });
});

describe("buildForkPlanCommand", () => {
  it("quotes ref and reason with embedded single quotes", () => {
    expect(buildForkPlanCommand("ref one", "we'd like more depth")).toBe(
      "alch experiments fork-plan 'ref one' --reason 'we'\\''d like more depth'",
    );
  });
});

describe("filenameSuffix", () => {
  it("replaces metacharacters and spaces with dashes", () => {
    expect(filenameSuffix("my family/v1?")).toBe("my-family-v1");
  });
  it("falls back to 'family' for empty/whitespace-only", () => {
    expect(filenameSuffix("   ")).toBe("family");
    expect(filenameSuffix("")).toBe("family");
  });
  it("preserves safe characters", () => {
    expect(filenameSuffix("baseline-v1.2_a")).toBe("baseline-v1.2_a");
  });
});

describe("renderResearchReportMarkdown", () => {
  it("includes title, filters, counts, metric, leaderboard, and undecided summary", () => {
    const md = renderResearchReportMarkdown(makeReport());
    expect(md).toContain("# Experiment Research Report");
    expect(md).toContain("- family: fam");
    expect(md).toContain("- total: 2");
    expect(md).toContain("running=1");
    expect(md).toContain("## Metric");
    expect(md).toContain("- name: loss");
    expect(md).toContain("## Leaderboard");
    expect(md).toContain("| Rank | Experiment | Status | Decision | Metric | Value |");
    expect(md).toContain("| 1 | exp/baseline | running | — | loss |");
    expect(md).toContain("## Undecided");
    expect(md).toContain("exp/baseline");
    expect(md).toContain("## Experiments");
  });

  it("escapes pipe characters and backslashes in table cells", () => {
    const r = makeReport({
      leaderboard: [leader({ name: "weird|name\\v" })],
      experiments: [block({ name: "weird|name\\v" })],
    });
    const md = renderResearchReportMarkdown(r);
    expect(md).toContain("weird\\|name\\\\v");
    expect(md).not.toContain("weird|name\\v |");
  });

  it("handles empty report deterministically", () => {
    const r: ExperimentResearchReportResponse = {
      filters: { family: null, decision: null, status: null, limit: REPORT_LIMIT },
      generated_at: "",
      counts: { total: 0, by_status: {}, by_decision: {} },
      metric: null,
      leaderboard: [],
      experiments: [],
    };
    const md = renderResearchReportMarkdown(r);
    expect(md).toContain("# Experiment Research Report");
    expect(md).toContain("- family: *all*");
    expect(md).toContain("- total: 0");
    expect(md).toContain("_Empty — no experiment in this slice has a numeric goal-metric value yet._");
    expect(md).toContain("_No experiments in this slice._");
    expect(md).toContain("_No experiments match the current filters._");
  });

  it("includes decided and non-leaderboard experiments in the full experiments section", () => {
    const md = renderResearchReportMarkdown(
      makeReport({
        leaderboard: [leader()],
        experiments: [
          block(),
          block({
            id: "exp-3",
            name: "exp/decided-no-goal",
            status: "passed" as any,
            decision: "keep",
            task_counts: { passed: 1 },
            primary_metric: null,
            artifact_count: 0,
            checkpoint_count: 0,
            recent_events: [
              {
                id: "evt-1",
                experiment_id: "exp-3",
                kind: "decision",
                message: "kept",
                created_at: "2026-06-01T01:00:00Z",
              },
            ],
          }),
        ],
      }),
    );
    expect(md).toContain("## Experiments");
    expect(md).toContain(
      "| exp/decided-no-goal | fam | passed | keep | passed=1 | — | 0 | 0 | decision@2026-06-01T01:00:00Z |",
    );
  });

  it("escapes markdown metacharacters in non-table filter and metric fields", () => {
    const md = renderResearchReportMarkdown(
      makeReport({
        filters: { family: "fam\n# injected", decision: "keep|drop", status: "<running>", limit: REPORT_LIMIT },
        metric: { name: "loss|rm<tag>", direction: "min" },
      }),
    );
    expect(md).toContain("- family: fam \\# injected");
    expect(md).toContain("- decision: keep\\|drop");
    expect(md).toContain("- status: \\<running\\>");
    expect(md).toContain("- name: loss\\|rm\\<tag\\>");
  });

  it("produces a deterministic byte-for-byte output for the same input", () => {
    const a = renderResearchReportMarkdown(makeReport());
    const b = renderResearchReportMarkdown(makeReport());
    expect(a).toBe(b);
  });
});

describe("ExperimentReviewWorkspace component", () => {
  function renderWithFamily(family: string = "fam") {
    return render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentReviewWorkspace
          familyFilter={family}
          families={["fam", "other"]}
          decisionFilter=""
          statusFilter=""
          onSelectFamily={() => {}}
        />
      </MemoryRouter>,
    );
  }

  it("shows the markdown report command and JSON download affordance", async () => {
    getReportSpy.mockResolvedValue(makeReport());
    renderWithFamily("fam");
    await waitFor(() => {
      expect(
        screen.getByText(
          "alch experiments report --family fam --format markdown --output report.md",
        ),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /download json/i })).toBeInTheDocument();
  });

  it("shows a download Markdown button when a family report is loaded", async () => {
    getReportSpy.mockResolvedValue(makeReport());
    renderWithFamily("fam");
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /download markdown/i }),
      ).toBeInTheDocument();
    });
  });

  it("clears the stale report and shows zero totals when fetch fails", async () => {
    getReportSpy.mockRejectedValue(new Error("boom"));
    renderWithFamily("fam");
    await waitFor(() => {
      expect(screen.getByText(/boom/i)).toBeInTheDocument();
    });
    // The Total card should now read 0 (stale data was cleared).
    const totalLabel = screen.getByText("Total");
    const totalCard = totalLabel.parentElement!;
    expect(totalCard.textContent).toContain("0");
  });

  it("renders the no-family message when no family is selected", () => {
    getReportSpy.mockResolvedValue({
      filters: { family: null, decision: null, status: null, limit: REPORT_LIMIT },
      generated_at: "",
      counts: { total: 0, by_status: {}, by_decision: {} },
      metric: null,
      leaderboard: [],
      experiments: [],
    });
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentReviewWorkspace
          familyFilter=""
          families={["fam"]}
          decisionFilter=""
          statusFilter=""
          onSelectFamily={() => {}}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByText(/Pick a family above to load its leaderboard/i),
    ).toBeInTheDocument();
    return waitFor(() => expect(getReportSpy).toHaveBeenCalledTimes(1));
  });
});
