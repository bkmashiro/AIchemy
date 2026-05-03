import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api, Task } from "../lib/api";
import { formatRelTime } from "../lib/format";

// ─── Types ──────────────────────────────────────────────────────────────────

interface CriterionResult {
  value: number;
  threshold: string;
  ok: boolean;
}

interface TaskValidation {
  passed: boolean;
  checked_at: string;
  details: Record<string, CriterionResult>;
}

interface Experiment {
  id: string;
  name: string;
  description?: string;
  criteria: Record<string, string>;
  grid_id: string;
  status: "running" | "passed" | "partial" | "failed";
  results: Record<string, TaskValidation>;
  created_at: string;
}

interface ExperimentDetail extends Experiment {
  grid?: {
    id: string;
    display_name: string;
    script: string;
    param_space: Record<string, unknown[]>;
    task_ids: string[];
  };
  tasks?: Task[];
}

// ─── API ────────────────────────────────────────────────────────────────────

const experimentsApi = {
  list: () => api.get<Experiment[]>("/experiments").then((r) => r.data),
  get: (id: string) => api.get<ExperimentDetail>(`/experiments/${id}`).then((r) => r.data),
  delete: (id: string) => api.delete(`/experiments/${id}`).then((r) => r.data),
  retryFailed: (id: string) => api.post(`/experiments/${id}/retry-failed`).then((r) => r.data),
};

// ─── Status badges ──────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, string> = {
  running: "bg-blue-900/30 text-blue-400 border-blue-700/40",
  passed:  "bg-green-900/30 text-green-400 border-green-700/40",
  partial: "bg-orange-900/30 text-orange-400 border-orange-700/40",
  failed:  "bg-red-900/30 text-red-400 border-red-700/40",
};

// ─── List View ──────────────────────────────────────────────────────────────

function ExperimentsList() {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    experimentsApi.list()
      .then(setExperiments)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  if (loading && experiments.length === 0) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-500">
        Loading experiments...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">Experiments</h1>
        <span className="text-xs text-gray-500">{experiments.length} total</span>
      </div>

      {experiments.length === 0 ? (
        <div className="text-center py-24 text-gray-700">
          <p className="text-lg font-medium text-gray-500">No experiments yet</p>
          <p className="text-sm mt-1">
            Use <code className="bg-gray-800 px-1 rounded">POST /api/experiments</code> to create one
          </p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">Name</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">Status</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">Criteria</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">Progress</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {experiments.map((exp) => {
                const badge = STATUS_BADGE[exp.status] || "bg-gray-800 text-gray-400 border-gray-700";
                const validations = Object.values(exp.results);
                const passed = validations.filter((v) => v.passed).length;
                const total = validations.length;
                const pct = total > 0 ? Math.round((passed / total) * 100) : 0;

                return (
                  <tr key={exp.id} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-3">
                      <Link
                        to={`/experiments/${exp.id}`}
                        className="text-blue-400 hover:text-blue-300 font-medium transition-colors"
                      >
                        {exp.name}
                      </Link>
                      {exp.description && (
                        <p className="text-xs text-gray-600 mt-0.5 truncate max-w-xs">{exp.description}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded border ${badge}`}>
                        {exp.status.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400 font-mono">
                      {Object.entries(exp.criteria).map(([k, v]) => `${k}${v}`).join(", ")}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-24 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              exp.status === "passed" ? "bg-green-500" :
                              exp.status === "partial" ? "bg-orange-500" :
                              exp.status === "failed" ? "bg-red-500" : "bg-blue-500"
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500 tabular-nums">
                          {passed}/{total} {pct > 0 ? `${pct}%` : ""}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">
                      {formatRelTime(exp.created_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Detail View ────────────────────────────────────────────────────────────

function ExperimentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [exp, setExp] = useState<ExperimentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedCell, setExpandedCell] = useState<string | null>(null);

  const load = () => {
    if (!id) return;
    experimentsApi.get(id)
      .then(setExp)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [id]);

  if (loading) {
    return <div className="flex items-center justify-center py-24 text-gray-500">Loading...</div>;
  }

  if (!exp) {
    return <div className="flex items-center justify-center py-24 text-red-400">Experiment not found</div>;
  }

  const badge = STATUS_BADGE[exp.status] || "bg-gray-800 text-gray-400 border-gray-700";

  // Build matrix heatmap
  const paramSpace = exp.grid?.param_space ?? {};
  const paramKeys = Object.keys(paramSpace);
  const tasks = exp.tasks ?? [];

  // For 2D matrix: use first key as rows, second as columns (or "seed" as columns)
  // If only 1 param, single row. If 3+ params, flatten non-primary into rows.
  let rowKey = paramKeys[0] ?? "";
  let colKey = paramKeys[1] ?? "";

  // Prefer "seed" as column key
  if (paramKeys.includes("seed") && paramKeys.length > 1) {
    colKey = "seed";
    rowKey = paramKeys.find((k) => k !== "seed") ?? paramKeys[0];
  }

  const rowValues = rowKey ? (paramSpace[rowKey] as unknown[]) ?? [] : [""];
  const colValues = colKey ? (paramSpace[colKey] as unknown[]) ?? [] : [""];

  // Extra params beyond row/col
  const extraKeys = paramKeys.filter((k) => k !== rowKey && k !== colKey);

  // Build task lookup: "rowVal|colVal|extra..." → task
  function taskKey(task: Task): string {
    if (!task.param_overrides) return "";
    const parts = [
      rowKey ? String(task.param_overrides[rowKey]) : "",
      colKey ? String(task.param_overrides[colKey]) : "",
      ...extraKeys.map((k) => String(task.param_overrides?.[k] ?? "")),
    ];
    return parts.join("|");
  }

  const taskMap = new Map<string, Task>();
  for (const task of tasks) {
    taskMap.set(taskKey(task), task);
  }

  function getCellStatus(task: Task | undefined): "passed" | "failed" | "running" | "pending" {
    if (!task) return "pending";
    const validation = exp!.results[task.id];
    if (validation) return validation.passed ? "passed" : "failed";
    if (["running", "dispatched"].includes(task.status)) return "running";
    if (["completed"].includes(task.status)) return "running"; // completed but no eval yet
    return "pending";
  }

  const cellColors: Record<string, string> = {
    passed:  "bg-green-900/40 text-green-400 border-green-700/30",
    failed:  "bg-red-900/40 text-red-400 border-red-700/30",
    running: "bg-blue-900/40 text-blue-400 border-blue-700/30",
    pending: "bg-gray-800/40 text-gray-500 border-gray-700/30",
  };

  const cellIcons: Record<string, string> = {
    passed: "\u2713",
    failed: "\u2717",
    running: "\u21BB",
    pending: "\u23F3",
  };

  const handleDelete = async () => {
    if (!exp) return;
    await experimentsApi.delete(exp.id);
    navigate("/experiments");
  };

  const handleRetry = async () => {
    if (!exp) return;
    await experimentsApi.retryFailed(exp.id);
    load();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Link to="/experiments" className="text-gray-500 hover:text-gray-300 text-sm">&larr; Experiments</Link>
            <h1 className="text-xl font-bold text-white">{exp.name}</h1>
            <span className={`text-xs px-2 py-0.5 rounded border ${badge}`}>
              {exp.status.toUpperCase()}
            </span>
          </div>
          {exp.description && <p className="text-sm text-gray-500 mt-1">{exp.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          {(exp.status === "partial" || exp.status === "failed") && (
            <button
              onClick={handleRetry}
              className="px-3 py-1.5 text-xs rounded bg-blue-600/20 text-blue-400 border border-blue-700/40 hover:bg-blue-600/30"
            >
              Retry Failed
            </button>
          )}
          <button
            onClick={handleDelete}
            className="px-3 py-1.5 text-xs rounded bg-red-600/20 text-red-400 border border-red-700/40 hover:bg-red-600/30"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Criteria */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h2 className="text-sm font-medium text-gray-400 mb-2">Criteria</h2>
        <div className="flex flex-wrap gap-3">
          {Object.entries(exp.criteria).map(([metric, expr]) => (
            <span key={metric} className="text-xs font-mono bg-gray-800 px-2 py-1 rounded text-gray-300">
              {metric} {expr}
            </span>
          ))}
        </div>
      </div>

      {/* Matrix Heatmap */}
      {paramKeys.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 overflow-x-auto">
          <h2 className="text-sm font-medium text-gray-400 mb-3">Result Matrix</h2>
          <table className="text-sm">
            <thead>
              <tr>
                <th className="px-3 py-2 text-xs text-gray-600 font-medium text-left">
                  {rowKey || ""}
                </th>
                {colValues.map((cv) => (
                  <th key={String(cv)} className="px-3 py-2 text-xs text-gray-500 font-medium text-center">
                    {colKey ? `${colKey}=${cv}` : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowValues.map((rv) => (
                <tr key={String(rv)}>
                  <td className="px-3 py-2 text-xs text-gray-400 font-mono whitespace-nowrap">
                    {rowKey ? `${rowKey}=${rv}` : ""}
                  </td>
                  {colValues.map((cv) => {
                    // Find task matching this cell
                    const task = tasks.find((t) => {
                      if (!t.param_overrides) return false;
                      const matchRow = !rowKey || String(t.param_overrides[rowKey]) === String(rv);
                      const matchCol = !colKey || String(t.param_overrides[colKey]) === String(cv);
                      return matchRow && matchCol;
                    });

                    const status = getCellStatus(task);
                    const cellId = `${rv}|${cv}`;
                    const isExpanded = expandedCell === cellId;
                    const validation = task ? exp.results[task.id] : undefined;

                    return (
                      <td key={String(cv)} className="px-1 py-1">
                        <button
                          onClick={() => setExpandedCell(isExpanded ? null : cellId)}
                          className={`w-full min-w-[60px] px-3 py-2 rounded border text-center cursor-pointer transition-colors ${cellColors[status]}`}
                        >
                          <span className="text-lg">{cellIcons[status]}</span>
                        </button>
                        {isExpanded && validation && (
                          <div className="mt-1 p-2 bg-gray-800 rounded text-xs space-y-0.5">
                            {Object.entries(validation.details).map(([metric, cr]) => (
                              <div key={metric} className={cr.ok ? "text-green-400" : "text-red-400"}>
                                {metric}: {cr.value.toFixed(4)} {cr.threshold} {cr.ok ? "\u2713" : "\u2717"}
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Task list */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-medium text-gray-400">Tasks ({tasks.length})</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="text-left px-4 py-2 text-xs text-gray-500 font-medium">Task</th>
              <th className="text-left px-4 py-2 text-xs text-gray-500 font-medium">Status</th>
              <th className="text-left px-4 py-2 text-xs text-gray-500 font-medium">Params</th>
              <th className="text-left px-4 py-2 text-xs text-gray-500 font-medium">Validation</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {tasks.map((task) => {
              const validation = exp.results[task.id];
              const taskBadge = task.status === "running" ? "text-blue-400" :
                task.status === "completed" ? "text-green-400" :
                task.status === "failed" ? "text-red-400" : "text-gray-500";

              return (
                <tr key={task.id} className="hover:bg-gray-800/30">
                  <td className="px-4 py-2">
                    <Link to={`/tasks/${task.id}`} className="text-blue-400 hover:text-blue-300 text-xs font-mono">
                      #{task.seq} {task.display_name}
                    </Link>
                  </td>
                  <td className={`px-4 py-2 text-xs ${taskBadge}`}>
                    {task.status}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500 font-mono">
                    {task.param_overrides
                      ? Object.entries(task.param_overrides).map(([k, v]) => `${k}=${v}`).join(" ")
                      : ""}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {validation ? (
                      <span className={validation.passed ? "text-green-400" : "text-red-400"}>
                        {validation.passed ? "PASSED" : "FAILED"}
                        {" "}
                        {Object.entries(validation.details).map(([m, cr]) => (
                          <span key={m} className={`ml-1 ${cr.ok ? "text-green-600" : "text-red-600"}`}>
                            {m}={cr.value.toFixed(3)}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-gray-600">pending</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Router entry ───────────────────────────────────────────────────────────

export default function ExperimentsPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <ExperimentDetail /> : <ExperimentsList />;
}
