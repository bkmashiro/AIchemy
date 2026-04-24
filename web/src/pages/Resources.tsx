import { Stub, Task } from "../lib/api";
import { formatBytes, formatRelTime, formatDuration } from "../lib/format";

interface Props {
  stubs: Stub[];
  globalQueue: Task[];
  connected: boolean;
}

function UtilBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className="text-xs text-gray-400 tabular-nums w-8 text-right">{Math.round(pct)}%</span>
    </div>
  );
}

function StubResourceRow({ stub }: { stub: Stub }) {
  const isOnline = stub.status === "online";
  const gpus = stub.gpu_stats?.gpus || [];

  const totalVram = gpus.length > 0
    ? gpus.reduce((n, g) => n + g.memory_total_mb, 0)
    : stub.gpu.vram_total_mb * stub.gpu.count;
  const usedVram = gpus.reduce((n, g) => n + g.memory_used_mb, 0);
  const avgUtil = gpus.length > 0
    ? Math.round(gpus.reduce((n, g) => n + g.utilization_pct, 0) / gpus.length)
    : 0;
  const vramPct = totalVram > 0 ? Math.round((usedVram / totalVram) * 100) : 0;

  const sys = stub.system_stats;
  const cpuPct = sys?.cpu_pct ?? null;
  const memPct = sys && sys.mem_total_mb > 0
    ? Math.round((sys.mem_used_mb / sys.mem_total_mb) * 100)
    : null;

  const running = stub.tasks.filter((t) => t.status === "running").length;
  const queued = stub.tasks.filter((t) => ["queued", "dispatched"].includes(t.status)).length;

  const utilColor = avgUtil > 80 ? "bg-green-500" : avgUtil > 40 ? "bg-blue-500" : "bg-gray-600";
  const vramColor = vramPct > 90 ? "bg-red-500" : vramPct > 70 ? "bg-yellow-500" : "bg-purple-500";

  return (
    <div className={`bg-gray-900 border rounded-xl p-4 ${isOnline ? "border-gray-800" : "border-gray-800/50 opacity-60"}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isOnline ? "bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.4)]" : "bg-gray-600"}`} />
          <span className="font-semibold text-sm text-white truncate">{stub.name}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0 text-xs text-gray-600">
          {running > 0 && <span className="text-blue-400">{running}r</span>}
          {queued > 0 && <span className="text-yellow-400">{queued}q</span>}
          <span className="text-gray-700">/{stub.max_concurrent}</span>
        </div>
      </div>

      {/* GPU model + type */}
      <p className="text-xs text-gray-500 mb-1">
        {stub.gpu.name}
        {stub.gpu.count > 1 && <span className="text-gray-600"> ×{stub.gpu.count}</span>}
        <span className="text-gray-600 ml-1">{formatBytes(stub.gpu.vram_total_mb * stub.gpu.count)}</span>
        <span className={`ml-2 px-1.5 py-0.5 rounded text-xs border ${
          stub.type === "slurm"
            ? "text-blue-400 bg-blue-900/20 border-blue-800/40"
            : "text-teal-400 bg-teal-900/20 border-teal-800/40"
        }`}>{stub.type}</span>
      </p>

      {/* SLURM walltime */}
      {stub.type === "slurm" && stub.walltime_remaining_s !== undefined && (
        <p className={`text-xs mb-2 ${stub.walltime_remaining_s < 600 ? "text-orange-400" : "text-gray-600"}`}>
          walltime: {formatDuration(stub.walltime_remaining_s * 1000)}
          {stub.walltime_remaining_s < 600 && " ⚠"}
        </p>
      )}

      {/* Tags */}
      {stub.tags && stub.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {stub.tags.map((tag) => (
            <span key={tag} className="text-xs bg-gray-800 text-gray-500 rounded px-1.5 py-0.5 font-mono">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Resource bars */}
      <div className="space-y-2.5">
        <div>
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>GPU util</span>
            <span className={avgUtil > 50 ? "text-green-400" : "text-gray-500"}>{avgUtil}%</span>
          </div>
          <UtilBar pct={avgUtil} color={utilColor} />
        </div>
        <div>
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>VRAM</span>
            <span className={vramPct > 80 ? "text-red-400" : "text-gray-500"}>
              {formatBytes(usedVram)}/{formatBytes(totalVram)}
            </span>
          </div>
          <UtilBar pct={vramPct} color={vramColor} />
        </div>
        {cpuPct !== null && (
          <div>
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>CPU</span>
              <span>{cpuPct}%</span>
            </div>
            <UtilBar
              pct={cpuPct}
              color={cpuPct > 90 ? "bg-red-500" : cpuPct > 70 ? "bg-yellow-500" : "bg-cyan-600"}
            />
          </div>
        )}
        {memPct !== null && sys && (
          <div>
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>MEM</span>
              <span className={memPct > 90 ? "text-red-400" : "text-gray-500"}>
                {formatBytes(sys.mem_used_mb)}/{formatBytes(sys.mem_total_mb)}
              </span>
            </div>
            <UtilBar
              pct={memPct}
              color={memPct > 90 ? "bg-red-500" : memPct > 75 ? "bg-yellow-500" : "bg-teal-600"}
            />
          </div>
        )}
      </div>

      {/* Multi-GPU breakdown */}
      {gpus.length > 1 && (
        <div className="mt-3 pt-3 border-t border-gray-800">
          <p className="text-xs text-gray-600 mb-2">Per-GPU</p>
          <div className="space-y-1.5">
            {gpus.map((g, i) => {
              const p = g.memory_total_mb > 0
                ? Math.round((g.memory_used_mb / g.memory_total_mb) * 100)
                : 0;
              return (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="text-gray-600 w-5 text-right shrink-0">G{g.index}</span>
                  <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${g.utilization_pct > 80 ? "bg-green-500" : "bg-blue-500"} rounded-full`}
                      style={{ width: `${g.utilization_pct}%` }}
                    />
                  </div>
                  <span className="text-gray-500 w-7 text-right shrink-0">{g.utilization_pct}%</span>
                  <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${p > 90 ? "bg-red-500" : "bg-purple-500"} rounded-full`}
                      style={{ width: `${p}%` }}
                    />
                  </div>
                  <span className="text-gray-500 w-7 text-right shrink-0">{p}%</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Last heartbeat */}
      {!isOnline && (
        <p className="text-xs text-gray-700 mt-3">
          Last seen {formatRelTime(stub.last_heartbeat)}
        </p>
      )}
    </div>
  );
}

export default function Resources({ stubs, globalQueue, connected }: Props) {
  const onlineStubs = stubs.filter((s) => s.status === "online");
  const offlineStubs = stubs.filter((s) => s.status !== "online");

  // Aggregate totals
  let totalVram = 0, usedVram = 0, totalGpu = 0;
  let weightedUtil = 0;
  for (const s of onlineStubs) {
    const gpus = s.gpu_stats?.gpus || [];
    if (gpus.length > 0) {
      for (const g of gpus) {
        totalVram += g.memory_total_mb;
        usedVram += g.memory_used_mb;
        weightedUtil += g.utilization_pct;
        totalGpu++;
      }
    } else {
      totalVram += s.gpu.vram_total_mb * s.gpu.count;
    }
  }
  const avgUtil = totalGpu > 0 ? Math.round(weightedUtil / totalGpu) : 0;
  const vramPct = totalVram > 0 ? Math.round((usedVram / totalVram) * 100) : 0;

  const globalPending = globalQueue.filter((t) => ["pending", "queued"].includes(t.status));
  const totalRunning = stubs.reduce((n, s) => n + s.tasks.filter((t) => t.status === "running").length, 0);
  const totalSlots = stubs.reduce((n, s) => n + s.max_concurrent, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">Resources</h1>
        <div className="flex items-center gap-1.5">
          <div className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-400" : "bg-red-500"}`} />
          <span className="text-xs text-gray-500">{connected ? "Live" : "Offline"}</span>
        </div>
      </div>

      {/* Aggregate stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Stubs</p>
          <p className="text-3xl font-bold text-green-400 tabular-nums">{onlineStubs.length}</p>
          <p className="text-xs text-gray-600">{offlineStubs.length} offline</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">GPU Util</p>
          <p className="text-3xl font-bold tabular-nums text-blue-400">{avgUtil}%</p>
          <p className="text-xs text-gray-600">{totalGpu} GPU(s)</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">VRAM</p>
          <p className={`text-3xl font-bold tabular-nums ${vramPct > 90 ? "text-red-400" : vramPct > 70 ? "text-yellow-400" : "text-purple-400"}`}>
            {vramPct}%
          </p>
          <p className="text-xs text-gray-600">
            {formatBytes(usedVram)}/{formatBytes(totalVram)}
          </p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Queue</p>
          <p className="text-3xl font-bold tabular-nums text-yellow-400">
            {globalPending.length}
          </p>
          <p className="text-xs text-gray-600">
            {totalRunning}/{totalSlots} slots used
          </p>
        </div>
      </div>

      {/* Aggregate util bars */}
      {onlineStubs.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-4">GPU Util per Stub</h3>
          <div className="space-y-3">
            {onlineStubs.map((s) => {
              const gpus = s.gpu_stats?.gpus || [];
              const util = gpus.length > 0
                ? Math.round(gpus.reduce((n, g) => n + g.utilization_pct, 0) / gpus.length)
                : 0;
              const totalV = gpus.length > 0
                ? gpus.reduce((n, g) => n + g.memory_total_mb, 0)
                : s.gpu.vram_total_mb * s.gpu.count;
              const usedV = gpus.reduce((n, g) => n + g.memory_used_mb, 0);
              const vp = totalV > 0 ? Math.round((usedV / totalV) * 100) : 0;
              const running = s.tasks.filter((t) => t.status === "running").length;

              return (
                <div key={s.id} className="grid grid-cols-[160px_1fr_1fr_60px] gap-3 items-center">
                  <span className="text-sm text-gray-300 truncate">{s.name}</span>
                  <div>
                    <div className="text-xs text-gray-600 mb-0.5">GPU {util}%</div>
                    <UtilBar
                      pct={util}
                      color={util > 80 ? "bg-green-500" : util > 40 ? "bg-blue-500" : "bg-gray-600"}
                    />
                  </div>
                  <div>
                    <div className="text-xs text-gray-600 mb-0.5">
                      VRAM {formatBytes(usedV)}/{formatBytes(totalV)}
                    </div>
                    <UtilBar
                      pct={vp}
                      color={vp > 90 ? "bg-red-500" : vp > 70 ? "bg-yellow-500" : "bg-purple-500"}
                    />
                  </div>
                  <span className="text-xs text-gray-500 text-right">
                    {running}/{s.max_concurrent}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Per-stub cards grouped by type */}
      {onlineStubs.length > 0 && (() => {
        const slurmStubs = onlineStubs.filter((s) => s.type === "slurm");
        const workstationStubs = onlineStubs.filter((s) => s.type === "workstation");
        return (
          <div className="space-y-4">
            {slurmStubs.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-blue-400 uppercase tracking-wider mb-3">
                  SLURM ({slurmStubs.length})
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {slurmStubs.map((stub) => (
                    <StubResourceRow key={stub.id} stub={stub} />
                  ))}
                </div>
              </div>
            )}
            {workstationStubs.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-teal-400 uppercase tracking-wider mb-3">
                  Workstations ({workstationStubs.length})
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {workstationStubs.map((stub) => (
                    <StubResourceRow key={stub.id} stub={stub} />
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Global queue details */}
      {globalPending.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-300">
              Global Queue
              <span className="ml-2 bg-yellow-900/40 text-yellow-400 text-xs px-2 py-0.5 rounded-full">
                {globalPending.length}
              </span>
            </h3>
          </div>
          <div className="space-y-1.5">
            {globalPending.map((t) => (
              <div key={t.id} className="flex items-center gap-3 text-xs py-1 border-b border-gray-800/50 last:border-0">
                <span className="text-gray-500 font-mono shrink-0">#{t.seq}</span>
                <span className="text-yellow-400 font-semibold shrink-0">{t.status.toUpperCase()}</span>
                <span className="text-gray-300 truncate flex-1">{t.display_name}</span>
                {t.requirements?.gpu_mem_mb && (
                  <span className="text-gray-600 shrink-0">{Math.round(t.requirements.gpu_mem_mb / 1024)}G</span>
                )}
                {t.requirements?.gpu_type && (
                  <span className="text-gray-600 shrink-0">{t.requirements.gpu_type.join("/")}</span>
                )}
                <span className="text-gray-600 shrink-0">p={t.priority}</span>
                <span className="text-gray-700 shrink-0">{formatRelTime(t.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Offline stubs */}
      {offlineStubs.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
            Offline Stubs ({offlineStubs.length})
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {offlineStubs.map((stub) => (
              <StubResourceRow key={stub.id} stub={stub} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
