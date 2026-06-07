import { Link } from "react-router-dom";
import type {
  ExperimentDiffResponse,
  ExperimentSummaryResponse,
} from "../../lib/api";

export function ExperimentConfigDiffCard({
  diff,
  summary,
}: {
  diff: ExperimentDiffResponse | null;
  summary: ExperimentSummaryResponse | null;
}) {
  const configDiff = diff?.config_diff ?? summary?.config_diff ?? null;
  const parentId = diff?.parent_id ?? summary?.parent?.id ?? null;
  const parentName = diff?.parent_name ?? summary?.parent?.name ?? null;

  if (!diff && !summary) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-md p-3">
        <h2 className="text-sm font-medium text-gray-400 mb-3">Config diff</h2>
        <p className="text-xs text-gray-600">Loading...</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-md p-3">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-gray-400">Config diff</h2>
        <span className="text-xs text-gray-600">
          {parentName ? (
            parentId ? (
              <>
                vs{" "}
                <Link
                  to={`/experiments/${parentId}`}
                  className="text-blue-400 hover:text-blue-300 font-mono"
                >
                  {parentName}
                </Link>
              </>
            ) : (
              <>
                vs <span className="font-mono text-gray-400">{parentName}</span>
              </>
            )
          ) : (
            "no parent"
          )}
        </span>
      </div>

      {!parentId && !parentName ? (
        <p className="text-xs text-gray-600">
          Root experiment &mdash; no parent diff.
        </p>
      ) : !configDiff || Object.keys(configDiff).length === 0 ? (
        <p className="text-xs text-gray-600">
          No config changes from parent. This node records runtime / checkpoint lineage only.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-800">
          <table className="w-full text-xs">
            <thead className="bg-gray-800/40 text-gray-500">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">Key</th>
                <th className="px-2 py-1.5 text-left font-medium">Parent</th>
                <th className="px-2 py-1.5 text-left font-medium">Current</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {Object.entries(configDiff).map(([key, change]) => (
                <tr key={key}>
                  <td className="px-2 py-1.5 font-mono text-gray-400">{key}</td>
                  <td className="px-2 py-1.5 font-mono text-red-300/85">
                    {change.old === undefined ? (
                      <span className="text-gray-600">—</span>
                    ) : (
                      String(change.old)
                    )}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-green-300/85">
                    {change.new === undefined ? (
                      <span className="text-gray-600">—</span>
                    ) : (
                      String(change.new)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
