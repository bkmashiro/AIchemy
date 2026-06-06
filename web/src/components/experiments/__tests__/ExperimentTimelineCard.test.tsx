import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ExperimentEvent } from "../../../lib/api";
import { experimentsApi } from "../../../lib/api";
import { ExperimentTimelineCard } from "../ExperimentTimelineCard";

vi.mock("../../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api")>();
  return {
    ...actual,
    experimentsApi: {
      ...actual.experimentsApi,
      addNote: vi.fn(),
    },
  };
});

function makeEvent(id: string, created_at: string, message = id): ExperimentEvent {
  return {
    id,
    experiment_id: "exp-a",
    kind: "note",
    message,
    created_at,
    actor: "tester",
    data: {},
  };
}

function renderCard(events: ExperimentEvent[], pageSize = 20, onNoteAdded = vi.fn()) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ExperimentTimelineCard
        experimentId="exp-a"
        events={events}
        pageSize={pageSize}
        onNoteAdded={onNoteAdded}
      />
    </MemoryRouter>,
  );
}

describe("ExperimentTimelineCard", () => {
  beforeEach(() => {
    vi.mocked(experimentsApi.addNote).mockReset();
  });

  it("renders newest events first", () => {
    renderCard([
      makeEvent("old", "2026-06-01T00:00:00.000Z", "old event"),
      makeEvent("new", "2026-06-03T00:00:00.000Z", "new event"),
      makeEvent("mid", "2026-06-02T00:00:00.000Z", "mid event"),
    ]);

    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("new event");
    expect(items[1]).toHaveTextContent("mid event");
    expect(items[2]).toHaveTextContent("old event");
  });

  it("paginates timeline events and disables controls at bounds", () => {
    renderCard([
      makeEvent("one", "2026-06-01T00:00:00.000Z", "oldest"),
      makeEvent("two", "2026-06-02T00:00:00.000Z", "middle"),
      makeEvent("three", "2026-06-03T00:00:00.000Z", "newest"),
    ], 2);

    expect(screen.getByText("1-2 of 3 events")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    expect(screen.getByText("newest")).toBeInTheDocument();
    expect(screen.getByText("middle")).toBeInTheDocument();
    expect(screen.queryByText("oldest")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText("3-3 of 3 events")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByText("oldest")).toBeInTheDocument();
    expect(screen.queryByText("newest")).not.toBeInTheDocument();
  });

  it("still allows adding a note from the empty state", async () => {
    const onNoteAdded = vi.fn();
    vi.mocked(experimentsApi.addNote).mockResolvedValue(makeEvent("note", "2026-06-04T00:00:00.000Z"));
    renderCard([], 2, onNoteAdded);

    fireEvent.change(screen.getByPlaceholderText("Add a note..."), {
      target: { value: "capture finding" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));

    await waitFor(() => {
      expect(experimentsApi.addNote).toHaveBeenCalledWith("exp-a", "capture finding", {
        task_id: undefined,
      });
      expect(onNoteAdded).toHaveBeenCalled();
    });
  });
});
