import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { capacityApi } from "../../lib/api";
import CapacityPage from "../CapacityPage";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, capacityApi: {
    targets: vi.fn(), allocations: vi.fn(), campaigns: vi.fn(), previewCancel: vi.fn(), reconcileCampaign: vi.fn(),
  } };
});

beforeEach(() => {
  vi.mocked(capacityApi.targets).mockResolvedValue([{ id: "slurm-a16", aliases: ["a16"], partition: "gpu-small", qos: "normal", gres: "gpu:a16:1", gpu_class: "A16", tags: [], enabled: true }]);
  vi.mocked(capacityApi.allocations).mockResolvedValue([{ id: "alloc-1", job_id: "42", managed_target_id: "slurm-a16", requested_resources: {}, job_name: "campaign-card", owner: "alice", managed_by: "alchemy", pinned: false, state: "pending", queue_reason: "Resources", requested_at: "2026-07-30T00:00:00Z", stub_id: "stub-1", campaign_id: "camp-1" }]);
  vi.mocked(capacityApi.campaigns).mockResolvedValue([{ id: "camp-1", name: "formal-eval", state: "wait_stub", target_id: "slurm-a16", frozen_spec_hash: "sha256:x", capacity_lease_id: "lease-1", allocation_id: "alloc-1", max_attempts: 3, attempts: 1, max_runtime_seconds: 3600, created_at: "2026-07-30T00:00:00Z", updated_at: "2026-07-30T00:00:00Z", history: [] }]);
  vi.mocked(capacityApi.previewCancel).mockResolvedValue({ dry_run: true, eligible: [], skipped: [{ id: "alloc-1", reason: "busy" }] });
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
});
