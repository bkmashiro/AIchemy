import { memo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Stub } from "../lib/api";
import { formatBytes, formatDuration } from "../lib/format";
import TaskRow from "./TaskRow";

function formatWalltime(seconds: number): string {
  return formatDuration(seconds * 1000);
}

interface Props {
  stub: Stub;
  lossHistory?: Map<string, number[]>;
  logBuffers?: Map<string, string[]>;
  onTaskUpdate?: () => void;
}

export default memo(function StubCard({ stub, lossHistory, logBuffers, onTaskUpdate }: Props) {
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();

  const running = stub.tasks.filter((t) => t.status === "running").length;
  const queued = stub.tasks.filter((t) => t.status === "queued" || t.status === "dispatched").length;
  const paused = stub.tasks.filter((t) => t.status === "paused").length;
  const failed = stub.tasks.filter((t) => t.status === "failed").length;

  const gpus = stub.gpu_stats?.gpus || [];
  const gpu0 = gpus[0];
  const utilPct = gpu0?.utilization_pct ?? 0;
  const totalVram = gpus.length > 0
    ? gpus.reduce((n, g) => n + g.memory_total_mb, 0)
    : stub.gpu.vram_total_mb * stub.gpu.count;
  const usedVram = gpus.reduce((n, g) => n + g.memory_used_mb, 0);
  const vramPct = totalVram > 0 ? Math.min(100, Math.round((usedVram / totalVram) * 100)) : 0;

  const sys = stub.system_stats;
  const cpuPct = sys?.cpu_pct ?? null;
  const memPct = sys && sys.mem_total_mb > 0
    ? Math.round((sys.mem_used_mb / sys.mem_total_mb) * 100)
    : null;

  const temp = gpu0?.temperature_c;
  const isOnline = stub.status === "online";

  const utilColor = utilPct > 80 ? "bg-green-500" : utilPct > 40 ? "bg-blue-500" : "bg-gray-600";
  const vramColor = vramPct > 90 ? "bg-red-500" : vramPct > 70 ? "bg-yellow-500" : "bg-purple-500";

  const activeTasks = stub.tasks.filter(
    (t) => !["completed", "failed", "killed", "lost"].includes(t.status)
  );
  const recentTasks = stub.tasks
    .filter((t) => ["completed", "failed", "killed", "lost"].includes(t.status))
    .slice(-5)
    .reverse();

  return (
    <div
      className={`bg-gray-900 rounded-xl border transition-all ${
        isOnline
          ? "border-gray-800 hover:border-blue-600/40"
          : "border-gray-800/50 opacity-70"
      }`}
    >
      {/* Card header — click name to go to detail, click expand toggle at bottom */}
      <div className="p-4">
        {/* Header: name + status dot */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div
            className="min-w-0 flex-1 cursor-pointer"
            onClick={() => navigate(`/stubs/${stub.id}`)}
          >
            <div className="flex items-center gap-1.5 mb-0.5">
              <div
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  isOnline
                    ? "bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]"
                    : "bg-gray-600"
                }`}
              />
              <h3 className="font-semibold text-white text-sm truncate hover:text-blue-400 transition-colors" title={stub.name}>
                {stub.name}
              </h3>
            </div>
            <p className="text-xs text-gray-500 truncate ml-3">{stub.hostname}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {stub.type === "slurm" && stub.slurm_job_id && (
              <span className="text-xs text-gray-600 font-mono">#{stub.slurm_job_id}</span>
            )}
            <span
              className={`text-xs px-2 py-0.5 rounded-full border ${
                isOnline
                  ? "text-green-400 bg-green-900/20 border-green-800/40"
                  : "text-gray-500 bg-gray-800/40 border-gray-700/40"
              }`}
            >
              {stub.status}
            </span>
          </div>
        </div>

        {/* GPU model + type badge */}
        <div className="text-xs text-gray-500 mb-3 flex items-center justify-between">
          <span className="truncate">
            {stub.gpu.name}
            {stub.gpu.count > 1 && <span className="text-gray-600"> ×{stub.gpu.count}</span>}
            <span className="text-gray-600 ml-1">
              {formatBytes(stub.gpu.vram_total_mb * stub.gpu.count)}
            </span>
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`text-xs px-1.5 py-0.5 rounded border ${
              stub.type === "slurm"
                ? "text-blue-400 bg-blue-900/20 border-blue-800/40"
                : "text-teal-400 bg-teal-900/20 border-teal-800/40"
            }`}>
              {stub.type}
            </span>
            {temp !== undefined && (
              <span
                className={`font-mono ${
                  temp > 80 ? "text-red-400" : temp > 65 ? "text-yellow-400" : "text-gray-600"
                }`}
              >
                {temp}°C
              </span>
            )}
          </div>
        </div>

        {/* SLURM walltime remaining */}
        {stub.type === "slurm" && stub.walltime_remaining_s !== undefined && (
          <div className="mb-2 text-xs flex items-center gap-1.5">
            <span className="text-gray-600">walltime</span>
            <span className={stub.walltime_remaining_s < 600 ? "text-orange-400 font-mono" : "text-gray-500 font-mono"}>
              {formatWalltime(stub.walltime_remaining_s)}
            </span>
            {stub.walltime_remaining_s < 600 && (
              <span className="text-orange-400">⚠</span>
            )}
          </div>
        )}

        {/* Tags */}
        {stub.tags && stub.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {stub.tags.map((tag) => (
              <span key={tag} className="text-xs bg-gray-800 text-gray-400 rounded px-1.5 py-0.5 font-mono">
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Resource bars */}
        <div className="space-y-2">
          {/* GPU util */}
          <div>
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>GPU</span>
              <span className={utilPct > 50 ? "text-green-400" : "text-gray-500"}>{utilPct}%</span>
            </div>
            <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className={`h-full ${utilColor} rounded-full transition-all`}
                style={{ width: `${utilPct}%` }}
              />
            </div>
          </div>

          {/* VRAM */}
          {gpus.length > 1 ? (
            <div>
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>VRAM ({gpus.length}×)</span>
                <span className={vramPct > 80 ? "text-red-400" : "text-gray-500"}>
                  {formatBytes(usedVram)}/{formatBytes(totalVram)}
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
                  {formatBytes(usedVram)}/{formatBytes(totalVram)}
                </span>
              </div>
              <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={`h-full ${vramColor} rounded-full transition-all`}
                  style={{ width: `${vramPct}%` }}
                />
              </div>
            </div>
          )}

          {/* CPU */}
          {cpuPct !== null && (
            <div>
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>CPU</span>
                <span>{cpuPct}%</span>
              </div>
              <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={`h-full ${cpuPct > 90 ? "bg-red-500" : cpuPct > 70 ? "bg-yellow-500" : "bg-cyan-600"} rounded-full transition-all`}
                  style={{ width: `${cpuPct}%` }}
                />
              </div>
            </div>
          )}

          {/* MEM */}
          {memPct !== null && sys && (
            <div>
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>MEM</span>
                <span className={memPct > 90 ? "text-red-400" : "text-gray-500"}>
                  {formatBytes(sys.mem_used_mb)}/{formatBytes(sys.mem_total_mb)}
                </span>
              </div>
              <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={`h-full ${memPct > 90 ? "bg-red-500" : memPct > 75 ? "bg-yellow-500" : "bg-teal-600"} rounded-full transition-all`}
                  style={{ width: `${memPct}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Task counters */}
        <div
          className="mt-3 pt-3 border-t border-gray-800 flex items-center gap-3 text-xs cursor-pointer hover:bg-gray-800/20 rounded transition-colors px-1 -mx-1"
          onClick={() => setExpanded((v) => !v)}
        >
          {running > 0 && <span className="text-blue-400">{running} running</span>}
          {queued > 0 && <span className="text-yellow-400">{queued} queued</span>}
          {paused > 0 && <span className="text-orange-400">{paused} paused</span>}
          {failed > 0 && <span className="text-red-400">{failed} failed</span>}
          {running === 0 && queued === 0 && paused === 0 && failed === 0 && (
            <span className="text-gray-600">idle</span>
          )}
          <span className="ml-auto text-gray-600">{stub.max_concurrent} slots</span>
          <span className="text-gray-700">{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {/* Expanded: task list */}
      {expanded && (
        <div className="border-t border-gray-800 px-3 py-3 space-y-2">
          {activeTasks.length === 0 && recentTasks.length === 0 ? (
            <p className="text-xs text-gray-600 text-center py-2">No tasks</p>
          ) : (
            <>
              {activeTasks.length > 0 && (
                <>
                  <p className="text-xs text-gray-600 uppercase tracking-wider">Active</p>
                  <div className="space-y-1.5">
                    {activeTasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        stubName={stub.name}
                        lossHistory={lossHistory?.get(task.id)}
                        liveLogLines={logBuffers?.get(task.id)}
                        onUpdate={onTaskUpdate}
                        compact
                      />
                    ))}
                  </div>
                </>
              )}
              {recentTasks.length > 0 && (
                <>
                  <p className="text-xs text-gray-600 uppercase tracking-wider mt-3">Recent</p>
                  <div className="space-y-1.5">
                    {recentTasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        stubName={stub.name}
                        lossHistory={lossHistory?.get(task.id)}
                        liveLogLines={logBuffers?.get(task.id)}
                        onUpdate={onTaskUpdate}
                        compact
                      />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});
