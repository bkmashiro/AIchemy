import { useCallback, useState } from "react";
import { capacityApi, tasksApi, type CapacityCampaign, type CapacityPlan, type CapacityPolicyEvent, type CapacityTarget, type SlurmAllocation, type Task } from "../lib/api";
import { useSerialPolling } from "../hooks/useSerialPolling";

const stateLabel = (state: string) => state.replace(/_/g, " ");

function latestTargetSnapshot(targetId: string, allocations: SlurmAllocation[]): string | undefined {
  const snapshots = allocations
    .filter((allocation) => allocation.managed_target_id === targetId && allocation.last_observed_at)
    .map((allocation) => allocation.last_observed_at!)
    .sort();
  return snapshots[snapshots.length - 1];
}

function targetSnapshotLabel(targetId: string, allocations: SlurmAllocation[]): string {
  const observedAt = latestTargetSnapshot(targetId, allocations);
  if (!observedAt) return "unavailable";
  const ageMs = Date.now() - Date.parse(observedAt);
  return `${observedAt}${Number.isFinite(ageMs) && ageMs > 60_000 ? " · stale" : ""}`;
}

export default function CapacityPage() {
  const [targets, setTargets] = useState<CapacityTarget[]>([]);
  const [allocations, setAllocations] = useState<SlurmAllocation[]>([]);
  const [campaigns, setCampaigns] = useState<CapacityCampaign[]>([]);
  const [policyEvents, setPolicyEvents] = useState<CapacityPolicyEvent[]>([]);
  const [activeTasks, setActiveTasks] = useState<Task[]>([]);
  const [minimumGpuMemory, setMinimumGpuMemory] = useState("");
  const [plannerSnapshot, setPlannerSnapshot] = useState<Record<string, unknown>>({});
  const [plan, setPlan] = useState<CapacityPlan | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const [nextTargets, nextAllocations, nextCampaigns, nextPolicyEvents, nextTasks] = await Promise.all([
        capacityApi.targets(signal), capacityApi.allocations(signal), capacityApi.campaigns(signal), capacityApi.policyEvents(signal),
        tasksApi.list({ status_group: "active", limit: 500 }, signal),
      ]);
      setTargets(nextTargets); setAllocations(nextAllocations); setCampaigns(nextCampaigns); setPolicyEvents(nextPolicyEvents); setActiveTasks(nextTasks.tasks);
      setPlannerSnapshot({ partitions: nextTargets.map((target) => {
        const observed = nextAllocations.filter((allocation) => allocation.managed_target_id === target.id && allocation.last_observed_at);
        const pending = observed.filter((allocation) => ["requested", "submitted", "pending"].includes(allocation.state));
        return {
          name: target.partition,
          pending_jobs: pending.length,
          observed_at: observed.map((allocation) => allocation.last_observed_at).filter(Boolean).sort().slice(-1)[0],
          queue_reason: pending.map((allocation) => allocation.queue_reason).find(Boolean),
          predicted_start_at: pending.map((allocation) => allocation.predicted_start_at).filter(Boolean).sort()[0],
        };
      }) });
      setError(null);
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

  async function planCapacity() {
    const parsedMemory = Number(minimumGpuMemory);
    const resources = Number.isFinite(parsedMemory) && parsedMemory > 0 ? { gpu_mem_mb: parsedMemory } : {};
    try {
      setPlan(await capacityApi.recommend(resources, plannerSnapshot));
      setError(null);
    } catch (cause) {
      const response = (cause as { response?: { data?: Partial<CapacityPlan> } })?.response?.data;
      if (response && Array.isArray(response.rejections)) {
        setPlan({ mode: "recommend_only", recommendation: null, alternatives: [], rejections: response.rejections });
        setError(null);
      } else {
        setPlan(null);
        setError(String(cause));
      }
    }
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
        <div className="text-[11px] text-gray-600">snapshot {targetSnapshotLabel(target.id, allocations)}</div>
      </div>)}</div>
    </section>

    <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h2 className="font-semibold mb-3">Planner recommendation</h2>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void planCapacity(); }}>
        <label className="text-xs text-gray-400">
          Minimum GPU memory (MB)
          <input
            className="mt-1 block rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-200"
            inputMode="numeric"
            value={minimumGpuMemory}
            onChange={(event) => setMinimumGpuMemory(event.target.value)}
          />
        </label>
        <button className="rounded border border-blue-700 px-3 py-1 text-sm text-blue-200" type="submit">Plan capacity</button>
      </form>
      {plan && <div className="mt-3 space-y-1 text-sm">
        {plan.recommendation
          ? <>
            <div className="text-green-300">Best target: {plan.recommendation.target.id} · score {plan.recommendation.score}</div>
            <div className="text-xs text-gray-400">{plan.recommendation.reasons.join(" · ")}</div>
          </>
          : <div className="text-yellow-300">No managed target satisfies these constraints.</div>}
        {plan.rejections.map((rejection) => <div className="text-xs text-yellow-300" key={rejection.target_id}>
          {rejection.target_id}: {rejection.reasons.join("; ")}
        </div>)}
      </div>}
    </section>

    <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h2 className="font-semibold mb-3">Capacity policy audit</h2>
      <div className="space-y-1">
        {policyEvents.slice(0, 20).map((event) => <div className="text-xs text-gray-400" key={event.id}>
          <span className={event.applied ? "text-green-300" : "text-yellow-300"}>{event.applied ? "applied" : "preview"}</span>
          {` · ${event.mode} · ${event.kind} · ${event.target_id ?? event.allocation_id ?? "n/a"} · ${event.reason}`}
        </div>)}
        {policyEvents.length === 0 && <div className="text-xs text-gray-600">No policy decisions recorded.</div>}
      </div>
    </section>

    <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h2 className="font-semibold mb-3">Queue &amp; allocations</h2>
      <div className="space-y-2">{allocations.map((allocation) => <div key={allocation.id} className="border border-gray-800 rounded p-3 flex gap-4 items-center">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{allocation.job_name}</div>
          <div className="text-xs text-gray-400">{allocation.owner} · {allocation.managed_by}{allocation.pinned ? " · pinned" : ""}</div>
          <div className="text-xs text-gray-500">job {allocation.job_id ?? "pending"} · stub {allocation.stub_id ?? "unbound"} · campaign {allocation.campaign_id ?? "none"}</div>
          <div className="text-xs text-gray-500">tasks {allocation.stub_id ? activeTasks.filter((task) => task.stub_id === allocation.stub_id).map((task) => `#${task.seq}`).join(", ") || "none active" : "awaiting stub binding"}</div>
          <div className="text-xs text-yellow-300"><span>{stateLabel(allocation.state)}</span>{allocation.queue_reason && <> · <span>{allocation.queue_reason}</span></>}</div>
          <div className="text-[11px] text-gray-600">predicted start {allocation.predicted_start_at ?? "unknown"} · snapshot {allocation.last_observed_at ?? "not observed"}</div>
        </div>
        <button className="border border-yellow-700 rounded px-2 py-1 text-xs text-yellow-200" aria-label={`Preview release ${allocation.job_name}`} onClick={() => void previewRelease(allocation)}>Preview release</button>
      </div>)}</div>
    </section>

    <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h2 className="font-semibold mb-3">Campaign progress</h2>
      <div className="space-y-2">{campaigns.map((campaign) => <div key={campaign.id} className="border border-gray-800 rounded p-3">
        <div className="flex justify-between"><span className="font-medium">{campaign.name}</span><span className="text-sm text-blue-300">{stateLabel(campaign.state)}</span></div>
        <div className="text-xs text-gray-500">lease {campaign.capacity_lease_id} · allocation {campaign.allocation_id ?? "pending"} · attempts {campaign.attempts}/{campaign.max_attempts}</div>
        <div className="text-xs text-gray-500">cleanup obligation {campaign.cleanup_required ? "verify owned allocation terminal" : campaign.state === "release" ? "release owned allocation" : campaign.state === "closeout" ? "prove zero active tasks and terminal allocation" : "none at current step"}</div>
        {campaign.history.length > 0 && <div className="mt-2 space-y-1 border-l border-gray-700 pl-2">
          {campaign.history.map((event, index) => <div className="text-[11px] text-gray-500" key={`${event.at}-${index}`}>
            {stateLabel(event.from)} → {stateLabel(event.to)} · {event.actor}{event.reason ? ` · ${event.reason}` : ""}
          </div>)}
        </div>}
        {campaign.last_error && <div className="text-xs text-red-300">cleanup/error: {campaign.last_error}</div>}
      </div>)}</div>
    </section>
  </div>;
}
