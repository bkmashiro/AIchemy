import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  experimentsApi,
  type ExperimentResearchReportResponse,
  type ExperimentResearchReportLeaderEntry,
  type ExperimentResearchReportBlock,
} from "../../lib/api";
import { StatusBadge } from "./StatusBadge";
import { ExperimentFamilyCompareBoard } from "./ExperimentFamilyCompareBoard";

const REPORT_LIMIT = 50;

// Stable shape so a "no family selected" panel still renders without
// special-casing every reader. Counts are zero, lists are empty.
const EMPTY_REPORT: ExperimentResearchReportResponse = {
  filters: { family: null, decision: null, status: null, limit: REPORT_LIMIT },
  generated_at: "",
  counts: { total: 0, by_status: {}, by_decision: {} },
  metric: null,
  leaderboard: [],
  experiments: [],
};

// Quote a CLI argument that may contain spaces or shell metacharacters.
// Single-quote escape is enough for /bin/sh, zsh, and bash.
function shellQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_./@:=+-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function buildReportCommand(opts: {
  family?: string | null;
  decision?: string | null;
  status?: string | null;
  format?: "json" | "markdown";
  output?: string | null;
}): string {
  const parts = ["alch", "experiments", "report"];
  if (opts.family) parts.push("--family", shellQuote(opts.family));
  if (opts.decision) parts.push("--decision", shellQuote(opts.decision));
  if (opts.status) parts.push("--status", shellQuote(opts.status));
  if (opts.format) parts.push("--format", opts.format);
  if (opts.output) parts.push("--output", shellQuote(opts.output));
  return parts.join(" ");
}

export function buildBundleCommand(ref: string): string {
  return `alch experiments bundle ${shellQuote(ref)}`;
}

export function buildForkPlanCommand(ref: string, reason?: string): string {
  const parts = ["alch", "experiments", "fork-plan", shellQuote(ref)];
  if (reason) parts.push("--reason", shellQuote(reason));
  return parts.join(" ");
}

export function pickUndecided(
  report: ExperimentResearchReportResponse,
): ExperimentResearchReportBlock[] {
  return report.experiments.filter((e) => !e.decision);
}

function formatMetricValue(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6)) return value.toExponential(3);
  return value.toPrecision(6).replace(/0+$/, "").replace(/\.$/, "");
}

function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function filenameSuffix(value: string): string {
  const safe = value.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "family";
}

function mdText(value: string | number | null | undefined, empty = "—"): string {
  if (value == null || value === "") return empty;
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, " ")
    .replace(/([`*_{}\[\]()#+.!|>\-<>])/g, "\\$1");
}

function mdCell(value: string | number | null | undefined): string {
  if (value == null || value === "") return "—";
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function mdCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "_(none)_";
  return entries.map(([k, v]) => `${mdText(k)}=${v}`).join(", ");
}

function formatTaskCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "—";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

function formatPrimaryMetric(
  primary: ExperimentResearchReportBlock["primary_metric"],
): string {
  if (!primary) return "—";
  return `${primary.metric}=${formatMetricValue(primary.best)}`;
}

function formatRecentEvents(events: ExperimentResearchReportBlock["recent_events"]): string {
  if (!events.length) return "—";
  return events
    .map((evt) => (evt.created_at ? `${evt.kind}@${evt.created_at}` : evt.kind))
    .join("; ");
}

export function renderResearchReportMarkdown(
  report: ExperimentResearchReportResponse,
): string {
  const lines: string[] = [];
  lines.push("# Experiment Research Report");
  lines.push("");
  lines.push("## Filters");
  lines.push("");
  lines.push(`- family: ${report.filters.family ? mdText(report.filters.family) : "*all*"}`);
  lines.push(
    `- decision: ${report.filters.decision ? mdText(report.filters.decision) : "*all*"}`,
  );
  lines.push(`- status: ${report.filters.status ? mdText(report.filters.status) : "*all*"}`);
  lines.push(`- limit: ${report.filters.limit ?? "*default*"}`);
  if (report.generated_at) {
    lines.push(`- generated_at: ${mdText(report.generated_at)}`);
  }
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push(`- total: ${report.counts.total}`);
  lines.push(`- by_status: ${mdCounts(report.counts.by_status)}`);
  lines.push(`- by_decision: ${mdCounts(report.counts.by_decision)}`);
  lines.push("");

  lines.push("## Metric");
  lines.push("");
  if (report.metric?.name) {
    lines.push(`- name: ${mdText(report.metric.name)}`);
    lines.push(`- direction: ${mdText(report.metric.direction)}`);
  } else {
    lines.push("_No goal metric declared by any experiment in this slice._");
  }
  lines.push("");

  lines.push("## Leaderboard");
  lines.push("");
  if (report.leaderboard.length === 0) {
    lines.push("_Empty — no experiment in this slice has a numeric goal-metric value yet._");
  } else {
    lines.push("| Rank | Experiment | Status | Decision | Metric | Value |");
    lines.push("| ---: | --- | --- | --- | --- | ---: |");
    for (const row of report.leaderboard) {
      lines.push(
        `| ${row.rank} | ${mdCell(row.name)} | ${mdCell(row.status)} | ${mdCell(
          row.decision,
        )} | ${mdCell(row.metric)} | ${formatMetricValue(row.value)} |`,
      );
    }
  }
  lines.push("");

  const undecided = pickUndecided(report);
  lines.push("## Undecided");
  lines.push("");
  if (report.experiments.length === 0) {
    lines.push("_No experiments in this slice._");
  } else if (undecided.length === 0) {
    lines.push("_All experiments in this slice have a decision._");
  } else {
    lines.push(`_${undecided.length} of ${report.counts.total} undecided._`);
    lines.push("");
    lines.push("| Experiment | Status | Primary metric | Artifacts | Checkpoints |");
    lines.push("| --- | --- | --- | ---: | ---: |");
    for (const exp of undecided) {
      lines.push(
        `| ${mdCell(exp.name)} | ${mdCell(exp.status)} | ${mdCell(
          formatPrimaryMetric(exp.primary_metric),
        )} | ${exp.artifact_count} | ${exp.checkpoint_count} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Experiments");
  lines.push("");
  if (report.experiments.length === 0) {
    lines.push("_No experiments match the current filters._");
  } else {
    lines.push(
      "| Name | Family | Status | Decision | Task counts | Primary metric | Artifacts | Checkpoints | Recent events |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- | ---: | ---: | --- |");
    for (const exp of report.experiments) {
      lines.push(
        `| ${mdCell(exp.name || exp.id)} | ${mdCell(exp.family)} | ${mdCell(
          exp.status,
        )} | ${mdCell(exp.decision)} | ${mdCell(formatTaskCounts(exp.task_counts))} | ${mdCell(
          formatPrimaryMetric(exp.primary_metric),
        )} | ${exp.artifact_count} | ${exp.checkpoint_count} | ${mdCell(
          formatRecentEvents(exp.recent_events),
        )} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n").replace(/\n+$/, "\n");
}

function downloadMarkdown(filename: string, body: string) {
  const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers / non-secure context: ignore — user can still read.
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[10px] uppercase tracking-wide text-gray-500 hover:text-gray-300"
      title="Copy to clipboard"
    >
      {copied ? "copied" : label}
    </button>
  );
}

function CommandRow({ cmd, label }: { cmd: string; label: string }) {
  return (
    <div className="flex items-center justify-between gap-1.5 bg-gray-950 border border-gray-800/80 rounded-sm px-2 py-1">
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wide text-gray-600">{label}</div>
        <code className="block text-[11px] text-gray-300 truncate font-mono leading-tight">{cmd}</code>
      </div>
      <CopyButton value={cmd} label="copy" />
    </div>
  );
}

function CountsRow({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return <span className="text-gray-600">none</span>;
  return (
    <span className="font-mono text-[11px] text-gray-300">
      {entries.map(([k, v]) => `${k}=${v}`).join("  ")}
    </span>
  );
}

interface Props {
  familyFilter: string;
  families: string[];
  decisionFilter: string;
  statusFilter: string;
  onSelectFamily: (family: string) => void;
}

export function ExperimentReviewWorkspace({
  familyFilter,
  families,
  decisionFilter,
  statusFilter,
  onSelectFamily,
}: Props) {
  const [report, setReport] = useState<ExperimentResearchReportResponse>(EMPTY_REPORT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAllUndecided, setShowAllUndecided] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      setLoading(true);
      experimentsApi
        .getResearchReport({
          family: familyFilter || undefined,
          decision: decisionFilter || undefined,
          status: statusFilter || undefined,
          limit: REPORT_LIMIT,
        })
        .then((data) => {
          if (cancelled) return;
          setReport(data);
          setError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setReport({
            ...EMPTY_REPORT,
            filters: {
              family: familyFilter || null,
              decision: decisionFilter || null,
              status: statusFilter || null,
              limit: REPORT_LIMIT,
            },
          });
          setError(err?.message ?? "Failed to load research report");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const t = setInterval(load, 20000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [familyFilter, decisionFilter, statusFilter]);

  // Drop a stale selection whenever the filtered slice no longer contains it.
  // Reading from the report (not local state) keeps the selection coherent
  // even when filters change underneath us between refreshes.
  useEffect(() => {
    if (!selectedId) return;
    const stillPresent = report.experiments.some((e) => e.id === selectedId);
    if (!stillPresent) setSelectedId(null);
  }, [report, selectedId]);

  const undecided = useMemo(() => pickUndecided(report), [report]);
  const selected = useMemo(
    () => (selectedId ? report.experiments.find((e) => e.id === selectedId) ?? null : null),
    [report, selectedId],
  );
  const selectedRef = selected?.name ?? selected?.id ?? null;

  const reportCmd = buildReportCommand({
    family: familyFilter || null,
    decision: decisionFilter || null,
    status: statusFilter || null,
    format: "markdown",
    output: "report.md",
  });
  const bundleCmd = selectedRef ? buildBundleCommand(selectedRef) : null;
  const forkCmd = selectedRef
    ? buildForkPlanCommand(selectedRef, "TODO: describe the ablation")
    : null;

  const onDownloadJson = () => {
    const suffix = familyFilter ? `-${filenameSuffix(familyFilter)}` : "-all";
    downloadJson(`experiment-research-report${suffix}.json`, report);
  };
  const onDownloadMarkdown = () => {
    const suffix = familyFilter ? filenameSuffix(familyFilter) : "all";
    downloadMarkdown(`report-${suffix}.md`, renderResearchReportMarkdown(report));
  };

  const hasFamily = !!familyFilter;
  const hasReport = report.counts.total > 0;

  return (
    <div className="bg-gray-900 border border-gray-800/80 rounded-sm p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-gray-200">Review workspace</h2>
          {loading && <span className="text-[10px] text-gray-600">refreshing…</span>}
        </div>
        <div className="flex items-center gap-2">
          {!hasFamily && families.length > 0 && (
            <select
              value=""
              onChange={(e) => e.target.value && onSelectFamily(e.target.value)}
              className="bg-gray-950 border border-gray-800/80 rounded-sm px-2 py-1 text-[11px] text-gray-300"
            >
              <option value="">Pick a family…</option>
              {families.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={onDownloadMarkdown}
            disabled={!hasReport && !hasFamily}
            className="text-[11px] text-gray-400 hover:text-gray-200 disabled:text-gray-700 disabled:cursor-not-allowed"
            title="Download the research report as Markdown"
          >
            download Markdown
          </button>
          <button
            type="button"
            onClick={onDownloadJson}
            disabled={!hasReport && !hasFamily}
            className="text-[11px] text-gray-400 hover:text-gray-200 disabled:text-gray-700 disabled:cursor-not-allowed"
            title="Download the research report as JSON"
          >
            download JSON
          </button>
        </div>
      </div>

      {error && (
        <div className="text-[11px] text-red-400 bg-red-950/40 border border-red-900 rounded-sm px-2 py-1">
          {error}
        </div>
      )}

      {!hasFamily && (
        <p className="text-[11px] text-gray-500">
          Pick a family above to load its leaderboard, undecided queue, and
          report/bundle/fork-plan export commands. The workspace is read-only —
          decisions are still set from each experiment&apos;s detail page.
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px]">
        <div className="bg-gray-950 border border-gray-800/80 rounded-sm p-1.5 break-words">
          <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">Total</div>
          <div className="text-gray-200 font-mono text-base">{report.counts.total}</div>
        </div>
        <div className="bg-gray-950 border border-gray-800/80 rounded-sm p-1.5 break-words">
          <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">By status</div>
          <CountsRow counts={report.counts.by_status} />
        </div>
        <div className="bg-gray-950 border border-gray-800/80 rounded-sm p-1.5 break-words">
          <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">By decision</div>
          <CountsRow counts={report.counts.by_decision} />
        </div>
      </div>

      {hasFamily && (
        <ExperimentFamilyCompareBoard
          report={report}
          selectedId={selectedId}
          onSelectExperiment={setSelectedId}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        <div>
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-xs text-gray-400">Leaderboard</h3>
            <span className="text-[10px] text-gray-600">
              {report.metric
                ? `${report.metric.name} (${report.metric.direction})`
                : "no goal metric"}
            </span>
          </div>
          <div className="bg-gray-950 border border-gray-800/80 rounded-sm overflow-hidden">
            {report.leaderboard.length === 0 ? (
              <p className="text-[11px] text-gray-600 px-2 py-2">
                {hasFamily
                  ? "No leaderboard yet — no experiment in this slice has a numeric goal-metric value."
                  : "Select a family to see the leaderboard."}
              </p>
            ) : (
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-gray-500 text-left">
                    <th className="px-2 py-1 font-normal">#</th>
                    <th className="px-2 py-1 font-normal">Experiment</th>
                    <th className="px-2 py-1 font-normal">Status</th>
                    <th className="px-2 py-1 font-normal">Decision</th>
                    <th className="px-2 py-1 font-normal text-right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {report.leaderboard.map((row: ExperimentResearchReportLeaderEntry) => (
                    <tr
                      key={row.id}
                      onClick={() => setSelectedId(row.id)}
                      className={
                        "border-t border-gray-800/70 cursor-pointer hover:bg-gray-900/70 " +
                        (selectedId === row.id ? "bg-gray-900" : "")
                      }
                    >
                      <td className="px-2 py-1 text-gray-500 font-mono leading-tight">{row.rank}</td>
                      <td className="px-2 py-1 font-mono text-gray-200 truncate max-w-[12rem] leading-tight">
                        {row.name}
                      </td>
                      <td className="px-2 py-1 leading-tight">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="px-2 py-1 text-gray-400 leading-tight">{row.decision ?? "—"}</td>
                      <td className="px-2 py-1 font-mono text-right text-gray-200 leading-tight">
                        {formatMetricValue(row.value)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-xs text-gray-400">Undecided queue</h3>
            <span className="text-[10px] text-gray-600">
              {undecided.length} of {report.counts.total}
            </span>
          </div>
          <div className="bg-gray-950 border border-gray-800/80 rounded-sm overflow-hidden">
            {undecided.length === 0 ? (
              <p className="text-[11px] text-gray-600 px-2 py-2">
                {hasFamily ? "Nothing left to decide in this slice." : "—"}
              </p>
            ) : (
              <ul className="divide-y divide-gray-800">
                {(showAllUndecided ? undecided : undecided.slice(0, 8)).map((exp) => (
                  <li
                    key={exp.id}
                    onClick={() => setSelectedId(exp.id)}
                    className={
                      "px-2 py-1 cursor-pointer hover:bg-gray-900/70 " +
                      (selectedId === exp.id ? "bg-gray-900" : "")
                    }
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-gray-200 truncate">
                        {exp.name}
                      </span>
                      <StatusBadge status={exp.status} />
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[10px] text-gray-500 leading-tight">
                      <span className="font-mono">
                        {exp.primary_metric
                          ? `${exp.primary_metric.metric}=${formatMetricValue(exp.primary_metric.best)}`
                          : "no metric"}
                      </span>
                      <span>
                        a={exp.artifact_count} c={exp.checkpoint_count}
                      </span>
                    </div>
                  </li>
                ))}
                {undecided.length > 8 && (
                  <li className="px-2 py-1 text-[10px] text-gray-500">
                    <button
                      type="button"
                      onClick={() => setShowAllUndecided((v) => !v)}
                      className="hover:text-gray-300"
                    >
                      {showAllUndecided ? "show fewer" : `show all ${undecided.length}`}
                    </button>
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
      </div>

      <div className="bg-gray-950 border border-gray-800/80 rounded-sm p-1.5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-xs text-gray-400">
            Selected:{" "}
            {selected ? (
              <Link
                to={`/experiments/${selected.id}`}
                className="text-blue-400 hover:text-blue-300 font-mono"
              >
                {selected.name}
              </Link>
            ) : (
              <span className="text-gray-600">none</span>
            )}
          </h3>
          {selected && (
            <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
              <StatusBadge status={selected.status} />
              <span>decision: {selected.decision ?? "—"}</span>
            </div>
          )}
        </div>
        {selected ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 text-[11px]">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-600">Tasks</div>
              <CountsRow counts={selected.task_counts} />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-600">Primary metric</div>
              <span className="font-mono text-gray-300">
                {selected.primary_metric
                  ? `${selected.primary_metric.metric} (${selected.primary_metric.direction}) best=${formatMetricValue(selected.primary_metric.best)}`
                  : "—"}
              </span>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-600">Artifacts</div>
              <span className="font-mono text-gray-300">
                {selected.artifact_count} files / {selected.checkpoint_count} checkpoints
              </span>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-600">Recent events</div>
              {selected.recent_events.length === 0 ? (
                <span className="text-gray-600">none</span>
              ) : (
                <ul className="space-y-0.5 leading-tight">
                  {selected.recent_events.slice(-3).map((evt, i) => (
                    <li key={i} className="font-mono text-gray-400 truncate">
                      {evt.kind}: {evt.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-gray-600">
            Click a leaderboard row or undecided item to inspect its brief and export commands.
          </p>
        )}
      </div>

      <div className="space-y-1">
        <h3 className="text-xs text-gray-400">Exports</h3>
        <CommandRow cmd={reportCmd} label="Family report (markdown)" />
        {bundleCmd && <CommandRow cmd={bundleCmd} label="Selected bundle" />}
        {forkCmd && <CommandRow cmd={forkCmd} label="Selected fork-plan (dry-run)" />}
        {!bundleCmd && (
          <p className="text-[10px] text-gray-600">
            Select an experiment above to reveal bundle and fork-plan commands.
          </p>
        )}
      </div>
    </div>
  );
}
