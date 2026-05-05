import { useState, useEffect, useCallback } from "react";
import { deployApi, DeployTarget, TunnelStatus, StubStatus, DeployResult } from "../lib/api";

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

function StatusDot({ status }: { status: StubStatus | null | "loading" }) {
  if (status === "loading" || status === null) {
    return <div className="w-2 h-2 rounded-full bg-gray-600 shrink-0" />;
  }
  return (
    <div
      className={`w-2 h-2 rounded-full shrink-0 ${
        status.running
          ? "bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]"
          : "bg-gray-600"
      }`}
      title={status.running ? `Running${status.pid ? ` (PID ${status.pid})` : status.job_id ? ` (Job ${status.job_id})` : ""}` : "Stopped"}
    />
  );
}

interface TargetCardProps {
  target: DeployTarget;
}

function TargetCard({ target }: TargetCardProps) {
  const [status, setStatus] = useState<StubStatus | null | "loading">("loading");
  const [jobId, setJobId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<"deploy" | "restart" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const fetchStatus = useCallback(() => {
    deployApi.status(target.name, jobId)
      .then((s) => {
        setStatus(s);
        // Track job ID for SLURM targets
        if (s.job_id) setJobId(s.job_id);
      })
      .catch(() => setStatus(null));
  }, [target.name, jobId]);

  useEffect(() => {
    fetchStatus();
    const t = setInterval(fetchStatus, 30_000);
    return () => clearInterval(t);
  }, [fetchStatus]);

  const handleDeploy = async () => {
    setError(null);
    setLastResult(null);
    setBusy("deploy");
    try {
      const result: DeployResult = await deployApi.deploy(target.name);
      if (!result.ok) {
        setError(`Deploy failed (${result.step}): ${result.error}`);
      } else {
        const info = result.job_id ? `Job ${result.job_id}` : result.pid ? `PID ${result.pid}` : "OK";
        setLastResult(`Deployed — ${info}`);
        if (result.job_id) setJobId(result.job_id);
        setTimeout(fetchStatus, 3000);
      }
    } catch (e: any) {
      setError(e?.response?.data?.error ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleRestart = async () => {
    setError(null);
    setLastResult(null);
    setBusy("restart");
    try {
      const result: DeployResult = await deployApi.restart(target.name);
      if (!result.ok) {
        setError(`Restart failed (${result.step}): ${result.error}`);
      } else {
        const info = result.job_id ? `Job ${result.job_id}` : result.pid ? `PID ${result.pid}` : "OK";
        setLastResult(`Restarted — ${info}`);
        if (result.job_id) setJobId(result.job_id);
        setTimeout(fetchStatus, 3000);
      }
    } catch (e: any) {
      setError(e?.response?.data?.error ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleStop = async () => {
    if (!window.confirm(`Stop stub "${target.name}"?`)) return;
    setError(null);
    setLastResult(null);
    setBusy("stop");
    try {
      const result: DeployResult = await deployApi.stop(target.name, jobId);
      if (!result.ok) {
        setError(`Stop failed (${result.step}): ${result.error}`);
      } else {
        setLastResult("Stopped");
        setJobId(undefined);
        setTimeout(fetchStatus, 3000);
      }
    } catch (e: any) {
      setError(e?.response?.data?.error ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const tags = Array.isArray(target.tags)
    ? target.tags
    : typeof target.tags === "string"
    ? target.tags.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const isSlurm = target.type === "slurm";
  const hostDisplay = isSlurm
    ? (target.ssh_user ? `${target.ssh_user}@` : "") + (target.ssh_host ?? "")
    : (target.user ? `${target.user}@` : "") + (target.host ?? "");

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot status={status} />
          <h3 className="text-base font-bold text-white">{target.name}</h3>
          {isSlurm && (
            <span className="text-xs text-purple-400 bg-purple-900/30 px-1.5 py-0.5 rounded font-mono">
              slurm
            </span>
          )}
        </div>
        {target.max_concurrent !== undefined && (
          <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">
            max {target.max_concurrent}
          </span>
        )}
      </div>

      {/* Info rows */}
      <div className="space-y-1.5">
        <Row label={isSlurm ? "Submit Host" : "Host"} value={hostDisplay} />
        {!isSlurm && target.jump_host && <Row label="Jump Host" value={target.jump_host} />}
        {isSlurm && target.partition && <Row label="Partition" value={target.partition} />}
        {isSlurm && target.gres && <Row label="GRES" value={target.gres} />}
        {isSlurm && target.mem && <Row label="Mem" value={target.mem} />}
        {isSlurm && target.time && <Row label="Time" value={target.time} />}
        {isSlurm && target.qos && <Row label="QOS" value={target.qos} />}
        {target.python_path && <Row label="Python" value={target.python_path} />}
        {target.default_cwd && <Row label="Default CWD" value={target.default_cwd} />}
        {target.env_setup && <Row label="Env Setup" value={target.env_setup} />}
        {/* SLURM job ID if known */}
        {isSlurm && jobId && (
          <Row label="Job ID" value={jobId} />
        )}
      </div>

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {tags.map((tag) => (
            <span key={tag} className="bg-gray-800 text-gray-400 rounded px-1.5 py-0.5 text-xs font-mono">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 pt-1 border-t border-gray-800">
        <ActionBtn
          label="Deploy"
          title="Sync code + restart"
          loading={busy === "deploy"}
          disabled={busy !== null}
          onClick={handleDeploy}
          variant="primary"
        />
        <ActionBtn
          label="Restart"
          title="Restart only (no sync)"
          loading={busy === "restart"}
          disabled={busy !== null}
          onClick={handleRestart}
          variant="secondary"
        />
        <ActionBtn
          label="Stop"
          title="Stop stub"
          loading={busy === "stop"}
          disabled={busy !== null}
          onClick={handleStop}
          variant="danger"
        />
      </div>

      {/* Feedback */}
      {error && (
        <div className="text-red-400 text-xs bg-red-900/20 border border-red-900/40 rounded px-2 py-1 break-all">
          {error}
        </div>
      )}
      {!error && lastResult && (
        <div className="text-green-400 text-xs bg-green-900/20 border border-green-900/30 rounded px-2 py-1">
          {lastResult}
        </div>
      )}
    </div>
  );
}

interface ActionBtnProps {
  label: string;
  title: string;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
  variant: "primary" | "secondary" | "danger";
}

function ActionBtn({ label, title, loading, disabled, onClick, variant }: ActionBtnProps) {
  const base = "text-xs font-medium px-2.5 py-1 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
  const variants = {
    primary: "bg-blue-600 hover:bg-blue-500 text-white",
    secondary: "bg-gray-700 hover:bg-gray-600 text-gray-200",
    danger: "bg-red-700 hover:bg-red-600 text-white",
  };
  return (
    <button
      className={`${base} ${variants[variant]}`}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {loading ? "…" : label}
    </button>
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
