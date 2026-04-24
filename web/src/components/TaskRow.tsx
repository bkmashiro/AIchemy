import { memo, useState } from "react";
import { Task, tasksApi } from "../lib/api";
import { taskDuration, taskEta, generateDisplayName } from "../lib/format";
import { LossChart } from "./LossChart";
import LogViewer from "./LogViewer";

interface Props {
  task: Task;
  stubName?: string;
  lossHistory?: number[];
  liveLogLines?: string[];
  onUpdate?: () => void;
  compact?: boolean;
}

// Status badge colors per spec §10
const STATUS_BADGE: Record<string, { bg: string; text: string; border: string }> = {
  running:    { bg: "bg-blue-900/40",   text: "text-blue-300",   border: "border-blue-700/50" },
  completed:  { bg: "bg-green-900/30",  text: "text-green-400",  border: "border-green-700/40" },
  failed:     { bg: "bg-red-900/40",    text: "text-red-400",    border: "border-red-700/50" },
  killed:     { bg: "bg-gray-800/60",   text: "text-gray-500",   border: "border-gray-700/40" },
  lost:       { bg: "bg-orange-900/30", text: "text-orange-400", border: "border-orange-700/40" },
  pending:    { bg: "bg-yellow-900/30", text: "text-yellow-400", border: "border-yellow-700/40" },
  queued:     { bg: "bg-yellow-900/30", text: "text-yellow-400", border: "border-yellow-700/40" },
  dispatched: { bg: "bg-indigo-900/30", text: "text-indigo-400", border: "border-indigo-700/40" },
  paused:     { bg: "bg-orange-900/30", text: "text-orange-300", border: "border-orange-700/40" },
};

// Row background per status
const ROW_BG: Record<string, string> = {
  running:    "bg-blue-950/20 border-blue-900/30",
  completed:  "bg-green-950/10 border-green-900/20",
  failed:     "bg-red-950/20 border-red-900/30",
  killed:     "bg-gray-900/30 border-gray-800/30",
  lost:       "bg-orange-950/20 border-orange-900/30",
  pending:    "bg-yellow-950/10 border-yellow-900/20",
  queued:     "bg-yellow-950/10 border-yellow-900/20",
  dispatched: "bg-indigo-950/10 border-indigo-900/20",
  paused:     "bg-orange-950/10 border-orange-900/20",
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_BADGE[status] || { bg: "bg-gray-800", text: "text-gray-400", border: "border-gray-700" };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold tracking-wide border ${cfg.bg} ${cfg.text} ${cfg.border}`}>
      {status.toUpperCase()}
    </span>
  );
}

export default memo(function TaskRow({ task, stubName, lossHistory, liveLogLines, onUpdate, compact }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [acting, setActing] = useState(false);

  const displayName = generateDisplayName(task);
  const progressPct = task.progress
    ? Math.min(100, Math.round((task.progress.step / task.progress.total) * 100))
    : null;
  const eta = task.status === "running" ? taskEta(task) : null;
  const duration = taskDuration(task);

  const isActive = ["running", "paused", "queued", "dispatched"].includes(task.status);
  const canRetry = ["failed", "killed", "lost"].includes(task.status);

  const doAction = async (action: () => Promise<any>, e: React.MouseEvent) => {
    e.stopPropagation();
    setActing(true);
    try {
      await action();
      onUpdate?.();
    } catch (err) {
      console.error(err);
    } finally {
      setActing(false);
    }
  };

  const handleKill = (e: React.MouseEvent) => {
    if (!confirm(`Kill task #${task.seq} ${displayName}?`)) return;
    doAction(() => tasksApi.patch(task.id, { status: "killed" }), e);
  };

  const handleRetry = (e: React.MouseEvent) => {
    doAction(() => tasksApi.retry(task.id), e);
  };

  const handlePause = (e: React.MouseEvent) => {
    doAction(() => tasksApi.patch(task.id, { status: "paused" }), e);
  };

  const handleResume = (e: React.MouseEvent) => {
    doAction(() => tasksApi.patch(task.id, { status: "running" }), e);
  };

  const rowBg = ROW_BG[task.status] || "bg-gray-900/30 border-gray-800/30";

  return (
    <div className={`rounded-lg border transition-colors ${rowBg}`}>
      {/* Main row */}
      <div
        className={`px-3 ${compact ? "py-2" : "py-2.5"} cursor-pointer hover:brightness-110 transition`}
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-start gap-2.5">
          {/* Expand indicator */}
          <span className="text-gray-600 text-xs mt-0.5 shrink-0 w-3">
            {expanded ? "▼" : "▶"}
          </span>

          <div className="flex-1 min-w-0">
            {/* Main line: #seq display_name */}
            <div className="flex items-baseline gap-1.5 flex-wrap">
              <span className="text-gray-500 text-xs font-mono shrink-0">#{task.seq}</span>
              <span className="text-sm text-white font-medium truncate" title={displayName}>
                {displayName}
              </span>
            </div>

            {/* Sub line: status, duration, progress, loss, ETA */}
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <StatusBadge status={task.status} />
              <span className="text-xs text-gray-500 font-mono">{duration}</span>
              {task.progress && (
                <span className="text-xs text-gray-400 font-mono">
                  {task.progress.step.toLocaleString()}/{task.progress.total.toLocaleString()}
                  {progressPct !== null && <span className="text-gray-600"> ({progressPct}%)</span>}
                </span>
              )}
              {task.progress?.loss !== undefined && (
                <span className="text-xs text-gray-300">
                  loss=<span className="font-mono">{task.progress.loss.toFixed(4)}</span>
                </span>
              )}
              {eta && <span className="text-xs text-cyan-400">{eta}</span>}
              {task.retry_count > 0 && (
                <span className="text-xs text-gray-600">retry {task.retry_count}/{task.max_retries}</span>
              )}
              {task.exit_code !== undefined && (
                <span className="text-xs text-gray-600 font-mono">exit={task.exit_code}</span>
              )}
              {task.target_tags && task.target_tags.length > 0 && (
                <span className="text-xs text-gray-600 font-mono">
                  [{task.target_tags.join(",")}]
                </span>
              )}
            </div>

            {/* Progress bar */}
            {task.progress && progressPct !== null && (
              <div className="h-1 bg-gray-800 rounded-full overflow-hidden mt-1.5">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    task.status === "completed"
                      ? "bg-green-500"
                      : task.status === "failed"
                      ? "bg-red-500"
                      : "bg-blue-500"
                  }`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            )}
          </div>

          {/* Right side: stub name + action buttons */}
          <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
            {stubName && (
              <span className="text-xs text-gray-600 hidden sm:block">{stubName}</span>
            )}
            {task.status === "running" && (
              <button
                onClick={handlePause}
                disabled={acting}
                className="px-2 py-1 text-xs bg-orange-900/50 hover:bg-orange-800 border border-orange-800/50 rounded text-orange-300 disabled:opacity-50 transition-colors"
              >
                Pause
              </button>
            )}
            {task.status === "paused" && (
              <button
                onClick={handleResume}
                disabled={acting}
                className="px-2 py-1 text-xs bg-green-900/50 hover:bg-green-800 border border-green-800/50 rounded text-green-300 disabled:opacity-50 transition-colors"
              >
                Resume
              </button>
            )}
            {isActive && (
              <button
                onClick={handleKill}
                disabled={acting}
                className="px-2 py-1 text-xs bg-red-900/50 hover:bg-red-800 border border-red-800/50 rounded text-red-300 disabled:opacity-50 transition-colors"
              >
                Kill
              </button>
            )}
            {canRetry && (
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

      {/* Expanded detail panel */}
      {expanded && (
        <div className="border-t border-gray-800/50 px-3 py-3 space-y-3">
          {/* Full command */}
          <div>
            <p className="text-xs text-gray-600 uppercase tracking-wider mb-1">Command</p>
            <p className="text-xs font-mono text-gray-400 break-all bg-gray-950 rounded px-2 py-1.5 select-all">
              {task.command}
            </p>
          </div>

          {/* Metadata grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs">
            {task.cwd && (
              <div>
                <span className="text-gray-600">cwd </span>
                <span className="text-gray-400 font-mono truncate block">{task.cwd}</span>
              </div>
            )}
            {task.run_dir && (
              <div>
                <span className="text-gray-600">run_dir </span>
                <span className="text-gray-400 font-mono truncate block">{task.run_dir}</span>
              </div>
            )}
            {task.checkpoint_path && (
              <div>
                <span className="text-gray-600">checkpoint </span>
                <span className="text-gray-400 font-mono truncate block">{task.checkpoint_path}</span>
              </div>
            )}
            {task.pid && (
              <div>
                <span className="text-gray-600">pid </span>
                <span className="text-gray-400 font-mono">{task.pid}</span>
              </div>
            )}
            {task.grid_id && (
              <div>
                <span className="text-gray-600">grid </span>
                <span className="text-gray-400 font-mono">{task.grid_id.slice(0, 8)}</span>
              </div>
            )}
          </div>

          {/* Param overrides */}
          {task.param_overrides && Object.keys(task.param_overrides).length > 0 && (
            <div>
              <p className="text-xs text-gray-600 uppercase tracking-wider mb-1">Params</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(task.param_overrides).map(([k, v]) => (
                  <span key={k} className="text-xs bg-gray-800 rounded px-2 py-0.5 font-mono text-gray-300">
                    {k}={String(v)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Loss chart */}
          {lossHistory && lossHistory.length >= 2 && (
            <LossChart
              data={lossHistory}
              height={120}
              startedAt={task.started_at}
              totalSteps={task.progress?.total}
            />
          )}

          {/* Logs */}
          <div>
            <p className="text-xs text-gray-600 uppercase tracking-wider mb-1">Logs</p>
            <LogViewer
              taskId={task.id}
              initialLines={task.log_buffer}
              liveLines={liveLogLines}
              maxHeight="220px"
            />
          </div>
        </div>
      )}
    </div>
  );
});
