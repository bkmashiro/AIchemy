import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Stub, Task, overviewApi, OverviewData, costApi, CostSummary, deployApi, TunnelStatus } from "../lib/api";
import { formatRelTime, generateDisplayName } from "../lib/format";
import StubCard from "../components/StubCard";
import TaskForm from "../components/TaskForm";
import { TASK_STATUS_TEXT_CLASS, isTerminalTaskStatus, taskStatusLabel } from "../lib/taskStatus";

interface Props {
  stubs: Stub[];
  globalQueue: Task[];
  lossHistory: Map<string, number[]>;
  logBuffers: Map<string, string[]>;
  onTaskUpdate?: () => void;
}

function StatTile({ label, value, sub, color }: { label: string; value: number | string; sub?: string; color?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-1">
      <span className="text-xs text-gray-500 uppercase tracking-wider">{label}</span>
      <span className={`text-3xl font-bold tabular-nums ${color || "text-white"}`}>{value}</span>
      {sub && <span className="text-xs text-gray-600">{sub}</span>}
    </div>
  );
}

function PendingTaskRow({ task, onClick }: { task: Task; onClick: () => void }) {
  const displayName = generateDisplayName(task);
  const statusColor: Record<string, string> = {
    pending: "text-yellow-400",
    assigned: "text-indigo-400",
    blocked: "text-purple-300",
  };
  return (
    <div className="flex items-center gap-3 py-1.5 border-b border-gray-800/50 last:border-0 cursor-pointer hover:bg-gray-800/30 transition-colors rounded px-1" onClick={onClick}>
      <span className={`text-xs font-semibold ${statusColor[task.status] || "text-gray-400"}`}>
        {taskStatusLabel(task)}
      </span>
      <span className="text-gray-500 text-xs font-mono shrink-0">#{task.seq}</span>
      <span className="text-sm text-gray-300 truncate flex-1" title={displayName}>{displayName}</span>
      {task.requirements?.gpu_mem_mb && (
        <span className="text-xs text-gray-600 shrink-0">{Math.round(task.requirements.gpu_mem_mb / 1024)}G</span>
      )}
      <span className="text-xs text-gray-600 shrink-0">{formatRelTime(task.created_at)}</span>
    </div>
  );
}

function RecentTaskRow({ task, onClick }: { task: Task; onClick: () => void }) {
  const displayName = generateDisplayName(task);
  const statusColors = TASK_STATUS_TEXT_CLASS;
  return (
    <div className="flex items-center gap-3 py-1.5 border-b border-gray-800/50 last:border-0 cursor-pointer hover:bg-gray-800/30 transition-colors rounded px-1" onClick={onClick}>
      <span className={`text-xs font-semibold ${statusColors[task.status] || "text-gray-400"}`}>
        {taskStatusLabel(task)}
      </span>
      <span className="text-gray-500 text-xs font-mono shrink-0">#{task.seq}</span>
      <span className="text-sm text-gray-300 truncate flex-1" title={displayName}>{displayName}</span>
      {task.exit_code !== undefined && task.status === "failed" && (
        <span className="text-xs text-red-500 font-mono shrink-0">exit={task.exit_code}</span>
      )}
      {task.finished_at && (
        <span className="text-xs text-gray-600 shrink-0">{formatRelTime(task.finished_at)}</span>
      )}
    </div>
  );
}

function taskTriageReason(task: Task): string {
  if (task.status === "blocked") {
    if (task.target_stub_id) return "waiting for target stub";
    if (task.requirements?.gpu_mem_mb || task.requirements?.gpu_type?.length) return "waiting for matching capacity";
    if ((task.dispatch_attempts ?? 0) > 0) return "dispatch attempts exhausted";
    return "scheduler blocked";
  }
  if (task.status === "failed") {
    if (task.death_cause === "oom" || task.exit_code === 137) return "oom";
    if (task.death_cause) return task.death_cause;
    return "failed";
  }
  return task.status;
}

function TaskTriageCard({ tasks, onTaskClick }: { tasks: Task[]; onTaskClick: (task: Task) => void }) {
  const running = tasks.filter((t) => t.status === "running").length;
  const assigned = tasks.filter((t) => t.status === "assigned").length;
  const pending = tasks.filter((t) => t.status === "pending").length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const failedRecent = tasks.filter((t) => t.status === "failed").length;
  const attentionTasks = tasks
    .filter((t) => t.status === "blocked" || t.status === "failed")
    .sort((a, b) => {
      const aTime = a.finished_at || a.created_at;
      const bTime = b.finished_at || b.created_at;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    })
    .slice(0, 4);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-300">Task Triage</h3>
        <span className="text-xs text-gray-600">active + recent failures</span>
      </div>
      <div className="flex flex-wrap gap-2 mb-3">
        <span className="text-xs px-2 py-0.5 rounded border border-blue-700/50 bg-blue-900/30 text-blue-300">running {running}</span>
        <span className="text-xs px-2 py-0.5 rounded border border-indigo-700/50 bg-indigo-900/30 text-indigo-300">assigned {assigned}</span>
        <span className="text-xs px-2 py-0.5 rounded border border-yellow-700/50 bg-yellow-900/30 text-yellow-300">pending {pending}</span>
        <span className="text-xs px-2 py-0.5 rounded border border-purple-700/50 bg-purple-900/30 text-purple-300">blocked {blocked}</span>
        <span className="text-xs px-2 py-0.5 rounded border border-red-700/50 bg-red-900/30 text-red-300">failed recent {failedRecent}</span>
      </div>
      {attentionTasks.length > 0 ? (
        <div className="divide-y divide-gray-800/50">
          {attentionTasks.map((task) => (
            <button
              key={task.id}
              type="button"
              onClick={() => onTaskClick(task)}
              className="w-full flex items-center gap-3 py-1.5 text-left hover:bg-gray-800/30 rounded px-1 transition-colors"
            >
              <span className="text-gray-500 text-xs font-mono shrink-0">#{task.seq} {generateDisplayName(task)}</span>
              <span className="text-xs text-gray-500 shrink-0">{task.status}</span>
              <span className="text-xs text-purple-300 truncate">{taskTriageReason(task)}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-600">No blocked or failed tasks need attention.</p>
      )}
    </div>
  );
}

type CostRange = "7d" | "30d" | "all";

function CostWidget() {
  const [range, setRange] = useState<CostRange>("7d");
  const [cost, setCost] = useState<CostSummary | null>(null);

  useEffect(() => {
    setCost(null);
    const params: { from?: string } = {};
    if (range === "7d") params.from = new Date(Date.now() - 7 * 86400_000).toISOString();
    else if (range === "30d") params.from = new Date(Date.now() - 30 * 86400_000).toISOString();
    costApi.summary(params).then(setCost).catch((err) => {
      console.error("Failed to fetch cost summary:", err);
      setCost(null);
    });
  }, [range]);

  const TUITION_USD = 15000;
  const roi = cost && cost.total_cost_usd > 0
    ? Math.round((cost.total_cost_usd / TUITION_USD) * 100)
    : 0;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-300">GPU Cost</h3>
        <div className="flex gap-1">
          {(["7d", "30d", "all"] as CostRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${
                range === r
                  ? "bg-gray-700 text-white"
                  : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {r === "all" ? "All" : r}
            </button>
          ))}
        </div>
      </div>
      {cost ? (
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-xs text-gray-500">GPU-Hours</div>
            <div className="text-lg font-bold text-blue-400 tabular-nums">{cost.total_gpu_hours.toFixed(1)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Est. Cost</div>
            <div className="text-lg font-bold text-green-400 tabular-nums">${cost.total_cost_usd.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Utilization</div>
            <div className="text-lg font-bold text-yellow-400 tabular-nums">{cost.utilization_pct.toFixed(1)}%</div>
          </div>
        </div>
      ) : (
        <div className="text-gray-600 text-sm">Loading...</div>
      )}
      {cost && roi > 0 && (
        <div className="text-xs text-gray-600 mt-2 text-right">
          Tuition ROI: {roi}%
        </div>
      )}
    </div>
  );
}

export default function Dashboard({ stubs, globalQueue, lossHistory, logBuffers, onTaskUpdate }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [offlineOpen, setOfflineOpen] = useState(false);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [tunnel, setTunnel] = useState<TunnelStatus | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    overviewApi.get().then(setOverview).catch(() => {});
    const t = setInterval(() => overviewApi.get().then(setOverview).catch(() => {}), 10000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    deployApi.tunnelStatus().then(setTunnel).catch(() => {});
    const t = setInterval(() => deployApi.tunnelStatus().then(setTunnel).catch(() => {}), 30000);
    return () => clearInterval(t);
  }, []);

  const onlineStubs = stubs.filter((s) => s.status === "online");
  const offlineStubs = stubs.filter((s) => s.status !== "online");

  const totalRunning = stubs.reduce((n, s) => n + s.tasks.filter((t) => t.status === "running").length, 0);
  const totalAssigned = stubs.reduce((n, s) => n + s.tasks.filter((t) => t.status === "assigned").length, 0);
  const totalPaused = stubs.reduce((n, s) => n + s.tasks.filter((t) => t.status === "paused").length, 0);
  const globalPending = globalQueue.filter((t) => t.status === "pending" || t.status === "blocked");

  let totalVram = 0, usedVram = 0;
  for (const s of onlineStubs) {
    if (!s.gpu_stats?.gpus) continue;
    for (const g of s.gpu_stats.gpus) {
      totalVram += g.memory_total_mb;
      usedVram += g.memory_used_mb;
    }
  }
  const vramPct = totalVram > 0 ? Math.round((usedVram / totalVram) * 100) : 0;

  // Recent terminal tasks from stubs
  const recentTasks = stubs
    .flatMap((s) => s.tasks.filter((t) => isTerminalTaskStatus(t.status)))
    .sort((a, b) => {
      const aTime = a.finished_at || a.created_at;
      const bTime = b.finished_at || b.created_at;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    })
    .slice(0, 20);
  const triageTasks = [...globalQueue, ...stubs.flatMap((s) => s.tasks)];

  return (
    <div className="space-y-6">
      {/* Stat tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatTile
          label="Online"
          value={onlineStubs.length}
          sub={`of ${stubs.length} stubs`}
          color="text-green-400"
        />
        <StatTile
          label="Running"
          value={totalRunning}
          color={totalRunning > 0 ? "text-blue-400" : "text-gray-500"}
        />
        <StatTile
          label="Queued"
          value={totalAssigned + globalPending.length}
          sub={globalPending.length > 0 ? `${globalPending.length} global` : undefined}
          color="text-yellow-400"
        />
        <StatTile
          label="Paused"
          value={totalPaused}
          color={totalPaused > 0 ? "text-orange-400" : "text-gray-500"}
        />
        <StatTile
          label="VRAM"
          value={`${vramPct}%`}
          sub={totalVram > 0 ? `${Math.round(usedVram / 1024)}/${Math.round(totalVram / 1024)}G` : undefined}
          color={vramPct > 90 ? "text-red-400" : vramPct > 70 ? "text-yellow-400" : "text-blue-400"}
        />
        <StatTile
          label="Grids"
          value={overview?.grids.running ?? "—"}
          sub={overview ? `${overview.grids.total} total` : undefined}
          color="text-purple-400"
        />
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-1">
          <span className="text-xs text-gray-500 uppercase tracking-wider">Tunnel</span>
          {tunnel === null ? (
            <span className="text-gray-700 text-sm">—</span>
          ) : (
            <div className="flex items-center gap-1.5">
              <div className={`w-2 h-2 rounded-full shrink-0 ${tunnel.running ? "bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.6)]" : "bg-red-500"}`} />
              <span className={`text-sm font-semibold ${tunnel.running ? "text-green-400" : "text-red-400"}`}>
                {tunnel.running ? "✓ running" : "✗ down"}
              </span>
            </div>
          )}
          {tunnel?.running && tunnel.url && (
            <span className="text-xs text-gray-600 truncate" title={tunnel.url}>{tunnel.url}</span>
          )}
        </div>
      </div>

      {/* Cost widget */}
      <CostWidget />

      <TaskTriageCard tasks={triageTasks} onTaskClick={(task) => navigate(`/tasks/${task.id}`)} />

      {/* Top actions */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Stubs ({onlineStubs.length} online)
        </h2>
        <button
          onClick={() => setShowForm(true)}
          className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors font-medium"
        >
          + Submit Task
        </button>
      </div>

      {/* Online stubs grid */}
      {stubs.length === 0 ? (
        <div className="text-center py-24 text-gray-700">
          <div className="text-5xl mb-4">⚗️</div>
          <p className="text-lg font-medium text-gray-500">No stubs connected</p>
          <p className="text-sm mt-1 text-gray-700">Start a stub daemon to get started</p>
        </div>
      ) : (
        <>
          {onlineStubs.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {onlineStubs.map((stub) => (
                <StubCard
                  key={stub.id}
                  stub={stub}
                  lossHistory={lossHistory}
                  logBuffers={logBuffers}
                  onTaskUpdate={onTaskUpdate}
                />
              ))}
            </div>
          )}

          {/* Global queue */}
          {globalPending.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-300">
                  Global Queue
                  <span className="ml-2 bg-yellow-900/50 text-yellow-400 text-xs px-2 py-0.5 rounded-full">
                    {globalPending.length}
                  </span>
                </h3>
                <span className="text-xs text-gray-600">pending → scheduler → stub</span>
              </div>
              <div className="divide-y divide-gray-800/50">
                {globalPending.slice(0, 15).map((t) => (
                  <PendingTaskRow key={t.id} task={t} onClick={() => navigate(`/tasks/${t.id}`)} />
                ))}
                {globalPending.length > 15 && (
                  <p className="text-gray-600 text-xs pt-2">+{globalPending.length - 15} more</p>
                )}
              </div>
            </div>
          )}

          {/* Recent completed / failed */}
          {recentTasks.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-3">Recent Tasks</h3>
              <div className="divide-y divide-gray-800/50">
                {recentTasks.map((t) => (
                  <RecentTaskRow key={t.id} task={t} onClick={() => navigate(`/tasks/${t.id}`)} />
                ))}
              </div>
            </div>
          )}

          {/* Offline stubs */}
          {offlineStubs.length > 0 && (
            <div>
              <button
                onClick={() => setOfflineOpen((v) => !v)}
                className="text-sm text-gray-500 hover:text-white transition flex items-center gap-1.5 mb-3"
              >
                <span className="text-xs">{offlineOpen ? "▼" : "▶"}</span>
                Offline Stubs ({offlineStubs.length})
              </button>
              {offlineOpen && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {offlineStubs.map((stub) => (
                    <StubCard
                      key={stub.id}
                      stub={stub}
                      lossHistory={lossHistory}
                      logBuffers={logBuffers}
                      onTaskUpdate={onTaskUpdate}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {showForm && (
        <TaskForm
          stubs={stubs}
          onSubmit={onTaskUpdate}
          onClose={() => setShowForm(false)}
        />
      )}
    </div>
  );
}
