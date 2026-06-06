import { describe, expect, it } from "vitest";
import type { Experiment } from "../../../lib/api";
import { filterExperimentEntryPoints } from "../ExperimentListTable";

function exp(overrides: Partial<Experiment> & { id: string; name: string }): Experiment {
  return {
    description: "",
    criteria: {},
    grid_id: `grid-${overrides.id}`,
    status: "running",
    results: {},
    created_at: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

describe("filterExperimentEntryPoints", () => {
  it("keeps lineage roots and promoted fork points, not every child run", () => {
    const experiments = [
      exp({ id: "root", name: "series/root", parent_id: undefined }),
      exp({ id: "seed-a", name: "series/seed-a", parent_id: "root", decision: "drop" }),
      exp({ id: "fork", name: "series/important-fork", parent_id: "root", decision: "fork" }),
      exp({ id: "keep", name: "series/kept", parent_id: "fork", decision: "keep" }),
      exp({ id: "rerun", name: "series/rerun", parent_id: "fork", decision: "rerun" }),
    ];

    expect(filterExperimentEntryPoints(experiments).map((e) => e.id)).toEqual([
      "root",
      "fork",
      "keep",
    ]);
  });

  it("falls back to the original slice when no entry point is detectable", () => {
    const experiments = [exp({ id: "orphan-child", name: "legacy/child", parent_id: "missing" })];
    expect(filterExperimentEntryPoints(experiments)).toEqual(experiments);
  });
});
