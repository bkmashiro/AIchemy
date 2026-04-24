import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Task, TaskStatus, tasksApi } from "../lib/api";
import { formatRelTime, taskDuration, generateDisplayName } from "../lib/format";

const STATUS_ORDER: TaskStatus[] = ["running", "dispatched", "queued", "pending", "paused", "completed", "failed", "killed", "lost"];

const STATUS_COLORS: Record<string, string> = {
  running: "bg-blue-900/40 text-blue-300 border-blue-700/50",
  completed: "bg-green-900/30 text-green-400 border-green-700/40",
  failed: "bg-red-900/40 text-red-400 border-red-700/50",
  killed: "bg-gray-800/60 text-gray-500 border-gray-700/40",
  lost: "bg-orange-900/30 text-orange-400 border-orange-700/40",
  pending: "bg-yellow-900/30 text-yellow-400 border-yellow-700/40",
  queued: "bg-yellow-900/30 text-yellow-400 border-yellow-700/40",
  dispatched: "bg-indigo-900/30 text-indigo-400 border-indigo-700/40",
  paused: "bg-orange-900/30 text-orange-300 border-orange-700/40",
};

type Filter = "all" | "active" | "terminal";

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [acting, setActing] = useState<Set<string>>(new Set());
  const navigate = useNavigate();

  const fetchTasks = () => {
    tasksApi.list().then((t) => { setTasks(t); setLoading(false); }).catch(() => setLoading(false));
  };

  useEffect(() => {
    fetchTasks();
    const t = setInterval(fetchTasks, 5000);
    return () => clearInterval(t);
  }, []);

  const filtered = useMemo(() => {
    let list = tasks;
    if (filter === "active") list = list.filter((t) => ["running", "dispatched", "queued", "pending", "paused"].includes(t.status));
    if (filter === "terminal") list = list.filter((t) => ["completed", "failed", "killed", "lost"].includes(t.status));
    return list.sort((a, b) => {
      const ai = STATUS_ORDER.indexOf(a.status as TaskStatus);
      const bi = STATUS_ORDER.indexOf(b.status as TaskStatus);
      if (ai !== bi) return ai - bi;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [tasks, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of tasks) c[t.status] = (c[t.status] || 0) + 1;
    return c;
  }, [tasks]);

  const doAction = async (id: string, action: () => Promise<any>, e: React.MouseEvent) => {
    e.stopPropagation();
    setActing((s) => new Set(s).add(id));
    try { await action(); fetchTasks(); } catch (err) { console.error(err); }
    finally { setActing((s) => { const n = new Set(s); n.delete(id); return n; }); }
  };

  const batchKillPending = async () => {
    const ids = tasks.filter((t) => t.status === "pending").map((t) => t.id);
    if (ids.length === 0) return;
    if (!confirm(`Kill ${ids.length} pending tasks?`)) return;
    await tasksApi.batch("kill", ids);
    fetchTasks();
  };

  if (loading) return <div className="text-gray-500 text-center py-20">Loading...</div>;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-white">Tasks</h1>
        <div className="flex items-center gap-2">
          {(counts["pending"] || 0) > 0 && (
            <button onClick={batchKillPending} className="px-3 py-1 text-xs bg-red-900/50 hover:bg-red-800 border border-red-800/50 rounded text-red-300 transition-colors">
              Kill {counts["pending"]} pending
            </button>
          )}
        </div>
      </div>

      {/* Status summary */}
      <div className="flex items-center gap-2 flex-wrap">
        {STATUS_ORDER.map((s) => counts[s] ? (
          <span key={s} className={`text-xs px-2 py-0.5 rounded border ${STATUS_COLORS[s]}`}>
            {s} {counts[s]}
          </span>
        ) : null)}
        <span className="text-xs text-gray-600 ml-2">{tasks.length} total</span>
      </div>

      {/* Filters */}
      <div className="flex gap-1">
        {(["all", "active", "terminal"] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 text-xs rounded transition-colors ${filter === f ? "bg-gray-700 text-white" : "text-gray-500 hover:text-white hover:bg-gray-800"}`}
          >
            {f === "all" ? "All" : f === "active" ? "Active" : "History"}
          </button>
        ))}
      </div>

      {/* Task list */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase">
              <th className="text-left px-4 py-2 w-12">#</th>
              <th className="text-left px-4 py-2">Name</th>
              <th className="text-left px-4 py-2 w-24">Status</th>
              <th className="text-left px-4 py-2 w-20 hidden sm:table-cell">Duration</th>
              <th className="text-left px-4 py-2 w-20 hidden md:table-cell">Progress</th>
              <th className="text-left px-4 py-2 w-24 hidden lg:table-cell">Created</th>
              <th className="text-right px-4 py-2 w-28">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => {
              const isActive = ["running", "paused", "queued", "dispatched", "pending"].includes(t.status);
              const canRetry = ["failed", "killed", "lost"].includes(t.status);
              const displayName = generateDisplayName(t);
              const pct = t.progress ? Math.round((t.progress.step / t.progress.total) * 100) : null;
              return (
                <tr
                  key={t.id}
                  className="border-b border-gray-800/50 hover:bg-gray-800/30 cursor-pointer transition-colors"
                  onClick={() => navigate(`/tasks/${t.id}`)}
                >
                  <td className="px-4 py-2 text-gray-500 font-mono text-xs">{t.seq}</td>
                  <td className="px-4 py-2 text-gray-200 truncate max-w-[300px]" title={displayName}>
                    {displayName}
                    {t.target_tags && t.target_tags.length > 0 && (
                      <span className="text-xs text-gray-600 ml-2 font-mono">[{t.target_tags.join(",")}]</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-semibold border ${STATUS_COLORS[t.status] || ""}`}>
                      {t.status.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-500 text-xs font-mono hidden sm:table-cell">{taskDuration(t)}</td>
                  <td className="px-4 py-2 text-gray-500 text-xs font-mono hidden md:table-cell">
                    {pct !== null ? `${pct}%` : "—"}
                  </td>
                  <td className="px-4 py-2 text-gray-600 text-xs hidden lg:table-cell">{formatRelTime(t.created_at)}</td>
                  <td className="px-4 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      {isActive && (
                        <button
                          onClick={(e) => doAction(t.id, () => tasksApi.patch(t.id, { status: "killed" }), e)}
                          disabled={acting.has(t.id)}
                          className="px-2 py-0.5 text-xs bg-red-900/50 hover:bg-red-800 border border-red-800/50 rounded text-red-300 disabled:opacity-50"
                        >Kill</button>
                      )}
                      {canRetry && (
                        <button
                          onClick={(e) => doAction(t.id, () => tasksApi.retry(t.id), e)}
                          disabled={acting.has(t.id)}
                          className="px-2 py-0.5 text-xs bg-blue-900/50 hover:bg-blue-800 border border-blue-800/50 rounded text-blue-300 disabled:opacity-50"
                        >Retry</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-center py-12 text-gray-600">No tasks</div>
        )}
      </div>
    </div>
  );
}
