import { useState } from "react";
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

  if (paramKeys.length === 0) return null;

  const { rowKey, colKey, rowValues, colValues } = pickMatrixKeys(paramSpace);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 overflow-x-auto">
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
                const task: Task | undefined = tasks.find((t) => {
                  if (!t.param_overrides) return false;
                  const matchRow =
                    !rowKey || String(t.param_overrides[rowKey]) === String(rv);
                  const matchCol =
                    !colKey || String(t.param_overrides[colKey]) === String(cv);
                  return matchRow && matchCol;
                });

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
