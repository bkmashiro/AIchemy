import { useState, useEffect, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { Stub, GpuStats } from "../lib/api";
import TaskRow from "../components/TaskRow";
import GpuChart, { DataPoint } from "../components/GpuChart";
import LogViewer from "../components/LogViewer";
import TaskForm from "../components/TaskForm";
import RemoteShell from "../components/RemoteShell";

interface Props {
  stubs: Stub[];
}

export default function StubDetail({ stubs }: Props) {
  const { id } = useParams<{ id: string }>();
  const stub = stubs.find((s) => s.id === id);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [gpuHistory, setGpuHistory] = useState<DataPoint[]>([]);
  const [showShell, setShowShell] = useState(false);

  // Track GPU history
  const prevStats = useRef<GpuStats | null>(null);
  useEffect(() => {
    if (!stub) return;
    const stats = stub.gpu_stats;
    if (stats && stats !== prevStats.current) {
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
    }
  }, [stub?.gpu_stats]);

  if (!stub) {
    return (
      <div className="text-center py-20 text-gray-500">
        <p>Stub not found. <Link to="/" className="text-blue-400 hover:underline">Go back</Link></p>
      </div>
    );
  }

  const selectedTask = stub.tasks.find((t) => t.id === selectedTaskId) || stub.tasks[0] || null;

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Link to="/" className="text-gray-500 hover:text-white transition text-sm">← Dashboard</Link>
        <h1 className="text-xl font-bold text-white">{stub.name}</h1>
        <span
          className={`text-xs px-2 py-1 rounded-full text-white ${
            stub.status === "online" ? "bg-green-600" : stub.status === "stale" ? "bg-yellow-600" : "bg-gray-600"
          }`}
        >
          {stub.status}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => setShowShell((v) => !v)}
            className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 rounded text-gray-300"
          >
            {showShell ? "Hide Shell" : "Remote Shell"}
          </button>
          <button
            onClick={() => setShowTaskForm(true)}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 rounded text-white"
          >
            + New Task
          </button>
        </div>
      </div>

      {/* Stub info */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6 text-sm">
        <InfoCard label="GPU" value={stub.gpu.name} />
        <InfoCard label="VRAM" value={`${stub.gpu.vram_total_mb} MB`} />
        <InfoCard label="Max Concurrent" value={stub.max_concurrent.toString()} />
        {stub.type === "slurm" && stub.slurm_job_id && (
          <InfoCard label="SLURM Job" value={`#${stub.slurm_job_id}`} />
        )}
        {stub.remaining_walltime_s !== undefined && (
          <InfoCard
            label="Walltime Left"
            value={`${Math.round(stub.remaining_walltime_s / 60)}m`}
            warning={stub.remaining_walltime_s < 1800}
          />
        )}
      </div>

      {/* GPU chart */}
      {gpuHistory.length > 1 && (
        <div className="mb-6">
          <GpuChart data={gpuHistory} />
        </div>
      )}

      {/* Remote shell */}
      {showShell && (
        <div className="mb-6">
          <RemoteShell stubId={stub.id} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Task list */}
        <div>
          <h2 className="text-base font-semibold text-gray-300 mb-3">
            Tasks ({stub.tasks.length})
          </h2>
          <div className="space-y-2">
            {stub.tasks.length === 0 ? (
              <p className="text-gray-600 text-sm">No tasks</p>
            ) : (
              stub.tasks.slice().reverse().map((task) => (
                <div
                  key={task.id}
                  onClick={() => setSelectedTaskId(task.id)}
                  className={`cursor-pointer ${selectedTask?.id === task.id ? "ring-1 ring-blue-500 rounded-lg" : ""}`}
                >
                  <TaskRow task={task} />
                </div>
              ))
            )}
          </div>
        </div>

        {/* Log viewer */}
        <div>
          <h2 className="text-base font-semibold text-gray-300 mb-3">
            Logs {selectedTask ? `— ${selectedTask.command.slice(0, 40)}` : ""}
          </h2>
          {selectedTask ? (
            <LogViewer lines={selectedTask.log_buffer} maxHeight="400px" />
          ) : (
            <div className="bg-gray-900 rounded-lg border border-gray-800 p-6 text-gray-600 text-sm text-center">
              Select a task to view logs
            </div>
          )}
        </div>
      </div>

      {showTaskForm && (
        <TaskForm
          stubId={stub.id}
          onClose={() => setShowTaskForm(false)}
        />
      )}
    </div>
  );
}

function InfoCard({ label, value, warning }: { label: string; value: string; warning?: boolean }) {
  return (
    <div className={`bg-gray-900 rounded-lg p-3 border ${warning ? "border-yellow-600" : "border-gray-800"}`}>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-sm font-semibold mt-0.5 ${warning ? "text-yellow-400" : "text-white"}`}>{value}</p>
    </div>
  );
}
