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

  it("preserves sibling order when clicking a child for preview", () => {
    const onSelectExperiment = vi.fn();
    const roots: ExperimentTreeNode[] = [
      node({
        id: "root",
        name: "root/start",
        children: [
          node({ id: "alpha", name: "alpha", parent_id: "root", status: "running" }),
          node({ id: "beta", name: "beta", parent_id: "root", status: "running" }),
          node({ id: "gamma", name: "gamma", parent_id: "root", status: "running" }),
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

    expect(getRowNames(container)).toEqual(["root/start", "alpha", "beta", "gamma"]);

    fireEvent.click(screen.getByRole("button", { name: "Preview beta" }));
    expect(onSelectExperiment).toHaveBeenCalledWith("beta");

    rerender(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ExperimentLineageGraphCard
          roots={roots}
          currentId="beta"
          pageId="root"
          onSelectExperiment={onSelectExperiment}
        />
      </MemoryRouter>,
    );

    expect(getRowNames(container)).toEqual(["root/start", "alpha", "beta", "gamma"]);
  });

  it("shows compact task links for selected lineage node", () => {
    const roots: ExperimentTreeNode[] = [
      node({
        id: "root",
        name: "root/start",
      }),
    ];

    const selectedTasks: Task[] = [
      task({ id: "t-running-a", seq: 1, display_name: "running-a", status: "running" }),
      task({ id: "t-pending", seq: 2, display_name: "pending", status: "pending" }),
      task({ id: "t-complete", seq: 3, display_name: "complete", status: "completed" }),
      task({ id: "t-running-b", seq: 4, display_name: "running-b", status: "running" }),
      task({ id: "t-fail", seq: 5, display_name: "fail", status: "failed" }),
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

    const taskLinks = Array.from(document.querySelectorAll('a[href^="/tasks/"]')).map((n) =>
      n.textContent,
    );

    expect(screen.getByText("Tasks: 5")).toBeInTheDocument();
    expect(taskLinks).toHaveLength(3);
    expect(taskLinks[0]).toMatch("#1 · running");
    expect(taskLinks[1]).toMatch("#4 · running");
    expect(taskLinks[2]).toMatch("#3 · completed");
    expect(screen.queryByRole("link", { name: /open detail/i })).toBeNull();
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
