import { useState, useEffect } from "react";
import { deployApi, DeployTarget, TunnelStatus } from "../lib/api";

function TunnelIndicator({ status }: { status: TunnelStatus | null }) {
  if (!status) return <span className="text-gray-600 text-sm">Loading…</span>;
  return (
    <div className="flex items-center gap-2">
      <div
        className={`w-2 h-2 rounded-full shrink-0 ${
          status.running
            ? "bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]"
            : "bg-red-500"
        }`}
      />
      <span className={`text-sm font-medium ${status.running ? "text-green-400" : "text-red-400"}`}>
        {status.running ? "Running" : "Down"}
      </span>
      {status.running && status.url && (
        <a
          href={status.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 text-xs font-mono hover:underline ml-1"
        >
          {status.url}
        </a>
      )}
      {status.running && status.uptime_s !== undefined && (
        <span className="text-xs text-gray-600">
          up {Math.round(status.uptime_s / 60)}m
        </span>
      )}
    </div>
  );
}

function TargetCard({ target }: { target: DeployTarget }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold text-white">{target.name}</h3>
        {target.max_concurrent !== undefined && (
          <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">
            max {target.max_concurrent} concurrent
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        <Row label="Host" value={`${target.user ? target.user + "@" : ""}${target.host}`} />
        {target.jump_host && <Row label="Jump Host" value={target.jump_host} />}
        {target.python_path && <Row label="Python" value={target.python_path} />}
        {target.default_cwd && <Row label="Default CWD" value={target.default_cwd} />}
        {target.env_setup && <Row label="Env Setup" value={target.env_setup} />}
      </div>

      {target.tags && target.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {target.tags.map((tag) => (
            <span key={tag} className="bg-gray-800 text-gray-400 rounded px-1.5 py-0.5 text-xs font-mono">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-xs text-gray-500 uppercase w-24 shrink-0">{label}</span>
      <span className="text-sm text-gray-300 font-mono break-all">{value}</span>
    </div>
  );
}

export default function DeployPage() {
  const [targets, setTargets] = useState<DeployTarget[] | null>(null);
  const [tunnel, setTunnel] = useState<TunnelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    deployApi.targets()
      .then(setTargets)
      .catch(() => setError("Failed to load deploy targets"));

    const fetchTunnel = () =>
      deployApi.tunnelStatus().then(setTunnel).catch(() => {});
    fetchTunnel();
    const t = setInterval(fetchTunnel, 15000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">Deploy Targets</h1>
        <span className="text-xs text-gray-600 uppercase tracking-wider">Read-only</span>
      </div>

      {/* Tunnel status */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Tunnel</p>
        <TunnelIndicator status={tunnel} />
      </div>

      {/* Targets */}
      {error ? (
        <div className="text-red-400 text-sm">{error}</div>
      ) : !targets ? (
        <div className="text-gray-600 text-sm">Loading…</div>
      ) : targets.length === 0 ? (
        <div className="text-center py-16 text-gray-700">
          <p className="text-lg text-gray-500">No deploy targets configured</p>
          <p className="text-sm mt-1">Add targets to your deploy config file</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {targets.map((t) => (
            <TargetCard key={t.name} target={t} />
          ))}
        </div>
      )}
    </div>
  );
}
