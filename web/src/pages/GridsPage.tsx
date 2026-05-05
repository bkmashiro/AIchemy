import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Grid, gridsApi } from "../lib/api";
import { formatRelTime } from "../lib/format";

const STATUS_BADGE: Record<string, string> = {
  pending:   "bg-yellow-900/30 text-yellow-400 border-yellow-700/40",
  running:   "bg-blue-900/30 text-blue-400 border-blue-700/40",
  partial:   "bg-orange-900/30 text-orange-400 border-orange-700/40",
  completed: "bg-green-900/30 text-green-400 border-green-700/40",
  failed:    "bg-red-900/30 text-red-400 border-red-700/40",
};

export default function GridsPage() {
  const [grids, setGrids] = useState<Grid[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = () => {
    gridsApi.list()
      .then(setGrids)
      .catch(() => setError("Failed to load grids"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  if (loading && grids.length === 0) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-500">
        Loading grids...
      </div>
    );
  }

  if (error && grids.length === 0) {
    return (
      <div className="flex items-center justify-center py-24 text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">Grids</h1>
        <span className="text-xs text-gray-500">{grids.length} total</span>
      </div>

      {grids.length === 0 ? (
        <div className="text-center py-24 text-gray-700">
          <p className="text-lg font-medium text-gray-500">No grids yet</p>
          <p className="text-sm mt-1">Use <code className="bg-gray-800 px-1 rounded">alchemy grid</code> CLI to create one</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">Name</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">Status</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">Script</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">Tasks</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {grids.map((grid) => {
                const badge = STATUS_BADGE[grid.status] || "bg-gray-800 text-gray-400 border-gray-700";
                return (
                  <tr key={grid.id} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-3">
                      <Link
                        to={`/grids/${grid.id}`}
                        className="text-blue-400 hover:text-blue-300 font-medium transition-colors"
                      >
                        {grid.display_name}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded border ${badge}`}>
                        {grid.status.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400 font-mono truncate max-w-[200px]">
                      {grid.script}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 tabular-nums">
                      {grid.task_ids.length}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">
                      {formatRelTime(grid.created_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
