import { Link } from "react-router-dom";
import { StatusBadge } from "./StatusBadge";
import type { ExperimentResearchReportResponse } from "../../lib/api";
import {
  buildFamilyCompareRows,
  getReportWinnerId,
} from "./experimentFamilyCompareUtils";

interface Props {
  report: ExperimentResearchReportResponse;
  selectedId?: string | null;
  onSelectExperiment?: (id: string) => void;
}

export function ExperimentFamilyCompareBoard({
  report,
  selectedId,
  onSelectExperiment,
}: Props) {
  const rows = buildFamilyCompareRows(report);
  const winnerId = getReportWinnerId(report.leaderboard);
  const hasFamily = Boolean(report.filters.family);
  const canSelect = typeof onSelectExperiment === "function";

  if (!hasFamily || rows.length === 0) {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-xs text-gray-400">Family compare</h3>
          <span className="text-[10px] text-gray-600">No data</span>
        </div>
        <p className="bg-gray-950 border border-gray-800 rounded px-2 py-2 text-[11px] text-gray-600">
          Select a family with at least one experiment to view the family compare board.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-xs text-gray-400">Family compare</h3>
        <span className="text-[10px] text-gray-600">{rows.length} rows</span>
      </div>
      <div className="bg-gray-950 border border-gray-800 rounded overflow-x-auto">
        <table className="w-full min-w-[52rem] text-[11px]">
          <thead>
            <tr className="text-gray-500 text-left border-b border-gray-800">
              <th className="px-2 py-1 font-normal">Experiment</th>
              <th className="px-2 py-1 font-normal">Status</th>
              <th className="px-2 py-1 font-normal">Recommendation</th>
              <th className="px-2 py-1 font-normal text-right">Best</th>
              <th className="px-2 py-1 font-normal text-right">Δ best</th>
              <th className="px-2 py-1 font-normal text-right">Δ baseline</th>
              <th className="px-2 py-1 font-normal text-right">Config</th>
              <th className="px-2 py-1 font-normal text-right">Tasks</th>
              <th className="px-2 py-1 font-normal">Decision</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {rows.map((row) => {
              const isWinner = row.id === winnerId || row.isWinner;
              const isSelected = selectedId === row.id;
              const rowKind = isWinner ? "winner" : row.isRegression ? "regression" : "normal";
              return (
                <tr
                  key={row.id}
                  role={canSelect ? "button" : undefined}
                  tabIndex={canSelect ? 0 : undefined}
                  aria-label={canSelect ? `Select ${row.name || row.id} for family compare` : undefined}
                  aria-pressed={canSelect ? isSelected : undefined}
                  onClick={canSelect ? () => onSelectExperiment(row.id) : undefined}
                  onKeyDown={
                    canSelect
                      ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onSelectExperiment(row.id);
                          }
                        }
                      : undefined
                  }
                  data-row-kind={rowKind}
                  className={[
                    "bg-gray-950/40 hover:bg-gray-900",
                    canSelect ? "cursor-pointer" : "",
                    isWinner ? "bg-emerald-900/15" : "",
                    row.isRegression ? "bg-rose-900/10" : "",
                    isSelected ? "outline outline-1 outline-cyan-700/60" : "",
                  ].join(" ")}
                >
                  <td className="px-2 py-1 font-mono text-gray-200 truncate max-w-[14rem]">
                    <Link
                      to={`/experiments/${row.id}`}
                      className="text-blue-400 hover:text-blue-300 font-medium transition-colors"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {row.name || row.id}
                    </Link>
                  </td>
                  <td className="px-2 py-1">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-2 py-1 text-gray-400">
                    {row.recommendationLabel ? (
                      <span
                        data-testid={`recommendation-${row.id}`}
                        className={`text-[10px] px-1.5 py-0.5 rounded border ${row.recommendationClass}`}
                      >
                        {row.recommendationLabel}
                      </span>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1 font-mono text-gray-300 text-right tabular-nums">
                    {row.bestLabel}
                  </td>
                  <td className="px-2 py-1 font-mono text-gray-300 text-right tabular-nums">
                    {row.deltaVsBestFormatted}
                  </td>
                  <td className="px-2 py-1 font-mono text-gray-300 text-right tabular-nums">
                    {row.deltaVsBaselineFormatted}
                  </td>
                  <td className="px-2 py-1 text-gray-400 text-right tabular-nums">
                    {row.configCount ?? "—"}
                  </td>
                  <td className="px-2 py-1 text-gray-400 text-right tabular-nums">{row.taskCount}</td>
                  <td className="px-2 py-1 text-gray-400">{row.decision ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
