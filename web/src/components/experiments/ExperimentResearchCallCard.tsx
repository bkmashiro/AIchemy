import { useState } from "react";
import { experimentsApi } from "../../lib/api";
import type {
  ExperimentDetail,
  ExperimentSummaryResponse,
} from "../../lib/api";
import {
  DECISION_BADGE,
  NEXT_ACTION,
  NEXT_ACTION_DEFAULT,
} from "./experimentDetailUtils";

export function ExperimentResearchCallCard({
  exp,
  summary,
}: {
  exp: ExperimentDetail;
  summary: ExperimentSummaryResponse | null;
}) {
  const decision = summary?.decision ?? exp.decision ?? null;
  const action = decision
    ? NEXT_ACTION[decision] ?? NEXT_ACTION_DEFAULT
    : NEXT_ACTION_DEFAULT;

  const validation = summary?.validation;
  const primary = summary?.primary_metric ?? null;
  const goalMetric = summary?.goal_metric ?? exp.goal_metric ?? null;
  const bestMetrics = summary?.best_metrics ?? {};
  const bestEntries = Object.entries(bestMetrics).slice(0, 4);
  const forkReason = summary?.fork_reason ?? exp.fork_reason ?? null;
  const decisionReason =
    summary?.decision_reason ?? exp.decision_reason ?? null;

  const decisionBadge = decision
    ? DECISION_BADGE[decision] || "bg-gray-800 text-gray-400 border-gray-700"
    : "bg-gray-800 text-gray-500 border-gray-700";

  const [exportState, setExportState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [exportError, setExportError] = useState<string | null>(null);

  const cliRef = exp.name || exp.id;
  const cliRefForShell = cliRef.length === 0
    ? "''"
    : `'${cliRef.replace(/'/g, `'\\''`)}'`;

  async function downloadBundle() {
    setExportState("loading");
    setExportError(null);
    try {
      const bundle = await experimentsApi.getResearchBundle(exp.id);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeName = (exp.name || exp.id).replace(/[^a-zA-Z0-9_.-]+/g, "_");
      a.download = `${safeName}-research-bundle.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportState("done");
      setTimeout(() => setExportState("idle"), 2000);
    } catch (err: any) {
      setExportError(err?.message ?? String(err));
      setExportState("error");
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-gray-400">Research call</h2>
        <span
          className={`text-[10px] px-2 py-0.5 rounded border uppercase ${decisionBadge}`}
        >
          {decision ?? "undecided"}
        </span>
      </div>

      <div className={`rounded-lg border px-3 py-2 ${action.tone}`}>
        <div className="text-xs font-medium">{action.label}</div>
        <div className="mt-0.5 text-[11px] opacity-80">{action.hint}</div>
      </div>

      {decisionReason && (
        <p className="mt-3 border-l-2 border-gray-800 pl-3 text-xs italic text-gray-400">
          &ldquo;{decisionReason}&rdquo;
        </p>
      )}

      <div className="mt-3 space-y-2 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-0.5">
            Goal metric
          </div>
          {primary ? (
            <span className="font-mono text-gray-300">
              {primary.direction === "min" ? "↓" : "↑"} {primary.metric}
              {primary.best !== null && (
                <span className="ml-1 text-gray-500">
                  best {primary.best.toFixed?.(4) ?? primary.best}
                </span>
              )}
            </span>
          ) : goalMetric ? (
            <span className="text-gray-600">
              {goalMetric} declared, but no explicit primary metric / goal direction.
            </span>
          ) : (
            <span className="text-gray-600">No explicit goal metric set.</span>
          )}
        </div>

        {validation && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-0.5">
              Validation
            </div>
            <div className="font-mono text-gray-300">
              <span className="text-green-400">{validation.passed} passed</span>
              {" / "}
              <span className="text-red-400">{validation.failed} failed</span>
              {" / "}
              <span className="text-gray-500">{validation.total} total</span>
            </div>
          </div>
        )}

        {bestEntries.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">
              Best metrics
            </div>
            <div className="flex flex-wrap gap-1">
              {bestEntries.map(([k, v]) => (
                <span
                  key={k}
                  className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-gray-700 bg-gray-800 text-gray-300"
                >
                  {k}={typeof v === "number" ? v.toFixed(4) : String(v)}
                </span>
              ))}
            </div>
          </div>
        )}

        {forkReason && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-0.5">
              Fork reason
            </div>
            <p className="text-gray-300 whitespace-pre-wrap">{forkReason}</p>
          </div>
        )}

        <div className="pt-2 border-t border-gray-800">
          <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">
            Research bundle
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={downloadBundle}
              disabled={exportState === "loading"}
              className="text-[11px] px-2 py-1 rounded border border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-50"
              title="Read-only JSON export: detail + summary + diff + manifest + timeline + decision + artifacts"
            >
              {exportState === "loading"
                ? "Exporting…"
                : exportState === "done"
                  ? "Downloaded"
                  : "Export JSON"}
            </button>
            <code className="text-[10px] text-gray-500 truncate">
              alch experiments bundle {cliRefForShell}
            </code>
          </div>
          {exportError && (
            <div className="mt-1 text-[10px] text-red-400">{exportError}</div>
          )}
        </div>
      </div>
    </div>
  );
}
