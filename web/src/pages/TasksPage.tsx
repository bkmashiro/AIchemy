import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Task, tasksApi } from "../lib/api";
import { formatRelTime, taskDuration, generateDisplayName } from "../lib/format";
import ConfirmDialog from "../components/ConfirmDialog";
import PhaseBadge from "../components/PhaseBadge";
import {
  TASK_STATUS_BADGE_CLASS,
  TASK_STATUS_ORDER,
  isActiveTaskStatus,
  isRetryableTaskStatus,
  taskStatusLabel,
} from "../lib/taskStatus";

type Filter = "all" | "active" | "terminal";

const PAGE_LIMIT = 50;

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [acting, setActing] = useState<Set<string>>(new Set());
  const [confirmAction, setConfirmAction] = useState<{
    action: () => void;
    title: string;
    message: string;
    items?: string[];
    variant: "danger" | "warning" | "default";
    confirmLabel: string;
  } | null>(null);
  const navigate = useNavigate();

  const fetchTasks = useCallback(() => {
    const params: { page: number; limit: number; status_group?: string } = { page, limit: PAGE_LIMIT };
    if (filter === "active") params.status_group = "active";
    if (filter === "terminal") params.status_group = "terminal";
    tasksApi.list(params)
      .then((r) => { setTasks(r.tasks); setTotal(r.total); if (r.counts) setCounts(r.counts); setLoading(false); })
      .catch(() => setLoading(false));
  }, [page, filter]);

  useEffect(() => {
    fetchTasks();
    const t = setInterval(fetchTasks, 5000);
    return () => clearInterval(t);
  }, [fetchTasks]);

  // Reset to page 1 when filter changes
  useEffect(() => { setPage(1); }, [filter]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));

  const doAction = async (id: string, action: () => Promise<any>, e: React.MouseEvent) => {
    e.stopPropagation();
    setActing((s) => new Set(s).add(id));
    try { await action(); fetchTasks(); } catch (err) { console.error(err); }
    finally { setActing((s) => { const n = new Set(s); n.delete(id); return n; }); }
  };

  const batchCancelPending = () => {
    const pendingTasks = tasks.filter((t) => t.status === "pending");
    if (pendingTasks.length === 0) return;
    setConfirmAction({
      action: async () => {
        await tasksApi.batch("kill", pendingTasks.map((t) => t.id));
        fetchTasks();
      },
      title: "Cancel Pending Tasks",
      message: `Cancel ${pendingTasks.length} pending task${pendingTasks.length > 1 ? "s" : ""}?`,
      items: pendingTasks.map((t) => `#${t.seq} ${generateDisplayName(t)}`),
      variant: "danger",
      confirmLabel: "Cancel All",
    });
  };

  if (loading) return <div className="text-gray-500 text-center py-20">Loading...</div>;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-white">Tasks</h1>
        <div className="flex items-center gap-2">
          {(counts["pending"] || 0) > 0 && (
            <button onClick={batchCancelPending} className="px-3 py-1 text-xs bg-red-900/50 hover:bg-red-800 border border-red-800/50 rounded text-red-300 transition-colors">
              Cancel {counts["pending"]} pending
            </button>
          )}
        </div>
      </div>

      {/* Status summary */}
      <div className="flex items-center gap-2 flex-wrap">
        {TASK_STATUS_ORDER.map((s) => counts[s] ? (
          <span key={s} className={`text-xs px-2 py-0.5 rounded border ${TASK_STATUS_BADGE_CLASS[s]}`}>
            {s} {counts[s]}
          </span>
        ) : null)}
        <span className="text-xs text-gray-600 ml-2">{total} total</span>
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
              <th className="text-left px-4 py-2 w-24 hidden lg:table-cell">Stub</th>
              <th className="text-left px-4 py-2 w-24 hidden lg:table-cell">Created</th>
              <th className="text-right px-4 py-2 w-28">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => {
              const isActive = isActiveTaskStatus(t.status);
              const canRetry = isRetryableTaskStatus(t.status);
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
                    <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-semibold border ${TASK_STATUS_BADGE_CLASS[t.status] || ""}`}>
                      {taskStatusLabel(t)}
                    </span>
                    {t.phase && <span className="ml-1.5"><PhaseBadge phase={t.phase} /></span>}
                  </td>
                  <td className="px-4 py-2 text-gray-500 text-xs font-mono hidden sm:table-cell">{taskDuration(t)}</td>
                  <td className="px-4 py-2 text-gray-500 text-xs font-mono hidden md:table-cell">
                    {pct !== null ? `${pct}%` : "—"}
                  </td>
                  <td className="px-4 py-2 text-gray-600 text-xs font-mono hidden lg:table-cell">{t.stub_name ?? "—"}</td>
                  <td className="px-4 py-2 text-gray-600 text-xs hidden lg:table-cell">{formatRelTime(t.created_at)}</td>
                  <td className="px-4 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      {isActive && (
                        <button
                          onClick={(e) => doAction(t.id, () => tasksApi.patch(t.id, { status: "cancelled" }), e)}
                          disabled={acting.has(t.id)}
                          className="px-2 py-0.5 text-xs bg-red-900/50 hover:bg-red-800 border border-red-800/50 rounded text-red-300 disabled:opacity-50"
                        >Cancel</button>
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
        {tasks.length === 0 && (
          <div className="text-center py-12 text-gray-600">No tasks</div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-3 py-1 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-400 disabled:opacity-40"
          >Prev</button>
          <span className="text-xs text-gray-500">Page {page} / {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="px-3 py-1 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-400 disabled:opacity-40"
          >Next</button>
        </div>
      )}

      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction?.title ?? ""}
        message={confirmAction?.message ?? ""}
        items={confirmAction?.items}
        variant={confirmAction?.variant ?? "default"}
        confirmLabel={confirmAction?.confirmLabel ?? "Confirm"}
        onConfirm={() => { confirmAction?.action(); setConfirmAction(null); }}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
