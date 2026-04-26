import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Task, tasksApi, costApi, TaskCost } from "../lib/api";
import { taskDuration, taskEta, formatRelTime, generateDisplayName } from "../lib/format";
import LogViewer from "../components/LogViewer";
import MetricsChart from "../components/MetricsChart";
import ConfirmDialog from "../components/ConfirmDialog";
import PhaseBadge from "../components/PhaseBadge";

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

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-3 py-1.5 border-b border-gray-800/50">
      <span className="text-xs text-gray-500 uppercase w-28 shrink-0">{label}</span>
      <span className="text-sm text-gray-300 font-mono break-all">{value}</span>
    </div>
  );
}

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [taskCost, setTaskCost] = useState<TaskCost | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    action: () => void;
    title: string;
    message: string;
    variant: "danger" | "warning" | "default";
    confirmLabel: string;
  } | null>(null);

  const fetch = useCallback(() => {
    if (!id) return;
    tasksApi.get(id).then(setTask).finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    fetch();
    const t = setInterval(fetch, 3000);
    return () => clearInterval(t);
  }, [fetch]);

  useEffect(() => {
    if (!id) return;
    costApi.taskCost(id).then((r) => setTaskCost(r.cost)).catch(() => {});
    const t = setInterval(() => {
      costApi.taskCost(id).then((r) => setTaskCost(r.cost)).catch(() => {});
    }, 10000);
    return () => clearInterval(t);
  }, [id]);

  const doAction = async (action: () => Promise<any>) => {
    setActing(true);
    try { await action(); fetch(); } catch (err) { console.error(err); }
    finally { setActing(false); }
  };

  if (loading && !task) return <div className="text-gray-500 text-center py-20">Loading...</div>;
  if (!task) return <div className="text-gray-500 text-center py-20">Task not found</div>;

  const isActive = ["running", "paused", "queued", "dispatched", "pending"].includes(task.status);
  const canRetry = ["failed", "killed", "lost"].includes(task.status);
  const displayName = generateDisplayName(task);
  const pct = task.progress ? Math.round((task.progress.step / task.progress.total) * 100) : null;
  const eta = task.status === "running" ? taskEta(task) : null;

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm">
        <Link to="/tasks" className="text-gray-500 hover:text-white transition-colors">Tasks</Link>
        <span className="text-gray-700">/</span>
        <span className="text-gray-400">#{task.seq}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white">{displayName}</h1>
          <div className="flex items-center gap-3 mt-2">
            <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold border ${STATUS_COLORS[task.status] || ""}`}>
              {task.status.toUpperCase()}
            </span>
            {task.phase && <PhaseBadge phase={task.phase} />}
            <span className="text-sm text-gray-500 font-mono">#{task.seq}</span>
            <span className="text-sm text-gray-500">{taskDuration(task)}</span>
            {eta && <span className="text-sm text-cyan-400">{eta}</span>}
            {task.retry_count > 0 && (
              <span className="text-xs text-gray-600">retry {task.retry_count}/{task.max_retries}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {task.status === "running" && (
            <button onClick={() => doAction(() => tasksApi.patch(task.id, { should_stop: true }))} disabled={acting}
              className="px-3 py-1.5 text-sm bg-orange-900/50 hover:bg-orange-800 border border-orange-800/50 rounded text-orange-300 disabled:opacity-50 transition-colors">
              Stop
            </button>
          )}
          {task.status === "paused" && (
            <button onClick={() => doAction(() => tasksApi.patch(task.id, { status: "running" }))} disabled={acting}
              className="px-3 py-1.5 text-sm bg-green-900/50 hover:bg-green-800 border border-green-800/50 rounded text-green-300 disabled:opacity-50 transition-colors">
              Resume
            </button>
          )}
          {isActive && (
            <button onClick={() => setConfirmAction({
              action: () => doAction(() => tasksApi.patch(task.id, { status: "killed" })),
              title: "Kill Task",
              message: `Kill task #${task.seq} "${displayName}"?`,
              variant: "danger",
              confirmLabel: "Kill",
            })} disabled={acting}
              className="px-3 py-1.5 text-sm bg-red-900/50 hover:bg-red-800 border border-red-800/50 rounded text-red-300 disabled:opacity-50 transition-colors">
              Kill
            </button>
          )}
          {canRetry && (
            <button onClick={() => doAction(() => tasksApi.retry(task.id).then((newTask) => navigate(`/tasks/${newTask.id}`)))} disabled={acting}
              className="px-3 py-1.5 text-sm bg-blue-900/50 hover:bg-blue-800 border border-blue-800/50 rounded text-blue-300 disabled:opacity-50 transition-colors">
              Retry
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {task.progress && pct !== null && (
        <div>
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
            <span>{task.progress.step.toLocaleString()} / {task.progress.total.toLocaleString()}</span>
            <span>{pct}%</span>
          </div>
          <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-500 ${task.status === "completed" ? "bg-green-500" : task.status === "failed" ? "bg-red-500" : "bg-blue-500"}`}
              style={{ width: `${pct}%` }} />
          </div>
          {task.progress.loss !== undefined && (
            <div className="text-xs text-gray-400 mt-1">loss = <span className="font-mono">{task.progress.loss.toFixed(6)}</span></div>
          )}
        </div>
      )}

      {/* Metrics chart */}
      {(task.status === "running" || task.status === "completed" || task.status === "failed") && (
        <MetricsChart taskId={task.id} socket={null} />
      )}

      {/* Command */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Command</p>
        <pre className="text-sm font-mono text-gray-300 bg-gray-950 rounded px-3 py-2 overflow-x-auto select-all whitespace-pre-wrap break-all">
          {task.command}
        </pre>
      </div>

      {/* Metadata */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Details</p>
        <MetaRow label="ID" value={task.id} />
        <MetaRow label="Fingerprint" value={task.fingerprint} />
        <MetaRow label="Script" value={task.script} />
        {task.args && <MetaRow label="Args" value={JSON.stringify(task.args)} />}
        {task.raw_args && <MetaRow label="Raw Args" value={task.raw_args} />}
        <MetaRow label="Stub" value={task.stub_id || "—"} />
        <MetaRow label="Priority" value={String(task.priority)} />
        {task.cwd && <MetaRow label="CWD" value={task.cwd} />}
        {task.run_dir && <MetaRow label="Run Dir" value={task.run_dir} />}
        {task.checkpoint_path && <MetaRow label="Checkpoint" value={task.checkpoint_path} />}
        {task.env_setup && <MetaRow label="Env Setup" value={task.env_setup} />}
        {task.target_tags && task.target_tags.length > 0 && <MetaRow label="Tags" value={task.target_tags.join(", ")} />}
        {task.requirements && <MetaRow label="Requirements" value={JSON.stringify(task.requirements)} />}
        {task.grid_id && <MetaRow label="Grid" value={<Link to={`/grids/${task.grid_id}`} className="text-blue-400 hover:underline">{task.grid_id.slice(0, 8)}</Link>} />}
        {task.retry_of && <MetaRow label="Retry Of" value={<Link to={`/tasks/${task.retry_of}`} className="text-blue-400 hover:underline">{task.retry_of.slice(0, 8)}</Link>} />}
        <MetaRow label="Created" value={task.created_at} />
        {task.started_at && <MetaRow label="Started" value={`${task.started_at} (${formatRelTime(task.started_at)})`} />}
        {task.finished_at && <MetaRow label="Finished" value={`${task.finished_at} (${formatRelTime(task.finished_at)})`} />}
        {task.exit_code !== undefined && <MetaRow label="Exit Code" value={String(task.exit_code)} />}
        {task.pid && <MetaRow label="PID" value={String(task.pid)} />}
        {taskCost && <MetaRow label="GPU-Hours" value={`${taskCost.gpu_hours.toFixed(3)} h (${taskCost.gpu_type} @ $${taskCost.rate_per_hour}/hr)`} />}
        {taskCost && <MetaRow label="Est. Cost" value={`$${taskCost.cost_usd.toFixed(2)}`} />}
      </div>

      {/* Param overrides */}
      {task.param_overrides && Object.keys(task.param_overrides).length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Parameters</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(task.param_overrides).map(([k, v]) => (
              <span key={k} className="text-sm bg-gray-800 rounded px-2 py-0.5 font-mono text-gray-300">
                {k}={String(v)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Logs */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Logs</p>
        <LogViewer taskId={task.id} initialLines={task.log_buffer} maxHeight="500px" />
      </div>

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
