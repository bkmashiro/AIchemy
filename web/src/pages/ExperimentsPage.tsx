import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import {
  Task,
  Experiment,
  ExperimentDetail,
  ExperimentEvent,
  ExperimentDecision,
  experimentsApi,
} from "../lib/api";
import { formatRelTime } from "../lib/format";

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

function ExperimentDetailView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [exp, setExp] = useState<ExperimentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedCell, setExpandedCell] = useState<string | null>(null);
  const [events, setEvents] = useState<ExperimentEvent[]>([]);
  const [allExperiments, setAllExperiments] = useState<Experiment[]>([]);

  const load = () => {
    if (!id) return;
    experimentsApi.get(id)
      .then(setExp)
      .catch(() => {})
      .finally(() => setLoading(false));
    experimentsApi.getTimeline(id)
      .then((r) => setEvents(r.events))
      .catch(() => {});
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [id]);

  useEffect(() => {
    experimentsApi.list()
      .then(setAllExperiments)
      .catch(() => {});
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
          {Object.keys(exp.criteria).length === 0 && (
            <span className="text-xs text-gray-600">No criteria</span>
          )}
        </div>
      </div>

      {/* Intent + Decision + Lineage grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <IntentCard exp={exp} />
        <DecisionCard exp={exp} onUpdated={(u) => { setExp({ ...exp, ...u }); load(); }} />
        <LineageCard exp={exp} allExperiments={allExperiments} />
      </div>

      {/* Timeline */}
      <TimelineCard
        exp={exp}
        events={events}
        onNoteAdded={() => load()}
      />

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

// ─── Intent Card ────────────────────────────────────────────────────────────

function IntentCard({ exp }: { exp: ExperimentDetail }) {
  const hasIntent = exp.hypothesis || exp.expected_outcome || exp.family || exp.parent_name || exp.fork_reason;
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h2 className="text-sm font-medium text-gray-400 mb-3">Intent</h2>
      {!hasIntent && <p className="text-xs text-gray-600">No intent recorded</p>}
      <div className="space-y-2 text-xs">
        {exp.family && (
          <Field label="Family">
            <span className="font-mono text-gray-300">{exp.family}</span>
          </Field>
        )}
        {exp.parent_name && (
          <Field label="Parent">
            {exp.parent_id ? (
              <Link to={`/experiments/${exp.parent_id}`} className="text-blue-400 hover:text-blue-300 font-mono">
                {exp.parent_name}
              </Link>
            ) : (
              <span className="font-mono text-gray-300">{exp.parent_name}</span>
            )}
          </Field>
        )}
        {exp.hypothesis && (
          <Field label="Hypothesis">
            <p className="text-gray-300 whitespace-pre-wrap">{exp.hypothesis}</p>
          </Field>
        )}
        {exp.expected_outcome && (
          <Field label="Expected">
            <p className="text-gray-300 whitespace-pre-wrap">{exp.expected_outcome}</p>
          </Field>
        )}
        {exp.fork_reason && (
          <Field label="Fork reason">
            <p className="text-gray-300 whitespace-pre-wrap">{exp.fork_reason}</p>
          </Field>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-0.5">{label}</div>
      <div>{children}</div>
    </div>
  );
}

// ─── Decision Card ──────────────────────────────────────────────────────────

const DECISION_OPTIONS: ExperimentDecision[] = ["keep", "drop", "rerun", "fork"];

const DECISION_BADGE: Record<string, string> = {
  keep:  "bg-green-900/30 text-green-400 border-green-700/40",
  drop:  "bg-red-900/30 text-red-400 border-red-700/40",
  rerun: "bg-blue-900/30 text-blue-400 border-blue-700/40",
  fork:  "bg-purple-900/30 text-purple-400 border-purple-700/40",
};

function DecisionCard({
  exp,
  onUpdated,
}: {
  exp: ExperimentDetail;
  onUpdated: (u: Partial<ExperimentDetail>) => void;
}) {
  const [decision, setDecision] = useState<ExperimentDecision>(exp.decision ?? "keep");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      setError("Reason required");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const updated = await experimentsApi.decide(exp.id, decision, reason.trim());
      setReason("");
      onUpdated(updated);
    } catch (err: any) {
      setError(err?.response?.data?.error ?? "Failed to set decision");
    } finally {
      setSubmitting(false);
    }
  }

  const currentBadge = exp.decision
    ? DECISION_BADGE[exp.decision] || "bg-gray-800 text-gray-400 border-gray-700"
    : "bg-gray-800 text-gray-500 border-gray-700";

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h2 className="text-sm font-medium text-gray-400 mb-3">Decision</h2>
      <div className="space-y-3 text-xs">
        <div>
          <span className={`inline-block text-xs px-2 py-0.5 rounded border ${currentBadge}`}>
            {(exp.decision ?? "undecided").toUpperCase()}
          </span>
          {exp.decision_at && (
            <span className="ml-2 text-gray-600">{formatRelTime(exp.decision_at)}</span>
          )}
        </div>
        {exp.decision_reason && (
          <p className="text-gray-300 whitespace-pre-wrap">{exp.decision_reason}</p>
        )}

        <form onSubmit={handleSubmit} className="space-y-2 pt-2 border-t border-gray-800">
          <div className="flex items-center gap-2">
            <select
              value={decision}
              onChange={(e) => setDecision(e.target.value as ExperimentDecision)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
              disabled={submitting}
            >
              {DECISION_OPTIONS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <button
              type="submit"
              disabled={submitting}
              className="px-3 py-1 text-xs rounded bg-blue-600/20 text-blue-400 border border-blue-700/40 hover:bg-blue-600/30 disabled:opacity-50"
            >
              {submitting ? "Saving..." : "Set"}
            </button>
          </div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason..."
            rows={2}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600"
            disabled={submitting}
          />
          {error && <p className="text-red-400 text-xs">{error}</p>}
        </form>
      </div>
    </div>
  );
}

// ─── Lineage Card ───────────────────────────────────────────────────────────

function LineageCard({
  exp,
  allExperiments,
}: {
  exp: ExperimentDetail;
  allExperiments: Experiment[];
}) {
  // Walk ancestors via parent_id
  const ancestors: Experiment[] = [];
  const byId = new Map(allExperiments.map((e) => [e.id, e]));
  let cursor = exp.parent_id ? byId.get(exp.parent_id) : undefined;
  const seen = new Set<string>([exp.id]);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    ancestors.unshift(cursor);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  const descendants = allExperiments.filter((e) => e.parent_id === exp.id);

  const hasAny = ancestors.length > 0 || descendants.length > 0;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h2 className="text-sm font-medium text-gray-400 mb-3">Lineage</h2>
      {!hasAny && <p className="text-xs text-gray-600">No related experiments</p>}
      {ancestors.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">Ancestors</div>
          <div className="flex flex-wrap items-center gap-1 text-xs">
            {ancestors.map((a, i) => (
              <span key={a.id} className="flex items-center gap-1">
                <Link to={`/experiments/${a.id}`} className="text-blue-400 hover:text-blue-300 font-mono">
                  {a.name}
                </Link>
                {i < ancestors.length - 1 && <span className="text-gray-700">/</span>}
              </span>
            ))}
            <span className="text-gray-700">/</span>
            <span className="text-gray-400 font-mono">{exp.name}</span>
          </div>
        </div>
      )}
      {descendants.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">
            Forks ({descendants.length})
          </div>
          <ul className="space-y-1 text-xs">
            {descendants.map((d) => (
              <li key={d.id} className="flex items-center gap-2">
                <Link to={`/experiments/${d.id}`} className="text-blue-400 hover:text-blue-300 font-mono truncate">
                  {d.name}
                </Link>
                {d.fork_reason && (
                  <span className="text-gray-600 truncate">— {d.fork_reason}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Timeline Card ──────────────────────────────────────────────────────────

const EVENT_BADGE: Record<string, string> = {
  created:        "bg-blue-900/30 text-blue-400 border-blue-700/40",
  forked:         "bg-purple-900/30 text-purple-400 border-purple-700/40",
  task_started:   "bg-blue-900/30 text-blue-400 border-blue-700/40",
  task_completed: "bg-green-900/30 text-green-400 border-green-700/40",
  task_failed:    "bg-red-900/30 text-red-400 border-red-700/40",
  resumed:        "bg-amber-900/30 text-amber-400 border-amber-700/40",
  moved_stub:     "bg-amber-900/30 text-amber-400 border-amber-700/40",
  metric_best:    "bg-green-900/30 text-green-400 border-green-700/40",
  note:           "bg-gray-800 text-gray-300 border-gray-700",
  decision:       "bg-purple-900/30 text-purple-400 border-purple-700/40",
};

function formatEventData(data: Record<string, any> | undefined): string | null {
  if (!data) return null;
  try {
    const s = JSON.stringify(data);
    if (s === "{}") return null;
    return s.length > 240 ? s.slice(0, 237) + "..." : s;
  } catch {
    return null;
  }
}

function TimelineCard({
  exp,
  events,
  onNoteAdded,
}: {
  exp: ExperimentDetail;
  events: ExperimentEvent[];
  onNoteAdded: () => void;
}) {
  const [message, setMessage] = useState("");
  const [taskId, setTaskId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) {
      setError("Message required");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await experimentsApi.addNote(exp.id, message.trim(), {
        task_id: taskId.trim() || undefined,
      });
      setMessage("");
      setTaskId("");
      onNoteAdded();
    } catch (err: any) {
      setError(err?.response?.data?.error ?? "Failed to add note");
    } finally {
      setSubmitting(false);
    }
  }

  const sorted = [...events].sort((a, b) => a.created_at.localeCompare(b.created_at));

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-gray-400">Timeline</h2>
        <span className="text-xs text-gray-600">{sorted.length} event{sorted.length === 1 ? "" : "s"}</span>
      </div>

      {/* Note form */}
      <form onSubmit={handleSubmit} className="mb-4 space-y-2 p-3 bg-gray-950/40 border border-gray-800 rounded-lg">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Add a note..."
          rows={2}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600"
          disabled={submitting}
        />
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
            placeholder="Task ID (optional)"
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 font-mono"
            disabled={submitting}
          />
          <button
            type="submit"
            disabled={submitting}
            className="px-3 py-1 text-xs rounded bg-blue-600/20 text-blue-400 border border-blue-700/40 hover:bg-blue-600/30 disabled:opacity-50"
          >
            {submitting ? "Posting..." : "Add note"}
          </button>
        </div>
        {error && <p className="text-red-400 text-xs">{error}</p>}
      </form>

      {/* Event list */}
      {sorted.length === 0 ? (
        <p className="text-xs text-gray-600 text-center py-6">No timeline events yet</p>
      ) : (
        <ul className="space-y-2">
          {sorted.map((ev) => {
            const badge = EVENT_BADGE[ev.kind] || "bg-gray-800 text-gray-400 border-gray-700";
            const dataStr = formatEventData(ev.data);
            return (
              <li key={ev.id} className="text-xs border-l-2 border-gray-800 pl-3 py-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`px-1.5 py-0.5 rounded border text-[10px] ${badge}`}>
                    {ev.kind}
                  </span>
                  <span className="text-gray-300">{ev.message}</span>
                  <span className="text-gray-600 ml-auto">{formatRelTime(ev.created_at)}</span>
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-gray-600 text-[11px]">
                  {ev.actor && <span>by {ev.actor}</span>}
                  {ev.task_id && (
                    <Link to={`/tasks/${ev.task_id}`} className="text-blue-500 hover:text-blue-400 font-mono">
                      task {ev.task_id.slice(0, 8)}
                    </Link>
                  )}
                </div>
                {dataStr && (
                  <pre className="mt-1 text-[10px] text-gray-600 bg-gray-950/40 rounded px-2 py-1 overflow-x-auto font-mono">
                    {dataStr}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── Router entry ───────────────────────────────────────────────────────────

export default function ExperimentsPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <ExperimentDetailView /> : <ExperimentsList />;
}
