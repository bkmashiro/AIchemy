import { Link } from "react-router-dom";
import { Stub } from "../lib/api";

interface Props {
  stub: Stub;
}

const statusColor = {
  online: "bg-green-500",
  offline: "bg-gray-500",
  stale: "bg-yellow-500",
};

export default function StubCard({ stub }: Props) {
  const running = stub.tasks.filter((t) => t.status === "running").length;
  const queued = stub.tasks.filter((t) => t.status === "queued").length;
  const gpu0 = stub.gpu_stats.gpus[0];
  const utilPct = gpu0?.utilization_pct ?? 0;
  const vramPct = gpu0 ? Math.round((gpu0.memory_used_mb / gpu0.memory_total_mb) * 100) : 0;

  const walltimeWarning =
    stub.remaining_walltime_s !== undefined && stub.remaining_walltime_s < 1800;

  return (
    <Link to={`/stubs/${stub.id}`}>
      <div className={`bg-gray-900 rounded-xl p-4 border hover:border-blue-500 transition cursor-pointer ${walltimeWarning ? "border-yellow-600" : "border-gray-800"}`}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-semibold text-white truncate max-w-[180px]" title={stub.name}>
              {stub.name}
            </h3>
            <p className="text-xs text-gray-400">{stub.gpu.name}</p>
          </div>
          <span className={`text-xs px-2 py-1 rounded-full text-white ${statusColor[stub.status]}`}>
            {stub.status}
          </span>
        </div>

        {stub.type === "slurm" && stub.slurm_job_id && (
          <p className="text-xs text-gray-500 mb-2">SLURM #{stub.slurm_job_id}</p>
        )}

        {walltimeWarning && stub.remaining_walltime_s !== undefined && (
          <p className="text-xs text-yellow-400 mb-2">
            ⚠ Walltime: {Math.round(stub.remaining_walltime_s / 60)}m remaining
          </p>
        )}

        <div className="space-y-2">
          <div>
            <div className="flex justify-between text-xs text-gray-400 mb-1">
              <span>GPU Util</span>
              <span>{utilPct}%</span>
            </div>
            <div className="h-1.5 bg-gray-800 rounded-full">
              <div
                className="h-full bg-blue-500 rounded-full transition-all"
                style={{ width: `${utilPct}%` }}
              />
            </div>
          </div>
          <div>
            <div className="flex justify-between text-xs text-gray-400 mb-1">
              <span>VRAM</span>
              <span>{vramPct}%</span>
            </div>
            <div className="h-1.5 bg-gray-800 rounded-full">
              <div
                className="h-full bg-purple-500 rounded-full transition-all"
                style={{ width: `${vramPct}%` }}
              />
            </div>
          </div>
        </div>

        <div className="mt-3 flex gap-3 text-xs text-gray-400">
          <span>{running} running</span>
          <span>{queued} queued</span>
          <span className="ml-auto">{stub.max_concurrent} max</span>
        </div>
      </div>
    </Link>
  );
}
