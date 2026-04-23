import { useState, useEffect } from "react";
import { Stub, api } from "../lib/api";
import { MigrationSuggestion } from "../hooks/useSocket";

interface Props {
  stubs: Stub[];
  migrationSuggestions: MigrationSuggestion[];
  onDismiss: (id: string) => void;
}

export default function MigrationsPage({ stubs, migrationSuggestions, onDismiss }: Props) {
  const [loading, setLoading] = useState(false);
  const [localSuggestions, setLocalSuggestions] = useState<MigrationSuggestion[]>([]);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Merge prop suggestions with locally fetched ones
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const res = await api.get<MigrationSuggestion[]>("/migrations/suggestions");
        setLocalSuggestions(res.data);
      } catch {}
      setLoading(false);
    };
    load();
  }, []);

  // Merge local + socket suggestions (deduplicated)
  const allSuggestions = [
    ...localSuggestions,
    ...migrationSuggestions.filter((s) => !localSuggestions.find((l) => l.id === s.id)),
  ];

  const showFeedback = (msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 2000);
  };

  const handleDismiss = async (id: string) => {
    setDismissing(id);
    try {
      await api.delete(`/migrations/suggestions/${id}`);
      setLocalSuggestions((prev) => prev.filter((s) => s.id !== id));
      onDismiss(id);
      showFeedback("Suggestion dismissed");
    } catch (err: any) {
      showFeedback(`Error: ${err.response?.data?.error || "Failed"}`);
    } finally {
      setDismissing(null);
    }
  };

  const getStubName = (id: string) => {
    const stub = stubs.find((s) => s.id === id);
    return stub ? stub.name : id.slice(0, 8) + "...";
  };

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold text-white">Load Balancing Suggestions</h1>
        {allSuggestions.length > 0 && (
          <span className="bg-blue-700 text-white text-xs px-2 py-0.5 rounded-full font-medium">
            {allSuggestions.length} pending
          </span>
        )}
        {feedback && <span className="text-xs text-green-400 ml-auto">{feedback}</span>}
      </div>

      <p className="text-sm text-gray-500">
        Alchemy automatically analyzes cluster load and suggests task migrations to improve balance.
      </p>

      {loading ? (
        <div className="text-gray-600 text-sm">Loading...</div>
      ) : allSuggestions.length === 0 ? (
        <div className="text-center py-24 text-gray-700">
          <div className="text-5xl mb-4">⚖️</div>
          <p className="text-sm font-medium text-gray-500">No migration suggestions</p>
          <p className="text-xs mt-1">Cluster is balanced</p>
        </div>
      ) : (
        <div className="space-y-3">
          {allSuggestions.map((s) => (
            <div
              key={s.id}
              className="bg-gray-900 border border-blue-800/30 rounded-xl p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-white font-medium">{getStubName(s.from_stub_id)}</span>
                      <span className="text-blue-400">→</span>
                      <span className="text-white font-medium">{getStubName(s.to_stub_id)}</span>
                    </div>
                  </div>
                  <p className="text-sm text-gray-400 mb-2">{s.reason}</p>
                  <div className="flex items-center gap-4 text-xs text-gray-600">
                    <span>Task: <span className="font-mono text-gray-500">{s.task_id.slice(0, 12)}...</span></span>
                    <span>{new Date(s.created_at).toLocaleString()}</span>
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => handleDismiss(s.id)}
                    disabled={dismissing === s.id}
                    className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-400 hover:text-white transition-colors disabled:opacity-50"
                  >
                    {dismissing === s.id ? "..." : "Dismiss"}
                  </button>
                </div>
              </div>

              {/* Stub utilization comparison */}
              <div className="mt-3 grid grid-cols-2 gap-3">
                {[
                  { id: s.from_stub_id, label: "From" },
                  { id: s.to_stub_id, label: "To" },
                ].map(({ id, label }) => {
                  const stub = stubs.find((st) => st.id === id);
                  if (!stub) return null;
                  const running = stub.tasks.filter((t) => t.status === "running").length;
                  const queued = stub.tasks.filter((t) => t.status === "queued").length;
                  const gpus = stub.gpu_stats?.gpus || [];
                  const vramPct = gpus.length > 0
                    ? Math.round((gpus.reduce((n, g) => n + g.memory_used_mb, 0) / gpus.reduce((n, g) => n + g.memory_total_mb, 0)) * 100)
                    : 0;
                  return (
                    <div key={id} className="bg-gray-800/50 rounded-lg px-3 py-2">
                      <div className="text-xs text-gray-500 mb-1">{label}: <span className="text-gray-300">{stub.name}</span></div>
                      <div className="flex gap-3 text-xs">
                        <span className="text-green-400">{running} running</span>
                        {queued > 0 && <span className="text-yellow-400">{queued} queued</span>}
                        <span className="text-gray-500 ml-auto">VRAM {vramPct}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
