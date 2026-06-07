import { useState } from "react";
import { experimentsApi } from "../../lib/api";
import type {
  ExperimentDetail,
  ExperimentEvent,
  ExperimentRecommendation,
  ExperimentDecision,
  ExperimentSummaryResponse,
} from "../../lib/api";
import {
  DECISION_BADGE,
  NEXT_ACTION,
  NEXT_ACTION_DEFAULT,
  recommendationBadgeClass,
  recommendationLabel,
  recommendationLabelValue,
  decisionLabelForFilter,
} from "./experimentDetailUtils";

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Quote a CLI argument that may contain spaces or shell metacharacters.
// Single-quote escape is enough for /bin/sh, zsh, and bash.
function shellQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_./@:=+-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function recommendationTone(
  recommendationAction: string | null | undefined,
  recommendationVerdict: string | null | undefined,
): string {
  const toneFromVerdict = isText(recommendationVerdict)
    ? recommendationBadgeClass(recommendationVerdict)
    : null;
  if (toneFromVerdict) return toneFromVerdict;
  return recommendationBadgeClass(recommendationAction);
}

function recommendationAction(rec: ExperimentRecommendation | null) {
  if (!rec) {
    return {
      label: NEXT_ACTION_DEFAULT.label,
      hint: NEXT_ACTION_DEFAULT.hint,
      tone: NEXT_ACTION_DEFAULT.tone,
    };
  }

  const action = isText(rec.action) ? recommendationLabelValue(rec.action) : null;
  const verdict = isText(rec.verdict) ? recommendationLabelValue(rec.verdict) : null;
  const label = action ?? verdict ?? NEXT_ACTION_DEFAULT.label;
  const hint = isText(rec.reason)
    ? rec.reason.trim()
    : isText(rec.metric)
      ? `Metric signal: ${rec.metric}`
      : NEXT_ACTION_DEFAULT.hint;

  return {
    label,
    hint,
    tone: recommendationTone(action, rec.verdict),
  };
}

function formatNumericMetric(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return value.toFixed(4);
}

function deltaClass(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "text-gray-400";
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
  return "text-gray-300";
}

function evidenceBadgeClass(value: string | null | undefined): string {
  switch (value) {
    case "strong":
      return "border-emerald-700/50 bg-emerald-900/30 text-emerald-300";
    case "moderate":
      return "border-cyan-700/50 bg-cyan-900/30 text-cyan-300";
    case "weak":
      return "border-amber-700/50 bg-amber-900/30 text-amber-300";
    case "insufficient":
      return "border-gray-700 bg-gray-800 text-gray-400";
    default:
      return "border-gray-700 bg-gray-800 text-gray-500";
  }
}

const WRITEBACK_MODES = ["note", "decision", "artifact", "checkpoint"] as const;
type WritebackMode = (typeof WRITEBACK_MODES)[number];
const WRITEBACK_DECISIONS: ExperimentDecision[] = ["keep", "drop", "rerun", "fork"];
const WRITEBACK_DECISION_LABEL: Record<ExperimentDecision, string> = {
  keep: "Keep",
  drop: "Drop",
  rerun: "Needs stronger evidence",
  fork: "Fork",
};
const WRITEBACK_MODE_LABEL: Record<WritebackMode, string> = {
  note: "Add note",
  decision: "Record decision",
  artifact: "Attach artifact",
  checkpoint: "Attach checkpoint",
};
const RECENT_WRITEBACK_KINDS: Set<ExperimentEvent["kind"]> = new Set([
  "note",
  "decision",
  "artifact",
  "checkpoint",
]);

function normalizeWritebackDecision(decision: unknown): string {
  if (!isText(decision)) return "";
  return decisionLabelForFilter(decision) ?? decision;
}

function normalizeWritebackEvents(recentEvents: ExperimentEvent[] = []): ExperimentEvent[] {
  return recentEvents
    .filter((event) => RECENT_WRITEBACK_KINDS.has(event.kind))
    .slice()
    .sort((a, b) => {
      const left = Date.parse(a.created_at);
      const right = Date.parse(b.created_at);
      if (Number.isNaN(left) && Number.isNaN(right)) return 0;
      if (Number.isNaN(left)) return 1;
      if (Number.isNaN(right)) return -1;
      if (left === right) return 0;
      return right - left;
    })
    .slice(0, 3);
}

function writebackDecisionText(decisionEvent: ExperimentEvent): string {
  const data = asRecord(decisionEvent.data);
  const dataDecision = isText(data?.decision) ? data.decision : null;
  if (dataDecision) return normalizeWritebackDecision(dataDecision);
  if (isText(decisionEvent.message)) return decisionEvent.message;
  return "Decision recorded";
}

function writebackLocator(event: ExperimentEvent): string {
  const data = asRecord(event.data);
  const locator = data?.locator;
  return isText(locator) ? locator : "";
}

function normalizeBundleValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return Number.isFinite(value) ? value.toString() : "—";
  return String(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function renderResearchBundleMarkdown(
  bundle: Record<string, any>,
  refForFallback: string,
  includeReplicationHint: boolean,
  replicationHint: string,
): string {
  const experiment = asRecord(bundle.experiment) ?? {};
  const summary = asRecord(bundle.summary) ?? {};
  const decision = asRecord(bundle.decision) ?? {};
  const timeline = asRecord(bundle.timeline) ?? {};
  const recommendation = asRecord(summary.recommendation) ?? {};

  const name =
    typeof experiment.name === "string" && experiment.name.trim() ? experiment.name : refForFallback;
  const id =
    typeof experiment.id === "string" && experiment.id.trim() ? experiment.id : null;
  const title = `# Research bundle: ${name}${id && id !== name ? ` (${id})` : ""}`;

  const recAction =
    (isText(typeof recommendation.action === "string" ? recommendation.action : "")
      ? recommendationLabelValue(recommendation.action as string)
      : null) ?? normalizeBundleValue(recommendation.action);
  const recVerdict =
    (isText(typeof recommendation.verdict === "string" ? recommendation.verdict : "")
      ? recommendationLabelValue(recommendation.verdict as string)
      : null) ?? normalizeBundleValue(recommendation.verdict);
  const recReason =
    isText(typeof recommendation.reason === "string" ? recommendation.reason : "")
      ? (recommendation.reason as string)
      : "";

  const rawDecisionValue = isText(typeof decision.decision === "string" ? decision.decision : "")
    ? (decision.decision as string)
    : "";
  const decisionValue = WRITEBACK_DECISIONS.includes(rawDecisionValue as ExperimentDecision)
    ? decisionLabelForFilter(rawDecisionValue as ExperimentDecision)
    : rawDecisionValue;
  const decisionReason =
    isText(typeof decision.reason === "string" ? decision.reason : "")
      ? (decision.reason as string)
      : "";
  const bundleSuggestsReplication = [recAction, recVerdict, recommendation.action, recommendation.verdict]
    .some((value) =>
      isText(typeof value === "string" ? value : "") &&
      /rerun|replication|stronger evidence/i.test(value as string),
    );

  const lines: string[] = [];
  lines.push(title);
  lines.push("");

  lines.push("## Recommendation");
  if (recAction || recVerdict || recReason) {
    if (recAction) lines.push(`- action: ${normalizeBundleValue(recAction)}`);
    if (recVerdict) lines.push(`- verdict: ${normalizeBundleValue(recVerdict)}`);
    if (recReason) lines.push(`- reason: ${normalizeBundleValue(recReason)}`);
  } else {
    lines.push("- no recommendation available");
  }
  lines.push("");

  lines.push("## Decision");
  if (decisionValue || decisionReason) {
    if (decisionValue) lines.push(`- decision: ${normalizeBundleValue(decisionValue)}`);
    if (decisionReason) lines.push(`- reason: ${normalizeBundleValue(decisionReason)}`);
  } else {
    lines.push("- no decision recorded");
  }
  lines.push("");

  lines.push("## Recent timeline events");
  const timelineEvents = Array.isArray(timeline.events) ? timeline.events : [];
  const recentEvents = timelineEvents.slice(0, 8);
  if (recentEvents.length === 0) {
    lines.push("- none");
  } else {
    for (const event of recentEvents) {
      if (!asRecord(event)) continue;
      const ts =
        normalizeBundleValue((event as Record<string, unknown>).created_at) !== "—"
          ? normalizeBundleValue((event as Record<string, unknown>).created_at)
          : normalizeBundleValue((event as Record<string, unknown>).timestamp);
      const kind = normalizeBundleValue((event as Record<string, unknown>).kind);
      const msg = normalizeBundleValue((event as Record<string, unknown>).message);
      const renderedKind = kind === "—" ? "event" : kind;
      if (ts !== "—" && msg !== "—") {
        lines.push(`- ${ts}: ${renderedKind} — ${msg}`);
      } else if (ts !== "—") {
        lines.push(`- ${ts}: ${renderedKind}`);
      } else if (msg !== "—") {
        lines.push(`- ${renderedKind} — ${msg}`);
      } else {
        lines.push(`- ${renderedKind}`);
      }
    }
    if (lines[lines.length - 1] === "## Recent timeline events") {
      lines.push("- no timeline events");
    }
  }
  lines.push("");

  if (includeReplicationHint || bundleSuggestsReplication) {
    lines.push("## Replication CLI hint");
    lines.push(`- ${replicationHint}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function ExperimentResearchCallCard({
  exp,
  summary,
  recentEvents = [],
  onChanged,
}: {
  exp: ExperimentDetail;
  summary: ExperimentSummaryResponse | null;
  recentEvents?: ExperimentEvent[];
  onChanged?: (experimentId: string) => void;
}) {
  const explicitDecision = summary?.decision ?? exp.decision ?? null;
  const decisionLabel = explicitDecision ? decisionLabelForFilter(explicitDecision) : null;
  const recommendation = summary?.recommendation ?? null;
  const recentWritebacks = normalizeWritebackEvents(recentEvents);

  const action = explicitDecision
    ? NEXT_ACTION[explicitDecision] ?? NEXT_ACTION_DEFAULT
    : recommendationAction(recommendation);

  const decisionBadge = explicitDecision
    ? DECISION_BADGE[explicitDecision] || "bg-gray-800 text-gray-400 border-gray-700"
    : "bg-gray-800 text-gray-500 border-gray-700";

  const validation = summary?.validation;
  const primary = summary?.primary_metric ?? null;
  const goalMetric = summary?.goal_metric ?? exp.goal_metric ?? null;
  const bestMetrics = summary?.best_metrics ?? {};
  const bestEntries = Object.entries(bestMetrics).slice(0, 4);
  const forkReason = summary?.fork_reason ?? exp.fork_reason ?? null;
  const decisionReason = summary?.decision_reason ?? exp.decision_reason ?? null;

  const recMetric = recommendation?.metric ?? null;
  const recValue = recommendation?.value ?? null;
  const recBaseline = recommendation?.baseline_value ?? null;
  const recDelta = recommendation?.delta ?? null;
  const recDirection = recommendation?.direction ?? null;
  const recAction = isText(recommendation?.action)
    ? recommendationLabelValue(recommendation.action)
    : null;
  const recVerdict = isText(recommendation?.verdict)
    ? recommendationLabelValue(recommendation.verdict)
    : null;
  const evidenceQuality = recommendation?.evidence_quality ?? null;
  const evidenceReason = recommendation?.evidence_reason ?? null;
  const sampleCount = recommendation?.sample_count ?? null;
  const baselineSource = recommendation?.baseline_source ?? null;
  const comparableCount = recommendation?.comparable_count ?? null;

  const explicitDecisionIsRerun = explicitDecision === "rerun";
  const recommendationLabelText = recommendationLabel(recommendation);
  const recommendationIsRerunLike =
    recommendationLabelText != null &&
    ["needs stronger evidence", "needs replication"].includes(
      recommendationLabelText.toLowerCase(),
    );
  const showReplicationPlan = explicitDecisionIsRerun || recommendationIsRerunLike;

  const parent = summary?.parent ?? null;
  const parentName = parent?.name ?? exp.parent_name ?? null;
  const parentRef = parent?.id ?? exp.parent_id ?? parentName ?? null;
  const family = summary?.family ?? exp.family ?? null;
  const goalDirection = summary?.goal_direction ?? exp.goal_direction ?? null;
  const parentFamily = parent?.family ?? family;
  const replicationReason = isText(recommendation?.reason)
    ? recommendation.reason.trim()
    : isText(decisionReason)
      ? decisionReason.trim()
      : "TODO: describe the ablation";
  const replicationPlanHint = `alch experiments replication-plan ${shellQuote(exp.name || exp.id)} --reason ${shellQuote(
    replicationReason,
  )}`;

  const [exportState, setExportState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [exportError, setExportError] = useState<string | null>(null);
  const [markdownExportState, setMarkdownExportState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [markdownExportError, setMarkdownExportError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "success" | "error">("idle");
  const [copyError, setCopyError] = useState<string | null>(null);
  const [bundleCopyState, setBundleCopyState] = useState<"idle" | "success" | "error">("idle");
  const [bundleCopyError, setBundleCopyError] = useState<string | null>(null);
  const [writeMode, setWriteMode] = useState<WritebackMode>("note");
  const [writeNote, setWriteNote] = useState("");
  const [writeDecision, setWriteDecision] = useState<ExperimentDecision>("keep");
  const [writeDecisionReason, setWriteDecisionReason] = useState("");
  const [writeLocator, setWriteLocator] = useState("");
  const [writeState, setWriteState] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [writeError, setWriteError] = useState<string | null>(null);

  const cliRef = exp.name || exp.id;
  const cliRefForShell = shellQuote(cliRef);
  const safeName = (cliRef || "experiment").replace(/[^a-zA-Z0-9_.-]+/g, "_");
  const bundleCli = `alch experiments bundle ${cliRefForShell}`;
  const sdkRef = JSON.stringify(exp.name || exp.id);
  const sdkReason = JSON.stringify(replicationReason);
  const sdkSnippet = `client = ExperimentClient(...)
client.replication_plan(${sdkRef}, reason=${sdkReason})`;
  const replicationPlanManifest = {
    kind: "replication-plan",
    dry_run: true,
    experiment: {
      id: exp.id,
      name: exp.name || exp.id,
    },
    parent: {
      ...(parent?.id ? { id: parent.id } : {}),
      ...(parentName ? { name: parentName } : {}),
      ...(parent?.id || parentName || parentFamily ? { family: parentFamily } : {}),
    },
    goal_metric: goalMetric,
    goal_direction: goalDirection,
    recommendation: {
      action: recAction,
      verdict: recVerdict,
      reason: recommendation?.reason ?? null,
      metric: recMetric,
      value: recValue,
      baseline: recBaseline,
      delta: recDelta,
      evidence: evidenceQuality,
    },
    cli: replicationPlanHint,
    safeguards: [
      "This manifest is dry_run=true and does not submit any task by itself.",
      "Explicit submit is required before running replication",
    ],
  };

  async function copyClipboardText(text: string) {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      throw new Error("Clipboard is unavailable in this environment.");
    }
    await navigator.clipboard.writeText(text);
  }

  async function copyReplicationPlanCli() {
    setCopyState("idle");
    setCopyError(null);

    try {
      await copyClipboardText(replicationPlanHint);
      setCopyState("success");
    } catch (err: unknown) {
      setCopyError(err instanceof Error ? err.message : String(err));
      setCopyState("error");
    }
  }

  async function copyResearchBundleCli() {
    setBundleCopyState("idle");
    setBundleCopyError(null);

    try {
      await copyClipboardText(bundleCli);
      setBundleCopyState("success");
    } catch (err: unknown) {
      setBundleCopyError(err instanceof Error ? err.message : String(err));
      setBundleCopyState("error");
    }
  }

  async function downloadReplicationPlan() {
    try {
      const manifest = JSON.stringify(replicationPlanManifest, null, 2);
      const blob = new Blob([manifest], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}-replication-plan.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setExportError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadResearchBundle() {
    return experimentsApi.getResearchBundle(exp.id);
  }

  async function downloadResearchBundleJson() {
    setExportState("loading");
    setExportError(null);
    try {
      const bundle = await loadResearchBundle();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
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

  async function downloadResearchBundleMarkdown() {
    setMarkdownExportState("loading");
    setMarkdownExportError(null);
    try {
      const bundle = await loadResearchBundle();
      const markdown = renderResearchBundleMarkdown(
        bundle as Record<string, any>,
        cliRef,
        showReplicationPlan,
        replicationPlanHint,
      );
      const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}-research-bundle.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setMarkdownExportState("done");
      setTimeout(() => setMarkdownExportState("idle"), 2000);
    } catch (err: any) {
      setMarkdownExportError(err?.message ?? String(err));
      setMarkdownExportState("error");
    }
  }

  const writebackValid = () => {
    if (writeMode === "note") return isText(writeNote);
    if (writeMode === "decision") return isText(writeDecisionReason);
    return isText(writeLocator);
  };

  async function submitWriteback() {
    if (!writebackValid() || writeState === "saving") return;

    const payloadLocator = writeLocator.trim();
    const payloadNote = writeNote.trim();
    const payloadReason = writeDecisionReason.trim();

    setWriteState("saving");
    setWriteError(null);

    try {
      if (writeMode === "note") {
        await experimentsApi.addNote(exp.id, payloadNote);
        setWriteNote("");
      } else if (writeMode === "decision") {
        await experimentsApi.decide(exp.id, writeDecision, payloadReason);
        setWriteDecisionReason("");
      } else {
        await experimentsApi.addEvent(exp.id, {
          kind: writeMode,
          message: `${writeMode === "artifact" ? "Artifact" : "Checkpoint"} locator: ${payloadLocator}`,
          data: {
            locator: payloadLocator,
            type: writeMode,
          },
        });
        setWriteLocator("");
      }

      setWriteState("success");
      onChanged?.(exp.id);
      setTimeout(() => setWriteState("idle"), 2000);
    } catch (err: unknown) {
      setWriteError(err instanceof Error ? err.message : String(err));
      setWriteState("error");
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-gray-400">Research call</h2>
        <span
          className={`text-[10px] px-2 py-0.5 rounded border uppercase ${decisionBadge}`}
        >
          {decisionLabel ?? "undecided"}
        </span>
      </div>

      <div className={`rounded-lg border px-3 py-2 ${action.tone}`}>
        <div className="text-xs font-medium">{action.label}</div>
        <div className="mt-0.5 text-[11px] opacity-80">{action.hint}</div>
      </div>

      {recommendation && (
        <div className="mt-3 rounded-lg border border-cyan-900/40 bg-cyan-900/10">
          <div className="px-2 py-1.5 border-b border-cyan-900/30 flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wide text-cyan-300">Recommendation</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={`text-[10px] px-2 py-0.5 rounded border ${recommendationTone(recAction, recVerdict)}`}
              >
                {recAction ?? "No action"}
              </span>
              <span
                className={`text-[10px] px-2 py-0.5 rounded border ${recommendationTone(recVerdict, recAction)}`}
              >
                {recVerdict ?? "No verdict"}
              </span>
            </div>
          </div>

          <div className="px-2 py-2 space-y-2">
            {isText(recommendation.reason) && (
              <p className="text-xs text-gray-300">{recommendation.reason}</p>
            )}
            {(isText(recMetric) || recValue !== null || recBaseline !== null || recDelta !== null) && (
              <div className="grid gap-1 sm:grid-cols-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-gray-500">Metric</div>
                  <div className="font-mono text-gray-300 text-xs">{recMetric ?? "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-gray-500">Value</div>
                  <div className="font-mono text-gray-300 text-xs">{formatNumericMetric(recValue)}</div>
                </div>
                <div className="sm:col-span-2 text-xs">
                  <div className="text-[10px] uppercase tracking-wide text-gray-500">Baseline / Delta</div>
                  <div className="font-mono text-gray-300 mt-0.5">
                    <span>baseline {formatNumericMetric(recBaseline)}</span>
                    <span className="text-gray-500"> / </span>
                    <span className={deltaClass(recDelta)}>
                      {isText(recDirection) ? `${recDirection} ` : ""}
                      {formatNumericMetric(recDelta)}
                    </span>
                  </div>
                </div>
              </div>
            )}
            {evidenceQuality && (
              <div className="rounded border border-gray-800 bg-gray-950/30 px-2 py-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wide text-gray-500">Evidence</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded border ${evidenceBadgeClass(evidenceQuality)}`}>
                    {evidenceQuality}
                  </span>
                  {baselineSource && (
                    <span className="text-[10px] text-gray-500">baseline: {baselineSource}</span>
                  )}
                </div>
                <div className="mt-1 text-[11px] text-gray-400">
                  {isText(evidenceReason) ? evidenceReason : "Evidence details unavailable."}
                  {sampleCount !== null && ` Samples: ${sampleCount}.`}
                  {comparableCount !== null && ` Comparables: ${comparableCount}.`}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showReplicationPlan && (
        <div className="mt-3 rounded-lg border border-blue-900/40 bg-blue-900/10">
          <div className="px-2 py-1.5 border-b border-blue-900/30 text-[10px] uppercase tracking-wide text-blue-300">
            Replication plan
          </div>
          <div className="px-2 py-2 space-y-2 text-xs text-gray-300">
            <p className="text-emerald-300">
              Replication plan preview for stronger evidence; this is dry-run only and no task will be submitted without
              explicit submit.
            </p>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Parent experiment</div>
              {parentName || parentRef ? (
                <p className="font-mono">
                  {parentName ? `${parentName} ` : ""}
                  {parentRef ? `(id: ${parentRef})` : ""}
                </p>
              ) : (
                <p className="text-gray-600">No parent reference available</p>
              )}
            </div>
            {family && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500">Family</div>
                <p className="font-mono">{family}</p>
              </div>
            )}
            {goalMetric && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500">Goal metric</div>
                <p className="font-mono">
                  {goalMetric}
                  {goalDirection ? ` (${goalDirection})` : ""}
                </p>
              </div>
            )}
            {(isText(recMetric) || recValue !== null || recBaseline !== null || recDelta !== null) && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500">Current metric</div>
                <div className="font-mono">
                  {isText(recMetric) ? recMetric : "—"}
                  {" / value "}
                  {formatNumericMetric(recValue)}
                  {" / baseline "}
                  {formatNumericMetric(recBaseline)}
                  {" / delta "}
                  <span className={deltaClass(recDelta)}>{formatNumericMetric(recDelta)}</span>
                </div>
              </div>
            )}
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Suggested reason</div>
              <p className="italic">{replicationReason}</p>
            </div>
            <p className="text-[11px] text-gray-400">
              Before submit, review config diff and target / cwd / args in CLI output.
              <br />
              Explicit submit required.
            </p>
            <p className="text-[11px] text-gray-400">CLI hint:</p>
            <code className="block text-[10px] text-gray-500 break-all">{replicationPlanHint}</code>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={copyReplicationPlanCli}
                aria-label="Copy replication plan CLI"
                className="text-[11px] px-2 py-1 rounded border border-blue-700 bg-blue-900/40 text-blue-100 hover:bg-blue-900/60"
                >
                Copy CLI
              </button>
              <button
                type="button"
                onClick={downloadReplicationPlan}
                className="text-[11px] px-2 py-1 rounded border border-blue-700 bg-blue-900/40 text-blue-100 hover:bg-blue-900/60"
              >
                Download plan JSON
              </button>
            </div>
            {copyState === "success" && (
              <p className="mt-1 text-[11px] text-emerald-400">CLI copied to clipboard.</p>
            )}
            {copyState === "error" && (
              <p className="mt-1 text-[11px] text-rose-400">{copyError ?? "Failed to copy CLI hint."}</p>
            )}
            <div>
              <p className="mt-2 text-[11px] text-gray-400">SDK snippet:</p>
              <pre className="mt-1 rounded border border-gray-800 bg-gray-950/40 p-2 text-[10px] text-gray-300 overflow-x-auto">
                <code>{sdkSnippet}</code>
              </pre>
            </div>
          </div>
        </div>
      )}

      {decisionReason && (
        <p className="mt-3 border-l-2 border-gray-800 pl-3 text-xs italic text-gray-400">
          &ldquo;{decisionReason}&rdquo;
        </p>
      )}

      {recentWritebacks.length > 0 && (
        <div>
          <div className="mt-3 text-[10px] uppercase tracking-wide text-gray-600 mb-1">Recent writebacks</div>
          <ul className="space-y-1 text-[11px] text-gray-300">
            {recentWritebacks.map((event) => {
              const locator = writebackLocator(event);
              const title = event.kind === "decision" ? writebackDecisionText(event) : event.message;
              const decisionData = event.kind === "decision" ? asRecord(event.data) : null;
              const rawDecisionWritebackReason = decisionData?.reason;
              const decisionWritebackReason = isText(rawDecisionWritebackReason) ? rawDecisionWritebackReason : null;
              return (
                <li key={event.id} className="rounded border border-gray-800 bg-gray-900/40 px-2 py-1">
                  <span>{title}</span>
                  {decisionWritebackReason && (
                    <span className="text-gray-400"> — {decisionWritebackReason}</span>
                  )}
                  {locator ? <code className="ml-1 font-mono">{locator}</code> : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="mt-3 space-y-2 text-xs">
        <div className="rounded-lg border border-indigo-900/40 bg-indigo-900/10">
          <div className="px-2 py-1.5 border-b border-indigo-900/30 text-[10px] uppercase tracking-wide text-indigo-300">
            Research writeback
          </div>

          <div className="px-2 py-2 space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {WRITEBACK_MODES.map((mode) => {
                const isActive = writeMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setWriteMode(mode)}
                    disabled={writeState === "saving"}
                    className={`text-[11px] px-2 py-1 rounded border ${
                      isActive
                        ? "border-indigo-400 bg-indigo-900/40 text-indigo-100"
                        : "border-gray-700 bg-gray-900 text-gray-300 hover:bg-gray-800"
                    }`}
                    aria-pressed={isActive}
                  >
                    {WRITEBACK_MODE_LABEL[mode]}
                  </button>
                );
              })}
            </div>

            {writeMode === "note" ? (
              <input
                type="text"
                placeholder="Write a research note"
                value={writeNote}
                onChange={(e) => setWriteNote(e.target.value)}
                className="w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[12px] text-gray-200 focus:border-indigo-400 focus:outline-none"
              />
            ) : writeMode === "decision" ? (
              <div className="space-y-2">
                <label htmlFor="research-call-decision" className="sr-only">
                  Decision
                </label>
                <select
                  id="research-call-decision"
                  value={writeDecision}
                  onChange={(e) => setWriteDecision(e.target.value as ExperimentDecision)}
                  aria-label="Decision"
                  className="w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[12px] text-gray-200 focus:border-indigo-400 focus:outline-none"
                >
                  {WRITEBACK_DECISIONS.map((d) => (
                    <option key={d} value={d}>
                      {WRITEBACK_DECISION_LABEL[d]}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="Write decision reason"
                  value={writeDecisionReason}
                  onChange={(e) => setWriteDecisionReason(e.target.value)}
                  className="w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[12px] text-gray-200 focus:border-indigo-400 focus:outline-none"
                />
              </div>
            ) : (
              <input
                type="text"
                placeholder="Write locator"
                value={writeLocator}
                onChange={(e) => setWriteLocator(e.target.value)}
                className="w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[12px] text-gray-200 focus:border-indigo-400 focus:outline-none"
              />
            )}

            <button
              type="button"
              onClick={submitWriteback}
              disabled={writeState === "saving" || !writebackValid()}
              className="text-[11px] px-2 py-1 rounded border border-indigo-700 bg-indigo-900/40 text-indigo-100 hover:bg-indigo-900/60 disabled:opacity-50"
            >
              Submit writeback
            </button>

            {writeState === "saving" && (
              <p className="text-[10px] text-gray-400">Saving…</p>
            )}
            {writeState === "success" && <p className="text-[10px] text-emerald-400">Writeback saved.</p>}
            {writeState === "error" && <p className="text-[10px] text-rose-400">{writeError ?? "Failed to save writeback."}</p>}
          </div>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-0.5">Goal metric</div>
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
          <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">Research bundle</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={downloadResearchBundleJson}
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
            <button
              type="button"
              onClick={downloadResearchBundleMarkdown}
              disabled={markdownExportState === "loading"}
              className="text-[11px] px-2 py-1 rounded border border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-50"
              title="Markdown handoff-friendly research-bundle export"
            >
              {markdownExportState === "loading"
                ? "Exporting…"
                : markdownExportState === "done"
                  ? "Downloaded"
                  : "Export Markdown"}
            </button>
            <div className="flex-1 min-w-0">
              <code className="text-[10px] text-gray-500 break-all">{bundleCli}</code>
            </div>
            <button
              type="button"
              onClick={copyResearchBundleCli}
              aria-label="Copy bundle CLI"
              className="text-[11px] px-2 py-1 rounded border border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700"
              >
              Copy CLI
            </button>
          </div>
          {exportError && <div className="mt-1 text-[10px] text-red-400">{exportError}</div>}
          {markdownExportError && (
            <div className="mt-1 text-[10px] text-red-400">{markdownExportError}</div>
          )}
          {bundleCopyState === "success" && (
            <p className="mt-1 text-[11px] text-emerald-400">Bundle CLI copied to clipboard.</p>
          )}
          {bundleCopyState === "error" && (
            <p className="mt-1 text-[11px] text-rose-400">{bundleCopyError ?? "Failed to copy bundle CLI."}</p>
          )}
        </div>
      </div>
    </div>
  );
}
