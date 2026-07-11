import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Task } from "../../lib/api";
import { costApi, tasksApi } from "../../lib/api";
import TaskDetailPage from "../TaskDetailPage";

vi.mock("../../components/LogViewer", () => ({ default: () => <div>Log viewer</div> }));
vi.mock("../../components/MetricsChart", () => ({ default: () => <div>Metrics chart</div> }));
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    tasksApi: {
      ...actual.tasksApi,
      get: vi.fn(),
      assignmentDiagnosis: vi.fn(),
      patch: vi.fn(),
      retry: vi.fn(),
    },
    costApi: {
      ...actual.costApi,
      taskCost: vi.fn(),
    },
  };
});

function task(overrides: Partial<Task>): Task {
  return {
    id: "task-abc",
    seq: 42,
    fingerprint: "fp",
    display_name: "blocked eval",
    script: "/tmp/eval.py",
    command: "python /tmp/eval.py",
    status: "blocked",
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

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={["/tasks/task-abc"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/tasks/:id" element={<TaskDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("TaskDetailPage operator diagnostics", () => {
  beforeEach(() => {
    vi.mocked(costApi.taskCost).mockRejectedValue(new Error("no cost"));
    vi.mocked(tasksApi.assignmentDiagnosis).mockResolvedValue({
      task_id: "task-abc",
      task_status: "blocked",
      ready: false,
      schedulable: false,
      blocker: "target_stub_offline",
      summary_code: "target_stub_offline",
      next_action: "restart_target_or_retarget",
      compatible_stub_count: 0,
      online_stub_count: 2,
      rejections: [{
        stub_id: "stub-dead",
        stub_name: "a30-dead",
        reason_code: "target_stub_offline",
        details: { slots_active: 0, slots_limit: 1 },
      }],
      computed_at: "2026-07-11T00:00:00.000Z",
    });
  });

  it("shows diagnosis and copyable operator commands", async () => {
    vi.mocked(tasksApi.get).mockResolvedValue(task({
      target_stub_id: "stub-dead",
      dispatch_attempts: 3,
      run_dir: "/tmp/run-a",
    }));

    renderDetail();

    expect(await screen.findByText("Operator Diagnostics")).toBeInTheDocument();
    expect(screen.getByText("waiting for target stub")).toBeInTheDocument();
    expect(await screen.findByText("target_stub_offline")).toBeInTheDocument();
    expect(screen.getByText("restart_target_or_retarget")).toBeInTheDocument();
    expect(screen.getByText("a30-dead · target_stub_offline")).toBeInTheDocument();
    expect(screen.getByText("alch tasks get task-abc")).toBeInTheDocument();
    expect(screen.getByText("alch tasks logs task-abc --tail 200")).toBeInTheDocument();
    expect(screen.getByText("ls -la /tmp/run-a")).toBeInTheDocument();
  });
});
