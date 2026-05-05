import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { Stub, stubsApi } from "../lib/api";
import { formatBytes, formatRelTime } from "../lib/format";

function VramBar({ usedMb, totalMb }: { usedMb: number; totalMb: number }) {
  const pct = totalMb > 0 ? Math.min(100, Math.round((usedMb / totalMb) * 100)) : 0;
  const color = pct > 90 ? "bg-red-500" : pct > 70 ? "bg-yellow-500" : "bg-purple-500";
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-400 tabular-nums whitespace-nowrap">
        {formatBytes(usedMb)}/{formatBytes(totalMb)}
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: "online" | "offline" }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold border ${
      status === "online"
        ? "bg-green-900/30 text-green-400 border-green-700/40"
        : "bg-gray-800/60 text-gray-500 border-gray-700/40"
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${status === "online" ? "bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.5)]" : "bg-gray-600"}`} />
      {status}
    </span>
  );
}

function TypeBadge({ type }: { type: "slurm" | "workstation" }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs border ${
      type === "slurm"
        ? "text-blue-400 bg-blue-900/20 border-blue-800/40"
        : "text-teal-400 bg-teal-900/20 border-teal-800/40"
    }`}>
      {type}
    </span>
  );
}

// Desktop table row
function StubTableRow({ stub }: { stub: Stub }) {
  const gpus = stub.gpu_stats?.gpus || [];
  const totalVram = gpus.length > 0
    ? gpus.reduce((n, g) => n + g.memory_total_mb, 0)
    : stub.gpu.vram_total_mb * stub.gpu.count;
  const usedVram = gpus.reduce((n, g) => n + g.memory_used_mb, 0);
  const running = stub.tasks.filter((t) => t.status === "running").length;
  const isOnline = stub.status === "online";

  return (
    <tr className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors ${!isOnline ? "opacity-60" : ""}`}>
      <td className="px-4 py-3">
        <StatusBadge status={stub.status} />
      </td>
      <td className="px-4 py-3">
        <Link
          to={`/stubs/${stub.id}`}
          className="text-sm font-medium text-white hover:text-blue-400 transition-colors"
        >
          {stub.name}
        </Link>
      </td>
      <td className="px-4 py-3">
        <span className="text-sm text-gray-400 font-mono">{stub.hostname}</span>
      </td>
      <td className="px-4 py-3">
        <span className="text-sm text-gray-300">
          {stub.gpu.name}
          {stub.gpu.count > 1 && <span className="text-gray-500"> ×{stub.gpu.count}</span>}
        </span>
      </td>
      <td className="px-4 py-3">
        <VramBar usedMb={usedVram} totalMb={totalVram} />
      </td>
      <td className="px-4 py-3">
        <span className="text-sm tabular-nums">
          <span className={running > 0 ? "text-blue-400" : "text-gray-500"}>{running}</span>
          <span className="text-gray-600">/{stub.max_concurrent}</span>
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {stub.tags && stub.tags.length > 0
            ? stub.tags.map((tag) => (
                <span key={tag} className="text-xs bg-gray-800 text-gray-500 rounded px-1.5 py-0.5 font-mono">
                  {tag}
                </span>
              ))
            : <span className="text-gray-700 text-xs">—</span>
          }
        </div>
      </td>
      <td className="px-4 py-3">
        <TypeBadge type={stub.type} />
      </td>
      <td className="px-4 py-3">
        {!isOnline ? (
          <span className="text-xs text-gray-600">{formatRelTime(stub.last_heartbeat)}</span>
        ) : (
          <span className="text-gray-700 text-xs">—</span>
        )}
      </td>
    </tr>
  );
}

// Mobile card
function StubCard({ stub }: { stub: Stub }) {
  const gpus = stub.gpu_stats?.gpus || [];
  const totalVram = gpus.length > 0
    ? gpus.reduce((n, g) => n + g.memory_total_mb, 0)
    : stub.gpu.vram_total_mb * stub.gpu.count;
  const usedVram = gpus.reduce((n, g) => n + g.memory_used_mb, 0);
  const running = stub.tasks.filter((t) => t.status === "running").length;
  const isOnline = stub.status === "online";

  return (
    <div className={`bg-gray-900 border border-gray-800 rounded-xl p-4 ${!isOnline ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <Link to={`/stubs/${stub.id}`} className="font-semibold text-white hover:text-blue-400 transition-colors">
            {stub.name}
          </Link>
          <p className="text-xs text-gray-500 font-mono mt-0.5">{stub.hostname}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge status={stub.status} />
          <TypeBadge type={stub.type} />
        </div>
      </div>
      <p className="text-xs text-gray-400 mb-2">
        {stub.gpu.name}{stub.gpu.count > 1 && ` ×${stub.gpu.count}`}
      </p>
      <div className="mb-2">
        <VramBar usedMb={usedVram} totalMb={totalVram} />
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-500">
          <span className={running > 0 ? "text-blue-400" : "text-gray-500"}>{running}</span>
          <span className="text-gray-600">/{stub.max_concurrent} slots</span>
        </span>
        {!isOnline && (
          <span className="text-gray-600">{formatRelTime(stub.last_heartbeat)}</span>
        )}
      </div>
      {stub.tags && stub.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {stub.tags.map((tag) => (
            <span key={tag} className="text-xs bg-gray-800 text-gray-500 rounded px-1.5 py-0.5 font-mono">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function StubsPage() {
  const [stubs, setStubs] = useState<Stub[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchStubs = useCallback(() => {
    stubsApi.list().then((data) => {
      // Sort: online first, then by name
      const sorted = [...data].sort((a, b) => {
        if (a.status === b.status) return a.name.localeCompare(b.name);
        return a.status === "online" ? -1 : 1;
      });
      setStubs(sorted);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchStubs();
    const t = setInterval(fetchStubs, 5000);
    return () => clearInterval(t);
  }, [fetchStubs]);

  const onlineCount = stubs.filter((s) => s.status === "online").length;
  const offlineCount = stubs.length - onlineCount;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Stubs</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {onlineCount} online
            {offlineCount > 0 && <span className="text-gray-600"> · {offlineCount} offline</span>}
          </p>
        </div>
      </div>

      {loading && stubs.length === 0 && (
        <div className="text-gray-500 text-center py-20">Loading...</div>
      )}

      {!loading && stubs.length === 0 && (
        <div className="text-gray-600 text-center py-20">No stubs registered</div>
      )}

      {/* Desktop table */}
      {stubs.length > 0 && (
        <div className="hidden md:block bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3 w-24">Status</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Hostname</th>
                <th className="px-4 py-3">GPU</th>
                <th className="px-4 py-3 w-48">VRAM</th>
                <th className="px-4 py-3 w-20">Slots</th>
                <th className="px-4 py-3">Tags</th>
                <th className="px-4 py-3 w-28">Type</th>
                <th className="px-4 py-3 w-28">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {stubs.map((stub) => (
                <StubTableRow key={stub.id} stub={stub} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Mobile cards */}
      {stubs.length > 0 && (
        <div className="md:hidden grid grid-cols-1 gap-3">
          {stubs.map((stub) => (
            <StubCard key={stub.id} stub={stub} />
          ))}
        </div>
      )}
    </div>
  );
}
