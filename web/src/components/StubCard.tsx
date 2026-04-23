import { memo } from "react";
import { Link } from "react-router-dom";
import { Stub } from "../lib/api";

interface Props {
  stub: Stub;
}

const statusConfig = {
  online: { dot: "bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]", badge: "text-green-400 bg-green-900/30 border-green-800/50" },
  offline: { dot: "bg-gray-600", badge: "text-gray-500 bg-gray-800/50 border-gray-700/50" },
  stale: { dot: "bg-yellow-400", badge: "text-yellow-400 bg-yellow-900/30 border-yellow-800/50" },
};

export default memo(function StubCard({ stub }: Props) {
  const running = stub.tasks.filter((t) => t.status === "running").length;
  const queued = stub.tasks.filter((t) => t.status === "queued" || t.status === "waiting").length;
  const paused = stub.tasks.filter((t) => t.status === "paused").length;
  const failed = stub.tasks.filter((t) => t.status === "failed").length;

  const gpus = stub.gpu_stats?.gpus || [];
  const gpu0 = gpus[0];
  const utilPct = gpu0?.utilization_pct ?? 0;
  const totalVram = gpus.reduce((n, g) => n + g.memory_total_mb, 0) || stub.gpu.vram_total_mb * stub.gpu.count;
  const usedVram = gpus.reduce((n, g) => n + g.memory_used_mb, 0);
  const vramPct = totalVram > 0 ? Math.round((usedVram / totalVram) * 100) : 0;

  const walltimeWarning = stub.remaining_walltime_s !== undefined && stub.remaining_walltime_s < 3600;
  const cfg = statusConfig[stub.status] || statusConfig.offline;

  const utilColor = utilPct > 80 ? "bg-green-500" : utilPct > 40 ? "bg-blue-500" : "bg-gray-600";
  const vramColor = vramPct > 90 ? "bg-red-500" : vramPct > 70 ? "bg-yellow-500" : "bg-purple-500";

  const temp = gpu0?.temperature_c;

  return (
    <Link to={`/stubs/${stub.id}`}>
      <div
        className={`bg-gray-900 rounded-xl p-4 border transition-all cursor-pointer group ${
          walltimeWarning
            ? "border-yellow-700/70 hover:border-yellow-500"
            : stub.status === "online"
            ? "border-gray-800 hover:border-blue-600/60"
            : "border-gray-800/50 hover:border-gray-700 opacity-75"
        }`}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-3 gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5">
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} />
              <h3
                className="font-semibold text-white truncate text-sm group-hover:text-blue-300 transition-colors"
                title={stub.name}
              >
                {stub.name}
              </h3>
            </div>
            <p className="text-xs text-gray-500 truncate ml-3">{stub.hostname}</p>
          </div>
          <span className={`text-xs px-2 py-0.5 rounded-full border shrink-0 ${cfg.badge}`}>
            {stub.status}
          </span>
        </div>

        {/* GPU info */}
        <div className="text-xs text-gray-500 mb-3 flex items-center justify-between">
          <span className="truncate">{stub.gpu.name} ×{stub.gpu.count}</span>
          {temp !== undefined && (
            <span className={`font-mono ${temp > 80 ? "text-red-400" : temp > 65 ? "text-yellow-400" : "text-gray-500"}`}>
              {temp}°C
            </span>
          )}
        </div>

        {/* Walltime warning */}
        {walltimeWarning && stub.remaining_walltime_s !== undefined && (
          <div className="flex items-center gap-1 text-xs text-yellow-400 bg-yellow-900/20 rounded px-2 py-1 mb-3">
            <span>⚠</span>
            <span>{Math.round(stub.remaining_walltime_s / 60)}m walltime</span>
          </div>
        )}

        {/* SLURM info */}
        {stub.type === "slurm" && stub.slurm_job_id && (
          <p className="text-xs text-gray-600 mb-2">
            SLURM #{stub.slurm_job_id}
            {stub.slurm?.partition && <span className="text-gray-700"> · {stub.slurm.partition}</span>}
          </p>
        )}

        {/* GPU bars */}
        <div className="space-y-2">
          <div>
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>GPU Util</span>
              <span className={utilPct > 50 ? "text-green-400" : "text-gray-500"}>{utilPct}%</span>
            </div>
            <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div className={`h-full ${utilColor} rounded-full transition-all`} style={{ width: `${utilPct}%` }} />
            </div>
          </div>

          {/* Per-GPU VRAM if multiple GPUs */}
          {gpus.length > 1 ? (
            <div>
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>VRAM ({gpus.length} GPUs)</span>
                <span className={vramPct > 80 ? "text-red-400" : "text-gray-500"}>
                  {Math.round(usedVram / 1024)}/{Math.round(totalVram / 1024)} GB
                </span>
              </div>
              <div className="flex gap-0.5">
                {gpus.map((g, i) => {
                  const p = Math.round((g.memory_used_mb / g.memory_total_mb) * 100);
                  return (
                    <div key={i} className="flex-1 h-1.5 bg-gray-800 rounded-sm overflow-hidden">
                      <div
                        className={`h-full ${p > 90 ? "bg-red-500" : p > 70 ? "bg-yellow-500" : "bg-purple-500"} transition-all`}
                        style={{ width: `${p}%` }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div>
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>VRAM</span>
                <span className={vramPct > 80 ? "text-red-400" : "text-gray-500"}>
                  {Math.round(usedVram / 1024)}/{Math.round(totalVram / 1024)} GB
                </span>
              </div>
              <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div className={`h-full ${vramColor} rounded-full transition-all`} style={{ width: `${vramPct}%` }} />
              </div>
            </div>
          )}
        </div>

        {/* Task counters */}
        <div className="mt-3 pt-3 border-t border-gray-800 flex items-center gap-3 text-xs">
          {running > 0 && <span className="text-green-400">{running} running</span>}
          {queued > 0 && <span className="text-yellow-400">{queued} queued</span>}
          {paused > 0 && <span className="text-orange-400">{paused} paused</span>}
          {failed > 0 && <span className="text-red-400">{failed} failed</span>}
          {running === 0 && queued === 0 && paused === 0 && failed === 0 && (
            <span className="text-gray-600">idle</span>
          )}
          <span className="ml-auto text-gray-600">{stub.max_concurrent} slots</span>
        </div>
      </div>
    </Link>
  );
});
