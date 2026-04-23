import { useState, useEffect } from "react";
import { Workflow, WorkflowRun, workflowsApi } from "../lib/api";

const statusColor: Record<string, string> = {
  draft: "text-gray-400 bg-gray-800/60 border-gray-700",
  validating: "text-yellow-400 bg-yellow-900/20 border-yellow-800/40",
  ready: "text-green-400 bg-green-900/20 border-green-800/40",
};

const runStatusColor: Record<string, string> = {
  running: "text-green-400 bg-green-900/20 border-green-800/40",
  completed: "text-blue-400 bg-blue-900/20 border-blue-800/40",
  failed: "text-red-400 bg-red-900/20 border-red-800/40",
  paused: "text-orange-400 bg-orange-900/20 border-orange-800/40",
  cancelled: "text-gray-400 bg-gray-800/60 border-gray-700",
};

const nodeStatusColor: Record<string, string> = {
  pending: "bg-gray-700",
  ready: "bg-yellow-600",
  running: "bg-green-500",
  completed: "bg-blue-500",
  failed: "bg-red-500",
  skipped: "bg-gray-600",
};

function RunCard({ run, onAction }: { run: WorkflowRun; onAction: (runId: string, action: string) => void }) {
  const completed = run.nodes.filter((n) => n.status === "completed").length;
  const failed = run.nodes.filter((n) => n.status === "failed").length;
  const running = run.nodes.filter((n) => n.status === "running").length;
  const pct = run.nodes.length > 0 ? Math.round((completed / run.nodes.length) * 100) : 0;

  return (
    <div className="bg-gray-800/50 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <span className="text-xs text-gray-500 font-mono">{run.id.slice(0, 12)}...</span>
          <div className="flex items-center gap-2 mt-0.5">
            <span className={`text-xs px-2 py-0.5 rounded-full border ${runStatusColor[run.status] || "text-gray-400"}`}>
              {run.status}
            </span>
            <span className="text-xs text-gray-500">
              {new Date(run.created_at).toLocaleString()}
            </span>
          </div>
        </div>
        <div className="flex gap-1.5">
          {run.status === "running" && (
            <button
              onClick={() => onAction(run.id, "pause")}
              className="px-2.5 py-1 text-xs bg-orange-900/40 hover:bg-orange-900/70 border border-orange-800/50 rounded text-orange-300 transition-colors"
            >
              Pause
            </button>
          )}
          {run.status === "paused" && (
            <button
              onClick={() => onAction(run.id, "resume")}
              className="px-2.5 py-1 text-xs bg-green-900/40 hover:bg-green-900/70 border border-green-800/50 rounded text-green-300 transition-colors"
            >
              Resume
            </button>
          )}
          {run.status === "failed" && (
            <button
              onClick={() => onAction(run.id, "retry")}
              className="px-2.5 py-1 text-xs bg-blue-900/40 hover:bg-blue-900/70 border border-blue-800/50 rounded text-blue-300 transition-colors"
            >
              Retry
            </button>
          )}
          {(run.status === "running" || run.status === "paused") && (
            <button
              onClick={() => onAction(run.id, "cancel")}
              className="px-2.5 py-1 text-xs bg-red-900/30 hover:bg-red-900/60 border border-red-900/50 rounded text-red-400 transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Progress */}
      <div className="mb-3">
        <div className="flex justify-between text-xs text-gray-500 mb-1">
          <span>
            {completed}/{run.nodes.length} nodes
            {running > 0 && <span className="text-green-400 ml-2">{running} running</span>}
            {failed > 0 && <span className="text-red-400 ml-2">{failed} failed</span>}
          </span>
          <span>{pct}%</span>
        </div>
        <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* Node dots */}
      <div className="flex flex-wrap gap-1">
        {run.nodes.map((node) => (
          <div
            key={node.node_id}
            title={`${node.node_id}: ${node.status}`}
            className={`w-4 h-4 rounded-sm ${nodeStatusColor[node.status] || "bg-gray-700"} cursor-help`}
          />
        ))}
      </div>

      {/* Variables */}
      {run.variables && Object.keys(run.variables).length > 0 && (
        <div className="mt-2 text-xs text-gray-600 font-mono">
          {Object.entries(run.variables).slice(0, 3).map(([k, v]) => (
            <span key={k} className="mr-3">{k}={JSON.stringify(v)}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function WorkflowDetail({ workflow }: { workflow: Workflow }) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [running, setRunning] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const data = await workflowsApi.getRuns(workflow.id);
        setRuns(data);
      } catch {}
      setLoadingRuns(false);
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [workflow.id]);

  const showFeedback = (msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 2000);
  };

  const handleRun = async () => {
    setRunning(true);
    try {
      const run = await workflowsApi.run(workflow.id);
      setRuns((prev) => [run, ...prev]);
      showFeedback("Workflow started");
    } catch (err: any) {
      showFeedback(`Error: ${err.response?.data?.error || "Failed to start"}`);
    } finally {
      setRunning(false);
    }
  };

  const handleAction = async (runId: string, action: string) => {
    try {
      if (action === "pause") await workflowsApi.pauseRun(runId);
      else if (action === "resume") await workflowsApi.resumeRun(runId);
      else if (action === "cancel") await workflowsApi.cancelRun(runId);
      else if (action === "retry") await workflowsApi.retryRun(runId);
      showFeedback(`Run ${action}d`);
    } catch (err: any) {
      showFeedback(`Error: ${err.response?.data?.error || "Failed"}`);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-semibold text-gray-300">{workflow.name}</h3>
        {feedback && <span className="text-xs text-green-400">{feedback}</span>}
        <div className="ml-auto">
          {workflow.status === "ready" && (
            <button
              onClick={handleRun}
              disabled={running}
              className="px-3 py-1.5 text-xs bg-green-700 hover:bg-green-600 rounded text-white transition-colors disabled:opacity-50"
            >
              {running ? "Starting..." : "▶ Run"}
            </button>
          )}
        </div>
      </div>

      {workflow.description && (
        <p className="text-xs text-gray-500">{workflow.description}</p>
      )}

      <div className="flex gap-3 text-xs">
        <span className={`px-2 py-0.5 rounded-full border ${statusColor[workflow.status] || "text-gray-400"}`}>
          {workflow.status}
        </span>
        <span className="text-gray-600">{workflow.nodes.length} nodes</span>
        <span className="text-gray-600">{new Date(workflow.created_at).toLocaleString()}</span>
      </div>

      <div>
        <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">Runs ({runs.length})</h4>
        {loadingRuns ? (
          <div className="text-gray-600 text-xs">Loading...</div>
        ) : runs.length === 0 ? (
          <div className="text-gray-600 text-xs py-4 text-center">No runs yet</div>
        ) : (
          <div className="space-y-3 max-h-[480px] overflow-y-auto">
            {runs.map((run) => (
              <RunCard key={run.id} run={run} onAction={handleAction} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await workflowsApi.list();
      setWorkflows(data);
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this workflow?")) return;
    try {
      await workflowsApi.delete(id);
      setWorkflows((prev) => prev.filter((w) => w.id !== id));
      if (selectedId === id) setSelectedId(null);
      setFeedback("Workflow deleted");
      setTimeout(() => setFeedback(null), 1500);
    } catch {}
  };

  const selected = workflows.find((w) => w.id === selectedId);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold text-white">Workflows</h1>
        {feedback && <span className="text-xs text-green-400">{feedback}</span>}
      </div>

      {loading ? (
        <div className="text-gray-600 text-sm">Loading...</div>
      ) : workflows.length === 0 ? (
        <div className="text-center py-24 text-gray-700">
          <div className="text-5xl mb-4">🔗</div>
          <p className="text-sm font-medium text-gray-500">No workflows defined</p>
          <p className="text-xs mt-1 text-gray-700">Create workflows via the SDK or API</p>
        </div>
      ) : (
        <div className="flex gap-5">
          {/* Workflow list */}
          <div className="w-80 shrink-0 space-y-2">
            {workflows.map((wf) => (
              <div
                key={wf.id}
                onClick={() => setSelectedId(wf.id === selectedId ? null : wf.id)}
                className={`bg-gray-900 border rounded-xl p-4 cursor-pointer transition-all ${
                  selectedId === wf.id
                    ? "border-blue-600/60"
                    : "border-gray-800 hover:border-gray-700"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-white truncate">{wf.name}</h3>
                    {wf.description && (
                      <p className="text-xs text-gray-500 truncate mt-0.5">{wf.description}</p>
                    )}
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full border shrink-0 ${statusColor[wf.status] || "text-gray-400"}`}>
                    {wf.status}
                  </span>
                </div>
                <div className="flex items-center justify-between mt-3">
                  <div className="flex gap-2 text-xs text-gray-600">
                    <span>{wf.nodes.length} nodes</span>
                    <span>·</span>
                    <span>{new Date(wf.created_at).toLocaleDateString()}</span>
                  </div>
                  <button
                    onClick={(e) => handleDelete(wf.id, e)}
                    className="px-2 py-0.5 text-xs bg-red-900/20 hover:bg-red-900/50 border border-red-900/40 rounded text-red-500 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Detail panel */}
          {selected ? (
            <div className="flex-1 bg-gray-900 border border-gray-800 rounded-xl p-5 overflow-y-auto">
              <WorkflowDetail workflow={selected} />
            </div>
          ) : (
            <div className="flex-1 border border-gray-800 rounded-xl flex items-center justify-center text-gray-700 text-sm">
              Select a workflow to view runs
            </div>
          )}
        </div>
      )}
    </div>
  );
}
