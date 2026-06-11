import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Task } from "../../lib/api";
import { tasksApi } from "../../lib/api";
import TasksPage from "../TasksPage";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    tasksApi: {
      ...actual.tasksApi,
      list: vi.fn(),
      patch: vi.fn(),
      retry: vi.fn(),
      batch: vi.fn(),
    },
  };
});

function task(overrides: Partial<Task>): Task {
  return {
    id: "task-1",
    seq: 1,
    fingerprint: "fp",
    display_name: "task one",
    script: "/tmp/train.py",
    command: "python /tmp/train.py",
    status: "pending",
    priority: 5,
    created_at: "2026-06-01T00:00:00.000Z",
    log_buffer: [],
    retry_count: 0,
    max_retries: 0,
    should_stop: false,
    should_checkpoint: false,
    ...overrides,
  } as Task;
}

function renderTasksPage() {
  return render(
    <MemoryRouter initialEntries={["/tasks"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/tasks/:id" element={<div>task detail</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("TasksPage server task statuses", () => {
  beforeEach(() => {
    vi.mocked(tasksApi.patch).mockResolvedValue({} as Task);
    vi.mocked(tasksApi.retry).mockResolvedValue({} as Task);
    vi.mocked(tasksApi.batch).mockResolvedValue({ ok: true });
  });

  it("renders assigned and blocked server statuses in the summary", async () => {
    vi.mocked(tasksApi.list).mockResolvedValue({
      tasks: [
        task({ id: "assigned-task", seq: 11, display_name: "assigned task", status: "assigned" as Task["status"] }),
        task({ id: "blocked-task", seq: 12, display_name: "blocked task", status: "blocked" as Task["status"] }),
      ],
      total: 2,
      page: 1,
      limit: 50,
      counts: { assigned: 1, blocked: 1 },
    });

    renderTasksPage();

    expect(await screen.findByText("assigned 1")).toBeInTheDocument();
    expect(screen.getByText("blocked 1")).toBeInTheDocument();
    expect(screen.getByText("ASSIGNED")).toBeInTheDocument();
    expect(screen.getByText("BLOCKED")).toBeInTheDocument();
  });

  it("shows diagnosis reasons for blocked and failed tasks", async () => {
    vi.mocked(tasksApi.list).mockResolvedValue({
      tasks: [
        task({ id: "blocked-task", seq: 12, display_name: "blocked task", status: "blocked", target_stub_id: "stub-dead" }),
        task({ id: "failed-task", seq: 13, display_name: "failed task", status: "failed", exit_code: 137, death_cause: "oom" }),
      ],
      total: 2,
      page: 1,
      limit: 50,
      counts: { blocked: 1, failed: 1 },
    });

    renderTasksPage();

    expect(await screen.findByText("waiting for target stub")).toBeInTheDocument();
    expect(screen.getByText("oom")).toBeInTheDocument();
  });

  it("cancels active server-status tasks with cancelled status", async () => {
    vi.mocked(tasksApi.list).mockResolvedValue({
      tasks: [task({ id: "assigned-task", seq: 11, display_name: "assigned task", status: "assigned" as Task["status"] })],
      total: 1,
      page: 1,
      limit: 50,
      counts: { assigned: 1 },
    });

    renderTasksPage();

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(tasksApi.patch).toHaveBeenCalledWith("assigned-task", { status: "cancelled" });
    });
  });
});
