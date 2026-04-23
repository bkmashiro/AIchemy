import { useState, useEffect } from "react";
import { AnomalyAlert, alertsApi } from "../lib/api";

interface Props {
  realtimeAlerts?: AnomalyAlert[];
  onResolve?: (id: string) => void;
}

const alertTypeColor: Record<string, string> = {
  stall: "text-orange-400 bg-orange-900/20 border-orange-800/40",
  gpu_idle: "text-yellow-400 bg-yellow-900/20 border-yellow-800/40",
  loss_nan: "text-red-400 bg-red-900/20 border-red-800/40",
  loss_spike: "text-amber-400 bg-amber-900/20 border-amber-800/40",
  no_output: "text-purple-400 bg-purple-900/20 border-purple-800/40",
};

const alertTypeIcon: Record<string, string> = {
  stall: "⚠",
  gpu_idle: "💤",
  loss_nan: "🔴",
  loss_spike: "📈",
  no_output: "🔇",
};

export default function AlertsPage({ realtimeAlerts, onResolve }: Props) {
  const [alerts, setAlerts] = useState<AnomalyAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await alertsApi.list();
      setAlerts(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  // Merge realtime alerts into local state
  useEffect(() => {
    if (!realtimeAlerts || realtimeAlerts.length === 0) return;
    setAlerts((prev) => {
      let next = [...prev];
      for (const a of realtimeAlerts) {
        const exists = next.find((x) => x.id === a.id);
        if (exists) {
          next = next.map((x) => (x.id === a.id ? a : x));
        } else {
          next = [a, ...next];
        }
      }
      return next;
    });
  }, [realtimeAlerts]);

  const handleResolve = async (id: string) => {
    setResolving(id);
    try {
      await alertsApi.resolve(id);
      setAlerts((prev) => prev.map((a) => a.id === id ? { ...a, resolved: true } : a));
      onResolve?.(id);
    } catch (err) {
      console.error(err);
    } finally {
      setResolving(null);
    }
  };

  const handleResolveAll = async () => {
    const unresolved = alerts.filter((a) => !a.resolved);
    for (const a of unresolved) {
      try { await alertsApi.resolve(a.id); } catch {}
    }
    setAlerts((prev) => prev.map((a) => ({ ...a, resolved: true })));
  };

  const displayed = showResolved ? alerts : alerts.filter((a) => !a.resolved);
  const unresolvedCount = alerts.filter((a) => !a.resolved).length;

  // Group by type for summary
  const typeCounts: Record<string, number> = {};
  for (const a of alerts.filter((x) => !x.resolved)) {
    typeCounts[a.type] = (typeCounts[a.type] || 0) + 1;
  }

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-bold text-white">Alerts</h1>
        {unresolvedCount > 0 && (
          <span className="bg-red-600 text-white text-xs px-2 py-0.5 rounded-full font-medium">
            {unresolvedCount} active
          </span>
        )}
        <div className="ml-auto flex gap-2 items-center">
          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
              className="accent-blue-500"
            />
            Show resolved
          </label>
          {unresolvedCount > 0 && (
            <button
              onClick={handleResolveAll}
              className="px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 hover:border-gray-600 rounded text-gray-400 hover:text-white transition-colors"
            >
              Resolve All
            </button>
          )}
        </div>
      </div>

      {/* Type summary chips */}
      {Object.keys(typeCounts).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(typeCounts).map(([type, count]) => (
            <span
              key={type}
              className={`text-xs px-3 py-1 rounded-full border ${alertTypeColor[type] || "text-gray-400 bg-gray-900 border-gray-700"}`}
            >
              {alertTypeIcon[type] || "⚠"} {type.replace(/_/g, " ")} × {count}
            </span>
          ))}
        </div>
      )}

      {loading ? (
        <div className="text-gray-600 text-sm">Loading...</div>
      ) : displayed.length === 0 ? (
        <div className="text-center py-24 text-gray-700">
          <div className="text-5xl mb-4">✅</div>
          <p className="text-sm font-medium text-gray-500">
            {unresolvedCount === 0 ? "No active alerts" : "No alerts to show"}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {displayed.map((alert) => (
            <div
              key={alert.id}
              className={`rounded-xl border px-4 py-3 transition-opacity ${
                alert.resolved ? "opacity-40" : ""
              } ${alertTypeColor[alert.type] || "text-gray-400 bg-gray-900/40 border-gray-800/40"}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className="text-xl">{alertTypeIcon[alert.type] || "⚠"}</span>
                  <div>
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-semibold">{alert.type.replace(/_/g, " ").toUpperCase()}</span>
                      <span className="text-xs text-gray-500 font-mono">{alert.stub_id.slice(0, 8)}</span>
                      {alert.task_id && (
                        <span className="text-xs text-gray-500 font-mono">task:{alert.task_id.slice(0, 8)}</span>
                      )}
                      {alert.resolved && (
                        <span className="text-xs text-green-600 bg-green-900/20 border border-green-800/30 px-1.5 py-0.5 rounded">resolved</span>
                      )}
                    </div>
                    <p className="text-sm text-gray-200">{alert.message}</p>
                    <p className="text-xs text-gray-500 mt-1">{new Date(alert.created_at).toLocaleString()}</p>
                  </div>
                </div>
                {!alert.resolved && (
                  <button
                    onClick={() => handleResolve(alert.id)}
                    disabled={resolving === alert.id}
                    className="shrink-0 px-2.5 py-1 text-xs bg-gray-900/60 hover:bg-gray-800 border border-gray-700/50 rounded text-gray-400 hover:text-white transition-colors disabled:opacity-50"
                  >
                    {resolving === alert.id ? "..." : "Resolve"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
