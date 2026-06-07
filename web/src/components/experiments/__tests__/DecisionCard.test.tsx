import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ExperimentDetail } from "../../../lib/api";
import { DecisionCard } from "../DecisionCard";

function experiment(overrides: Partial<ExperimentDetail> = {}): ExperimentDetail {
  return {
    id: "exp-a",
    name: "experiment-a",
    status: "running",
    criteria: {},
    grid_id: "grid-a",
    results: {},
    created_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("DecisionCard", () => {
  it("renders rerun decision with replication copy while keeping select value", () => {
    render(<DecisionCard exp={experiment({ decision: "rerun" })} onUpdated={() => {}} />);

    expect(screen.getByText("NEEDS REPLICATION")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "needs replication" })).toHaveValue("rerun");
  });
});
