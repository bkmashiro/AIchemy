import { Link } from "react-router-dom";
import type { Experiment } from "../../lib/api";
import { formatRelTime } from "../../lib/format";
import { StatusBadge } from "./StatusBadge";

function progressBarColor(status: Experiment["status"]): string {
  switch (status) {
    case "passed":
      return "bg-green-500";
    case "partial":
      return "bg-orange-500";
    case "failed":
      return "bg-red-500";
    default:
      return "bg-blue-500";
  }
}

export function ExperimentListTable({
  experiments,
}: {
  experiments: Experiment[];
}) {
  if (experiments.length === 0) {
    return (
      <div className="text-center py-24 text-gray-700">
        <p className="text-lg font-medium text-gray-500">No experiments yet</p>
        <p className="text-sm mt-1">
          Use{" "}
          <code className="bg-gray-800 px-1 rounded">POST /api/experiments</code>{" "}
          to create one
        </p>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800">
            <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">Name</th>
            <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">Status</th>
            <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">Criteria</th>
            <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">Progress</th>
            <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">Created</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/50">
          {experiments.map((exp) => {
            const validations = Object.values(exp.results);
            const passed = validations.filter((v) => v.passed).length;
            const total = validations.length;
            const pct = total > 0 ? Math.round((passed / total) * 100) : 0;

            return (
              <tr
                key={exp.id}
                className="hover:bg-gray-800/30 transition-colors"
              >
                <td className="px-4 py-3">
                  <Link
                    to={`/experiments/${exp.id}`}
                    className="text-blue-400 hover:text-blue-300 font-medium transition-colors"
                  >
                    {exp.name}
                  </Link>
                  {exp.description && (
                    <p className="text-xs text-gray-600 mt-0.5 truncate max-w-xs">
                      {exp.description}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={exp.status} />
                </td>
                <td className="px-4 py-3 text-xs text-gray-400 font-mono">
                  {Object.entries(exp.criteria)
                    .map(([k, v]) => `${k}${v}`)
                    .join(", ")}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="w-24 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${progressBarColor(exp.status)}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs text-gray-500 tabular-nums">
                      {passed}/{total} {pct > 0 ? `${pct}%` : ""}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-gray-600">
                  {formatRelTime(exp.created_at)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
