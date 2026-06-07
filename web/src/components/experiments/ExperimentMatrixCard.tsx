import { useMemo, useState } from "react";
import type { ExperimentDetail, Task } from "../../lib/api";
import {
  CELL_COLORS,
  CELL_ICONS,
  getCellStatus,
  pickMatrixKeys,
} from "./experimentDetailUtils";

export function ExperimentMatrixCard({ exp }: { exp: ExperimentDetail }) {
  const [expandedCell, setExpandedCell] = useState<string | null>(null);

  const paramSpace = exp.grid?.param_space ?? {};
  const paramKeys = Object.keys(paramSpace);
  const tasks = exp.tasks ?? [];
  const { rowKey, colKey, rowValues, colValues } = pickMatrixKeys(paramSpace);

  // Precompute a (row, col) → task index once per render. The previous code
  // ran `tasks.find(...)` for every cell, which is O(rows × cols × tasks);
  // grids of 10×10 with 100 tasks were doing 10k linear scans on every
  // re-render. The key intentionally uses `String(...)` to match how the
  // header cells coerce param values for display.
  const taskByCell = useMemo(() => {
    const map = new Map<string, Task>();
    for (const t of tasks) {
      const overrides = t.param_overrides;
      if (!overrides) continue;
      const rPart = rowKey ? String(overrides[rowKey]) : "";
      const cPart = colKey ? String(overrides[colKey]) : "";
      const key = `${rPart}|${cPart}`;
      // First task wins, matching the previous `find()` semantics. A grid
      // axis collision is a data bug worth keeping deterministic.
      if (!map.has(key)) map.set(key, t);
    }
    return map;
  }, [tasks, rowKey, colKey]);

  if (paramKeys.length === 0) return null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-md p-3 overflow-x-auto">
      <h2 className="text-sm font-medium text-gray-400 mb-3">Result Matrix</h2>
      <table className="text-sm">
        <thead>
          <tr>
            <th className="px-3 py-2 text-xs text-gray-600 font-medium text-left">
              {rowKey || ""}
            </th>
            {colValues.map((cv) => (
              <th
                key={String(cv)}
                className="px-3 py-2 text-xs text-gray-500 font-medium text-center"
              >
                {colKey ? `${colKey}=${cv}` : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowValues.map((rv) => (
            <tr key={String(rv)}>
              <td className="px-3 py-2 text-xs text-gray-400 font-mono whitespace-nowrap">
                {rowKey ? `${rowKey}=${rv}` : ""}
              </td>
              {colValues.map((cv) => {
                const rPart = rowKey ? String(rv) : "";
                const cPart = colKey ? String(cv) : "";
                const task: Task | undefined = taskByCell.get(`${rPart}|${cPart}`);

                const status = getCellStatus(task, exp);
                const cellId = `${rv}|${cv}`;
                const isExpanded = expandedCell === cellId;
                const validation = task ? exp.results[task.id] : undefined;

                return (
                  <td key={String(cv)} className="px-1 py-1">
                    <button
                      onClick={() => setExpandedCell(isExpanded ? null : cellId)}
                      className={`w-full min-w-[60px] px-3 py-2 rounded border text-center cursor-pointer transition-colors ${CELL_COLORS[status]}`}
                    >
                      <span className="text-lg">{CELL_ICONS[status]}</span>
                    </button>
                    {isExpanded && validation && (
                      <div className="mt-1 p-2 bg-gray-800 rounded text-xs space-y-0.5">
                        {Object.entries(validation.details).map(([metric, cr]) => (
                          <div
                            key={metric}
                            className={cr.ok ? "text-green-400" : "text-red-400"}
                          >
                            {metric}: {cr.value.toFixed(4)} {cr.threshold}{" "}
                            {cr.ok ? "✓" : "✗"}
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
