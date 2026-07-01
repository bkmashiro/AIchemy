import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type {
  ExperimentDetail,
  ExperimentDiffResponse,
  ExperimentSummaryResponse,
  ExperimentTreeNode,
} from "../../lib/api";
import { experimentsApi } from "../../lib/api";
import ExperimentsPage from "../ExperimentsPage";

vi.mock("../../components/experiments", async () => {
  const React = await import("react");
  return {
    IntentCard: () => null,
    DecisionCard: () => null,
    LineageCard: () => null,
    ExperimentListTable: ({ experiments }: { experiments: Array<{ name: string }> }) => (
      React.createElement("ul", { "aria-label": "experiment-list" }, experiments.map((exp) => React.createElement("li", { key: exp.name }, exp.name)))
    ),
    ExperimentDetailHeader: () => null,
    ExperimentCriteriaCard: () => null,
    ExperimentTaskTable: () => null,
    ExperimentMatrixCard: () => null,
    ExperimentTimelineCard: () => null,
    ExperimentReviewWorkspace: () => null,
    filterExperimentEntryPoints: (items: unknown[]) => items,
    ExperimentLineageGraphCard: ({ onSelectExperiment }: { onSelectExperiment: (id: string) => void }) => (
      React.createElement("button", {
        type: "button",
        onClick: () => onSelectExperiment("child"),
      }, "select child")
    ),
    ExperimentResearchCallCard: ({
      exp,
      summary,
      recentEvents,
      onChanged,
    }: {
      exp: ExperimentDetail;
      summary: ExperimentSummaryResponse | null;
      recentEvents?: { id: string }[];
      onChanged?: (experimentId: string) => void;
    }) => (
      React.createElement(
        "section",
        { "aria-label": "research-call" },
        React.createElement("span", null, `${exp.name} / ${summary?.name ?? "no summary"} / events:${(recentEvents ?? []).length}`),
        React.createElement("button", {
          type: "button",
          onClick: () => onChanged?.(exp.id),
        }, `refresh research ${exp.id}`),
      )
    ),
    ExperimentConfigDiffCard: ({ diff }: { diff: ExperimentDiffResponse | null }) => (
      React.createElement("section", { "aria-label": "config-diff" }, diff?.name ?? "no diff")
    ),
  };
});

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    experimentsApi: {
      ...actual.experimentsApi,
      list: vi.fn(),
      get: vi.fn(),
      getTimeline: vi.fn(),
      getSummary: vi.fn(),
      getDiff: vi.fn(),
      getTree: vi.fn(),
      retryFailed: vi.fn(),
      delete: vi.fn(),
    },
  };
});

function detail(id: string, name: string): ExperimentDetail {
  return {
    id,
    name,
    status: "running",
    criteria: {},
    grid_id: `${id}-grid`,
    results: {},
    created_at: "2026-06-01T00:00:00.000Z",
    tasks: [],
  };
}

function summary(id: string, name: string): ExperimentSummaryResponse {
  return {
    id,
    name,
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
    validation: { passed: 0, failed: 0, total: 0 },
    best_metrics: {},
    primary_metric: null,
    recommendation: null,
    timeline_event_count: 0,
    config: null,
    config_diff: null,
  };
}

function diff(id: string, name: string): ExperimentDiffResponse {
  return {
    experiment_id: id,
    name,
    config: null,
    config_diff: null,
    parent_name: null,
    parent_id: null,
  };
}

function timelineEvents(id: string): { experiment_id: string; events: Array<any> } {
  const now = "2026-06-01T00:00:00.000Z";
  if (id === "child") {
    return {
      experiment_id: "child",
      events: [
        {
          id: "child-note-1",
          experiment_id: "child",
          kind: "note",
          message: "child note",
          created_at: now,
        },
        {
          id: "child-artifact-1",
          experiment_id: "child",
          kind: "artifact",
          message: "artifact uploaded",
          created_at: now,
          data: { locator: "s3://child-artifact" },
        },
      ],
    };
  }

  return {
    experiment_id: "root",
    events: [],
  };
}

function tree(): ExperimentTreeNode[] {
  return [{
    id: "root",
    name: "root experiment",
    status: "running",
    family: null,
    parent_id: null,
    decision: null,
    fork_reason: null,
    goal_metric: null,
    goal_direction: null,
    recommendation: null,
    diff_summary: null,
    created_at: "2026-06-01T00:00:00.000Z",
    children: [{
      id: "child",
      name: "child experiment",
      status: "running",
      family: null,
      parent_id: "root",
      decision: null,
      fork_reason: null,
      goal_metric: null,
      goal_direction: null,
      recommendation: null,
      diff_summary: null,
      created_at: "2026-06-02T00:00:00.000Z",
      children: [],
    }],
  }];
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderDetailPage() {
  return render(
    <MemoryRouter initialEntries={["/experiments/root"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/experiments/:id" element={<><LocationProbe /><ExperimentsPage /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderListPage() {
  return render(
    <MemoryRouter initialEntries={["/experiments"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/experiments" element={<ExperimentsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ExperimentsPage lineage preview", () => {
  let childSummaryName = "child summary";

  beforeEach(() => {
    childSummaryName = "child summary";
    vi.mocked(experimentsApi.list).mockResolvedValue([]);
    vi.mocked(experimentsApi.getTimeline).mockImplementation((id: string) => Promise.resolve(timelineEvents(id)));
    vi.mocked(experimentsApi.getTree).mockResolvedValue(tree());
    vi.mocked(experimentsApi.get).mockImplementation((id: string) =>
      Promise.resolve(id === "child" ? detail("child", "child experiment") : detail("root", "root experiment")),
    );
    vi.mocked(experimentsApi.getSummary).mockImplementation((id: string) =>
      Promise.resolve(id === "child" ? summary("child", childSummaryName) : summary("root", "root summary")),
    );
    vi.mocked(experimentsApi.getDiff).mockImplementation((id: string) =>
      Promise.resolve(id === "child" ? diff("child", "child diff") : diff("root", "root diff")),
    );

  });

  it("uses canonical decision filter labels on the experiments list", async () => {
    vi.mocked(experimentsApi.list).mockResolvedValue([
      { ...detail("keep-exp", "keep exp"), decision: "keep" },
      { ...detail("try-exp", "try exp"), decision: "try_more" },
      { ...detail("discard-exp", "discard exp"), decision: "discard" },
    ]);

    renderListPage();

    const filter = await screen.findByDisplayValue("All decisions");
    expect(within(filter).getByRole("option", { name: "keep" })).toBeInTheDocument();
    expect(within(filter).getByRole("option", { name: "try_more" })).toBeInTheDocument();
    expect(within(filter).getByRole("option", { name: "discard" })).toBeInTheDocument();
    expect(within(filter).queryByRole("option", { name: "drop" })).not.toBeInTheDocument();
    expect(within(filter).queryByRole("option", { name: /stronger evidence/i })).not.toBeInTheDocument();
    expect(within(filter).queryByRole("option", { name: "fork" })).not.toBeInTheDocument();

    fireEvent.change(filter, { target: { value: "try_more" } });
    expect(screen.getByText("try exp")).toBeInTheDocument();
    expect(screen.queryByText("keep exp")).not.toBeInTheDocument();
    expect(screen.queryByText("discard exp")).not.toBeInTheDocument();
  });

  it("renders detail page as a research workbench with map, inspector, and evidence regions", async () => {
    renderDetailPage();

    expect(await screen.findByLabelText("Research workbench")).toBeInTheDocument();
    expect(screen.getByLabelText("Family map")).toBeInTheDocument();
    expect(screen.getByLabelText("Research inspector")).toBeInTheDocument();
    expect(screen.getByLabelText("Experiment evidence")).toBeInTheDocument();
  });

  it("updates right-side research and diff context on lineage click without route navigation", async () => {
    renderDetailPage();

    expect(await screen.findByLabelText("research-call")).toHaveTextContent("root experiment / root summary / events:0");
    expect(screen.getByLabelText("config-diff")).toHaveTextContent("root diff");
    expect(screen.getByTestId("location")).toHaveTextContent("/experiments/root");

    fireEvent.click(screen.getByRole("button", { name: "select child" }));

    await waitFor(() => {
      expect(screen.getByLabelText("research-call")).toHaveTextContent("child experiment / child summary / events:2");
      expect(screen.getByLabelText("config-diff")).toHaveTextContent("child diff");
    });
    expect(screen.getByTestId("location")).toHaveTextContent("/experiments/root");
  });

  it("refreshes selected-lineage research context after writeback", async () => {
    renderDetailPage();

    expect(await screen.findByLabelText("research-call")).toHaveTextContent("root experiment / root summary / events:0");
    fireEvent.click(screen.getByRole("button", { name: "select child" }));

    await waitFor(() => {
      expect(screen.getByLabelText("research-call")).toHaveTextContent("child experiment / child summary / events:2");
    });

    childSummaryName = "child refreshed summary";
    vi.mocked(experimentsApi.getTimeline).mockImplementation((id: string) =>
      Promise.resolve(
        id === "child"
          ? {
              experiment_id: "child",
              events: [
                {
                  id: "child-refreshed-note",
                  experiment_id: "child",
                  kind: "note",
                  message: "child refreshed note",
                  created_at: "2026-06-01T00:00:00.000Z",
                },
              ],
            }
          : timelineEvents(id),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "refresh research child" }));

    await waitFor(() => {
      expect(screen.getByLabelText("research-call")).toHaveTextContent("child experiment / child refreshed summary / events:1");
    });
    expect(screen.getByTestId("location")).toHaveTextContent("/experiments/root");
  });

  it("falls back to page context when selected-lineage detail fetch fails", async () => {
    vi.mocked(experimentsApi.get).mockImplementation((id: string) =>
      id === "child" ? Promise.reject(new Error("missing")) : Promise.resolve(detail("root", "root experiment")),
    );
    renderDetailPage();

    expect(await screen.findByLabelText("research-call")).toHaveTextContent("root experiment / root summary / events:0");
    fireEvent.click(screen.getByRole("button", { name: "select child" }));

    await waitFor(() => {
      expect(screen.getByLabelText("research-call")).toHaveTextContent("root experiment / root summary");
      expect(screen.getByLabelText("config-diff")).toHaveTextContent("root diff");
    });
  });
});
