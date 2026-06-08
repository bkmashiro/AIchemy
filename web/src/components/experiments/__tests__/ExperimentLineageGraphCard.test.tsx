import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ExperimentTreeNode, Task } from "../../../lib/api";
import { ExperimentLineageGraphCard } from "../ExperimentLineageGraphCard";

function node(
  overrides: Partial<ExperimentTreeNode> & { id: string; name: string },
): ExperimentTreeNode {
  return {
    status: "running",
    family: "fam",
    parent_id: null,
    decision: null,
    fork_reason: null,
    goal_metric: null,
    goal_direction: null,
    recommendation: null,
    diff_summary: null,
    created_at: "2026-06-01T00:00:00Z",
    children: [],
    ...overrides,
  };
}

function task(
  overrides: Partial<Task> & {
    id: string;
    seq: number;
    display_name: string;
    status: Task["status"];
  },
): Task {
  return {
    fingerprint: "fp",
    script: "echo 1",
    command: "echo 1",
    priority: 0,
    created_at: "2026-06-01T00:00:00Z",
    retry_count: 0,
    max_retries: 0,
    should_stop: false,
    should_checkpoint: false,
    log_buffer: [],
    ...overrides,
  };
}

function getRowNames(container: HTMLElement): string[] {
  const rows = Array.from(
    container.querySelectorAll("div.flex.items-stretch, button.flex.items-stretch"),
  );
  const names: string[] = [];

  for (const row of rows) {
    const button = row.querySelector('button[aria-label^="Preview "]');
    const name =
      button?.textContent?.trim() ||
      row.querySelector("span.font-mono.truncate")?.textContent?.trim() ||
      "";
    if (name) names.push(name);
  }

  return names;
}

function getRowByLabel(container: HTMLElement, name: string): HTMLElement {
  const row = container.querySelector(`button[aria-label="Preview ${name}"]`)?.closest(
    "button.flex.items-stretch, div.flex.items-stretch",
  );
  if (!row) {
    throw new Error(`Missing lineage row for ${name}`);
  }
  return row as HTMLDivElement;
}

function taskChipByDisplayName(name: string): HTMLAnchorElement {
  const textNode = screen.getByText(new RegExp(name));
  const link = textNode.closest('a[href^="/tasks/"]');
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`Missing task chip for ${name}`);
  }
  return link;
}

function setLineageMode(container: HTMLElement, mode: "Canvas" | "Rows"): void {
  const targetMode = mode.toLowerCase();
  const toggle =
    Array.from(container.querySelectorAll<HTMLButtonElement>("button[data-lineage-mode]"))
      .find((node) => node.dataset.lineageMode === targetMode);
  if (!toggle) {
    throw new Error(`Missing LineageGraphCard mode toggle for ${mode}`);
  }
  if (!toggle.getAttribute("aria-pressed") || toggle.getAttribute("aria-pressed") !== "true") {
    fireEvent.click(toggle);
  }
}

function showRowsMode(container: HTMLElement): void {
  setLineageMode(container, "Rows");
}

describe("ExperimentLineageGraphCard", () => {
  it("defaults to canvas mode and exposes a compact canvas node list", () => {
    const roots: ExperimentTreeNode[] = [
      node({
        id: "root",
        name: "root/start",
        children: [node({ id: "child", name: "child/variant", parent_id: "root", status: "passed" })],
      }),
    ];

    const { container } = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="root"
          pageId="root"
          onSelectExperiment={() => {}}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Canvas" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Rows" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Preview child/variant" })).toBeInTheDocument();
    expect(container.querySelector("[data-lineage-canvas-node]") != null).toBe(true);
  });

  it("clicking a canvas node selects it without navigating", () => {
    const onSelectExperiment = vi.fn();
    const roots: ExperimentTreeNode[] = [
      node({
        id: "root",
        name: "root/start",
        children: [node({ id: "child", name: "child/variant", parent_id: "root" })],
      }),
    ];

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="root"
          pageId="root"
          onSelectExperiment={onSelectExperiment}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview child/variant" }));
    expect(onSelectExperiment).toHaveBeenCalledWith("child");
  });

  it("shows a canvas inspector with recommendation, diff, tasks, and explicit detail link", () => {
    const roots: ExperimentTreeNode[] = [
      node({
        id: "root",
        name: "root/start",
        children: [
          node({
            id: "child",
            name: "child/variant",
            parent_id: "root",
            status: "passed",
            decision: "keep",
            recommendation: {
              action: "fork",
              verdict: "candidate",
              reason: "beats parent",
              metric: "loss",
              value: 0.2,
              baseline_value: 0.4,
              delta: -0.2,
              direction: "min",
            },
            diff_summary: {
              metric_delta: -0.2,
              metric: "loss",
              direction: "min",
              config_changed: true,
              config_change_count: 2,
              status_changed_from_parent: true,
              parent_status: "running",
            },
          }),
        ],
      }),
    ];

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="child"
          pageId="root"
          selectedTasks={[task({ id: "task-child", seq: 7, display_name: "child-task", status: "running" })]}
          onSelectExperiment={() => {}}
        />
      </MemoryRouter>,
    );

    const inspector = screen.getByLabelText("Canvas inspector");
    expect(within(inspector).getByText("Canvas inspector")).toBeInTheDocument();
    expect(within(inspector).getByText("child/variant")).toBeInTheDocument();
    expect(within(inspector).getByText("Decision: keep")).toBeInTheDocument();
    expect(within(inspector).getByText("Recommendation: fork")).toBeInTheDocument();
    expect(within(inspector).getByText("loss: ↓ -0.2000")).toBeInTheDocument();
    expect(within(inspector).getByText("child-task")).toBeInTheDocument();
    expect(within(inspector).getByRole("link", { name: /open detail/i })).toHaveAttribute(
      "href",
      "/experiments/child",
    );
  });

  it("focuses the selected path and can reveal folded canvas branches", () => {
    const roots: ExperimentTreeNode[] = [
      node({
        id: "root",
        name: "root/start",
        children: [
          node({
            id: "main",
            name: "main/path",
            parent_id: "root",
            children: [
              node({
                id: "selected",
                name: "selected/path",
                parent_id: "main",
              }),
            ],
          }),
          node({
            id: "side",
            name: "side/branch",
            parent_id: "root",
            children: [
              node({
                id: "side-child",
                name: "side/child",
                parent_id: "side",
                children: [node({ id: "deep", name: "deep/hidden", parent_id: "side-child" })],
              }),
            ],
          }),
        ],
      }),
    ];

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="selected"
          pageId="root"
          onSelectExperiment={() => {}}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Preview side/branch" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview deep/hidden" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Focus selected path" }));
    expect(screen.queryByRole("button", { name: "Preview side/branch" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Canvas inspector")).toHaveTextContent("selected/path");

    fireEvent.click(screen.getByRole("button", { name: "Focus selected path" }));
    fireEvent.click(screen.getByRole("button", { name: "Show folded branches" }));
    expect(screen.getByRole("button", { name: "Preview deep/hidden" })).toBeInTheDocument();
  });

  it("clicking a lineage node selects it for preview without requesting page navigation", () => {
    const onSelectExperiment = vi.fn();
    const roots: ExperimentTreeNode[] = [
      node({
        id: "root",
        name: "root/start",
        children: [node({ id: "child", name: "child/variant", parent_id: "root" })],
      }),
    ];

    const { rerender } = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="root"
          pageId="root"
          onSelectExperiment={onSelectExperiment}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview child/variant" }));
    expect(onSelectExperiment).toHaveBeenCalledWith("child");
    expect(screen.getByText("Viewing page")).toBeInTheDocument();

    rerender(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="child"
          pageId="root"
          onSelectExperiment={onSelectExperiment}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Preview selected")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open detail/i })).toHaveAttribute(
      "href",
      "/experiments/child",
    );
  });

  it("lets a wide row area and chip area trigger sibling preview selection", () => {
    const onSelectExperiment = vi.fn();
    const roots: ExperimentTreeNode[] = [
      node({
        id: "root",
        name: "root/start-with-a-very-long-name-that-truncates",
        children: [
          node({
            id: "branch-a",
            name: "branch-a",
            parent_id: "root",
            status: "passed",
          }),
          node({
            id: "branch-b-extremely-long-name-that-should-have-chips-and-changes",
            name: "branch-b-extremely-long-name-that-should-have-chips-and-changes",
            parent_id: "root",
            status: "passed",
            decision: "fork",
            recommendation: {
              action: "fork",
              verdict: null,
              reason: "branch breadth test",
              metric: "loss",
              value: 0.2,
              baseline_value: 0.3,
              delta: -0.1,
              direction: "min",
            },
            diff_summary: {
              metric_delta: -0.05,
              metric: "loss",
              direction: "min",
              config_changed: true,
              config_change_count: 7,
              status_changed_from_parent: true,
              parent_status: "running",
            },
          }),
        ],
      }),
    ];

    const { container } = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="root"
          pageId="root"
          onSelectExperiment={onSelectExperiment}
        />
      </MemoryRouter>,
    );

    showRowsMode(container);

    const row = getRowByLabel(
      container,
      "branch-b-extremely-long-name-that-should-have-chips-and-changes",
    );

    fireEvent.click(row);
    expect(onSelectExperiment).toHaveBeenCalledWith(
      "branch-b-extremely-long-name-that-should-have-chips-and-changes",
    );

    const chip = row.querySelector("[data-lineage-diff-chip]");
    if (!(chip instanceof HTMLElement)) {
      throw new Error("Missing diff chip summary on selected row");
    }

    fireEvent.click(chip);
    expect(onSelectExperiment).toHaveBeenLastCalledWith(
      "branch-b-extremely-long-name-that-should-have-chips-and-changes",
    );
    expect(onSelectExperiment).toHaveBeenCalledTimes(2);
  });

  it("preserves sibling order with child-bearing and failed leaf siblings", () => {
    const onSelectExperiment = vi.fn();
    const roots: ExperimentTreeNode[] = [
      node({
        id: "root",
        name: "root/start",
        children: [
          node({
            id: "failed-leaf",
            name: "failed-leaf",
            parent_id: "root",
            status: "failed",
            decision: "drop",
          }),
          node({
            id: "running-leaf",
            name: "running-leaf",
            parent_id: "root",
            status: "running",
          }),
          node({
            id: "parent-branch",
            name: "parent-branch",
            parent_id: "root",
            status: "passed",
            children: [node({ id: "grand-child", name: "grand-child", parent_id: "parent-branch" })],
          }),
        ],
      }),
    ];

    const { container, rerender } = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="root"
          pageId="root"
          onSelectExperiment={onSelectExperiment}
        />
      </MemoryRouter>,
    );
    showRowsMode(container);

    expect(getRowNames(container)).toEqual([
      "root/start",
      "parent-branch",
      "running-leaf",
      "failed-leaf",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Preview failed-leaf" }));
    expect(onSelectExperiment).toHaveBeenCalledWith("failed-leaf");

    rerender(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="failed-leaf"
          pageId="root"
          onSelectExperiment={onSelectExperiment}
        />
      </MemoryRouter>,
    );

    expect(getRowNames(container)).toEqual([
      "root/start",
      "parent-branch",
      "running-leaf",
      "failed-leaf",
    ]);
  });

  it("renders compact recommendation and diff summary chips on lineage rows", () => {
    const roots: ExperimentTreeNode[] = [
      node({
        id: "root",
        name: "root/start",
        children: [
          node({
            id: "child",
            name: "child/variant",
            parent_id: "root",
            status: "passed",
            recommendation: {
              action: "keep",
              verdict: null,
              reason: "stable metric improvements",
              metric: "loss",
              value: 0.4,
              baseline_value: 0.6,
              delta: -0.2,
              direction: "min",
            },
            diff_summary: {
              metric_delta: -0.4,
              metric: "loss",
              direction: "min",
              config_changed: true,
              config_change_count: 3,
              status_changed_from_parent: true,
              parent_status: "running",
            },
          }),
        ],
      }),
    ];

    const { container } = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="root"
          pageId="root"
          onSelectExperiment={() => {}}
        />
      </MemoryRouter>,
    );

    showRowsMode(container);

    const row = getRowByLabel(container, "child/variant");
    const recommendationChips = row.querySelectorAll('[data-lineage-recommendation-chip]');
    expect(recommendationChips).toHaveLength(1);
    expect(recommendationChips[0]).toHaveTextContent("keep");

    const diffChips = row.querySelectorAll('[data-lineage-diff-chip]');
    expect(diffChips).toHaveLength(2);
    expect(Array.from(diffChips).map((chip) => chip.textContent)).toEqual([
      "loss: ↓ -0.4000",
      "+2 diff",
    ]);
  });

  it("shows recommendation and diff chips in the selected detail strip", () => {
    const roots: ExperimentTreeNode[] = [
      node({
        id: "root",
        name: "root/start",
        children: [
          node({
            id: "child",
            name: "child/variant",
            parent_id: "root",
            status: "failed",
            decision: "drop",
            recommendation: {
              action: "rerun",
              verdict: null,
              reason: "metric regression",
              metric: "acc",
              value: 0.3,
              baseline_value: 0.5,
              delta: -0.2,
              direction: "max",
            },
            diff_summary: {
              metric_delta: -0.25,
              metric: "acc",
              direction: "max",
              config_changed: true,
              config_change_count: 1,
              status_changed_from_parent: true,
              parent_status: "running",
            },
          }),
        ],
      }),
    ];

    const { container } = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="child"
          pageId="root"
          onSelectExperiment={() => {}}
        />
      </MemoryRouter>,
    );

    const strip = container.querySelector('[data-lineage-selected-strip]');
    if (!(strip instanceof HTMLElement)) {
      throw new Error("Missing selected detail strip");
    }

    expect(within(strip).getByText("Preview selected")).toBeInTheDocument();
    expect(within(strip).getByText("Status: failed")).toBeInTheDocument();
    expect(within(strip).getByText("Decision: drop")).toBeInTheDocument();
    expect(within(strip).getByText("Recommendation: Needs stronger evidence")).toBeInTheDocument();

    const detailChips = strip.querySelectorAll('[data-lineage-diff-chip]');
    expect(Array.from(detailChips).map((chip) => chip.textContent)).toEqual([
      "acc: ↑ -0.2500",
      "config +1",
      "status running→failed",
    ]);
    expect(within(strip).getByText("acc: ↑ -0.2500")).toBeInTheDocument();
  });

  it("shows compact topology summary for shown vs hidden descendants", () => {
    const roots: ExperimentTreeNode[] = [
      node({
        id: "root",
        name: "root/origin",
        children: [
          node({
            id: "branch-main",
            name: "branch-main",
            parent_id: "root",
            status: "running",
            children: [
              node({
                id: "branch-main/continuation",
                name: "branch-main/continuation",
                parent_id: "branch-main",
                children: [
                  node({
                    id: "branch-main/continuation/hidden-a",
                    name: "branch-main/continuation/hidden-a",
                    parent_id: "branch-main/continuation",
                  }),
                  node({
                    id: "branch-main/continuation/hidden-b",
                    name: "branch-main/continuation/hidden-b",
                    parent_id: "branch-main/continuation",
                  }),
                ],
              }),
            ],
          }),
          node({ id: "other-branch", name: "other-branch", parent_id: "root" }),
        ],
      }),
    ];

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="root"
          pageId="root"
          onSelectExperiment={() => {}}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("1 root · 3 shown · 3 hidden")).toBeInTheDocument();
  });

  it("shows selected-run status and folded-descendant hint in the selected detail strip", () => {
    const roots: ExperimentTreeNode[] = [
      node({
        id: "root",
        name: "root/origin",
        status: "running",
        decision: "keep",
        recommendation: {
          action: "fork",
          verdict: null,
          reason: "promising",
          metric: "loss",
          value: 0.1,
          baseline_value: 0.4,
          delta: -0.3,
          direction: "min",
        },
        children: [
          node({
            id: "continuation",
            name: "continuation",
            parent_id: "root",
            children: [
              node({
                id: "continuation/branch",
                name: "continuation/branch",
                parent_id: "continuation",
                children: [
                  node({
                    id: "continuation/hidden-1",
                    name: "continuation/hidden-1",
                    parent_id: "continuation/branch",
                    status: "running",
                  }),
                  node({
                    id: "continuation/hidden-2",
                    name: "continuation/hidden-2",
                    parent_id: "continuation/branch",
                    status: "failed",
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ];

    const { container } = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="root"
          pageId="child"
          selectedTasks={[
            task({ id: "t-1", seq: 1, display_name: "task-1", status: "completed" }),
            task({ id: "t-2", seq: 2, display_name: "task-2", status: "running" }),
          ]}
          onSelectExperiment={() => {}}
        />
      </MemoryRouter>,
    );

    const strip = container.querySelector('[data-lineage-selected-strip]');
    if (!(strip instanceof HTMLElement)) {
      throw new Error("Missing selected detail strip");
    }

    expect(within(strip).getByText("Preview selected")).toBeInTheDocument();
    expect(within(strip).getByText("Status: running")).toBeInTheDocument();
    expect(within(strip).getByText("Decision: keep")).toBeInTheDocument();
    expect(within(strip).getByText("Recommendation: fork")).toBeInTheDocument();
    expect(within(strip).getByText("+3 hidden descendants folded")).toBeInTheDocument();
    expect(within(strip).getByText("Tasks: 2")).toBeInTheDocument();
  });

  it("does not duplicate identical decision and recommendation chips", () => {
    const roots: ExperimentTreeNode[] = [
      node({
        id: "root",
        name: "root/start",
        decision: "keep",
        recommendation: {
          action: "keep",
          verdict: "best",
          reason: "already decided",
          metric: "loss",
          value: 0.2,
          baseline_value: 0.4,
          delta: -0.2,
          direction: "min",
        },
      }),
    ];

    const { container } = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="root"
          pageId="root"
          onSelectExperiment={() => {}}
        />
      </MemoryRouter>,
    );

    expect(container.querySelectorAll('[data-lineage-decision-chip]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-lineage-recommendation-chip]')).toHaveLength(0);
  });

  it("visually marks failed/drop branches as muted while running child branches remain active", () => {
    const roots: ExperimentTreeNode[] = [
      node({
        id: "root",
        name: "root/start",
        children: [
          node({
            id: "failed-drop",
            name: "failed-drop",
            parent_id: "root",
            status: "failed",
            decision: "drop",
          }),
          node({
            id: "running-branch",
            name: "running-branch",
            parent_id: "root",
            status: "running",
            children: [node({ id: "running-leaf", name: "running-leaf", parent_id: "running-branch" })],
          }),
        ],
      }),
    ];

    const { container } = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="root"
          pageId="root"
          onSelectExperiment={() => {}}
        />
      </MemoryRouter>,
    );

    showRowsMode(container);

    expect(getRowByLabel(container, "running-branch")).toHaveAttribute(
      "data-lineage-tone",
      "active",
    );
    expect(getRowByLabel(container, "failed-drop")).toHaveAttribute("data-lineage-tone", "muted");
  });

  it("shows compact task chips with overflow indicator and preserves long task links", () => {
    const roots: ExperimentTreeNode[] = [
      node({
        id: "root",
        name: "root/start",
      }),
    ];

    const selectedTasks: Task[] = [
      task({
        id: "t-running-a",
        seq: 1,
        display_name: "running-a",
        status: "running",
      }),
      task({
        id: "t-pending",
        seq: 2,
        display_name: "pending",
        status: "pending",
      }),
      task({
        id: "t-complete",
        seq: 3,
        display_name:
          "extremely-long-task-display-name-that-should-be-truncated-in-chip-layout",
        status: "completed",
      }),
      task({
        id: "t-running-b",
        seq: 4,
        display_name: "running-b",
        status: "running",
      }),
      task({
        id: "t-fail",
        seq: 5,
        display_name: "very-very-very-long-failed-task-display-name-for-compression-testing",
        status: "failed",
      }),
    ];

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="root"
          pageId="root"
          selectedTasks={selectedTasks}
          onSelectExperiment={() => {}}
        />
      </MemoryRouter>,
    );

    const taskLinks = screen.getAllByRole("link", { name: /#\d+ · / });
    expect(taskLinks).toHaveLength(3);

    expect(screen.getByText("Tasks: 5")).toBeInTheDocument();
    expect(screen.getByText("+2 more")).toBeInTheDocument();

    const longChip = taskChipByDisplayName(
      "extremely-long-task-display-name-that-should-be-truncated-in-chip-layout",
    );
    const compactSpan = longChip.querySelector("span") as HTMLSpanElement;
    expect(compactSpan).toHaveClass("truncate");
    expect(compactSpan).toHaveClass("max-w-[10rem]");
    expect(longChip).toHaveAttribute("href", "/tasks/t-complete");
    expect(longChip).toHaveAttribute(
      "title",
      "extremely-long-task-display-name-that-should-be-truncated-in-chip-layout",
    );

    expect(taskLinks[0]).toHaveTextContent("running-a");
    expect(taskLinks[1]).toHaveTextContent("running-b");
    expect(taskLinks[2]).toHaveTextContent(
      "extremely-long-task-display-name-that-should-be-truncated-in-chip-layout",
    );
  });

  it("keeps open detail link for preview nodes and shows task links there too", () => {
    const roots: ExperimentTreeNode[] = [
      node({
        id: "root",
        name: "root/start",
        children: [node({ id: "child", name: "child/variant", parent_id: "root" })],
      }),
    ];

    const selectedTasks: Task[] = [
      task({ id: "t-complete", seq: 10, display_name: "done", status: "completed" }),
      task({ id: "t-pending", seq: 11, display_name: "wait", status: "pending" }),
      task({ id: "t-running", seq: 12, display_name: "work", status: "running" }),
      task({ id: "t-failed", seq: 13, display_name: "bad", status: "failed" }),
    ];

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="child"
          pageId="root"
          selectedTasks={selectedTasks}
          onSelectExperiment={() => {}}
        />
      </MemoryRouter>,
    );

    const taskLinks = Array.from(document.querySelectorAll('a[href^="/tasks/"]')).map((n) =>
      n.textContent,
    );

    expect(screen.getByText("Tasks: 4")).toBeInTheDocument();
    expect(taskLinks).toHaveLength(3);
    expect(taskLinks[0]).toMatch("#12 · running");
    expect(screen.getByRole("link", { name: /open detail/i })).toHaveAttribute(
      "href",
      "/experiments/child",
    );
  });

  it("shows Tasks: 0 when the selected node has no tasks", () => {
    const roots: ExperimentTreeNode[] = [
      node({
        id: "root",
        name: "root/start",
        children: [node({ id: "child", name: "child/variant", parent_id: "root" })],
      }),
    ];

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="child"
          pageId="root"
          selectedTasks={[]}
          onSelectExperiment={() => {}}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Tasks: 0")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^#\d+ · / })).toBeNull();
  });
});
