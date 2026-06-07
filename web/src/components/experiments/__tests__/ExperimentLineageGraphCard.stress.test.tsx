import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

function hiddenDescendants(
  parentId: string,
  count: number,
  status: ExperimentTreeNode["status"] = "passed",
): ExperimentTreeNode[] {
  return Array.from({ length: count }, (_, index) =>
    node({
      id: `${parentId}/hidden-${index + 1}`,
      name: `${parentId}/hidden-${index + 1}`,
      parent_id: parentId,
      status,
    }),
  );
}

function foldedDropBranch(parentId: string, id: string, hiddenCount = 2): ExperimentTreeNode {
  return node({
    id,
    name: `${id}`,
    parent_id: parentId,
    status: "failed",
    decision: "drop",
    children: hiddenDescendants(id, hiddenCount),
  });
}

function getRowNames(container: HTMLElement): string[] {
  const rows = Array.from(
    container.querySelectorAll("div.flex.items-stretch, button.flex.items-stretch"),
  );
  const names: string[] = [];

  for (const row of rows) {
    const button = row.querySelector('button[aria-label^="Preview "]');
    const name =
      button?.textContent?.trim() || row.querySelector("span.font-mono.truncate")?.textContent?.trim() || "";
    if (name) {
      names.push(name);
    }
  }

  return names;
}

function getRowByName(container: HTMLElement, name: string): HTMLElement {
  const byButton = container.querySelector(
    `button[aria-label="Preview ${name}"]`,
  )?.closest("button.flex.items-stretch, div.flex.items-stretch");
  if (byButton instanceof HTMLElement) {
    return byButton as HTMLDivElement;
  }

  const byLabel = Array.from(container.querySelectorAll("span.font-mono.truncate"))
    .find((span) => span.textContent?.trim() === name)
    ?.closest("div.flex.items-stretch");
  if (byLabel instanceof HTMLDivElement) {
    return byLabel;
  }

  throw new Error(`Missing lineage row for ${name}`);
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

describe("ExperimentLineageGraphCard stress tests", () => {
  const roots: ExperimentTreeNode[] = [
    node({
      id: "seed/orig",
      name: "seed/orig",
      status: "running",
      children: [
        node({ id: "seed/orig/fork", name: "seed/orig/fork", parent_id: "seed/orig", decision: "fork" }),
        node({ id: "seed/orig/drop", name: "seed/orig/drop", parent_id: "seed/orig", status: "failed", decision: "drop" }),
      ],
    }),
    node({
      id: "seed/zen",
      name: "seed/zen",
      status: "passed",
      decision: "keep",
      children: [
        node({
          id: "seed/zen/sweep-keep",
          name: "seed/zen/sweep-keep",
          parent_id: "seed/zen",
          status: "passed",
          decision: "keep",
          children: [
            node({
              id: "seed/zen/sweep-keep/continuation",
              name: "seed/zen/sweep-keep/continuation",
              parent_id: "seed/zen/sweep-keep",
              status: "running",
              decision: "keep",
              children: hiddenDescendants("seed/zen/sweep-keep/continuation", 2, "running"),
            }),
            foldedDropBranch("seed/zen/sweep-keep", "seed/zen/sweep-keep/drop-hidden", 2),
            node({ id: "seed/zen/sweep-keep/sweep-2", name: "seed/zen/sweep-keep/sweep-2", parent_id: "seed/zen/sweep-keep", status: "passed" }),
            node({ id: "seed/zen/sweep-keep/pending", name: "seed/zen/sweep-keep/pending", parent_id: "seed/zen/sweep-keep", status: "running" }),
          ],
        }),
        node({
          id: "seed/zen/sweep-fork",
          name: "seed/zen/sweep-fork",
          parent_id: "seed/zen",
          status: "running",
          decision: "fork",
          children: [
            node({ id: "seed/zen/sweep-fork/continue", name: "seed/zen/sweep-fork/continue", parent_id: "seed/zen/sweep-fork", status: "running", decision: "fork", children: hiddenDescendants("seed/zen/sweep-fork/continue", 2, "running") }),
            node({ id: "seed/zen/sweep-fork/late-failed-drop-leaf", name: "seed/zen/sweep-fork/late-failed-drop-leaf", parent_id: "seed/zen/sweep-fork", status: "failed", decision: "drop" }),
            foldedDropBranch("seed/zen/sweep-fork", "seed/zen/sweep-fork/drop-hidden", 3),
            node({ id: "seed/zen/sweep-fork/sweep-3", name: "seed/zen/sweep-fork/sweep-3", parent_id: "seed/zen/sweep-fork", status: "running" }),
          ],
        }),
        node({
          id: "seed/zen/sweep-core",
          name: "seed/zen/sweep-core",
          parent_id: "seed/zen",
          status: "partial",
          children: [
            node({ id: "seed/zen/sweep-core/continuation", name: "seed/zen/sweep-core/continuation", parent_id: "seed/zen/sweep-core", status: "running", children: hiddenDescendants("seed/zen/sweep-core/continuation", 2, "running") }),
            node({ id: "seed/zen/sweep-core/passed", name: "seed/zen/sweep-core/passed", parent_id: "seed/zen/sweep-core", status: "passed" }),
            foldedDropBranch("seed/zen/sweep-core", "seed/zen/sweep-core/drop-hidden", 2),
            node({ id: "seed/zen/sweep-core/pending", name: "seed/zen/sweep-core/pending", parent_id: "seed/zen/sweep-core", status: "running" }),
          ],
        }),
        node({
          id: "seed/zen/sweep-late",
          name: "seed/zen/sweep-late",
          parent_id: "seed/zen",
          status: "running",
          children: [
            node({ id: "seed/zen/sweep-late/sweep-2", name: "seed/zen/sweep-late/sweep-2", parent_id: "seed/zen/sweep-late", status: "running" }),
            node({ id: "seed/zen/sweep-late/sweep-3", name: "seed/zen/sweep-late/sweep-3", parent_id: "seed/zen/sweep-late", status: "passed" }),
            foldedDropBranch("seed/zen/sweep-late", "seed/zen/sweep-late/drop-hidden", 2),
            node({ id: "seed/zen/sweep-late/seedling", name: "seed/zen/sweep-late/seedling", parent_id: "seed/zen/sweep-late", status: "running" }),
          ],
        }),
        node({
          id: "seed/zen/sweep-revival",
          name: "seed/zen/sweep-revival",
          parent_id: "seed/zen",
          status: "running",
          children: [
            node({ id: "seed/zen/sweep-revival/branch-1", name: "seed/zen/sweep-revival/branch-1", parent_id: "seed/zen/sweep-revival", status: "running", children: hiddenDescendants("seed/zen/sweep-revival/branch-1", 2, "passed") }),
            node({ id: "seed/zen/sweep-revival/branch-2", name: "seed/zen/sweep-revival/branch-2", parent_id: "seed/zen/sweep-revival", status: "passed" }),
            node({ id: "seed/zen/sweep-revival/branch-3", name: "seed/zen/sweep-revival/branch-3", parent_id: "seed/zen/sweep-revival", status: "passed" }),
            foldedDropBranch("seed/zen/sweep-revival", "seed/zen/sweep-revival/drop-hidden", 3),
          ],
        }),
        node({
          id: "seed/zen/sweep-tail",
          name: "seed/zen/sweep-tail",
          parent_id: "seed/zen",
          status: "running",
          children: [
            node({ id: "seed/zen/sweep-tail/late-1", name: "seed/zen/sweep-tail/late-1", parent_id: "seed/zen/sweep-tail", status: "running" }),
            foldedDropBranch("seed/zen/sweep-tail", "seed/zen/sweep-tail/drop-hidden", 1),
            node({ id: "seed/zen/sweep-tail/late-2", name: "seed/zen/sweep-tail/late-2", parent_id: "seed/zen/sweep-tail", status: "running" }),
            node({ id: "seed/zen/sweep-tail/late-3", name: "seed/zen/sweep-tail/late-3", parent_id: "seed/zen/sweep-tail", status: "passed", decision: "drop" }),
          ],
        }),
      ],
    }),
  ];

  const selectedTasks: Task[] = [
    task({ id: "t-running", seq: 201, display_name: "running-task", status: "running" }),
    task({ id: "t-pending", seq: 202, display_name: "pending-task", status: "pending" }),
    task({ id: "t-complete", seq: 203, display_name: "complete-task", status: "completed" }),
    task({ id: "t-running-2", seq: 204, display_name: "second-running", status: "running" }),
    task({ id: "t-fail", seq: 205, display_name: "failed-task", status: "failed" }),
  ];

  it("renders a 20+ run tree without console errors", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="seed/zen"
          pageId="seed/zen"
          selectedTasks={selectedTasks}
          onSelectExperiment={() => {}}
        />
      </MemoryRouter>,
    );

    showRowsMode(container);

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(getRowNames(container)).toHaveLength(31);
    consoleErrorSpy.mockRestore();
  });

  it("keeps promoted continuation near the top of row order and keeps failed/drop branches visible as muted or folded", () => {
    const onSelectExperiment = vi.fn();
    const { container, rerender } = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="seed/zen"
          pageId="seed/zen"
          selectedTasks={selectedTasks}
          onSelectExperiment={onSelectExperiment}
        />
      </MemoryRouter>,
    );

    showRowsMode(container);

    const initialRows = getRowNames(container);
    expect(initialRows).toHaveLength(31);
    expect(initialRows).toContain("seed/zen/sweep-keep");
    expect(initialRows).toContain("seed/zen/sweep-fork");
    const promotedCandidates = [
      initialRows.indexOf("seed/zen/sweep-keep/continuation"),
      initialRows.indexOf("seed/zen/sweep-fork/continue"),
    ].filter((index) => index >= 0);
    expect(promotedCandidates.length).toBeGreaterThan(0);
    expect(Math.min(...promotedCandidates)).toBeLessThan(10);
    expect(initialRows.indexOf("seed/zen/sweep-keep/continuation")).toBeLessThan(11);
    expect(initialRows.indexOf("seed/zen/sweep-fork/late-failed-drop-leaf")).toBeGreaterThan(0);

    const mutedFailedLeaf = getRowByName(container, "seed/zen/sweep-fork/late-failed-drop-leaf");
    expect(mutedFailedLeaf).toHaveAttribute("data-lineage-tone", "muted");

    const mutedFoldedBranch = getRowByName(container, "seed/zen/sweep-keep/drop-hidden");
    expect(mutedFoldedBranch).toHaveAttribute("data-lineage-tone", "muted");
    expect(mutedFoldedBranch).toHaveTextContent("+2 hidden");

    fireEvent.click(screen.getByRole("button", { name: "Preview seed/zen/sweep-keep/continuation" }));
    expect(onSelectExperiment).toHaveBeenCalledWith("seed/zen/sweep-keep/continuation");

    rerender(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="seed/zen/sweep-keep/continuation"
          pageId="seed/zen"
          selectedTasks={selectedTasks}
          onSelectExperiment={onSelectExperiment}
        />
      </MemoryRouter>,
    );

    const focusedRows = getRowNames(container);
    expect(focusedRows).toContain("seed/zen/sweep-keep/continuation");
    expect(focusedRows.indexOf("seed/zen/sweep-keep/continuation")).toBeLessThan(10);
    expect(focusedRows[focusedRows.indexOf("seed/zen/sweep-keep")]).toBe("seed/zen/sweep-keep");
    expect(screen.getByText("Preview selected")).toBeInTheDocument();
  });

  it("preserves root/page spine order when previewing failed/drop leaves and exposes task links in selected strip", () => {
    const onSelectExperiment = vi.fn();
    const { container, rerender } = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="seed/zen"
          pageId="seed/zen"
          selectedTasks={selectedTasks}
          onSelectExperiment={onSelectExperiment}
        />
      </MemoryRouter>,
    );

    showRowsMode(container);

    const baselineRows = getRowNames(container);
    fireEvent.click(screen.getByRole("button", { name: "Preview seed/zen/sweep-fork/late-failed-drop-leaf" }));
    expect(onSelectExperiment).toHaveBeenCalledWith("seed/zen/sweep-fork/late-failed-drop-leaf");

    rerender(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="seed/zen/sweep-fork/late-failed-drop-leaf"
          pageId="seed/zen"
          selectedTasks={selectedTasks}
          onSelectExperiment={onSelectExperiment}
        />
      </MemoryRouter>,
    );

    const reorderedRows = getRowNames(container);
    const keyRows = [
      "seed/zen/sweep-keep",
      "seed/zen/sweep-fork",
      "seed/zen/sweep-core",
      "seed/zen/sweep-late",
      "seed/zen/sweep-revival",
      "seed/zen/sweep-tail",
    ];
    const baselineIndices = keyRows.map((name) => baselineRows.indexOf(name));
    const reorderedIndices = keyRows.map((name) => reorderedRows.indexOf(name));
    expect(baselineIndices).toEqual(reorderedIndices);

    expect(screen.getByText("Tasks: 5")).toBeInTheDocument();
    const selectedStrip = container.querySelector("[data-lineage-selected-strip]");
    if (!(selectedStrip instanceof HTMLElement)) {
      throw new Error("Missing selected detail strip");
    }

    const taskLinks = Array.from(selectedStrip.querySelectorAll('a[href^="/tasks/"]'));
    expect(taskLinks).toHaveLength(3);
    expect(taskLinks[0]).toHaveAttribute("href", "/tasks/t-running");
    expect(taskLinks[1]).toHaveAttribute("href", "/tasks/t-running-2");
    expect(taskLinks[2]).toHaveAttribute("href", "/tasks/t-complete");
    expect(screen.getByRole("link", { name: /open detail/i })).toHaveAttribute(
      "href",
      "/experiments/seed/zen/sweep-fork/late-failed-drop-leaf",
    );

    const failedPreviewRow = getRowByName(container, "seed/zen/sweep-fork/late-failed-drop-leaf");
    expect(failedPreviewRow).toHaveAttribute("data-lineage-tone", "current");
  });
});
