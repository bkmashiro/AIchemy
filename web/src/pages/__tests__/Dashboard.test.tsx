import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Dashboard from "../Dashboard";
import type { CostSummary, OverviewData, Stub, Task, TunnelStatus } from "../../lib/api";
import { costApi, deployApi, overviewApi } from "../../lib/api";

vi.mock("../../components/TaskForm", () => ({ default: () => <div>Task form</div> }));
vi.mock("../../components/StubCard", () => ({ default: ({ stub }: { stub: Stub }) => <div>{stub.name}</div> }));
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    overviewApi: { get: vi.fn() },
    costApi: { summary: vi.fn() },
    deployApi: { tunnelStatus: vi.fn() },
  };
});

const now = "2026-06-11T00:00:00Z";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? "task-1",
    seq: overrides.seq ?? 1,
    fingerprint: overrides.fingerprint ?? "fp",
    name: overrides.name ?? "task",
    display_name: overrides.display_name ?? overrides.name ?? "task",
    command: overrides.command ?? "python /tmp/train.py",
    script: overrides.script ?? "/tmp/train.py",
    args: overrides.args,
    raw_args: overrides.raw_args,
    status: overrides.status ?? "pending",
    priority: overrides.priority ?? 0,
    created_at: overrides.created_at ?? now,
    started_at: overrides.started_at,
    finished_at: overrides.finished_at,
    stub_id: overrides.stub_id,
    target_stub_id: overrides.target_stub_id,
    dispatch_attempts: overrides.dispatch_attempts,
    exit_code: overrides.exit_code,
    requirements: overrides.requirements,
    log_buffer: overrides.log_buffer ?? [],
    retry_count: overrides.retry_count ?? 0,
    max_retries: overrides.max_retries ?? 0,
    should_stop: overrides.should_stop ?? false,
    should_checkpoint: overrides.should_checkpoint ?? false,
    death_cause: overrides.death_cause,
  };
}

function makeStub(tasks: Task[]): Stub {
  return {
    id: "stub-a",
    name: "worker-a",
    hostname: "host-a",
    gpu: { name: "A30", vram_total_mb: 24576, count: 1 },
    status: "online",
    type: "slurm",
    connected_at: now,
    last_heartbeat: now,
    tags: ["a30"],
    max_concurrent: 1,
    tasks,
  };
}

function renderDashboard({ stubs = [], globalQueue = [] }: { stubs?: Stub[]; globalQueue?: Task[] }) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Dashboard stubs={stubs} globalQueue={globalQueue} lossHistory={new Map()} logBuffers={new Map()} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(overviewApi.get).mockResolvedValue({
    tasks: { total: 0, running: 0, queued: 0, completed: 0, failed: 0 },
    stubs: { total: 1, online: 1, offline: 0 },
    grids: { total: 0, running: 0, completed: 0 },
    gpus: { total_vram_mb: 24576, used_vram_mb: 0 },
    cached_at: now,
  } satisfies OverviewData);
  vi.mocked(costApi.summary).mockResolvedValue({
    total_gpu_hours: 0,
    total_cost_usd: 0,
    utilization_pct: 0,
    task_count: 0,
  } satisfies CostSummary);
  vi.mocked(deployApi.tunnelStatus).mockResolvedValue({ running: true, url: "https://alchemy.test" } satisfies TunnelStatus);
});

describe("Dashboard task triage", () => {
  it("summarizes active and failed task health with actionable blocked reasons", async () => {
    renderDashboard({
      stubs: [
        makeStub([
          makeTask({ id: "running-1", seq: 10, name: "train", status: "running", stub_id: "stub-a" }),
          makeTask({ id: "failed-1", seq: 11, name: "oom-eval", status: "failed", exit_code: 137, death_cause: "oom", finished_at: now }),
        ]),
      ],
      globalQueue: [
        makeTask({ id: "blocked-1", seq: 12, name: "pinned", status: "blocked", target_stub_id: "missing-stub", dispatch_attempts: 3 }),
        makeTask({ id: "pending-1", seq: 13, name: "queued", status: "pending" }),
      ],
    });

    expect(await screen.findByText("Task Triage")).toBeInTheDocument();
    expect(screen.getByText("running 1")).toBeInTheDocument();
    expect(screen.getByText("blocked 1")).toBeInTheDocument();
    expect(screen.getByText("failed recent 1")).toBeInTheDocument();
    expect(screen.getByText("waiting for target stub")).toBeInTheDocument();
    expect(screen.getByText("#12 pinned")).toBeInTheDocument();
    expect(await screen.findByText("$0.00")).toBeInTheDocument();
  });
});
