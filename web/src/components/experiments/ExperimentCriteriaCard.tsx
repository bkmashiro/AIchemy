export function ExperimentCriteriaCard({
  criteria,
}: {
  criteria: Record<string, string>;
}) {
  const entries = Object.entries(criteria);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h2 className="text-sm font-medium text-gray-400 mb-2">Criteria</h2>
      <div className="flex flex-wrap gap-3">
        {entries.map(([metric, expr]) => (
          <span
            key={metric}
            className="text-xs font-mono bg-gray-800 px-2 py-1 rounded text-gray-300"
          >
            {metric} {expr}
          </span>
        ))}
        {entries.length === 0 && (
          <span className="text-xs text-gray-600">No criteria</span>
        )}
      </div>
    </div>
  );
}
