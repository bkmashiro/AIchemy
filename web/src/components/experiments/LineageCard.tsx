import { Link } from "react-router-dom";
import type { Experiment, ExperimentDetail } from "../../lib/api";

export function LineageCard({
  exp,
  allExperiments,
}: {
  exp: ExperimentDetail;
  allExperiments: Experiment[];
}) {
  const ancestors: Experiment[] = [];
  const byId = new Map(allExperiments.map((e) => [e.id, e]));
  let cursor = exp.parent_id ? byId.get(exp.parent_id) : undefined;
  const seen = new Set<string>([exp.id]);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    ancestors.unshift(cursor);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  const descendants = allExperiments.filter((e) => e.parent_id === exp.id);

  const hasAny = ancestors.length > 0 || descendants.length > 0;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h2 className="text-sm font-medium text-gray-400 mb-3">Lineage</h2>
      {!hasAny && (
        <p className="text-xs text-gray-600">No related experiments</p>
      )}
      {ancestors.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">
            Ancestors
          </div>
          <div className="flex flex-wrap items-center gap-1 text-xs">
            {ancestors.map((a, i) => (
              <span key={a.id} className="flex items-center gap-1">
                <Link
                  to={`/experiments/${a.id}`}
                  className="text-blue-400 hover:text-blue-300 font-mono"
                >
                  {a.name}
                </Link>
                {i < ancestors.length - 1 && (
                  <span className="text-gray-700">/</span>
                )}
              </span>
            ))}
            <span className="text-gray-700">/</span>
            <span className="text-gray-400 font-mono">{exp.name}</span>
          </div>
        </div>
      )}
      {descendants.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">
            Forks ({descendants.length})
          </div>
          <ul className="space-y-1 text-xs">
            {descendants.map((d) => (
              <li key={d.id} className="flex items-center gap-2">
                <Link
                  to={`/experiments/${d.id}`}
                  className="text-blue-400 hover:text-blue-300 font-mono truncate"
                >
                  {d.name}
                </Link>
                {d.fork_reason && (
                  <span className="text-gray-600 truncate">
                    — {d.fork_reason}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
