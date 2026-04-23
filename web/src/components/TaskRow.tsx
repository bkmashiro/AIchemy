import { memo, useState } from "react";
import { Task, tasksApi } from "../lib/api";
import LossSparkline from "./LossSparkline";

interface Props {
  task: Task;
  stubName?: string;
  onUpdate?: () => void;
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
  lossHistory?: number[];
  onClick?: () => void;
  compact?: boolean;
}

export const statusColor: Record<string, string> = {
  queued: "text-yellow-400",
  waiting: "text-cyan-400",
  dispatched: "text-indigo-400",
  running: "text-green-400",
  paused: "text-orange-400",
  completed: "text-blue-400",
  completed_with_errors: "text-amber-400",
  failed: "text-red-400",
  killed: "text-gray-500",
  interrupted: "text-rose-400",
  blocked: "text-gray-600",
  migrating: "text-violet-400",
};

export const statusBg: Record<string, string> = {
  queued: "bg-yellow-900/20 border-yellow-800/40",
  waiting: "bg-cyan-900/20 border-cyan-800/40",
  dispatched: "bg-indigo-900/20 border-indigo-800/40",
  running: "bg-green-900/20 border-green-800/40",
  paused: "bg-orange-900/20 border-orange-800/40",
  completed: "bg-blue-900/10 border-blue-900/30",
  completed_with_errors: "bg-amber-900/15 border-amber-900/30",
  failed: "bg-red-900/20 border-red-800/40",
  killed: "bg-gray-900/40 border-gray-800/40",
  interrupted: "bg-rose-900/20 border-rose-800/40",
  blocked: "bg-gray-900/30 border-gray-800/30",
  migrating: "bg-violet-900/20 border-violet-800/40",
};

function duration(task: Task): string {
  const start = task.started_at ? new Date(task.started_at).getTime() : null;
  const end = task.finished_at ? new Date(task.finished_at).getTime() : null;
  if (!start) return "-";
  const ms = Math.max(0, (end || Date.now()) - start);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

function formatEta(task: Task): string | null {
  if (!task.progress || !task.started_at) return null;
  const { step, total } = task.progress;
  if (step <= 0 || step >= total) return null;
  const elapsed = Date.now() - new Date(task.started_at).getTime();
  if (elapsed <= 0) return null;
  const speed = step / elapsed;
  const remainMs = (total - step) / speed;
  const remainMin = Math.floor(remainMs / 60000);
  if (remainMin >= 60) {
    const h = Math.floor(remainMin / 60);
    const m = remainMin % 60;
    return `ETA ${h}h${m}m`;
  }
  return `ETA ${remainMin}m`;
}

export default memo(function TaskRow({ task, stubName, onUpdate, selected, onSelect, lossHistory, onClick, compact }: Props) {
  const [acting, setActing] = useState(false);
  const progressPct = task.progress ? Math.round((task.progress.step / task.progress.total) * 100) : null;
  const isGlobal = !task.stub_id || task.stub_id === "";
  const eta = task.status === "running" ? formatEta(task) : null;

  const handleAction = async (action: "pause" | "resume" | "kill", e: React.MouseEvent) => {
    e.stopPropagation();
    if (action === "kill" && !confirm(`Kill task?\n${task.command.slice(0, 80)}`)) return;
    if (action === "pause" && !confirm(`Pause task?\n${task.command.slice(0, 80)}`)) return;
    setActing(true);
    try {
      if (isGlobal) {
        if (action === "kill") await tasksApi.batchKill([task.id]);
      } else {
        await tasksApi.action(task.stub_id, task.id, action);
      }
      onUpdate?.();
    } catch (err) {
      console.error(err);
    } finally {
      setActing(false);
    }
  };

  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setActing(true);
    try {
      await tasksApi.retry(task.id);
      onUpdate?.();
    } catch (err) {
      console.error(err);
    } finally {
      setActing(false);
    }
  };

  const bgClass = statusBg[task.status] || "bg-gray-900/40 border-gray-800/40";

  return (
    <div
      className={`rounded-lg border px-3 py-2.5 transition-colors ${bgClass} ${onClick ? "cursor-pointer hover:brightness-110" : ""} ${compact ? "py-2" : ""}`}
      onClick={onClick}
    >
      <div className="flex items-start gap-2.5">
        {onSelect && (
          <input
            type="checkbox"
            checked={selected || false}
            onChange={(e) => {
              e.stopPropagation();
              onSelect(e.target.checked);
            }}
            onClick={(e) => e.stopPropagation()}
            className="mt-1 accent-blue-500 shrink-0"
          />
        )}

        <div className="flex-1 min-w-0">
          {/* Top row: status + metadata */}
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={`text-xs font-semibold tracking-wide ${statusColor[task.status] || "text-gray-400"}`}>
              {task.status.toUpperCase().replace(/_/g, " ")}
            </span>
            {task.exit_code !== undefined && (
              <span className="text-xs text-gray-500 font-mono">exit={task.exit_code}</span>
            )}
            {task.retry_count !== undefined && task.retry_count > 0 && (
              <span className="text-xs text-gray-500">retry {task.retry_count}/{task.max_retries ?? "?"}</span>
            )}
            {task.pid && task.status === "running" && (
              <span className="text-xs text-gray-600 font-mono">pid={task.pid}</span>
            )}
            {stubName && (
              <span className="text-xs text-gray-600 ml-auto">{stubName}</span>
            )}
            <span className="text-xs text-gray-500 font-mono ml-auto">{duration(task)}</span>
          </div>

          {/* Command */}
          <p className={`font-mono truncate ${compact ? "text-xs" : "text-sm"} text-gray-200`} title={task.command}>
            {task.command}
          </p>

          {/* cwd + run_dir */}
          {!compact && (task.cwd || task.run_dir) && (
            <p className="text-xs text-gray-600 font-mono truncate mt-0.5">
              {task.run_dir || task.cwd}
            </p>
          )}

          {/* Progress */}
          {task.progress && (
            <div className="mt-2">
              <div className="flex items-center justify-between text-xs text-gray-400 mb-1 gap-2">
                <span className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono">
                    {task.progress.step.toLocaleString()}/{task.progress.total.toLocaleString()}
                  </span>
                  {task.progress.loss !== undefined && (
                    <span className="text-gray-300">loss={task.progress.loss.toFixed(4)}</span>
                  )}
                  {lossHistory && lossHistory.length >= 3 && (
                    <span className="inline-block align-middle">
                      <LossSparkline data={lossHistory} />
                    </span>
                  )}
                  {eta && <span className="text-cyan-400">{eta}</span>}
                  {task.progress.metrics && Object.entries(task.progress.metrics).slice(0, 2).map(([k, v]) => (
                    <span key={k} className="text-gray-500">{k}={typeof v === "number" ? v.toFixed(3) : v}</span>
                  ))}
                </span>
                <span className="font-mono shrink-0">{progressPct}%</span>
              </div>
              <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 rounded-full transition-all duration-500"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}

          {/* Dependencies */}
          {!compact && task.depends_on && task.depends_on.length > 0 && (
            <p className="text-xs text-gray-600 mt-1">
              depends on {task.depends_on.length} task{task.depends_on.length > 1 ? "s" : ""}
            </p>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex gap-1 shrink-0 mt-0.5" onClick={(e) => e.stopPropagation()}>
          {task.status === "running" && !isGlobal && (
            <button
              onClick={(e) => handleAction("pause", e)}
              disabled={acting}
              className="px-2 py-1 text-xs bg-orange-900/50 hover:bg-orange-800 border border-orange-800/50 rounded text-orange-300 disabled:opacity-50 transition-colors"
            >
              Pause
            </button>
          )}
          {task.status === "paused" && !isGlobal && (
            <button
              onClick={(e) => handleAction("resume", e)}
              disabled={acting}
              className="px-2 py-1 text-xs bg-green-900/50 hover:bg-green-800 border border-green-800/50 rounded text-green-300 disabled:opacity-50 transition-colors"
            >
              Resume
            </button>
          )}
          {["running", "paused", "queued", "waiting", "dispatched"].includes(task.status) && (
            <button
              onClick={(e) => handleAction("kill", e)}
              disabled={acting}
              className="px-2 py-1 text-xs bg-red-900/50 hover:bg-red-800 border border-red-800/50 rounded text-red-300 disabled:opacity-50 transition-colors"
            >
              Kill
            </button>
          )}
          {["failed", "interrupted", "completed_with_errors", "killed"].includes(task.status) && (
            <button
              onClick={handleRetry}
              disabled={acting}
              className="px-2 py-1 text-xs bg-blue-900/50 hover:bg-blue-800 border border-blue-800/50 rounded text-blue-300 disabled:opacity-50 transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
