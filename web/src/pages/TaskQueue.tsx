import { useState, useMemo, useEffect } from "react";
import { Stub, Task, tasksApi } from "../lib/api";
import TaskRow from "../components/TaskRow";
import TaskForm from "../components/TaskForm";
import LogViewer from "../components/LogViewer";
import { LossChart } from "../components/LossChart";

interface Props {
  stubs: Stub[];
  globalQueue: Task[];
  lossHistory: Map<string, number[]>;
}

type StatusFilter = "all" | "active" | "queued" | "waiting" | "dispatched" | "running" | "paused" |
  "completed" | "completed_with_errors" | "failed" | "killed" | "interrupted" | "blocked" | "migrating";

const STATUS_GROUPS: Record<string, string[]> = {
  active: ["queued", "waiting", "dispatched", "running", "paused", "migrating"],
  terminal: ["completed", "completed_with_errors", "failed", "killed", "interrupted", "blocked"],
};

export default function TaskQueue({ stubs, globalQueue, lossHistory }: Props) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [stubFilter, setStubFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [cleanupHours, setCleanupHours] = useState(24);
  const [sortKey, setSortKey] = useState<"created" | "duration" | "status">("created");
  const [sortAsc, setSortAsc] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  const allStubTasks = useMemo(
    () => stubs.flatMap((s) => s.tasks.map((t) => ({ ...t, _stubName: s.name }))),
    [stubs]
  );

  const allTasks = useMemo(
    () => [
      ...globalQueue.map((t) => ({ ...t, _stubName: "Global Queue" })),
      ...allStubTasks,
    ],
    [globalQueue, allStubTasks]
  );

  // Status counts
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of allTasks) counts[t.status] = (counts[t.status] || 0) + 1;
    return counts;
  }, [allTasks]);

  const activeCount = useMemo(
    () => allTasks.filter((t) => STATUS_GROUPS.active.includes(t.status)).length,
    [allTasks]
  );

  const filtered = useMemo(() => {
    let tasks = allTasks;

    if (statusFilter === "active") {
      tasks = tasks.filter((t) => STATUS_GROUPS.active.includes(t.status));
    } else if (statusFilter !== "all") {
      tasks = tasks.filter((t) => t.status === statusFilter);
    }

    if (stubFilter === "global") {
      tasks = tasks.filter((t) => !t.stub_id || t.stub_id === "");
    } else if (stubFilter !== "all") {
      tasks = tasks.filter((t) => t.stub_id === stubFilter);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      tasks = tasks.filter(
        (t) =>
          t.command.toLowerCase().includes(q) ||
          t.id.toLowerCase().includes(q) ||
          (t.run_dir || "").toLowerCase().includes(q) ||
          (t._stubName || "").toLowerCase().includes(q)
      );
    }

    // Sort
    tasks = [...tasks].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "created") {
        cmp = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      } else if (sortKey === "status") {
        cmp = a.status.localeCompare(b.status);
      } else if (sortKey === "duration") {
        const da = a.started_at ? (Date.now() - new Date(a.started_at).getTime()) : 0;
        const db = b.started_at ? (Date.now() - new Date(b.started_at).getTime()) : 0;
        cmp = db - da;
      }
      return sortAsc ? -cmp : cmp;
    });

    return tasks;
  }, [allTasks, statusFilter, stubFilter, search, sortKey, sortAsc]);

  // Selected task for log panel
  const selectedTask = useMemo(() => {
    if (!selectedTaskId) return null;
    return (allTasks as any[]).find((t: any) => t.id === selectedTaskId) || null;
  }, [allTasks, selectedTaskId]);

  // Load logs for selected task
  useEffect(() => {
    if (!selectedTaskId || !selectedTask) {
      setLogLines([]);
      return;
    }
    const loadLogs = async () => {
      setLogLoading(true);
      try {
        if (selectedTask.stub_id && selectedTask.stub_id !== "") {
          const res = await tasksApi.logs(selectedTask.stub_id, selectedTask.id);
          setLogLines(res.lines);
        } else {
          setLogLines(selectedTask.log_buffer || []);
        }
      } catch {
        setLogLines(selectedTask.log_buffer || []);
      } finally {
        setLogLoading(false);
      }
    };
    loadLogs();
  }, [selectedTaskId, selectedTask?.status]);

  const toggleSelect = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(filtered.map((t) => t.id)));
  };

  const clearSelect = () => setSelectedIds(new Set());

  const showFeedback = (msg: string) => {
    setActionFeedback(msg);
    setTimeout(() => setActionFeedback(null), 2000);
  };

  const handleBatchKill = async () => {
    if (!selectedIds.size) return;
    if (!confirm(`Kill ${selectedIds.size} task(s)? Running tasks will be terminated.`)) return;
    try {
      const r = await tasksApi.batchKill(Array.from(selectedIds));
      showFeedback(`Killed ${r.results?.filter((x: any) => x.ok).length ?? selectedIds.size} tasks`);
      clearSelect();
    } catch (err) {
      console.error(err);
    }
  };

  const handleBatchRetry = async () => {
    if (!selectedIds.size) return;
    if (!confirm(`Retry ${selectedIds.size} task(s)?`)) return;
    try {
      const r = await tasksApi.batchRetry(Array.from(selectedIds));
      showFeedback(`Retried ${r.results?.filter((x: any) => x.ok).length ?? selectedIds.size} tasks`);
      clearSelect();
    } catch (err) {
      console.error(err);
    }
  };

  const handleBatchRequeue = async () => {
    if (!selectedIds.size) return;
    if (!confirm(`Requeue ${selectedIds.size} task(s)?`)) return;
    try {
      const r = await tasksApi.batchRequeue(Array.from(selectedIds));
      showFeedback(`Requeued ${r.results?.filter((x: any) => x.ok).length ?? selectedIds.size} tasks`);
      clearSelect();
    } catch (err) {
      console.error(err);
    }
  };

  const handleBatchDelete = async () => {
    if (!selectedIds.size) return;
    if (!confirm(`Delete ${selectedIds.size} task(s)? This cannot be undone.`)) return;
    try {
      const r = await tasksApi.batchDelete(Array.from(selectedIds));
      showFeedback(`Deleted ${r.results?.filter((x: any) => x.ok).length ?? selectedIds.size} tasks`);
      clearSelect();
    } catch (err) {
      console.error(err);
    }
  };

  const handleCleanup = async () => {
    if (!confirm(`Purge completed/failed tasks older than ${cleanupHours}h? This cannot be undone.`)) return;
    try {
      const r = await tasksApi.cleanup(cleanupHours);
      showFeedback(`Cleaned up ${r.purged} tasks`);
    } catch (err) {
      console.error(err);
    }
  };

  const SortBtn = ({ k, label }: { k: typeof sortKey; label: string }) => (
    <button
      onClick={() => { if (sortKey === k) setSortAsc((v) => !v); else { setSortKey(k); setSortAsc(false); } }}
      className={`px-2.5 py-1 text-xs rounded border transition-colors ${
        sortKey === k
          ? "bg-blue-900/30 border-blue-700/50 text-blue-300"
          : "bg-gray-800 border-gray-700 text-gray-400 hover:text-white"
      }`}
    >
      {label} {sortKey === k ? (sortAsc ? "▲" : "▼") : ""}
    </button>
  );

  return (
    <div className="flex gap-5 h-[calc(100vh-5rem)]">
      {/* Left panel: task list */}
      <div className="flex-1 min-w-0 flex flex-col gap-3">
        {/* Header */}
        <div className="flex items-center gap-3 flex-wrap shrink-0">
          <h1 className="text-lg font-bold text-white">Tasks</h1>
          <div className="flex gap-1.5 text-xs flex-wrap">
            {Object.entries(statusCounts).map(([s, n]) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s as StatusFilter)}
                className={`px-2 py-0.5 rounded-full border transition-colors ${
                  statusFilter === s
                    ? "bg-gray-700 border-gray-500 text-white"
                    : "border-gray-700 text-gray-500 hover:text-gray-300"
                }`}
              >
                {s}: {n}
              </button>
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => setShowTaskForm(true)}
              className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 rounded text-white font-medium transition-colors"
            >
              + Submit Task
            </button>
          </div>
        </div>

        {/* Filters row */}
        <div className="flex gap-2 flex-wrap items-center shrink-0">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
          >
            <option value="all">All statuses ({allTasks.length})</option>
            <option value="active">Active ({activeCount})</option>
            <option value="queued">Queued</option>
            <option value="waiting">Waiting</option>
            <option value="dispatched">Dispatched</option>
            <option value="running">Running</option>
            <option value="paused">Paused</option>
            <option value="completed">Completed</option>
            <option value="completed_with_errors">Completed w/ Errors</option>
            <option value="failed">Failed</option>
            <option value="killed">Killed</option>
            <option value="interrupted">Interrupted</option>
            <option value="blocked">Blocked</option>
          </select>

          <select
            value={stubFilter}
            onChange={(e) => setStubFilter(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
          >
            <option value="all">All stubs</option>
            <option value="global">Global Queue</option>
            {stubs.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>

          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search command, id, path..."
            className="flex-1 min-w-[160px] bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500 placeholder-gray-600"
          />

          <div className="flex gap-1">
            <SortBtn k="created" label="Time" />
            <SortBtn k="status" label="Status" />
            <SortBtn k="duration" label="Duration" />
          </div>

          <span className="text-xs text-gray-600">{filtered.length} tasks</span>
        </div>

        {/* Batch ops */}
        <div className="flex gap-2 items-center flex-wrap shrink-0">
          <button
            onClick={selectAll}
            className="px-2.5 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-400 hover:text-white transition-colors"
          >
            Select All
          </button>
          {selectedIds.size > 0 && (
            <>
              <span className="text-xs text-gray-400 font-medium">{selectedIds.size} selected</span>
              <button onClick={handleBatchKill} className="px-2.5 py-1 text-xs bg-red-900/50 hover:bg-red-800 border border-red-800/50 rounded text-red-300 transition-colors">
                Kill
              </button>
              <button onClick={handleBatchRetry} className="px-2.5 py-1 text-xs bg-blue-900/50 hover:bg-blue-800 border border-blue-800/50 rounded text-blue-300 transition-colors">
                Retry
              </button>
              <button onClick={handleBatchRequeue} className="px-2.5 py-1 text-xs bg-purple-900/50 hover:bg-purple-800 border border-purple-800/50 rounded text-purple-300 transition-colors">
                Requeue
              </button>
              <button onClick={handleBatchDelete} className="px-2.5 py-1 text-xs bg-gray-800 hover:bg-red-900/50 border border-gray-700 rounded text-gray-400 hover:text-red-300 transition-colors">
                Delete
              </button>
              <button onClick={clearSelect} className="px-2.5 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-500 transition-colors">
                Clear
              </button>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            {actionFeedback && (
              <span className="text-xs text-green-400">{actionFeedback}</span>
            )}
            <span className="text-xs text-gray-600">Cleanup older than</span>
            <input
              type="number"
              min={1}
              value={cleanupHours}
              onChange={(e) => setCleanupHours(parseInt(e.target.value) || 24)}
              className="w-14 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none"
            />
            <span className="text-xs text-gray-600">h</span>
            <button
              onClick={handleCleanup}
              className="px-2.5 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-400 hover:text-white transition-colors"
            >
              Cleanup
            </button>
          </div>
        </div>

        {/* Task list */}
        <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
          {filtered.length === 0 ? (
            <div className="text-center py-20 text-gray-700">
              <p className="text-4xl mb-3">📋</p>
              <p className="text-sm">No tasks found</p>
            </div>
          ) : (
            filtered.map((task: any) => (
              <TaskRow
                key={task.id}
                task={task}
                stubName={task._stubName}
                selected={selectedIds.has(task.id)}
                onSelect={(checked) => toggleSelect(task.id, checked)}
                lossHistory={lossHistory.get(task.id)}
                onClick={() => setSelectedTaskId(task.id === selectedTaskId ? null : task.id)}
                compact
              />
            ))
          )}
        </div>
      </div>

      {/* Right panel: task detail + logs */}
      {selectedTask ? (
        <div className="w-96 shrink-0 flex flex-col gap-3 overflow-hidden">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex-shrink-0">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-300">Task Detail</h3>
              <button
                onClick={() => setSelectedTaskId(null)}
                className="text-gray-600 hover:text-gray-400 text-xs"
              >
                ✕
              </button>
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex gap-2">
                <span className="text-gray-500 w-20 shrink-0">ID</span>
                <span className="text-gray-300 font-mono truncate">{selectedTask.id}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-500 w-20 shrink-0">Status</span>
                <span className="text-gray-300">{selectedTask.status}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-500 w-20 shrink-0">Command</span>
                <span className="text-gray-300 font-mono break-all">{selectedTask.command}</span>
              </div>
              {selectedTask.cwd && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-20 shrink-0">CWD</span>
                  <span className="text-gray-300 font-mono break-all">{selectedTask.cwd}</span>
                </div>
              )}
              {selectedTask.run_dir && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-20 shrink-0">Run Dir</span>
                  <span className="text-gray-300 font-mono break-all">{selectedTask.run_dir}</span>
                </div>
              )}
              {selectedTask.created_at && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-20 shrink-0">Created</span>
                  <span className="text-gray-300">{new Date(selectedTask.created_at).toLocaleString()}</span>
                </div>
              )}
              {selectedTask.started_at && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-20 shrink-0">Started</span>
                  <span className="text-gray-300">{new Date(selectedTask.started_at).toLocaleString()}</span>
                </div>
              )}
              {selectedTask.finished_at && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-20 shrink-0">Finished</span>
                  <span className="text-gray-300">{new Date(selectedTask.finished_at).toLocaleString()}</span>
                </div>
              )}
              {selectedTask.estimated_vram_mb && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-20 shrink-0">VRAM Est.</span>
                  <span className="text-gray-300">{selectedTask.estimated_vram_mb} MB</span>
                </div>
              )}
              {selectedTask.depends_on && selectedTask.depends_on.length > 0 && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-20 shrink-0">Depends on</span>
                  <div className="text-gray-300 font-mono break-all">
                    {selectedTask.depends_on.map((id: string) => (
                      <div key={id} className="truncate text-xs">{id}</div>
                    ))}
                  </div>
                </div>
              )}
              {selectedTask.retry_of && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-20 shrink-0">Retry of</span>
                  <span className="text-gray-300 font-mono truncate">{selectedTask.retry_of}</span>
                </div>
              )}
              {selectedTask.exit_code !== undefined && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-20 shrink-0">Exit Code</span>
                  <span className={selectedTask.exit_code === 0 ? "text-green-400" : "text-red-400"}>
                    {selectedTask.exit_code}
                  </span>
                </div>
              )}
              {selectedTask.env && Object.keys(selectedTask.env).length > 0 && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-20 shrink-0">Env</span>
                  <div className="text-gray-500 font-mono text-xs">
                    {Object.entries(selectedTask.env).slice(0, 4).map(([k, v]) => (
                      <div key={k}>{k}={String(v).slice(0, 30)}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Loss chart */}
          {(() => {
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

          <div className="flex-1 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-400">Logs</h3>
              {logLoading && <span className="text-xs text-gray-600">Loading...</span>}
            </div>
            <div className="flex-1 overflow-hidden">
              <LogViewer lines={logLines.length > 0 ? logLines : (selectedTask.log_buffer || [])} maxHeight="100%" />
            </div>
          </div>
        </div>
      ) : (
        <div className="w-72 shrink-0 flex items-center justify-center text-gray-700 text-sm border border-gray-800 rounded-xl">
          Click a task to view details
        </div>
      )}

      {showTaskForm && (
        <TaskForm stubs={stubs} onClose={() => setShowTaskForm(false)} />
      )}
    </div>
  );
}
