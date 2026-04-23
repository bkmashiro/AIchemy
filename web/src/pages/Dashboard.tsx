import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Stub, Task, stubsApi, overviewApi, OverviewData } from "../lib/api";
import StubCard from "../components/StubCard";

interface Props {
  stubs: Stub[];
  globalQueue: Task[];
}

function StatTile({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: number | string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-1">
      <span className="text-xs text-gray-500 uppercase tracking-wider">{label}</span>
      <span className={`text-3xl font-bold tabular-nums ${color || "text-white"}`}>{value}</span>
      {sub && <span className="text-xs text-gray-600">{sub}</span>}
    </div>
  );
}

function GpuMiniBar({ used, total, label }: { used: number; total: number; label: string }) {
  const pct = total > 0 ? Math.round((used / total) * 100) : 0;
  const color = pct > 90 ? "bg-red-500" : pct > 70 ? "bg-yellow-500" : "bg-blue-500";
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 w-20 truncate">{label}</span>
      <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-400 w-10 text-right">{pct}%</span>
    </div>
  );
}

export default function Dashboard({ stubs, globalQueue }: Props) {
  const [offlineOpen, setOfflineOpen] = useState(false);
  const [purging, setPurging] = useState(false);
  const [overview, setOverview] = useState<OverviewData | null>(null);

  useEffect(() => {
    overviewApi.get().then(setOverview).catch(() => {});
    const t = setInterval(() => overviewApi.get().then(setOverview).catch(() => {}), 10000);
    return () => clearInterval(t);
  }, []);

  const onlineStubs = stubs.filter((s) => s.status === "online");
  const offlineStubs = stubs.filter((s) => s.status !== "online");

  const totalRunning = stubs.reduce((acc, s) => acc + s.tasks.filter((t) => t.status === "running").length, 0);
  const stubQueued = stubs.reduce((acc, s) => acc + s.tasks.filter((t) => t.status === "queued").length, 0);
  const totalPaused = stubs.reduce((acc, s) => acc + s.tasks.filter((t) => t.status === "paused").length, 0);
  const globalCount = globalQueue.filter((t) => t.status === "queued" || t.status === "waiting").length;
  const totalQueued = stubQueued + globalCount;

  // Aggregate GPU stats from live data
  let totalVram = 0;
  let usedVram = 0;
  for (const s of onlineStubs) {
    if (!s.gpu_stats?.gpus) continue;
    for (const g of s.gpu_stats.gpus) {
      totalVram += g.memory_total_mb;
      usedVram += g.memory_used_mb;
    }
  }
  const vramPct = totalVram > 0 ? Math.round((usedVram / totalVram) * 100) : 0;

  const handlePurge = async () => {
    if (!confirm("Purge all offline stubs with no active tasks? This cannot be undone.")) return;
    setPurging(true);
    try {
      await stubsApi.purgeOffline();
    } catch (err) {
      console.error(err);
    } finally {
      setPurging(false);
    }
  };

  // Stubs with walltime warnings
  const walltimeWarnings = onlineStubs.filter(
    (s) => s.remaining_walltime_s !== undefined && s.remaining_walltime_s < 3600
  );

  return (
    <div className="space-y-6">
      {/* Walltime warnings */}
      {walltimeWarnings.length > 0 && (
        <div className="flex flex-col gap-2">
          {walltimeWarnings.map((s) => (
            <div key={s.id} className="flex items-center gap-3 bg-yellow-900/20 border border-yellow-700/50 rounded-lg px-4 py-2.5 text-sm">
              <span className="text-yellow-400">⚠</span>
              <span className="text-yellow-200">
                <Link to={`/stubs/${s.id}`} className="font-semibold hover:underline">{s.name}</Link>
                {" "}walltime expiring in{" "}
                <span className="font-mono font-bold">{Math.round(s.remaining_walltime_s! / 60)}m</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Stat tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatTile label="Online" value={onlineStubs.length} sub={`of ${stubs.length} stubs`} color="text-green-400" />
        <StatTile label="Running" value={totalRunning} color={totalRunning > 0 ? "text-green-400" : "text-gray-500"} />
        <StatTile label="Queued" value={totalQueued} sub={globalCount > 0 ? `${globalCount} global` : undefined} color="text-yellow-400" />
        <StatTile label="Paused" value={totalPaused} color={totalPaused > 0 ? "text-orange-400" : "text-gray-500"} />
        <StatTile
          label="VRAM"
          value={`${vramPct}%`}
          sub={`${Math.round(usedVram / 1024)}/${Math.round(totalVram / 1024)} GB`}
          color={vramPct > 90 ? "text-red-400" : vramPct > 70 ? "text-yellow-400" : "text-blue-400"}
        />
        <StatTile
          label="Grids"
          value={overview?.grids.running ?? "—"}
          sub={overview ? `${overview.grids.total} total` : undefined}
          color="text-purple-400"
        />
      </div>

      {/* GPU VRAM per stub */}
      {onlineStubs.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">VRAM Usage per Stub</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-2">
            {onlineStubs.map((s) => {
              if (!s.gpu_stats?.gpus || s.gpu_stats.gpus.length === 0) return null;
              const used = s.gpu_stats.gpus.reduce((n, g) => n + g.memory_used_mb, 0);
              const total = s.gpu_stats.gpus.reduce((n, g) => n + g.memory_total_mb, 0);
              return <GpuMiniBar key={s.id} used={used} total={total} label={s.name} />;
            })}
          </div>
        </div>
      )}

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
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                  Online Stubs ({onlineStubs.length})
                </h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {onlineStubs.map((stub) => (
                  <StubCard key={stub.id} stub={stub} />
                ))}
              </div>
            </>
          )}

          {/* Global queue summary */}
          {globalQueue.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-300">
                  Global Queue
                  <span className="ml-2 bg-yellow-900/50 text-yellow-400 text-xs px-2 py-0.5 rounded-full">
                    {globalQueue.length}
                  </span>
                </h3>
                <Link to="/tasks?filter=global" className="text-xs text-blue-400 hover:underline">
                  View all →
                </Link>
              </div>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {globalQueue.slice(0, 10).map((t) => (
                  <div key={t.id} className="flex items-center gap-2 text-xs">
                    <StatusDot status={t.status} />
                    <span className="text-gray-400 font-mono truncate flex-1">{t.command}</span>
                    <span className="text-gray-600 shrink-0">
                      {t.estimated_vram_mb ? `${t.estimated_vram_mb}MB` : ""}
                    </span>
                  </div>
                ))}
                {globalQueue.length > 10 && (
                  <p className="text-gray-600 text-xs">+{globalQueue.length - 10} more</p>
                )}
              </div>
            </div>
          )}

          {/* Offline stubs collapsible */}
          {offlineStubs.length > 0 && (
            <div>
              <div className="flex items-center gap-3 mb-3">
                <button
                  onClick={() => setOfflineOpen((v) => !v)}
                  className="text-sm text-gray-500 hover:text-white transition flex items-center gap-1.5"
                >
                  <span className="text-xs">{offlineOpen ? "▼" : "▶"}</span>
                  Offline / Stale Stubs ({offlineStubs.length})
                </button>
                <button
                  onClick={handlePurge}
                  disabled={purging}
                  className="px-2.5 py-1 text-xs bg-gray-800 hover:bg-red-900/50 border border-gray-700 hover:border-red-700 rounded text-gray-400 hover:text-red-300 disabled:opacity-50 transition-colors"
                >
                  {purging ? "Purging..." : "Purge Offline"}
                </button>
              </div>
              {offlineOpen && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {offlineStubs.map((stub) => (
                    <StubCard key={stub.id} stub={stub} />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color: Record<string, string> = {
    queued: "bg-yellow-400",
    waiting: "bg-cyan-400",
    running: "bg-green-400",
    paused: "bg-orange-400",
    failed: "bg-red-500",
    killed: "bg-gray-500",
    completed: "bg-blue-400",
  };
  return (
    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${color[status] || "bg-gray-600"}`} />
  );
}
