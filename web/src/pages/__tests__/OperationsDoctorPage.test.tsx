import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Stub, Task, WebhookSubscription } from "../../lib/api";
import { healthApi, stubsApi, tasksApi, webhooksApi } from "../../lib/api";
import OperationsDoctorPage from "../OperationsDoctorPage";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    healthApi: { get: vi.fn() },
    stubsApi: { ...actual.stubsApi, list: vi.fn() },
    tasksApi: { ...actual.tasksApi, list: vi.fn() },
    webhooksApi: { list: vi.fn(), deliveries: vi.fn() },
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

function stub(overrides: Partial<Stub>): Stub {
  return {
    id: "stub-a",
    name: "a30-live",
    hostname: "gpu-node",
    gpu: { name: "A30", vram_total_mb: 24576, count: 1 },
    status: "online",
    type: "slurm",
    connected_at: "2026-06-01T00:00:00.000Z",
    last_heartbeat: "2026-06-01T00:00:10.000Z",
    max_concurrent: 1,
    tasks: [],
    tags: ["a30", "slurm"],
    ...overrides,
  } as Stub;
}

function webhook(overrides: Partial<WebhookSubscription>): WebhookSubscription {
  return {
    id: "wh-1",
    name: "hermes-terminal",
    url: "http://127.0.0.1:8644/webhooks/alchemy-tasks",
    events: ["task.failed", "task.completed"],
    enabled: true,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    has_secret: true,
    ...overrides,
  } as WebhookSubscription;
}

function renderPage() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <OperationsDoctorPage />
    </MemoryRouter>,
  );
}

describe("OperationsDoctorPage", () => {
  beforeEach(() => {
    vi.mocked(healthApi.get).mockResolvedValue({ ok: true, version: "2.1.0", uptime_s: 3600 });
    vi.mocked(stubsApi.list).mockResolvedValue([
      stub({ id: "stub-a", name: "a30-live", status: "online", tasks: [task({ id: "run-1", status: "running" })] }),
      stub({ id: "stub-b", name: "expired", status: "offline", tasks: [] }),
    ]);
    vi.mocked(tasksApi.list)
      .mockResolvedValueOnce({
        tasks: [
          task({ id: "run-1", seq: 21, display_name: "train live", status: "running" }),
          task({ id: "block-1", seq: 22, display_name: "blocked eval", status: "blocked", target_stub_id: "expired" }),
        ],
        total: 2,
        page: 1,
        limit: 50,
        counts: { running: 1, blocked: 1 },
      })
      .mockResolvedValueOnce({
        tasks: [task({ id: "fail-1", seq: 20, display_name: "oom eval", status: "failed", exit_code: 137, death_cause: "oom" })],
        total: 1,
        page: 1,
        limit: 5,
        counts: { failed: 1 },
      });
    vi.mocked(webhooksApi.list).mockResolvedValue([webhook({ id: "wh-1", name: "hermes-terminal" })]);
    vi.mocked(webhooksApi.deliveries).mockResolvedValue({
      deliveries: [
        { id: "del-1", subscription_id: "wh-1", subscription_name: "hermes-terminal", event: "task.failed", task_id: "fail-1", task_seq: 20, success: false, http_status: 500, error: "connection refused", attempted_at: "2026-06-01T00:00:00.000Z" },
        { id: "del-2", subscription_id: "wh-1", subscription_name: "hermes-terminal", event: "task.completed", task_id: "done-1", task_seq: 19, success: true, http_status: 202, attempted_at: "2026-06-01T00:01:00.000Z" },
      ],
    });
  });

  it("renders a read-only ops doctor summary from health, tasks, stubs, and webhook deliveries", async () => {
    renderPage();

    expect(await screen.findByText("Operations Doctor")).toBeInTheDocument();
    expect(screen.getAllByText("server ok").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2.1.0").length).toBeGreaterThan(0);
    expect(screen.getByText("1 / 2 online")).toBeInTheDocument();
    expect(screen.getAllByText(/running\s*1.*blocked\s*1/).length).toBeGreaterThan(0);
    expect(screen.getByText("waiting for target stub")).toBeInTheDocument();
    expect(screen.getByText("oom eval")).toBeInTheDocument();
    expect(screen.getByText("oom")).toBeInTheDocument();
    expect(screen.getByText("hermes-terminal")).toBeInTheDocument();
    expect(screen.getAllByText(/1\s*failed\s*\/\s*2\s*recent/).length).toBeGreaterThan(0);
    expect(screen.getByText("connection refused")).toBeInTheDocument();
  });
});
