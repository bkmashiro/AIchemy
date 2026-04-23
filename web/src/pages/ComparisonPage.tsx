import { useState, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Task, tasksApi } from "../lib/api";
import { MultiLossChart, SERIES_COLORS } from "../components/LossChart";
import { formatDuration } from "../lib/format";

interface TaskWithLoss extends Task {
  lossData?: number[];
}

export default function ComparisonPage() {
  const [searchParams] = useSearchParams();
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    const ids = searchParams.get("ids");
    return ids ? ids.split(",").filter(Boolean) : [];
  });
  const [tasksData, setTasksData] = useState<Record<string, TaskWithLoss>>({});
  const [lossHistories] = useState<Record<string, number[]>>({});
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  // Load all tasks for the selector
  useEffect(() => {
    tasksApi.listAll().then((tasks) => {
      setAllTasks(tasks);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  // Load detail for selected tasks
  useEffect(() => {
    for (const id of selectedIds) {
      if (tasksData[id]) continue;
      tasksApi.getGlobal(id).then((task) => {
        setTasksData((prev) => ({ ...prev, [id]: task }));
      }).catch(() => {});
    }
  }, [selectedIds]);

  const filteredTasks = useMemo(() => {
    if (!search.trim()) return allTasks.slice(0, 50);
    const q = search.toLowerCase();
    return allTasks
      .filter((t) =>
        t.command.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        (t.label || "").toLowerCase().includes(q)
      )
      .slice(0, 50);
  }, [allTasks, search]);

  const toggleTask = (id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 5) return prev; // max 5
      return [...prev, id];
    });
  };

  const selectedTasks = selectedIds
    .map((id) => tasksData[id] || allTasks.find((t) => t.id === id))
    .filter(Boolean) as Task[];

  const series = selectedTasks
    .filter((t) => lossHistories[t.id] && lossHistories[t.id].length > 0)
    .map((t, i) => ({
      id: t.id,
      label: t.label || t.id.slice(0, 8),
      color: SERIES_COLORS[i % SERIES_COLORS.length],
      data: lossHistories[t.id],
    }));

  // Compute duration for a task
  const getDuration = (t: Task) => {
    if (!t.started_at) return null;
    const end = t.finished_at ? new Date(t.finished_at).getTime() : Date.now();
    return end - new Date(t.started_at).getTime();
  };

  // Extract ALCHEMY_PARAMS from env
  const getParams = (t: Task) => {
    if (!t.env) return null;
    const raw = t.env["ALCHEMY_PARAMS"];
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch { return raw; }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold text-white">Task Comparison</h1>
        <span className="text-xs text-gray-500">{selectedIds.length}/5 selected</span>
      </div>

      <div className="flex gap-5">
        {/* Task selector */}
        <div className="w-72 shrink-0">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Select Tasks</h3>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tasks..."
              className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500 placeholder-gray-600 mb-3"
            />
            {loading ? (
              <p className="text-gray-600 text-xs">Loading...</p>
            ) : (
              <div className="space-y-1 max-h-96 overflow-y-auto">
                {filteredTasks.map((t) => {
                  const isSelected = selectedIds.includes(t.id);
                  const idx = selectedIds.indexOf(t.id);
                  const color = idx >= 0 ? SERIES_COLORS[idx % SERIES_COLORS.length] : null;
                  return (
                    <button
                      key={t.id}
                      onClick={() => toggleTask(t.id)}
                      disabled={!isSelected && selectedIds.length >= 5}
                      className={`w-full text-left px-2.5 py-2 rounded-lg border text-xs transition-colors ${
                        isSelected
                          ? "border-blue-600/60 bg-blue-900/20 text-white"
                          : "border-gray-800 hover:border-gray-700 text-gray-400 hover:text-white disabled:opacity-40"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {color && (
                          <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span
                              className={`text-xs font-medium ${
                                t.status === "running" ? "text-green-400" :
                                t.status === "completed" ? "text-blue-400" :
                                t.status === "failed" ? "text-red-400" : "text-gray-500"
                              }`}
                            >
                              {t.status}
                            </span>
                          </div>
                          <p className="font-mono truncate">{t.command.slice(0, 40)}</p>
                          {t.label && <p className="text-gray-600 truncate">{t.label}</p>}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Comparison panel */}
        <div className="flex-1 min-w-0 space-y-4">
          {selectedTasks.length === 0 ? (
            <div className="text-center py-24 text-gray-700 border border-gray-800 rounded-xl">
              <p className="text-4xl mb-3">⚖️</p>
              <p className="text-sm">Select 2–5 tasks to compare</p>
            </div>
          ) : (
            <>
              {/* Overlaid loss curves */}
              {series.length >= 2 && (
                <MultiLossChart series={series} height={260} />
              )}
              {series.length === 1 && (
                <p className="text-xs text-gray-600 italic">Select another task with loss data to overlay curves</p>
              )}

              {/* Side-by-side comparison table */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <div className="p-4 border-b border-gray-800">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Side-by-Side</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-800">
                        <th className="text-left text-gray-600 px-4 py-2 font-medium w-28">Field</th>
                        {selectedTasks.map((t, i) => (
                          <th key={t.id} className="text-left px-4 py-2 font-medium min-w-[200px]">
                            <div className="flex items-center gap-2">
                              <div
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length] }}
                              />
                              <span className="text-gray-300 truncate">
                                {t.label || t.id.slice(0, 8)}
                              </span>
                              <button
                                onClick={() => toggleTask(t.id)}
                                className="text-gray-600 hover:text-red-400 ml-auto shrink-0"
                              >
                                ✕
                              </button>
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <CompareRow label="Status" values={selectedTasks.map((t) => (
                        <span className={
                          t.status === "running" ? "text-green-400" :
                          t.status === "completed" ? "text-blue-400" :
                          t.status === "failed" ? "text-red-400" : "text-gray-400"
                        }>{t.status}</span>
                      ))} />
                      <CompareRow label="Command" values={selectedTasks.map((t) => (
                        <span className="font-mono text-gray-300 break-all">{t.command}</span>
                      ))} />
                      <CompareRow label="Duration" values={selectedTasks.map((t) => {
                        const d = getDuration(t);
                        return <span className="text-gray-300">{d ? formatDuration(d) : "—"}</span>;
                      })} />
                      <CompareRow label="Steps" values={selectedTasks.map((t) => (
                        <span className="text-gray-300 font-mono">
                          {t.progress ? `${t.progress.step.toLocaleString()} / ${t.progress.total.toLocaleString()}` : "—"}
                        </span>
                      ))} />
                      <CompareRow label="Final Loss" values={selectedTasks.map((t) => {
                        const hist = lossHistories[t.id];
                        const loss = hist && hist.length > 0 ? hist[hist.length - 1] : t.progress?.loss;
                        return <span className="text-gray-300 font-mono">{loss != null ? loss.toFixed(6) : "—"}</span>;
                      })} />
                      <CompareRow label="Min Loss" values={selectedTasks.map((t) => {
                        const hist = lossHistories[t.id];
                        const minL = hist && hist.length > 0 ? Math.min(...hist) : null;
                        return <span className="text-gray-300 font-mono">{minL != null ? minL.toFixed(6) : "—"}</span>;
                      })} />
                      <CompareRow label="ALCHEMY_PARAMS" values={selectedTasks.map((t) => {
                        const p = getParams(t);
                        if (!p) return <span className="text-gray-600">—</span>;
                        if (typeof p === "object") {
                          return (
                            <div className="space-y-0.5">
                              {Object.entries(p).map(([k, v]) => (
                                <div key={k} className="flex gap-1.5">
                                  <span className="text-gray-500">{k}:</span>
                                  <span className="text-gray-300 font-mono">{JSON.stringify(v)}</span>
                                </div>
                              ))}
                            </div>
                          );
                        }
                        return <span className="text-gray-300 font-mono">{String(p)}</span>;
                      })} />

                      {/* Metrics at final step */}
                      {selectedTasks.some((t) => t.metrics && Object.keys(t.metrics).length > 0) && (
                        <>
                          <tr className="border-t border-gray-800">
                            <td colSpan={selectedTasks.length + 1} className="px-4 py-2 text-xs text-gray-600 uppercase tracking-wider bg-gray-900/50">
                              Final Metrics
                            </td>
                          </tr>
                          {Array.from(new Set(selectedTasks.flatMap((t) => Object.keys(t.metrics || {})))).map((metric) => (
                            <CompareRow key={metric} label={metric} values={selectedTasks.map((t) => {
                              const v = t.metrics?.[metric];
                              return <span className="text-gray-300 font-mono">{v != null ? (typeof v === "number" ? v.toFixed(4) : v) : "—"}</span>;
                            })} />
                          ))}
                        </>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CompareRow({ label, values }: { label: string; values: React.ReactNode[] }) {
  return (
    <tr className="border-b border-gray-800/50 hover:bg-gray-800/20">
      <td className="px-4 py-2 text-gray-500 font-medium align-top whitespace-nowrap">{label}</td>
      {values.map((v, i) => (
        <td key={i} className="px-4 py-2 align-top">{v}</td>
      ))}
    </tr>
  );
}
