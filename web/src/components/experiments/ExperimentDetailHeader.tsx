import { Link } from "react-router-dom";
import type { ExperimentDetail } from "../../lib/api";
import { StatusBadge } from "./StatusBadge";

export function ExperimentDetailHeader({
  exp,
  onRetryFailed,
  onDelete,
}: {
  exp: ExperimentDetail;
  onRetryFailed: () => void;
  onDelete: () => void;
}) {
  const canRetry = exp.status === "partial" || exp.status === "failed";

  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="flex items-center gap-3">
          <Link
            to="/experiments"
            className="text-gray-500 hover:text-gray-300 text-sm"
          >
            &larr; Experiments
          </Link>
          <h1 className="text-xl font-bold text-white">{exp.name}</h1>
          <StatusBadge status={exp.status} />
        </div>
        {exp.description && (
          <p className="text-sm text-gray-500 mt-1">{exp.description}</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {canRetry && (
          <button
            onClick={onRetryFailed}
            className="px-3 py-1.5 text-xs rounded bg-blue-600/20 text-blue-400 border border-blue-700/40 hover:bg-blue-600/30"
          >
            Retry Failed
          </button>
        )}
        <button
          onClick={onDelete}
          className="px-3 py-1.5 text-xs rounded bg-red-600/20 text-red-400 border border-red-700/40 hover:bg-red-600/30"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
