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
  const rows = Array.from(container.querySelectorAll("div.flex.items-stretch"));
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

function getRowByLabel(container: HTMLElement, name: string): HTMLDivElement {
  const row = container.querySelector(`button[aria-label="Preview ${name}"]`)?.closest(
    "div.flex.items-stretch",
  );
  if (!(row instanceof HTMLDivElement)) {
    throw new Error(`Missing lineage row for ${name}`);
  }
  return row;
}

function taskChipByDisplayName(name: string): HTMLAnchorElement {
  const textNode = screen.getByText(new RegExp(name));
  const link = textNode.closest('a[href^="/tasks/"]');
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`Missing task chip for ${name}`);
  }
  return link;
}

describe("ExperimentLineageGraphCard", () => {
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

    expect(getRowNames(container)).toEqual([
      "root/start",
      "parent-branch",
      "grand-child",
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
      "grand-child",
      "running-leaf",
      "failed-leaf",
    ]);
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
