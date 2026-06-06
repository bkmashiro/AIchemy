import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ExperimentTreeNode } from "../../../lib/api";
import { ExperimentLineageGraphCard } from "../ExperimentLineageGraphCard";

function node(overrides: Partial<ExperimentTreeNode> & { id: string; name: string }): ExperimentTreeNode {
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
});
