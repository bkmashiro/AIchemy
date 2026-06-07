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

function makeEvent(
  id: string,
  created_at: string,
  message = id,
  kind: ExperimentEvent["kind"] = "note",
  data: Record<string, unknown> = {},
): ExperimentEvent {
  return {
    id,
    experiment_id: "exp-a",
    kind,
    message,
    created_at,
    actor: "tester",
    data,
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
      makeEvent("old", "2026-06-01T00:00:00.000Z", "old event", "note"),
      makeEvent("new", "2026-06-03T00:00:00.000Z", "new event", "note"),
      makeEvent("mid", "2026-06-02T00:00:00.000Z", "mid event", "note"),
    ]);

    expect(screen.getByRole("button", { name: "Newest first" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("new event");
    expect(items[1]).toHaveTextContent("mid event");
    expect(items[2]).toHaveTextContent("old event");
  });

  it("renders oldest-first chronology for story reconstruction", () => {
    renderCard([
      makeEvent("old", "2026-06-01T00:00:00.000Z", "old event", "note"),
      makeEvent("new", "2026-06-03T00:00:00.000Z", "new event", "note"),
      makeEvent("mid", "2026-06-02T00:00:00.000Z", "mid event", "note"),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Oldest first" }));

    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("old event");
    expect(items[1]).toHaveTextContent("mid event");
    expect(items[2]).toHaveTextContent("new event");
  });

  it("resets to page 1 when chronology changes", () => {
    renderCard([
      makeEvent("e1", "2026-06-01T00:00:00.000Z", "event-1", "note"),
      makeEvent("e2", "2026-06-02T00:00:00.000Z", "event-2", "note"),
      makeEvent("e3", "2026-06-03T00:00:00.000Z", "event-3", "note"),
      makeEvent("e4", "2026-06-04T00:00:00.000Z", "event-4", "note"),
      makeEvent("e5", "2026-06-05T00:00:00.000Z", "event-5", "note"),
    ], 2);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("3-4 of 5 events")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Oldest first" }));

    expect(screen.getByText("1-2 of 5 events")).toBeInTheDocument();
    expect(screen.getByText("event-1")).toBeInTheDocument();
    expect(screen.getByText("event-2")).toBeInTheDocument();
    expect(screen.queryByText("event-5")).not.toBeInTheDocument();
  });

  it("renders filter chips with counts", () => {
    renderCard([
      makeEvent("n1", "2026-06-01T00:00:00.000Z", "note 1", "note"),
      makeEvent("d1", "2026-06-02T00:00:00.000Z", "decision 1", "decision"),
      makeEvent("a1", "2026-06-03T00:00:00.000Z", "artifact 1", "artifact"),
      makeEvent("c1", "2026-06-04T00:00:00.000Z", "checkpoint 1", "checkpoint"),
      makeEvent("t1", "2026-06-05T00:00:00.000Z", "task started", "task_started"),
      makeEvent("t2", "2026-06-06T00:00:00.000Z", "task completed", "task_completed"),
    ]);

    expect(screen.getByRole("button", { name: "All (6)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notes (1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decisions (1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Artifacts (1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Checkpoints (1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tasks (2)" })).toBeInTheDocument();
  });

  it("filters by decisions, artifacts, and tasks", () => {
    renderCard([
      makeEvent("task-start", "2026-06-01T00:00:00.000Z", "task started", "task_started"),
      makeEvent("artifact", "2026-06-02T00:00:00.000Z", "artifact event", "artifact"),
      makeEvent("decision", "2026-06-03T00:00:00.000Z", "decision event", "decision"),
      makeEvent("task-fail", "2026-06-04T00:00:00.000Z", "task failed", "task_failed"),
      makeEvent("task-done", "2026-06-05T00:00:00.000Z", "task completed", "task_completed"),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Decisions (1)" }));
    expect(screen.getByText("Showing decisions evidence")).toBeInTheDocument();
    const listItemsAfterDecisions = screen.getAllByRole("listitem");
    expect(listItemsAfterDecisions).toHaveLength(1);
    expect(listItemsAfterDecisions[0]).toHaveTextContent("decision event");

    fireEvent.click(screen.getByRole("button", { name: "Artifacts (1)" }));
    expect(screen.getByText("Showing artifacts evidence")).toBeInTheDocument();
    const listItemsAfterArtifacts = screen.getAllByRole("listitem");
    expect(listItemsAfterArtifacts).toHaveLength(1);
    expect(listItemsAfterArtifacts[0]).toHaveTextContent("artifact event");

    fireEvent.click(screen.getByRole("button", { name: "Tasks (3)" }));
    expect(screen.getByText("Showing tasks evidence")).toBeInTheDocument();
    const listItemsAfterTasks = screen.getAllByRole("listitem");
    expect(listItemsAfterTasks).toHaveLength(3);
    expect(listItemsAfterTasks[0]).toHaveTextContent("task completed");
    expect(listItemsAfterTasks[1]).toHaveTextContent("task failed");
    expect(listItemsAfterTasks[2]).toHaveTextContent("task started");
  });

  it("shows user-facing decision labels for decision events", () => {
    renderCard([
      makeEvent(
        "decision",
        "2026-06-01T00:00:00.000Z",
        "rerun",
        "decision",
        { decision: "rerun", reason: "Need more seeds" },
      ),
    ]);

    expect(screen.getByText("Needs stronger evidence")).toBeInTheDocument();
    expect(screen.getByText("Need more seeds")).toBeInTheDocument();
    expect(screen.queryByText("rerun")).not.toBeInTheDocument();
  });

  it("renders a copy locator button and copies artifact locator", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderCard([
      makeEvent(
        "artifact",
        "2026-06-01T00:00:00.000Z",
        "artifact event",
        "artifact",
        { path: "s3://bucket/artifact.pt" },
      ),
    ]);

    fireEvent.click(screen.getByRole("button", { name: /copy locator/i }));

    expect(writeText).toHaveBeenCalledWith("s3://bucket/artifact.pt");
    expect(await screen.findByText("Locator copied to clipboard.")).toBeInTheDocument();
  });

  it("renders an Open link for http(s) locator", () => {
    renderCard([
      makeEvent(
        "checkpoint",
        "2026-06-01T00:00:00.000Z",
        "checkpoint saved",
        "checkpoint",
        { uri: "https://artifacts.local/models/ckpt.pt" },
      ),
    ]);

    const openLink = screen.getByRole("link", { name: /open/i });
    expect(openLink).toHaveAttribute("href", "https://artifacts.local/models/ckpt.pt");
    expect(openLink).toHaveAttribute("target", "_blank");
    expect(openLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("paginates timeline events and disables controls at bounds", () => {
    renderCard([
      makeEvent("one", "2026-06-01T00:00:00.000Z", "oldest", "note"),
      makeEvent("two", "2026-06-02T00:00:00.000Z", "middle", "note"),
      makeEvent("three", "2026-06-03T00:00:00.000Z", "newest", "note"),
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

  it("resets to first page after applying a filter", () => {
    renderCard([
      makeEvent("t1", "2026-06-01T00:00:00.000Z", "task1", "task_started"),
      makeEvent("d1", "2026-06-02T00:00:00.000Z", "decision1", "decision"),
      makeEvent("t2", "2026-06-03T00:00:00.000Z", "task2", "task_completed"),
      makeEvent("t3", "2026-06-04T00:00:00.000Z", "task3", "task_failed"),
      makeEvent("a1", "2026-06-05T00:00:00.000Z", "artifact1", "artifact"),
    ], 2);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("3-4 of 5 events")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Artifacts (1)" }));

    expect(screen.getByText("Showing artifacts evidence")).toBeInTheDocument();
    expect(screen.getByText("1-1 of 1 event")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByText("artifact1")).toBeInTheDocument();
    expect(screen.queryByText("task3")).not.toBeInTheDocument();
  });

  it("still allows adding a note from the empty state", async () => {
    const onNoteAdded = vi.fn();
    vi.mocked(experimentsApi.addNote).mockResolvedValue(makeEvent("note", "2026-06-04T00:00:00.000Z", "new note"));
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
