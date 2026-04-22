import { useState } from "react";
import { Stub, Task, tasksApi } from "../lib/api";
import TaskRow from "../components/TaskRow";
import TaskForm from "../components/TaskForm";

interface Props {
  stubs: Stub[];
}

type StatusFilter = "all" | "queued" | "running" | "paused" | "completed" | "failed" | "killed";

export default function TaskQueue({ stubs }: Props) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [stubFilter, setStubFilter] = useState<string>("all");
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [selectedStubId, setSelectedStubId] = useState<string>("");

  const allTasks: Array<Task & { stub_name: string }> = stubs.flatMap((s) =>
    s.tasks.map((t) => ({ ...t, stub_name: s.name }))
  );

  const filtered = allTasks.filter((t) => {
    if (statusFilter !== "all" && t.status !== statusFilter) return false;
    if (stubFilter !== "all" && t.stub_id !== stubFilter) return false;
    return true;
  });

  // Sort by created_at desc
  filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const handleSubmitToLeastBusy = () => {
    const online = stubs.filter((s) => s.status === "online");
    if (online.length === 0) return;
    const least = online.reduce((a, b) => {
      const aActive = a.tasks.filter((t) => ["running", "queued"].includes(t.status)).length;
      const bActive = b.tasks.filter((t) => ["running", "queued"].includes(t.status)).length;
      return aActive <= bActive ? a : b;
    });
    setSelectedStubId(least.id);
    setShowTaskForm(true);
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold text-white">Task Queue</h1>
        <div className="ml-auto">
          <button
            onClick={handleSubmitToLeastBusy}
            disabled={stubs.filter((s) => s.status === "online").length === 0}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 rounded text-white disabled:opacity-40"
          >
            + Submit Task (auto-assign)
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-300 focus:outline-none"
        >
          <option value="all">All statuses</option>
          <option value="queued">Queued</option>
          <option value="running">Running</option>
          <option value="paused">Paused</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="killed">Killed</option>
        </select>
        <select
          value={stubFilter}
          onChange={(e) => setStubFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-300 focus:outline-none"
        >
          <option value="all">All stubs</option>
          {stubs.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <span className="text-sm text-gray-500 self-center">{filtered.length} tasks</span>
      </div>

      {/* Task list */}
      <div className="space-y-2">
        {filtered.length === 0 ? (
          <div className="text-center py-20 text-gray-600">
            <p>No tasks found</p>
          </div>
        ) : (
          filtered.map((task) => (
            <div key={task.id}>
              <div className="text-xs text-gray-600 mb-1">
                {task.stub_name} · {new Date(task.created_at).toLocaleString()}
              </div>
              <TaskRow task={task} />
            </div>
          ))
        )}
      </div>

      {showTaskForm && selectedStubId && (
        <TaskForm
          stubId={selectedStubId}
          onClose={() => setShowTaskForm(false)}
        />
      )}
    </div>
  );
}
