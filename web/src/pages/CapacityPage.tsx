import { useCallback, useState } from "react";
import { capacityApi, type CapacityCampaign, type CapacityTarget, type SlurmAllocation } from "../lib/api";
import { useSerialPolling } from "../hooks/useSerialPolling";

const stateLabel = (state: string) => state.replace(/_/g, " ");

export default function CapacityPage() {
  const [targets, setTargets] = useState<CapacityTarget[]>([]);
  const [allocations, setAllocations] = useState<SlurmAllocation[]>([]);
  const [campaigns, setCampaigns] = useState<CapacityCampaign[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const [nextTargets, nextAllocations, nextCampaigns] = await Promise.all([
        capacityApi.targets(signal), capacityApi.allocations(signal), capacityApi.campaigns(signal),
      ]);
      setTargets(nextTargets); setAllocations(nextAllocations); setCampaigns(nextCampaigns); setError(null);
    } catch (cause) {
      if (!signal.aborted) setError(String(cause));
    }
  }, []);
  useSerialPolling(load, 10_000);

  async function previewRelease(allocation: SlurmAllocation) {
    const result = await capacityApi.previewCancel([allocation.id]);
    const eligible = result.eligible?.length ? `${result.eligible.length} eligible` : "none eligible";
    const skipped = (result.skipped ?? []).map((item: { reason: string }) => item.reason).join(", ");
    setPreview(`${eligible}${skipped ? `; skipped: ${skipped}` : ""}. No changes applied.`);
  }

  return <div className="max-w-7xl mx-auto space-y-5">
    <div>
      <h1 className="text-xl font-bold">Capacity &amp; Campaigns</h1>
      <p className="text-sm text-gray-500">Server snapshots · recommend-only by default · actions require preview.</p>
    </div>
    {error && <div className="border border-red-800 text-red-300 rounded p-3">{error}</div>}
    {preview && <div className="border border-yellow-800 text-yellow-200 rounded p-3" role="status">{preview}</div>}

    <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h2 className="font-semibold mb-3">Target inventory</h2>
      <div className="grid md:grid-cols-3 gap-3">{targets.map((target) => <div key={target.id} className="border border-gray-800 rounded p-3">
        <div className="font-semibold">{target.gpu_class ?? target.id}</div>
        <div className="text-xs text-gray-400">{target.partition ?? "default partition"} · {target.qos ?? "default QOS"}</div>
        <div className="text-xs font-mono text-gray-500">{target.gres ?? "GRES unspecified"}</div>
      </div>)}</div>
    </section>

    <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h2 className="font-semibold mb-3">Queue &amp; allocations</h2>
      <div className="space-y-2">{allocations.map((allocation) => <div key={allocation.id} className="border border-gray-800 rounded p-3 flex gap-4 items-center">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{allocation.job_name}</div>
          <div className="text-xs text-gray-400">{allocation.owner} · {allocation.managed_by}{allocation.pinned ? " · pinned" : ""}</div>
          <div className="text-xs text-gray-500">job {allocation.job_id ?? "pending"} · stub {allocation.stub_id ?? "unbound"} · campaign {allocation.campaign_id ?? "none"}</div>
          <div className="text-xs text-yellow-300"><span>{stateLabel(allocation.state)}</span>{allocation.queue_reason && <> · <span>{allocation.queue_reason}</span></>}</div>
          <div className="text-[11px] text-gray-600">snapshot {allocation.last_observed_at ?? "not observed"}</div>
        </div>
        <button className="border border-yellow-700 rounded px-2 py-1 text-xs text-yellow-200" aria-label={`Preview release ${allocation.job_name}`} onClick={() => void previewRelease(allocation)}>Preview release</button>
      </div>)}</div>
    </section>

    <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h2 className="font-semibold mb-3">Campaign progress</h2>
      <div className="space-y-2">{campaigns.map((campaign) => <div key={campaign.id} className="border border-gray-800 rounded p-3">
        <div className="flex justify-between"><span className="font-medium">{campaign.name}</span><span className="text-sm text-blue-300">{stateLabel(campaign.state)}</span></div>
        <div className="text-xs text-gray-500">lease {campaign.capacity_lease_id} · allocation {campaign.allocation_id ?? "pending"} · attempts {campaign.attempts}/{campaign.max_attempts}</div>
        {campaign.last_error && <div className="text-xs text-red-300">cleanup/error: {campaign.last_error}</div>}
      </div>)}</div>
    </section>
  </div>;
}
