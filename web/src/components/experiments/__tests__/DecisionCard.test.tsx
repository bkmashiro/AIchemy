import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DecisionCard } from "../DecisionCard";
import { experimentsApi, type ExperimentDetail } from "../../../lib/api";

vi.mock("../../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api")>();
  return {
    ...actual,
    experimentsApi: {
      ...actual.experimentsApi,
      decide: vi.fn(),
    },
  };
});

function makeExperiment(overrides: Partial<ExperimentDetail> = {}): ExperimentDetail {
  return {
    id: "exp-1",
    name: "exp-one",
    status: "running",
    criteria: {},
    grid_id: "grid-1",
    results: {},
    created_at: "2026-06-01T00:00:00.000Z",
    tasks: [],

    ...overrides,
  };
}

describe("DecisionCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers only canonical decisions and requires a reason", async () => {
    vi.mocked(experimentsApi.decide).mockResolvedValue(makeExperiment({ decision: "try_more" }));
    const onUpdated = vi.fn();

    render(<DecisionCard exp={makeExperiment()} onUpdated={onUpdated} />);

    const select = screen.getByRole("combobox");
    expect(within(select).getByRole("option", { name: "keep" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "try more" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "discard" })).toBeInTheDocument();
    expect(within(select).queryByRole("option", { name: "drop" })).not.toBeInTheDocument();
    expect(within(select).queryByRole("option", { name: /stronger evidence/i })).not.toBeInTheDocument();
    expect(within(select).queryByRole("option", { name: "fork" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(await screen.findByText("Reason required")).toBeInTheDocument();
    expect(experimentsApi.decide).not.toHaveBeenCalled();

    fireEvent.change(select, { target: { value: "try_more" } });
    fireEvent.change(screen.getByPlaceholderText("Reason..."), {
      target: { value: "Need another seed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await waitFor(() => {
      expect(experimentsApi.decide).toHaveBeenCalledWith("exp-1", "try_more", "Need another seed");
    });
    expect(onUpdated).toHaveBeenCalled();
  });

  it("renders legacy stored decisions with canonical labels", () => {
    render(<DecisionCard exp={makeExperiment({ decision: "drop" })} onUpdated={vi.fn()} />);

    expect(screen.getByText("DISCARD")).toBeInTheDocument();
  });
});
