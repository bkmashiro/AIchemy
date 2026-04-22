import { Task } from "../lib/api";
import { tasksApi } from "../lib/api";

interface Props {
  task: Task;
  onUpdate?: () => void;
}

const statusColor: Record<string, string> = {
  queued: "text-yellow-400",
  running: "text-green-400",
  paused: "text-orange-400",
  completed: "text-blue-400",
  failed: "text-red-400",
  killed: "text-gray-400",
};

function duration(task: Task): string {
  const start = task.started_at ? new Date(task.started_at).getTime() : null;
  const end = task.finished_at ? new Date(task.finished_at).getTime() : null;
  if (!start) return "-";
  const ms = (end || Date.now()) - start;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

export default function TaskRow({ task, onUpdate }: Props) {
  const progressPct =
    task.progress ? Math.round((task.progress.step / task.progress.total) * 100) : null;

  const handleAction = async (action: "pause" | "resume" | "kill") => {
    try {
      await tasksApi.action(task.stub_id, task.id, action);
      onUpdate?.();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-xs font-medium ${statusColor[task.status] || "text-gray-400"}`}>
              {task.status.toUpperCase()}
            </span>
            {task.exit_code !== undefined && (
              <span className="text-xs text-gray-500">exit:{task.exit_code}</span>
            )}
            <span className="text-xs text-gray-500 ml-auto">{duration(task)}</span>
          </div>
          <p className="text-sm text-white font-mono truncate" title={task.command}>
            {task.command}
          </p>
          {task.progress && (
            <div className="mt-2">
              <div className="flex justify-between text-xs text-gray-400 mb-1">
                <span>
                  step {task.progress.step}/{task.progress.total}
                  {task.progress.loss !== undefined && ` · loss ${task.progress.loss.toFixed(4)}`}
                </span>
                <span>{progressPct}%</span>
              </div>
              <div className="h-1 bg-gray-800 rounded-full">
                <div
                  className="h-full bg-green-500 rounded-full transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}
        </div>
        <div className="flex gap-1 shrink-0">
          {task.status === "running" && (
            <button
              onClick={() => handleAction("pause")}
              className="px-2 py-1 text-xs bg-orange-900 hover:bg-orange-800 rounded text-orange-300"
            >
              Pause
            </button>
          )}
          {task.status === "paused" && (
            <button
              onClick={() => handleAction("resume")}
              className="px-2 py-1 text-xs bg-green-900 hover:bg-green-800 rounded text-green-300"
            >
              Resume
            </button>
          )}
          {["running", "paused", "queued"].includes(task.status) && (
            <button
              onClick={() => handleAction("kill")}
              className="px-2 py-1 text-xs bg-red-900 hover:bg-red-800 rounded text-red-300"
            >
              Kill
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
