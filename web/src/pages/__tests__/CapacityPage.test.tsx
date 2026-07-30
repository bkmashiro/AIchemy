import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { capacityApi, tasksApi } from "../../lib/api";
import CapacityPage from "../CapacityPage";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual,
    capacityApi: {
      targets: vi.fn(), allocations: vi.fn(), campaigns: vi.fn(), policyEvents: vi.fn(), recommend: vi.fn(), previewCancel: vi.fn(), reconcileCampaign: vi.fn(),
    },
    tasksApi: { ...actual.tasksApi, list: vi.fn() },
  };
});

beforeEach(() => {
  vi.mocked(capacityApi.targets).mockResolvedValue([{ id: "slurm-a16", aliases: ["a16"], partition: "gpu-small", qos: "normal", gres: "gpu:a16:1", gpu_class: "A16", tags: [], enabled: true }]);
  vi.mocked(capacityApi.allocations).mockResolvedValue([{ id: "alloc-1", job_id: "42", managed_target_id: "slurm-a16", requested_resources: {}, job_name: "campaign-card", owner: "alice", managed_by: "alchemy", pinned: false, state: "pending", queue_reason: "Resources", requested_at: "2026-07-30T00:00:00Z", stub_id: "stub-1", campaign_id: "camp-1" }]);
  vi.mocked(capacityApi.campaigns).mockResolvedValue([{ id: "camp-1", name: "formal-eval", state: "wait_stub", target_id: "slurm-a16", frozen_spec_hash: "sha256:x", capacity_lease_id: "lease-1", allocation_id: "alloc-1", max_attempts: 3, attempts: 1, max_runtime_seconds: 3600, created_at: "2026-07-30T00:00:00Z", updated_at: "2026-07-30T00:00:00Z", history: [] }]);
  vi.mocked(capacityApi.policyEvents).mockResolvedValue([]);
  vi.mocked(tasksApi.list).mockResolvedValue({ tasks: [], total: 0, page: 1, limit: 500, counts: {} });
  vi.mocked(capacityApi.previewCancel).mockResolvedValue({ dry_run: true, eligible: [], skipped: [{ id: "alloc-1", reason: "busy" }] });
  vi.mocked(capacityApi.recommend).mockResolvedValue({
    mode: "recommend_only",
    recommendation: { target: { id: "slurm-a40", aliases: ["a40"], partition: "gpu", tags: [], enabled: true }, score: 7, reasons: ["2 GPUs available"], observed: {} },
    alternatives: [],
    rejections: [{ target_id: "slurm-a16", reasons: ["gpu_mem_mb 16384 < 32768"] }],
  });
});

describe("CapacityPage", () => {
  it("shows inventory, queue state, ownership, allocation binding, and campaign progress", async () => {
    render(<CapacityPage />);
    expect(await screen.findByText("Capacity & Campaigns")).toBeInTheDocument();
    expect(screen.getByText("A16")).toBeInTheDocument();
    expect(screen.getByText("Resources")).toBeInTheDocument();
    expect(screen.getByText(/alice.*alchemy/)).toBeInTheDocument();
    expect(screen.getByText(/job 42.*stub stub-1/)).toBeInTheDocument();
    expect(screen.getByText("formal-eval")).toBeInTheDocument();
    expect(screen.getByText("wait stub")).toBeInTheDocument();
  });

  it("previews release and never applies from the first click", async () => {
    render(<CapacityPage />);
    await screen.findByText("campaign-card");
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Preview release campaign-card" }));
    });
    expect(capacityApi.previewCancel).toHaveBeenCalledWith(["alloc-1"]);
    expect(await screen.findByText(/busy/)).toBeInTheDocument();
  });

  it("shows planner recommendations and candidate rejection explanations", async () => {
    render(<CapacityPage />);
    await screen.findByText("Capacity & Campaigns");
    await act(async () => {
      await userEvent.type(screen.getByLabelText("Minimum GPU memory (MB)"), "32768");
      await userEvent.click(screen.getByRole("button", { name: "Plan capacity" }));
    });

    expect(capacityApi.recommend).toHaveBeenCalledWith(
      { gpu_mem_mb: 32768 },
      expect.objectContaining({ partitions: [expect.objectContaining({ name: "gpu-small", pending_jobs: 0 })] }),
    );
    expect(await screen.findByText(/Best target: slurm-a40/)).toBeInTheDocument();
    expect(screen.getByText(/slurm-a16.*gpu_mem_mb 16384 < 32768/)).toBeInTheDocument();
  });

  it("shows rejection explanations when no target matches", async () => {
    vi.mocked(capacityApi.recommend).mockRejectedValueOnce({
      response: { data: { rejections: [{ target_id: "slurm-a16", reasons: ["gpu_mem_mb 16384 < 65536"] }] } },
    });
    render(<CapacityPage />);
    await screen.findByText("Capacity & Campaigns");
    await act(async () => {
      await userEvent.type(screen.getByLabelText("Minimum GPU memory (MB)"), "65536");
      await userEvent.click(screen.getByRole("button", { name: "Plan capacity" }));
    });

    expect(await screen.findByText("No managed target satisfies these constraints.")).toBeInTheDocument();
    expect(screen.getByText(/slurm-a16.*gpu_mem_mb 16384 < 65536/)).toBeInTheDocument();
  });
});
