import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Stub, stubsApi } from "../lib/api";
import { formatRelTime, formatBytes, formatDuration } from "../lib/format";
import { useSocket } from "../hooks/useSocket";
import RemoteShell from "../components/RemoteShell";
import ConfirmDialog from "../components/ConfirmDialog";

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
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex items-baseline gap-3 py-1.5 border-b border-gray-800/50">
      <span className="text-xs text-gray-500 uppercase w-32 shrink-0">{label}</span>
      <span className="text-sm text-gray-300 font-mono break-all">{value}</span>
    </div>
  );
}

function formatWalltime(seconds: number): string {
  return formatDuration(seconds * 1000);
}

export default function StubDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [stub, setStub] = useState<Stub | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { socket } = useSocket();
  const [confirmAction, setConfirmAction] = useState<{
    action: () => void;
    title: string;
    message: string;
    variant: "danger" | "warning" | "default";
    confirmLabel: string;
  } | null>(null);

  // Settings edit state
  const [editMaxConcurrent, setEditMaxConcurrent] = useState<number | null>(null);
  const [editIdleTimeout, setEditIdleTimeout] = useState<number | null>(null);
  const [editTagsStr, setEditTagsStr] = useState<string | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);

  const fetchStub = useCallback(() => {
    if (!id) return;
    stubsApi.get(id)
      .then((s) => {
        setStub(s);
        setLoading(false);
        // Init settings fields if not dirty
        if (!settingsDirty) {
          setEditMaxConcurrent(s.max_concurrent);
          setEditIdleTimeout(s.idle_timeout_s ?? null);
          setEditTagsStr((s.tags ?? []).join(", "));
        }
      })
      .catch(() => { setLoading(false); setError("Stub not found"); });
  }, [id, settingsDirty]);

  useEffect(() => {
    fetchStub();
    const t = setInterval(fetchStub, 4000);
    return () => clearInterval(t);
  }, [fetchStub]);

  const doAction = async (action: () => Promise<any>) => {
    setActing(true);
    try { await action(); fetchStub(); }
    catch (err) { console.error(err); }
    finally { setActing(false); }
  };

  const saveSettings = async () => {
    if (!stub) return;
    setSettingsSaving(true);
    try {
      const tags = editTagsStr
        ? editTagsStr.split(",").map((t) => t.trim()).filter(Boolean)
        : [];
      const payload: { max_concurrent?: number; tags?: string[]; idle_timeout_s?: number } = {};
      if (editMaxConcurrent !== null) payload.max_concurrent = editMaxConcurrent;
      payload.tags = tags;
      if (editIdleTimeout !== null) payload.idle_timeout_s = editIdleTimeout;
      await stubsApi.patch(stub.id, payload);
      setSettingsDirty(false);
      fetchStub();
    } catch (err) {
      console.error(err);
    } finally {
      setSettingsSaving(false);
    }
  };

  if (loading && !stub) return <div className="text-gray-500 text-center py-20">Loading...</div>;
  if (error || !stub) return <div className="text-gray-500 text-center py-20">{error || "Stub not found"}</div>;

  const isOnline = stub.status === "online";
  const gpus = stub.gpu_stats?.gpus || [];
  const activeTasks = stub.tasks.filter(
    (t) => !["completed", "failed", "killed", "lost"].includes(t.status)
  );
  const hasRunningTasks = stub.tasks.some((t) => t.status === "running");

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm">
        <Link to="/" className="text-gray-500 hover:text-white transition-colors">Dashboard</Link>
        <span className="text-gray-700">/</span>
        <span className="text-gray-400">{stub.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className={`w-2 h-2 rounded-full shrink-0 ${isOnline ? "bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]" : "bg-gray-600"}`} />
            <h1 className="text-xl font-bold text-white">{stub.name}</h1>
          </div>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold border ${isOnline ? "bg-green-900/20 text-green-400 border-green-800/40" : "bg-gray-800/40 text-gray-500 border-gray-700/40"}`}>
              {stub.status.toUpperCase()}
            </span>
            <span className={`inline-flex px-2 py-0.5 rounded text-xs border ${stub.type === "slurm" ? "text-blue-400 bg-blue-900/20 border-blue-800/40" : "text-teal-400 bg-teal-900/20 border-teal-800/40"}`}>
              {stub.type}
            </span>
            <span className="text-sm text-gray-500">{stub.hostname}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => doAction(() => stubsApi.patch(stub.id, { max_concurrent: 0 }))}
            disabled={acting || stub.max_concurrent === 0}
            title="Set max_concurrent=0: stops accepting new tasks, lets running ones finish"
            className="px-3 py-1.5 text-sm bg-orange-900/50 hover:bg-orange-800 border border-orange-800/50 rounded text-orange-300 disabled:opacity-40 transition-colors"
          >
            Drain
          </button>
          <button
            onClick={() => {
              if (hasRunningTasks) { alert("Cannot release: stub has running tasks."); return; }
              setConfirmAction({
                action: () => doAction(() => stubsApi.release(stub.id)),
                title: "Release Stub",
                message: `Mark stub "${stub.name}" offline? It will stop accepting tasks.`,
                variant: "danger",
                confirmLabel: "Release",
              });
            }}
            disabled={acting || (isOnline && hasRunningTasks)}
            title="Mark stub offline (only if no running tasks)"
            className="px-3 py-1.5 text-sm bg-red-900/50 hover:bg-red-800 border border-red-800/50 rounded text-red-300 disabled:opacity-40 transition-colors"
          >
            Release
          </button>
        </div>
      </div>

      {/* Info */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Info</p>
        <MetaRow label="ID" value={stub.id} />
        <MetaRow label="Hostname" value={stub.hostname} />
        <MetaRow label="GPU" value={`${stub.gpu.name} × ${stub.gpu.count} (${formatBytes(stub.gpu.vram_total_mb * stub.gpu.count)} total)`} />
        {stub.slurm_job_id && <MetaRow label="SLURM Job" value={`#${stub.slurm_job_id}`} />}
        {stub.walltime_remaining_s !== undefined && (
          <MetaRow label="Walltime Left" value={
            <span className={stub.walltime_remaining_s < 600 ? "text-orange-400" : undefined}>
              {formatWalltime(stub.walltime_remaining_s)}
            </span>
          } />
        )}
        <MetaRow label="Connected" value={`${stub.connected_at} (${formatRelTime(stub.connected_at)})`} />
        <MetaRow label="Last Heartbeat" value={`${stub.last_heartbeat} (${formatRelTime(stub.last_heartbeat)})`} />
        {stub.tags && stub.tags.length > 0 && (
          <MetaRow label="Tags" value={
            <div className="flex flex-wrap gap-1">
              {stub.tags.map((tag) => (
                <span key={tag} className="bg-gray-800 text-gray-400 rounded px-1.5 py-0.5 text-xs">{tag}</span>
              ))}
            </div>
          } />
        )}
        {stub.env_setup && <MetaRow label="Env Setup" value={stub.env_setup} />}
        {stub.default_cwd && <MetaRow label="Default CWD" value={stub.default_cwd} />}
      </div>

      {/* GPU Stats */}
      {gpus.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">GPU Stats</p>
          <div className="space-y-3">
            {gpus.map((g) => {
              const vramPct = Math.round((g.memory_used_mb / g.memory_total_mb) * 100);
              const utilColor = g.utilization_pct > 80 ? "bg-green-500" : g.utilization_pct > 40 ? "bg-blue-500" : "bg-gray-600";
              const vramColor = vramPct > 90 ? "bg-red-500" : vramPct > 70 ? "bg-yellow-500" : "bg-purple-500";
              const tempColor = g.temperature_c !== undefined
                ? (g.temperature_c > 80 ? "text-red-400" : g.temperature_c > 65 ? "text-yellow-400" : "text-gray-400")
                : "";
              return (
                <div key={g.index} className="bg-gray-950 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-400 font-mono">GPU {g.index}</span>
                    {g.temperature_c !== undefined && (
                      <span className={`text-xs font-mono ${tempColor}`}>{g.temperature_c}°C</span>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <div>
                      <div className="flex justify-between text-xs text-gray-500 mb-1">
                        <span>Utilization</span>
                        <span className={g.utilization_pct > 50 ? "text-green-400" : ""}>{g.utilization_pct}%</span>
                      </div>
                      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div className={`h-full ${utilColor} rounded-full`} style={{ width: `${g.utilization_pct}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-xs text-gray-500 mb-1">
                        <span>VRAM</span>
                        <span className={vramPct > 80 ? "text-red-400" : ""}>{formatBytes(g.memory_used_mb)} / {formatBytes(g.memory_total_mb)}</span>
                      </div>
                      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div className={`h-full ${vramColor} rounded-full`} style={{ width: `${vramPct}%` }} />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {stub.gpu_stats && (
            <p className="text-xs text-gray-700 mt-2">Updated {formatRelTime(stub.gpu_stats.timestamp)}</p>
          )}
        </div>
      )}

      {/* Settings */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">Settings</p>
        <div className="space-y-4">
          <div>
            <label className="text-xs text-gray-400 uppercase block mb-1">Max Concurrent</label>
            <input
              type="number"
              min={0}
              value={editMaxConcurrent ?? 0}
              onChange={(e) => { setEditMaxConcurrent(Number(e.target.value)); setSettingsDirty(true); }}
              className="bg-gray-950 border border-gray-700 rounded px-3 py-1.5 text-sm text-white font-mono w-32 focus:outline-none focus:border-blue-600"
            />
            <p className="text-xs text-gray-600 mt-1">0 = drain (no new tasks accepted)</p>
          </div>
          <div>
            <label className="text-xs text-gray-400 uppercase block mb-1">Tags (comma-separated)</label>
            <input
              type="text"
              value={editTagsStr ?? ""}
              onChange={(e) => { setEditTagsStr(e.target.value); setSettingsDirty(true); }}
              placeholder="e.g. a40, ys25"
              className="bg-gray-950 border border-gray-700 rounded px-3 py-1.5 text-sm text-white font-mono w-full focus:outline-none focus:border-blue-600"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 uppercase block mb-1">Idle Timeout (seconds)</label>
            <input
              type="number"
              min={0}
              value={editIdleTimeout ?? ""}
              onChange={(e) => { setEditIdleTimeout(e.target.value ? Number(e.target.value) : null); setSettingsDirty(true); }}
              placeholder="e.g. 300"
              className="bg-gray-950 border border-gray-700 rounded px-3 py-1.5 text-sm text-white font-mono w-32 focus:outline-none focus:border-blue-600"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={saveSettings}
              disabled={settingsSaving || !settingsDirty}
              className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-40 transition-colors"
            >
              {settingsSaving ? "Saving…" : "Save Settings"}
            </button>
            {!settingsDirty && <span className="text-xs text-gray-600">Up to date</span>}
          </div>
        </div>
      </div>

      {/* Active Tasks */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">
          Active Tasks
          {activeTasks.length > 0 && (
            <span className="ml-2 bg-blue-900/50 text-blue-400 text-xs px-2 py-0.5 rounded-full">
              {activeTasks.length}
            </span>
          )}
        </p>
        {activeTasks.length === 0 ? (
          <p className="text-sm text-gray-600">No active tasks</p>
        ) : (
          <div className="space-y-1">
            {activeTasks.map((task) => {
              const displayName = task.display_name || task.name || task.script || task.id.slice(0, 8);
              return (
                <div
                  key={task.id}
                  onClick={() => navigate(`/tasks/${task.id}`)}
                  className="flex items-center gap-3 py-1.5 px-2 rounded border border-transparent hover:border-gray-700 hover:bg-gray-800/40 cursor-pointer transition-colors"
                >
                  <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold border ${STATUS_COLORS[task.status] || ""}`}>
                    {task.status.toUpperCase()}
                  </span>
                  <span className="text-gray-500 text-xs font-mono shrink-0">#{task.seq}</span>
                  <span className="text-sm text-gray-300 truncate flex-1">{displayName}</span>
                  {task.progress && (
                    <span className="text-xs text-gray-600 shrink-0">
                      {Math.round((task.progress.step / task.progress.total) * 100)}%
                    </span>
                  )}
                  <span className="text-xs text-gray-600 shrink-0">{formatRelTime(task.created_at)}</span>
                  <span className="text-gray-700 text-xs">→</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Remote Shell — only when online */}
      {isOnline && (
        <RemoteShell stubId={stub.id} socket={socket} isOnline={isOnline} />
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
