import { useState } from "react";
import {
  ExperimentDecision,
  ExperimentDetail,
  experimentsApi,
} from "../../lib/api";
import { formatRelTime } from "../../lib/format";
import { DECISION_BADGE, decisionLabelForFilter } from "./experimentDetailUtils";

const DECISION_OPTIONS: ExperimentDecision[] = ["keep", "try_more", "discard"];

function canonicalDecision(decision: ExperimentDecision | null | undefined): ExperimentDecision {
  if (decision === "drop") return "discard";
  if (decision === "rerun" || decision === "fork") return "try_more";
  return decision ?? "keep";
}

export function DecisionCard({
  exp,
  onUpdated,
}: {
  exp: ExperimentDetail;
  onUpdated: (u: Partial<ExperimentDetail>) => void;
}) {
  const [decision, setDecision] = useState<ExperimentDecision>(
    canonicalDecision(exp.decision),
  );
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      setError("Reason required");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const updated = await experimentsApi.decide(
        exp.id,
        decision,
        reason.trim(),
      );
      setReason("");
      onUpdated(updated);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      setError(e?.response?.data?.error ?? "Failed to set decision");
    } finally {
      setSubmitting(false);
    }
  }

  const currentBadge = exp.decision
    ? DECISION_BADGE[exp.decision] || "bg-gray-800 text-gray-400 border-gray-700"
    : "bg-gray-800 text-gray-500 border-gray-700";

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-md p-3">
      <h2 className="text-sm font-medium text-gray-400 mb-3">Decision</h2>
      <div className="space-y-3 text-xs">
        <div>
          <span
            className={`inline-block text-xs px-2 py-0.5 rounded border ${currentBadge}`}
          >
            {decisionLabelForFilter(exp.decision ?? "undecided")?.toUpperCase() ?? "UNDECIDED"}
          </span>
          {exp.decision_at && (
            <span className="ml-2 text-gray-600">
              {formatRelTime(exp.decision_at)}
            </span>
          )}
        </div>
        {exp.decision_reason && (
          <p className="text-gray-300 whitespace-pre-wrap">
            {exp.decision_reason}
          </p>
        )}

        <form
          onSubmit={handleSubmit}
          className="space-y-2 pt-2 border-t border-gray-800"
        >
          <div className="flex items-center gap-2">
            <select
              value={decision}
              onChange={(e) => setDecision(e.target.value as ExperimentDecision)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
              disabled={submitting}
            >
              {DECISION_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {decisionLabelForFilter(d) ?? d}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={submitting}
              className="px-3 py-1 text-xs rounded bg-blue-600/20 text-blue-400 border border-blue-700/40 hover:bg-blue-600/30 disabled:opacity-50"
            >
              {submitting ? "Saving..." : "Set"}
            </button>
          </div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason..."
            rows={2}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600"
            disabled={submitting}
          />
          {error && <p className="text-red-400 text-xs">{error}</p>}
        </form>
      </div>
    </div>
  );
}
