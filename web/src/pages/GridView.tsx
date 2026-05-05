import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Grid, Task, Stub, gridsApi, stubsApi } from "../lib/api";
import { formatRelTime } from "../lib/format";
import ConfirmDialog from "../components/ConfirmDialog";

type GridDetail = Grid & { tasks: Task[] };

const STATUS_BADGE: Record<string, string> = {
  pending:   "bg-yellow-900/30 text-yellow-400 border-yellow-700/40",
  running:   "bg-blue-900/30 text-blue-400 border-blue-700/40",
  partial:   "bg-orange-900/30 text-orange-400 border-orange-700/40",
  completed: "bg-green-900/30 text-green-400 border-green-700/40",
  failed:    "bg-red-900/30 text-red-400 border-red-700/40",
};

const TASK_STATUS_COLOR: Record<string, string> = {
  pending:   "text-yellow-400",
  queued:    "text-yellow-400",
  dispatched:"text-indigo-400",
  running:   "text-blue-400",
  paused:    "text-orange-400",
  completed: "text-green-400",
  failed:    "text-red-400",
  killed:    "text-gray-500",
  lost:      "text-orange-500",
};

function MetricCell({ value }: { value?: number }) {
  if (value === undefined) return <td className="px-3 py-2 text-gray-700">—</td>;
  return (
    <td className="px-3 py-2 font-mono text-gray-200 tabular-nums text-xs">
      {value.toFixed(4)}
    </td>
  );
}

export default function GridView() {
  const { id } = useParams<{ id: string }>();
  const [grid, setGrid] = useState<GridDetail | null>(null);
  const [stubs, setStubs] = useState<Stub[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [acting, setActing] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    action: () => void;
    title: string;
    message: string;
    variant: "danger" | "warning" | "default";
    confirmLabel: string;
  } | null>(null);

  // Build stub name lookup map
  const stubNames = new Map(stubs.map((s) => [s.id, s.name]));

  const load = () => {
    if (!id) return;
    setLoading(true);
    Promise.all([gridsApi.get(id), stubsApi.list()])
      .then(([gridData, stubData]) => {
        setGrid(gridData);
        setStubs(stubData);
      })
      .catch(() => setError("Failed to load grid"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [id]);

  const handleCancelAll = () => {
    if (!id) return;
    setConfirmAction({
      action: async () => {
        setActing(true);
        try {
          await gridsApi.cancelAll(id);
          load();
        } catch {
          setError("Failed to cancel");
        } finally {
          setActing(false);
        }
      },
      title: "Cancel All Tasks",
      message: "Cancel all running tasks in this grid?",
      variant: "danger",
      confirmLabel: "Cancel All",
    });
  };

  const handleRetryFailed = () => {
    if (!id) return;
    setConfirmAction({
      action: async () => {
        setActing(true);
        try {
          await gridsApi.retryFailed(id);
          load();
        } catch {
          setError("Failed to retry");
        } finally {
          setActing(false);
        }
      },
      title: "Retry Failed Tasks",
      message: "Retry all failed tasks in this grid?",
      variant: "warning",
      confirmLabel: "Retry All",
    });
  };

  if (loading && !grid) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="text-gray-500">Loading grid...</div>
      </div>
    );
  }

  if (error && !grid) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="text-red-400">{error}</div>
      </div>
    );
  }

  if (!grid) return null;

  const tasks = grid.tasks || [];
  const paramKeys = Object.keys(grid.param_space || {});

  // Collect all metric keys from completed tasks
  const metricKeys = Array.from(
    new Set(
      tasks.flatMap((t) => Object.keys(t.progress?.metrics || {}))
    )
  );
  const hasLoss = tasks.some((t) => t.progress?.loss !== undefined);
  if (hasLoss && !metricKeys.includes("loss")) metricKeys.unshift("loss");

  // Status summary
  const statusCounts: Record<string, number> = {};
  for (const t of tasks) {
    statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
  }

  const completedTasks = tasks.filter((t) => t.status === "completed");
  const failedTasks = tasks.filter((t) => t.status === "failed");
  const runningTasks = tasks.filter((t) => t.status === "running");

  // Best loss
  const completedWithLoss = completedTasks.filter((t) => t.progress?.loss !== undefined);
  const bestTask = completedWithLoss.sort((a, b) => (a.progress!.loss! - b.progress!.loss!))[0];

  const gridBadge = STATUS_BADGE[grid.status] || "bg-gray-800 text-gray-400 border-gray-700";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link to="/" className="text-gray-600 hover:text-gray-400 text-sm transition-colors">
              ← Dashboard
            </Link>
            <span className="text-gray-700">/</span>
            <span className="text-gray-400 text-sm">Grid</span>
          </div>
          <h1 className="text-xl font-bold text-white">{grid.display_name}</h1>
          <div className="flex items-center gap-3 mt-1">
            <span className={`text-xs px-2 py-0.5 rounded border ${gridBadge}`}>
              {grid.status.toUpperCase()}
            </span>
            <span className="text-xs text-gray-500">{formatRelTime(grid.created_at)}</span>
            <span className="text-xs text-gray-600">{tasks.length} tasks</span>
          </div>
        </div>

        <div className="flex gap-2 shrink-0">
          {runningTasks.length > 0 && (
            <button
              onClick={handleCancelAll}
              disabled={acting}
              className="px-3 py-1.5 text-sm bg-red-900/50 hover:bg-red-800 border border-red-700 rounded-lg text-red-300 disabled:opacity-50 transition-colors"
            >
              Cancel All
            </button>
          )}
          {failedTasks.length > 0 && (
            <button
              onClick={handleRetryFailed}
              disabled={acting}
              className="px-3 py-1.5 text-sm bg-blue-900/50 hover:bg-blue-800 border border-blue-700 rounded-lg text-blue-300 disabled:opacity-50 transition-colors"
            >
              Retry Failed ({failedTasks.length})
            </button>
          )}
        </div>
      </div>

      {/* Progress summary */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center gap-6 flex-wrap">
          {Object.entries(statusCounts).map(([status, count]) => (
            <div key={status} className="flex items-center gap-1.5">
              <span className={`text-xs font-semibold ${TASK_STATUS_COLOR[status] || "text-gray-400"}`}>
                {count}
              </span>
              <span className="text-xs text-gray-500">{status}</span>
            </div>
          ))}
          <div className="ml-auto">
            {completedTasks.length > 0 && (
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden w-40">
                <div
                  className="h-full bg-green-500 rounded-full"
                  style={{ width: `${Math.round((completedTasks.length / tasks.length) * 100)}%` }}
                />
              </div>
            )}
          </div>
        </div>
        {bestTask && (
          <p className="text-xs text-gray-500 mt-3">
            Best loss:{" "}
            <span className="text-green-400 font-mono font-semibold">
              {bestTask.progress!.loss!.toFixed(4)}
            </span>
            {bestTask.param_overrides && (
              <span className="text-gray-600 ml-2">
                ({Object.entries(bestTask.param_overrides).map(([k, v]) => `${k}=${v}`).join(", ")})
              </span>
            )}
          </p>
        )}
      </div>

      {/* Param space */}
      {paramKeys.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-3">Param Space</h3>
          <div className="flex flex-wrap gap-3">
            {paramKeys.map((k) => (
              <div key={k} className="flex items-center gap-2">
                <span className="text-xs text-gray-600 font-mono">{k}:</span>
                <div className="flex gap-1 flex-wrap">
                  {grid.param_space[k].map((v, i) => (
                    <span
                      key={i}
                      className="text-xs bg-gray-800 rounded px-1.5 py-0.5 font-mono text-gray-300"
                    >
                      {String(v)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Comparison table */}
      {tasks.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800">
            <h3 className="text-sm font-semibold text-gray-300">Task Comparison</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">Seq</th>
                  <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">Status</th>
                  {paramKeys.map((k) => (
                    <th key={k} className="text-left px-3 py-2 text-xs text-gray-500 font-medium font-mono">
                      {k}
                    </th>
                  ))}
                  {hasLoss && (
                    <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">Loss</th>
                  )}
                  {metricKeys.filter((k) => k !== "loss").map((k) => (
                    <th key={k} className="text-left px-3 py-2 text-xs text-gray-500 font-medium font-mono">
                      {k}
                    </th>
                  ))}
                  <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">Progress</th>
                  <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">Stub</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {tasks.map((task) => {
                  const isBest = bestTask?.id === task.id;
                  return (
                    <tr
                      key={task.id}
                      className={`hover:bg-gray-800/30 transition-colors ${isBest ? "bg-green-950/10" : ""}`}
                    >
                      <td className="px-3 py-2 text-xs text-gray-500 font-mono">
                        #{task.seq}
                        {isBest && <span className="ml-1 text-green-400">★</span>}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-xs font-semibold ${TASK_STATUS_COLOR[task.status] || "text-gray-400"}`}>
                          {task.status.toUpperCase()}
                        </span>
                      </td>
                      {paramKeys.map((k) => (
                        <td key={k} className="px-3 py-2 text-xs font-mono text-gray-300">
                          {task.param_overrides?.[k] !== undefined ? String(task.param_overrides[k]) : "—"}
                        </td>
                      ))}
                      {hasLoss && (
                        <MetricCell value={task.progress?.loss} />
                      )}
                      {metricKeys.filter((k) => k !== "loss").map((k) => (
                        <MetricCell key={k} value={task.progress?.metrics?.[k]} />
                      ))}
                      <td className="px-3 py-2">
                        {task.progress ? (
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${
                                  task.status === "completed" ? "bg-green-500" :
                                  task.status === "failed" ? "bg-red-500" : "bg-blue-500"
                                }`}
                                style={{
                                  width: `${Math.min(100, Math.round((task.progress.step / task.progress.total) * 100))}%`,
                                }}
                              />
                            </div>
                            <span className="text-xs text-gray-500 font-mono">
                              {Math.round((task.progress.step / task.progress.total) * 100)}%
                            </span>
                          </div>
                        ) : (
                          <span className="text-gray-700 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600 font-mono">
                        {task.stub_id ? (stubNames.get(task.stub_id) || task.stub_id.slice(0, 12)) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction?.title ?? ""}
        message={confirmAction?.message ?? ""}
        variant={confirmAction?.variant ?? "default"}
        confirmLabel={confirmAction?.confirmLabel ?? "Confirm"}
        onConfirm={() => { confirmAction?.action(); setConfirmAction(null); }}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
