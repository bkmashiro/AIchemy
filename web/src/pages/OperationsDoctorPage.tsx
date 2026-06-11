import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  HealthStatus,
  Stub,
  Task,
  WebhookDelivery,
  WebhookSubscription,
  healthApi,
  stubsApi,
  tasksApi,
  webhooksApi,
} from "../lib/api";
import { formatRelTime, generateDisplayName } from "../lib/format";
import { diagnosisToneClass, taskDiagnosis } from "../lib/taskDiagnostics";
import { TASK_STATUS_BADGE_CLASS, taskStatusLabel } from "../lib/taskStatus";

interface DoctorState {
  health: HealthStatus | null;
  stubs: Stub[];
  activeTasks: Task[];
  recentFailed: Task[];
  webhooks: WebhookSubscription[];
  deliveriesByWebhook: Record<string, WebhookDelivery[]>;
}

function StatCard({ label, value, tone = "neutral", detail }: { label: string; value: string; tone?: "ok" | "warn" | "bad" | "neutral"; detail?: string }) {
  const toneClass = tone === "ok"
    ? "border-green-800/50 bg-green-950/20 text-green-300"
    : tone === "warn"
      ? "border-yellow-800/50 bg-yellow-950/20 text-yellow-300"
      : tone === "bad"
        ? "border-red-800/50 bg-red-950/20 text-red-300"
        : "border-gray-800 bg-gray-900 text-gray-300";
  return (
    <div className={`rounded-xl border p-4 ${toneClass}`}>
      <p className="text-xs uppercase tracking-wider opacity-70">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
      {detail && <p className="mt-1 text-xs opacity-70">{detail}</p>}
    </div>
  );
}

function TaskLine({ task }: { task: Task }) {
  const diagnosis = taskDiagnosis(task);
  return (
    <Link
      to={`/tasks/${task.id}`}
      className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2 hover:border-gray-700 transition-colors"
    >
      <span className="text-xs font-mono text-gray-500 shrink-0">#{task.seq}</span>
      <span className="text-sm text-gray-200 truncate min-w-0 flex-1">{generateDisplayName(task)}</span>
      <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold border ${TASK_STATUS_BADGE_CLASS[task.status] || ""}`}>
        {taskStatusLabel(task)}
      </span>
      <span className={`hidden sm:inline-flex px-1.5 py-0.5 rounded text-[10px] border ${diagnosisToneClass(diagnosis.tone)}`}>
        {diagnosis.label}
      </span>
    </Link>
  );
}

function WebhookLine({ webhook, deliveries }: { webhook: WebhookSubscription; deliveries: WebhookDelivery[] }) {
  const failed = deliveries.filter((d) => !d.success);
  const latestFailure = failed[0];
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2">
      <div className="flex items-center gap-3">
        <span className={webhook.enabled ? "text-green-300" : "text-gray-500"}>{webhook.enabled ? "enabled" : "disabled"}</span>
        <span className="text-sm text-gray-200 font-medium">{webhook.name}</span>
        <span className="text-xs text-gray-500 truncate min-w-0">{webhook.events.join(", ")}</span>
        <span className={failed.length > 0 ? "ml-auto text-xs text-red-300" : "ml-auto text-xs text-green-300"}>
          {failed.length} failed / {deliveries.length} recent
        </span>
      </div>
      {latestFailure && (
        <div className="mt-2 text-xs text-red-300 font-mono truncate">
          {latestFailure.error || `HTTP ${latestFailure.http_status ?? "?"}`}
        </div>
      )}
    </div>
  );
}

export default function OperationsDoctorPage() {
  const [state, setState] = useState<DoctorState>({
    health: null,
    stubs: [],
    activeTasks: [],
    recentFailed: [],
    webhooks: [],
    deliveriesByWebhook: {},
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [health, stubs, active, failed, webhooks] = await Promise.all([
          healthApi.get(),
          stubsApi.list(),
          tasksApi.list({ status_group: "active", limit: 50 }),
          tasksApi.list({ status: "failed", limit: 5 }),
          webhooksApi.list(),
        ]);
        const deliveryPairs = await Promise.all(
          webhooks.map(async (webhook) => [webhook.id, (await webhooksApi.deliveries(webhook.id, 10)).deliveries] as const),
        );
        if (cancelled) return;
        setState({
          health,
          stubs,
          activeTasks: active.tasks,
          recentFailed: failed.tasks,
          webhooks,
          deliveriesByWebhook: Object.fromEntries(deliveryPairs),
        });
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const onlineStubs = state.stubs.filter((s) => s.status === "online");
  const activeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const task of state.activeTasks) counts[task.status] = (counts[task.status] || 0) + 1;
    return counts;
  }, [state.activeTasks]);
  const blockedTasks = state.activeTasks.filter((task) => task.status === "blocked");
  const runningTasks = state.activeTasks.filter((task) => task.status === "running");
  const recentWebhookDeliveries = Object.values(state.deliveriesByWebhook).flat();
  const failedDeliveries = recentWebhookDeliveries.filter((d) => !d.success);

  if (loading) return <div className="text-gray-500 text-center py-20">Loading operations doctor...</div>;

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white">Operations Doctor</h1>
          <p className="text-sm text-gray-500 mt-1">Read-only health, capacity, queue, and webhook triage.</p>
        </div>
        {state.health && (
          <div className="text-right text-xs text-gray-500">
            <div>{state.health.ok ? "server ok" : "server degraded"}</div>
            {state.health.version && <div className="font-mono">{state.health.version}</div>}
          </div>
        )}
      </div>

      {error && <div className="rounded border border-red-800 bg-red-950/30 p-3 text-sm text-red-300">{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <StatCard label="Server" value={state.health?.ok ? "server ok" : "degraded"} tone={state.health?.ok ? "ok" : "bad"} detail={state.health?.version} />
        <StatCard label="Capacity" value={`${onlineStubs.length} / ${state.stubs.length} online`} tone={onlineStubs.length > 0 ? "ok" : "bad"} detail={`${state.stubs.length - onlineStubs.length} offline`} />
        <StatCard label="Active Tasks" value={`${state.activeTasks.length}`} tone={blockedTasks.length > 0 ? "warn" : "ok"} detail={`running ${activeCounts.running || 0} · blocked ${activeCounts.blocked || 0}`} />
        <StatCard label="Webhooks" value={`${state.webhooks.filter((w) => w.enabled).length} enabled`} tone={failedDeliveries.length > 0 ? "warn" : "ok"} detail={`${failedDeliveries.length} failed / ${recentWebhookDeliveries.length} recent`} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white">Task Triage</h2>
            <span className="text-xs text-gray-500">running {activeCounts.running || 0} · blocked {activeCounts.blocked || 0}</span>
          </div>
          <div className="space-y-2">
            {[...blockedTasks, ...runningTasks, ...state.recentFailed].slice(0, 12).map((task) => <TaskLine key={task.id} task={task} />)}
            {state.activeTasks.length === 0 && state.recentFailed.length === 0 && <div className="text-sm text-gray-600">No active or recent failed tasks.</div>}
          </div>
        </section>

        <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white">Stub Capacity</h2>
            <span className="text-xs text-gray-500">{onlineStubs.length} online</span>
          </div>
          <div className="space-y-2">
            {state.stubs.map((stub) => (
              <Link key={stub.id} to={`/stubs/${stub.id}`} className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2 hover:border-gray-700 transition-colors">
                <span className={stub.status === "online" ? "text-green-300" : "text-gray-500"}>{stub.status}</span>
                <span className="text-sm text-gray-200 flex-1">{stub.name}</span>
                <span className="text-xs text-gray-500">{stub.gpu.count}× {stub.gpu.name}</span>
                <span className="text-xs text-gray-600">{formatRelTime(stub.last_heartbeat)}</span>
              </Link>
            ))}
          </div>
        </section>
      </div>

      <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-white">Webhook Delivery Health</h2>
          <span className="text-xs text-gray-500">metadata only</span>
        </div>
        <div className="space-y-2">
          {state.webhooks.map((webhook) => (
            <WebhookLine key={webhook.id} webhook={webhook} deliveries={state.deliveriesByWebhook[webhook.id] || []} />
          ))}
          {state.webhooks.length === 0 && <div className="text-sm text-gray-600">No webhook subscriptions.</div>}
        </div>
      </section>
    </div>
  );
}
