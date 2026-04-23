import { useState, useEffect, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { Stub, GpuStats, stubsApi } from "../lib/api";
import TaskRow from "../components/TaskRow";
import GpuChart, { DataPoint } from "../components/GpuChart";
import LogViewer from "../components/LogViewer";
import TaskForm from "../components/TaskForm";
import RemoteShell from "../components/RemoteShell";
import { LossChart } from "../components/LossChart";

interface Props {
  stubs: Stub[];
  lossHistory: Map<string, number[]>;
  connected?: boolean;
}

function fmt(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

export default function StubDetail({ stubs, lossHistory, connected }: Props) {
  const { id } = useParams<{ id: string }>();
  const stub = stubs.find((s) => s.id === id);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [gpuHistory, setGpuHistory] = useState<DataPoint[]>([]);
  const [showShell, setShowShell] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [taskFilter, setTaskFilter] = useState<"all" | "active" | "completed">("all");
  const [logLines, setLogLines] = useState<string[]>([]);

  // Settings state
  const [settingsName, setSettingsName] = useState("");
  const [settingsMaxConcurrent, setSettingsMaxConcurrent] = useState(1);
  const [settingsAutoRelease, setSettingsAutoRelease] = useState(false);
  const [settingsIdleTimeout, setSettingsIdleTimeout] = useState(0);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);

  // Sync settings with stub
  useEffect(() => {
    if (stub) {
      setSettingsName(stub.name);
      setSettingsMaxConcurrent(stub.max_concurrent);
      setSettingsAutoRelease(stub.auto_release ?? false);
      setSettingsIdleTimeout(stub.idle_timeout_s ?? 0);
    }
  }, [stub?.id]);

  // Track GPU history
  const prevStats = useRef<GpuStats | null>(null);
  useEffect(() => {
    if (!stub?.gpu_stats) return;
    const stats = stub.gpu_stats;
    if (stats === prevStats.current) return;
    prevStats.current = stats;
    const gpu0 = stats.gpus[0];
    if (gpu0) {
      const point: DataPoint = {
        time: new Date(stats.timestamp).toLocaleTimeString(),
        util: gpu0.utilization_pct,
        vram: Math.round((gpu0.memory_used_mb / gpu0.memory_total_mb) * 100),
      };
      setGpuHistory((prev) => [...prev.slice(-59), point]);
    }
  }, [stub?.gpu_stats]);

  // Auto-select first task
  useEffect(() => {
    if (stub && stub.tasks.length > 0 && !selectedTaskId) {
      const running = stub.tasks.find((t) => t.status === "running");
      setSelectedTaskId((running || stub.tasks[stub.tasks.length - 1])?.id || null);
    }
  }, [stub?.id]);

  // Load logs for selected task
  const selectedTask = stub?.tasks.find((t) => t.id === selectedTaskId);
  useEffect(() => {
    if (!selectedTask || !stub) { setLogLines([]); return; }
    const load = async () => {
      try {
        const res = await fetch(`/api/stubs/${stub.id}/tasks/${selectedTask.id}/logs`, {
          headers: { Authorization: `Bearer ${localStorage.getItem("alchemy_token") || "alchemy-v2-token"}` }
        });
        if (res.ok) {
          const d = await res.json();
          setLogLines(d.lines || []);
        } else {
          setLogLines(selectedTask.log_buffer || []);
        }
      } catch {
        setLogLines(selectedTask.log_buffer || []);
      }
    };
    load();
  }, [selectedTaskId, selectedTask?.status, selectedTask?.log_buffer?.length]);

  if (!stub) {
    // If not yet connected or stubs haven't loaded, show loading state
    if (!connected || stubs.length === 0) {
      return (
        <div className="text-center py-24 text-gray-600">
          <p className="text-lg animate-pulse">Loading...</p>
          <Link to="/" className="text-blue-400 hover:underline text-sm mt-2 block">← Dashboard</Link>
        </div>
      );
    }
    return (
      <div className="text-center py-24 text-gray-600">
        <p className="text-lg">Stub not found</p>
        <Link to="/" className="text-blue-400 hover:underline text-sm mt-2 block">← Dashboard</Link>
      </div>
    );
  }

  const handleSaveSettings = async () => {
    setSettingsSaving(true);
    try {
      await stubsApi.patch(stub.id, {
        name: settingsName || undefined,
        max_concurrent: settingsMaxConcurrent,
        auto_release: settingsAutoRelease,
        idle_timeout_s: settingsIdleTimeout > 0 ? settingsIdleTimeout : undefined,
      });
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch (err) {
      console.error(err);
    } finally {
      setSettingsSaving(false);
    }
  };

  const activeTasks = stub.tasks.filter((t) => ["running", "queued", "waiting", "paused", "dispatched"].includes(t.status));
  const completedTasks = stub.tasks.filter((t) => ["completed", "completed_with_errors", "failed", "killed", "interrupted"].includes(t.status));
  const displayedTasks = taskFilter === "active" ? activeTasks : taskFilter === "completed" ? completedTasks : [...stub.tasks].reverse();

  const gpus = stub.gpu_stats?.gpus || [];
  const totalVram = gpus.reduce((n, g) => n + g.memory_total_mb, 0) || stub.gpu.vram_total_mb * stub.gpu.count;
  const usedVram = gpus.reduce((n, g) => n + g.memory_used_mb, 0);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Link to="/" className="text-gray-600 hover:text-gray-400 text-sm transition-colors">← Dashboard</Link>
        <h1 className="text-xl font-bold text-white">{stub.name}</h1>
        <span
          className={`text-xs px-2.5 py-0.5 rounded-full border font-medium ${
            stub.status === "online"
              ? "text-green-400 bg-green-900/30 border-green-800/50"
              : stub.status === "stale"
              ? "text-yellow-400 bg-yellow-900/30 border-yellow-800/50"
              : "text-gray-500 bg-gray-800/50 border-gray-700/50"
          }`}
        >
          {stub.status}
        </span>
        <span className="text-xs text-gray-600">{stub.hostname}</span>

        <div className="ml-auto flex gap-2">
          <button
            onClick={() => setShowSettings((v) => !v)}
            className={`px-3 py-1.5 text-xs border rounded transition-colors ${
              showSettings
                ? "bg-gray-700 border-gray-600 text-white"
                : "bg-gray-900 border-gray-700 text-gray-400 hover:text-white"
            }`}
          >
            Settings
          </button>
          {stub.status === "online" && (
            <button
              onClick={() => setShowShell((v) => !v)}
              className={`px-3 py-1.5 text-xs border rounded transition-colors ${
                showShell
                  ? "bg-gray-700 border-gray-600 text-white"
                  : "bg-gray-900 border-gray-700 text-gray-400 hover:text-white"
              }`}
            >
              Shell
            </button>
          )}
          <button
            onClick={() => setShowTaskForm(true)}
            className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 rounded text-white transition-colors"
          >
            + New Task
          </button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3">Stub Settings</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Name</label>
              <input
                value={settingsName}
                onChange={(e) => setSettingsName(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Max Concurrent</label>
              <input
                type="number"
                min={1}
                value={settingsMaxConcurrent}
                onChange={(e) => setSettingsMaxConcurrent(parseInt(e.target.value) || 1)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Idle Timeout (s)</label>
              <input
                type="number"
                min={0}
                value={settingsIdleTimeout}
                onChange={(e) => setSettingsIdleTimeout(parseInt(e.target.value) || 0)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsAutoRelease}
                  onChange={(e) => setSettingsAutoRelease(e.target.checked)}
                  className="accent-blue-500"
                />
                Auto Release
              </label>
            </div>
            <div className="flex items-end gap-2">
              <button
                onClick={handleSaveSettings}
                disabled={settingsSaving}
                className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 rounded text-white disabled:opacity-50 transition-colors"
              >
                {settingsSaving ? "Saving..." : settingsSaved ? "Saved ✓" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Info tiles + GPU live stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <InfoTile label="GPU" value={stub.gpu.name} />
        <InfoTile label="GPU Count" value={`×${stub.gpu.count}`} />
        <InfoTile
          label="VRAM"
          value={`${Math.round(usedVram / 1024)}/${Math.round(totalVram / 1024)} GB`}
          warning={usedVram / totalVram > 0.9}
        />
        <InfoTile label="Concurrent" value={`${activeTasks.length}/${stub.max_concurrent}`} />
        {stub.type === "slurm" && stub.slurm_job_id && (
          <InfoTile label="SLURM Job" value={`#${stub.slurm_job_id}`} />
        )}
        {stub.remaining_walltime_s !== undefined && (
          <InfoTile
            label="Walltime Left"
            value={fmt(stub.remaining_walltime_s)}
            warning={stub.remaining_walltime_s < 1800}
          />
        )}
        {stub.slurm?.partition && (
          <InfoTile label="Partition" value={stub.slurm.partition} />
        )}
      </div>

      {/* Per-GPU stats */}
      {gpus.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Live GPU Stats</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {gpus.map((g, i) => (
              <div key={i} className="space-y-2">
                <div className="text-xs text-gray-400 font-medium">GPU {g.index}</div>
                <div className="space-y-1.5">
                  <div>
                    <div className="flex justify-between text-xs text-gray-500 mb-0.5">
                      <span>Util</span>
                      <span className={g.utilization_pct > 60 ? "text-green-400" : "text-gray-500"}>
                        {g.utilization_pct}%
                      </span>
                    </div>
                    <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          g.utilization_pct > 80 ? "bg-green-500" : g.utilization_pct > 40 ? "bg-blue-500" : "bg-gray-600"
                        }`}
                        style={{ width: `${g.utilization_pct}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs text-gray-500 mb-0.5">
                      <span>VRAM</span>
                      <span className={g.memory_used_mb / g.memory_total_mb > 0.8 ? "text-red-400" : "text-gray-500"}>
                        {Math.round(g.memory_used_mb / 1024)}/{Math.round(g.memory_total_mb / 1024)} GB
                      </span>
                    </div>
                    <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          g.memory_used_mb / g.memory_total_mb > 0.9
                            ? "bg-red-500"
                            : g.memory_used_mb / g.memory_total_mb > 0.7
                            ? "bg-yellow-500"
                            : "bg-purple-500"
                        }`}
                        style={{ width: `${Math.round((g.memory_used_mb / g.memory_total_mb) * 100)}%` }}
                      />
                    </div>
                  </div>
                  <div className="flex justify-between text-xs text-gray-600">
                    <span>Temp</span>
                    <span className={g.temperature_c > 80 ? "text-red-400" : g.temperature_c > 65 ? "text-yellow-400" : "text-gray-500"}>
                      {g.temperature_c}°C
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* GPU history chart */}
      {gpuHistory.length > 1 && (
        <GpuChart data={gpuHistory} />
      )}

      {/* Remote shell */}
      {showShell && (
        <RemoteShell stubId={stub.id} />
      )}

      {/* Tasks + Logs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-gray-300">Tasks ({stub.tasks.length})</h2>
            <div className="flex gap-1">
              {(["all", "active", "completed"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setTaskFilter(f)}
                  className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                    taskFilter === f
                      ? "bg-gray-700 border-gray-500 text-white"
                      : "border-gray-700 text-gray-500 hover:text-gray-300"
                  }`}
                >
                  {f === "all" ? `All (${stub.tasks.length})` : f === "active" ? `Active (${activeTasks.length})` : `Done (${completedTasks.length})`}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5 max-h-[500px] overflow-y-auto pr-1">
            {displayedTasks.length === 0 ? (
              <p className="text-gray-700 text-sm text-center py-8">No tasks</p>
            ) : (
              displayedTasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  lossHistory={lossHistory.get(task.id)}
                  onClick={() => setSelectedTaskId(task.id === selectedTaskId ? null : task.id)}
                  compact
                />
              ))
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-gray-300">
            Logs{selectedTask ? ` — ${selectedTask.command.slice(0, 40)}` : ""}
          </h2>

          {/* Loss chart for selected task */}
          {selectedTask && (() => {
            const lossData = lossHistory.get(selectedTask.id);
            if (!lossData || lossData.length < 2) return null;
            return (
              <LossChart
                data={lossData}
                height={120}
                startedAt={selectedTask.started_at}
                totalSteps={selectedTask.progress?.total}
              />
            );
          })()}

          {selectedTask ? (
            <LogViewer
              lines={logLines.length > 0 ? logLines : (selectedTask.log_buffer || [])}
              maxHeight="500px"
            />
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-xl flex items-center justify-center h-48 text-gray-700 text-sm">
              Select a task to view logs
            </div>
          )}
        </div>
      </div>

      {showTaskForm && (
        <TaskForm stubs={stubs} stubId={stub.id} onClose={() => setShowTaskForm(false)} />
      )}
    </div>
  );
}

function InfoTile({ label, value, warning }: { label: string; value: string; warning?: boolean }) {
  return (
    <div className={`bg-gray-900 rounded-lg p-3 border ${warning ? "border-yellow-700/70" : "border-gray-800"}`}>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-sm font-semibold mt-0.5 truncate ${warning ? "text-yellow-400" : "text-white"}`}>{value}</p>
    </div>
  );
}
