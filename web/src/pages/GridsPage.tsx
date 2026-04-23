import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Stub, GridTask, gridsApi } from "../lib/api";

interface Props {
  stubs: Stub[];
}

function statusColor(s: string) {
  const m: Record<string, string> = {
    pending: "text-yellow-400 bg-yellow-900/20 border-yellow-800/40",
    running: "text-green-400 bg-green-900/20 border-green-800/40",
    completed: "text-blue-400 bg-blue-900/20 border-blue-800/40",
    partial: "text-amber-400 bg-amber-900/20 border-amber-800/40",
    failed: "text-red-400 bg-red-900/20 border-red-800/40",
  };
  return m[s] || "text-gray-400 bg-gray-900/20 border-gray-800/40";
}

function cellColor(s: string) {
  const m: Record<string, string> = {
    pending: "bg-yellow-800/60",
    running: "bg-green-600",
    completed: "bg-blue-600",
    failed: "bg-red-600",
  };
  return m[s] || "bg-gray-700";
}

export default function GridsPage({ stubs }: Props) {
  const navigate = useNavigate();
  const [grids, setGrids] = useState<GridTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedGrid, setSelectedGrid] = useState<GridTask | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await gridsApi.list();
      setGrids(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const loadDetail = async (grid: GridTask) => {
    try {
      const detail = await gridsApi.get(grid.id);
      setSelectedGrid(detail);
    } catch {}
  };

  const showFeedback = (msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 2000);
  };

  const handleRetryFailed = async (gridId: string) => {
    if (!confirm("Retry all failed cells in this grid?")) return;
    setActing(gridId);
    try {
      const r = await gridsApi.retryFailed(gridId);
      showFeedback(`Retried ${r.retried} cells`);
      load();
    } catch (err) {
      console.error(err);
    } finally {
      setActing(null);
    }
  };

  const handleDelete = async (gridId: string) => {
    if (!confirm("Kill and delete this grid task?")) return;
    setActing(gridId);
    try {
      await gridsApi.delete(gridId);
      showFeedback("Grid deleted");
      if (selectedGrid?.id === gridId) setSelectedGrid(null);
      load();
    } catch (err) {
      console.error(err);
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold text-white">Grid Tasks</h1>
        {feedback && <span className="text-xs text-green-400">{feedback}</span>}
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => setShowCreateForm((v) => !v)}
            className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 rounded text-white transition-colors"
          >
            + Create Grid
          </button>
        </div>
      </div>

      {showCreateForm && (
        <CreateGridForm stubs={stubs} onCreated={() => { load(); setShowCreateForm(false); }} onCancel={() => setShowCreateForm(false)} />
      )}

      {loading ? (
        <div className="text-gray-600 text-sm">Loading...</div>
      ) : grids.length === 0 ? (
        <div className="text-center py-24 text-gray-700">
          <div className="text-5xl mb-4">🔲</div>
          <p className="text-sm font-medium text-gray-500">No grid tasks yet</p>
          <p className="text-xs mt-1">Create a grid to run hyperparameter sweeps</p>
        </div>
      ) : (
        <div className="flex gap-5">
          {/* Grid list */}
          <div className="flex-1 space-y-3">
            {grids.map((grid) => {
              const cells = grid.cells || [];
              const completed = cells.filter((c) => c.status === "completed").length;
              const running = cells.filter((c) => c.status === "running").length;
              const failed = cells.filter((c) => c.status === "failed").length;
              const pending = cells.filter((c) => c.status === "pending").length;
              const pct = cells.length > 0 ? Math.round((completed / cells.length) * 100) : 0;

              return (
                <div
                  key={grid.id}
                  onClick={() => { setSelectedGrid(grid); loadDetail(grid); }}
                  className={`bg-gray-900 border rounded-xl p-4 cursor-pointer transition-all ${
                    selectedGrid?.id === grid.id
                      ? "border-blue-600/60"
                      : "border-gray-800 hover:border-gray-700"
                  }`}
                >
                  <div className="flex items-start justify-between mb-2 gap-3">
                    <div className="min-w-0">
                      <h3 className="font-semibold text-white truncate">{grid.name}</h3>
                      <p className="text-xs text-gray-500 font-mono truncate mt-0.5">{grid.command_template}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${statusColor(grid.status)}`}>
                        {grid.status}
                      </span>
                    </div>
                  </div>

                  <div className="mb-2">
                    <div className="flex justify-between text-xs text-gray-500 mb-1">
                      <span>
                        {completed}/{cells.length} cells
                        {running > 0 && <span className="text-green-400 ml-2">{running} running</span>}
                        {failed > 0 && <span className="text-red-400 ml-2">{failed} failed</span>}
                        {pending > 0 && <span className="text-yellow-400 ml-2">{pending} pending</span>}
                      </span>
                      <span>{pct}%</span>
                    </div>
                    <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div className="h-full bg-blue-600 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-xs text-gray-600">
                    <span>{new Date(grid.created_at).toLocaleString()}</span>
                    <span>·</span>
                    <span>{Object.keys(grid.parameters || {}).length} params</span>
                    {grid.stub_id && <span className="ml-auto">stub: {grid.stub_id.slice(0, 8)}</span>}

                    <div className="ml-auto flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                      {failed > 0 && (
                        <button
                          onClick={() => handleRetryFailed(grid.id)}
                          disabled={acting === grid.id}
                          className="px-2 py-0.5 text-xs bg-blue-900/50 hover:bg-blue-800 border border-blue-800/50 rounded text-blue-300 transition-colors"
                        >
                          Retry Failed
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(grid.id)}
                        disabled={acting === grid.id}
                        className="px-2 py-0.5 text-xs bg-red-900/30 hover:bg-red-900/60 border border-red-900/50 rounded text-red-400 transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Grid detail panel */}
          {selectedGrid && (
            <div className="w-[440px] shrink-0 bg-gray-900 border border-gray-800 rounded-xl p-4 overflow-y-auto max-h-[600px]">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-300">{selectedGrid.name}</h3>
                <div className="flex items-center gap-2">
                  {selectedGrid.cells && selectedGrid.cells.some((c) => c.task_id) && (
                    <button
                      onClick={() => {
                        const ids = selectedGrid.cells
                          .filter((c) => c.task_id)
                          .slice(0, 5)
                          .map((c) => c.task_id!)
                          .join(",");
                        navigate(`/compare?ids=${ids}`);
                      }}
                      className="px-2 py-0.5 text-xs bg-blue-900/40 hover:bg-blue-900/70 border border-blue-800/50 rounded text-blue-300 transition-colors"
                    >
                      Compare
                    </button>
                  )}
                  <button onClick={() => setSelectedGrid(null)} className="text-gray-600 hover:text-gray-400 text-xs">✕</button>
                </div>
              </div>

              {/* Parameters */}
              <div className="mb-4">
                <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">Parameters</h4>
                <div className="space-y-1">
                  {Object.entries(selectedGrid.parameters || {}).map(([k, vals]) => (
                    <div key={k} className="flex gap-2 text-xs">
                      <span className="text-gray-400 w-24 shrink-0 font-mono">{k}</span>
                      <span className="text-gray-500">
                        [{(vals as any[]).map((v) => JSON.stringify(v)).join(", ")}]
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Cell grid */}
              <div className="mb-4">
                <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">
                  Cells ({selectedGrid.cells?.length || 0})
                </h4>
                <div className="flex flex-wrap gap-1">
                  {(selectedGrid.cells || []).map((cell) => (
                    <div
                      key={cell.id}
                      title={JSON.stringify(cell.params, null, 2)}
                      className={`w-5 h-5 rounded-sm ${cellColor(cell.status)} cursor-help transition-colors`}
                    />
                  ))}
                </div>
                <div className="flex gap-3 mt-2 text-xs">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-600 inline-block" /> completed</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-green-600 inline-block" /> running</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-yellow-800/60 inline-block" /> pending</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-600 inline-block" /> failed</span>
                </div>
              </div>

              {/* Best metrics */}
              {selectedGrid.cells?.some((c) => c.metrics && Object.keys(c.metrics).length > 0) && (
                <div>
                  <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">Cell Results</h4>
                  <div className="space-y-1 text-xs max-h-48 overflow-y-auto">
                    {selectedGrid.cells.filter((c) => c.metrics).map((cell) => (
                      <div key={cell.id} className="flex gap-2 items-start py-1 border-b border-gray-800">
                        <span className={`text-xs px-1 rounded ${cellColor(cell.status)} text-white shrink-0`}>{cell.status.slice(0, 1).toUpperCase()}</span>
                        <span className="text-gray-500 font-mono truncate flex-1">
                          {Object.entries(cell.params).map(([k, v]) => `${k}=${v}`).join(" ")}
                        </span>
                        {cell.metrics && (
                          <span className="text-gray-300 font-mono shrink-0">
                            {Object.entries(cell.metrics).slice(0, 2).map(([k, v]) =>
                              `${k}=${typeof v === "number" ? v.toFixed(3) : v}`
                            ).join(" ")}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CreateGridForm({ stubs, onCreated, onCancel }: { stubs: Stub[]; onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [commandTemplate, setCommandTemplate] = useState("");
  const [paramsJson, setParamsJson] = useState('{\n  "lr": [0.001, 0.0001],\n  "batch_size": [32, 64]\n}');
  const [stubId, setStubId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !commandTemplate.trim()) {
      setError("Name and command template are required");
      return;
    }
    let params: Record<string, any[]>;
    try {
      params = JSON.parse(paramsJson);
    } catch {
      setError("Parameters must be valid JSON");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await gridsApi.create({
        name: name.trim(),
        command_template: commandTemplate.trim(),
        parameters: params,
        stub_id: stubId || undefined,
      });
      onCreated();
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to create grid");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-white mb-4">Create Grid Task</h3>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-gray-400 block mb-1.5">Name *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="lr-sweep-2024"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1.5">Target Stub</label>
            <select
              value={stubId}
              onChange={(e) => setStubId(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
            >
              <option value="">Auto-dispatch</option>
              {stubs.filter((s) => s.status === "online").map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1.5">Command Template *</label>
          <input
            value={commandTemplate}
            onChange={(e) => setCommandTemplate(e.target.value)}
            placeholder="python train.py --lr {lr} --batch-size {batch_size}"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1.5">Parameters (JSON object of arrays)</label>
          <textarea
            value={paramsJson}
            onChange={(e) => setParamsJson(e.target.value)}
            rows={5}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-blue-500 resize-none"
          />
        </div>
        {error && <div className="text-red-400 text-sm bg-red-900/20 border border-red-800/50 rounded-lg px-3 py-2">{error}</div>}
        <div className="flex gap-3 justify-end">
          <button type="button" onClick={onCancel} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
          <button type="submit" disabled={loading} className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 rounded-lg text-white disabled:opacity-50 transition-colors font-medium">
            {loading ? "Creating..." : "Create Grid"}
          </button>
        </div>
      </form>
    </div>
  );
}
