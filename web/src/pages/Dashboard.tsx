import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Stub, Task, overviewApi, OverviewData } from "../lib/api";
import { formatRelTime, generateDisplayName } from "../lib/format";
import StubCard from "../components/StubCard";
import TaskForm from "../components/TaskForm";

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
    queued: "text-yellow-400",
    dispatched: "text-indigo-400",
  };
  return (
    <div className="flex items-center gap-3 py-1.5 border-b border-gray-800/50 last:border-0 cursor-pointer hover:bg-gray-800/30 transition-colors rounded px-1" onClick={onClick}>
      <span className={`text-xs font-semibold ${statusColor[task.status] || "text-gray-400"}`}>
        {task.status.toUpperCase()}
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
  const statusColors: Record<string, string> = {
    completed: "text-green-400",
    failed: "text-red-400",
    killed: "text-gray-500",
    lost: "text-orange-400",
  };
  return (
    <div className="flex items-center gap-3 py-1.5 border-b border-gray-800/50 last:border-0 cursor-pointer hover:bg-gray-800/30 transition-colors rounded px-1" onClick={onClick}>
      <span className={`text-xs font-semibold ${statusColors[task.status] || "text-gray-400"}`}>
        {task.status.toUpperCase()}
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

export default function Dashboard({ stubs, globalQueue, lossHistory, logBuffers, onTaskUpdate }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [offlineOpen, setOfflineOpen] = useState(false);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    overviewApi.get().then(setOverview).catch(() => {});
    const t = setInterval(() => overviewApi.get().then(setOverview).catch(() => {}), 10000);
    return () => clearInterval(t);
  }, []);

  const onlineStubs = stubs.filter((s) => s.status === "online");
  const offlineStubs = stubs.filter((s) => s.status !== "online");

  const totalRunning = stubs.reduce((n, s) => n + s.tasks.filter((t) => t.status === "running").length, 0);
  const totalQueued = stubs.reduce((n, s) => n + s.tasks.filter((t) => ["queued", "dispatched"].includes(t.status)).length, 0);
  const totalPaused = stubs.reduce((n, s) => n + s.tasks.filter((t) => t.status === "paused").length, 0);
  const globalPending = globalQueue.filter((t) => ["pending", "queued"].includes(t.status));

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
    .flatMap((s) => s.tasks.filter((t) => ["completed", "failed", "killed", "lost"].includes(t.status)))
    .sort((a, b) => {
      const aTime = a.finished_at || a.created_at;
      const bTime = b.finished_at || b.created_at;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    })
    .slice(0, 20);

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
          value={totalQueued + globalPending.length}
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
      </div>

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
