import { useState, useEffect } from "react";
import { auditApi } from "../lib/api";
import { formatTimeAgo } from "../lib/format";

interface AuditEntry {
  id?: string;
  timestamp: string;
  action: string;
  details?: any;
}

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [limit, setLimit] = useState(100);

  const load = async () => {
    try {
      const data = await auditApi.list(limit);
      setEntries(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err: any) {
      setError("Audit log unavailable");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [limit]);

  const toggleExpand = (idx: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const actionTypes = Array.from(new Set(entries.map((e) => e.action))).sort();

  const filtered = actionFilter === "all"
    ? entries
    : entries.filter((e) => e.action === actionFilter);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-lg font-bold text-white">Audit Log</h1>
        {!loading && !error && (
          <span className="text-xs text-gray-600">{entries.length} entries</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={load}
            className="px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 hover:border-gray-600 rounded text-gray-400 hover:text-white transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 items-center flex-wrap">
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
        >
          <option value="all">All actions</option>
          {actionTypes.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>

        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
        >
          <option value={50}>Last 50</option>
          <option value={100}>Last 100</option>
          <option value={250}>Last 250</option>
          <option value={500}>Last 500</option>
        </select>

        <span className="text-xs text-gray-600">Auto-refreshes every 10s</span>
      </div>

      {loading ? (
        <div className="text-gray-600 text-sm">Loading...</div>
      ) : error ? (
        <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-4 text-red-400 text-sm">
          {error}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-24 text-gray-700">
          <p className="text-4xl mb-3">📋</p>
          <p className="text-sm">No audit entries found</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-800 text-left">
                <th className="px-4 py-2.5 text-gray-500 font-medium w-36">Time</th>
                <th className="px-4 py-2.5 text-gray-500 font-medium w-40">Action</th>
                <th className="px-4 py-2.5 text-gray-500 font-medium">Details</th>
                <th className="px-4 py-2.5 text-gray-500 font-medium w-8"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry, idx) => {
                const expanded = expandedIds.has(idx);
                const hasDetails = entry.details && Object.keys(entry.details).length > 0;
                return (
                  <>
                    <tr
                      key={idx}
                      className="border-b border-gray-800/50 hover:bg-gray-800/30 cursor-pointer"
                      onClick={() => hasDetails && toggleExpand(idx)}
                    >
                      <td className="px-4 py-2.5 text-gray-500 font-mono whitespace-nowrap">
                        <span title={new Date(entry.timestamp).toLocaleString()}>
                          {formatTimeAgo(entry.timestamp)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="px-2 py-0.5 rounded bg-gray-800 border border-gray-700 text-gray-300 font-mono">
                          {entry.action}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-gray-400 truncate max-w-xs">
                        {entry.details
                          ? typeof entry.details === "string"
                            ? entry.details
                            : Object.entries(entry.details).slice(0, 3).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")
                          : "—"
                        }
                      </td>
                      <td className="px-4 py-2.5 text-gray-600">
                        {hasDetails && (
                          <span>{expanded ? "▲" : "▼"}</span>
                        )}
                      </td>
                    </tr>
                    {expanded && hasDetails && (
                      <tr key={`${idx}-detail`} className="border-b border-gray-800/50 bg-gray-800/20">
                        <td colSpan={4} className="px-4 py-3">
                          <pre className="text-xs text-gray-400 font-mono overflow-x-auto whitespace-pre-wrap">
                            {JSON.stringify(entry.details, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
