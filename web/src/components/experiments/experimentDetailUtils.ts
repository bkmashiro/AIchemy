import type {
  Task,
  ExperimentDetail,
  ExperimentTreeNode,
  ExperimentRecommendation,
} from "../../lib/api";

// ─── Status badges (experiment-level) ───────────────────────────────────────

export const STATUS_BADGE: Record<string, string> = {
  running: "bg-blue-900/30 text-blue-400 border-blue-700/40",
  passed:  "bg-green-900/30 text-green-400 border-green-700/40",
  partial: "bg-orange-900/30 text-orange-400 border-orange-700/40",
  failed:  "bg-red-900/30 text-red-400 border-red-700/40",
};

const STATUS_BADGE_FALLBACK = "bg-gray-800 text-gray-400 border-gray-700";

export function statusBadgeClass(status: string): string {
  return STATUS_BADGE[status] ?? STATUS_BADGE_FALLBACK;
}

// ─── Decision badges ────────────────────────────────────────────────────────

export const DECISION_BADGE: Record<string, string> = {
  keep:  "bg-green-900/30 text-green-400 border-green-700/40",
  drop:  "bg-red-900/30 text-red-400 border-red-700/40",
  rerun: "bg-blue-900/30 text-blue-400 border-blue-700/40",
  fork:  "bg-purple-900/30 text-purple-400 border-purple-700/40",
};

const RECOMMENDATION_BADGE_FALLBACK = "bg-cyan-900/30 text-cyan-400 border-cyan-700/40";

function normalizeRecommendationText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

export function recommendationBadgeClass(actionOrVerdict?: string | null): string {
  const key = normalizeRecommendationText(actionOrVerdict);
  return key ? DECISION_BADGE[key] ?? RECOMMENDATION_BADGE_FALLBACK : RECOMMENDATION_BADGE_FALLBACK;
}

export function recommendationLabel(
  recommendation?: ExperimentRecommendation | null,
): string | null {
  const action = normalizeRecommendationText(recommendation?.action);
  if (action) return recommendation?.action?.trim() ?? null;

  const verdict = normalizeRecommendationText(recommendation?.verdict);
  return verdict ? recommendation?.verdict?.trim() ?? null : null;
}

export function formatMetricDelta(
  delta?: number | null,
  direction?: "min" | "max" | string | null,
): string | null {
  if (typeof delta !== "number" || Number.isNaN(delta)) return null;
  if (!Number.isFinite(delta)) return null;

  const abs = Math.abs(delta);
  const magnitudeText =
    abs > 0 && (abs >= 10000 || abs < 1e-4)
      ? delta.toPrecision(4)
      : delta.toFixed(4);

  const sign = delta > 0 ? "+" : "";
  const directionKey = normalizeRecommendationText(direction);
  const prefix = directionKey === "max" ? "↑" : directionKey === "min" ? "↓" : "";

  return prefix ? `${prefix} ${sign}${magnitudeText}` : `${sign}${magnitudeText}`;
}

export function diffChipLabels(node: ExperimentTreeNode): string[] {
  const summary = node.diff_summary;
  if (!summary) return [];

  const labels: string[] = [];

  if (summary.metric_delta !== null && summary.metric_delta !== undefined) {
    const metricLabel =
      summary.metric && summary.metric.trim().length > 0 ? summary.metric : "metric";
    const deltaText = formatMetricDelta(summary.metric_delta, summary.direction);
    if (deltaText) {
      labels.push(`${metricLabel}: ${deltaText}`);
    }
  }

  if (summary.config_changed && typeof summary.config_change_count === "number") {
    const count = summary.config_change_count;
    labels.push(count > 0 ? `config +${count}` : "config changed");
  }

  if (summary.status_changed_from_parent) {
    if (summary.parent_status && summary.parent_status !== node.status) {
      labels.push(`status ${summary.parent_status}→${node.status}`);
    } else {
      labels.push("status changed");
    }
  }

  return labels.slice(0, 3);
}

// ─── Matrix helpers ─────────────────────────────────────────────────────────

export type MatrixKeys = {
  rowKey: string;
  colKey: string;
  extraKeys: string[];
  rowValues: unknown[];
  colValues: unknown[];
};

// Pick a row/column axis pair for the experiment matrix grid.
//
// Edge cases worth knowing:
//   - 0 params  → rowKey/colKey are "" and the grid degenerates to one cell.
//   - 1 param   → only rowKey is set; colValues defaults to [""] so the grid
//                 renders as a single column.
//   - seed bias → when "seed" is one of the params, it is forced into colKey
//                 (humans read seeds as repetitions, so they belong on cols).
//   - non-array param values fall through to `[]`, which is what the grid
//                 already expects (renders an empty row/col instead of NaN).
export function pickMatrixKeys(
  paramSpace: Record<string, unknown>,
): MatrixKeys {
  const paramKeys = Object.keys(paramSpace);
  let rowKey = paramKeys[0] ?? "";
  let colKey = paramKeys[1] ?? "";

  if (paramKeys.includes("seed") && paramKeys.length > 1) {
    colKey = "seed";
    rowKey = paramKeys.find((k) => k !== "seed") ?? paramKeys[0];
  }

  // Preserve the historical empty-array fallback for non-array param values.
  // Callers downstream iterate rowValues/colValues directly with .map().
  const rowValues = rowKey
    ? Array.isArray(paramSpace[rowKey])
      ? (paramSpace[rowKey] as unknown[])
      : []
    : [""];
  const colValues = colKey
    ? Array.isArray(paramSpace[colKey])
      ? (paramSpace[colKey] as unknown[])
      : []
    : [""];
  const extraKeys = paramKeys.filter((k) => k !== rowKey && k !== colKey);

  return { rowKey, colKey, extraKeys, rowValues, colValues };
}

export function taskKeyFor(
  task: Task,
  rowKey: string,
  colKey: string,
  extraKeys: string[],
): string {
  if (!task.param_overrides) return "";
  const parts = [
    rowKey ? String(task.param_overrides[rowKey]) : "",
    colKey ? String(task.param_overrides[colKey]) : "",
    ...extraKeys.map((k) => String(task.param_overrides?.[k] ?? "")),
  ];
  return parts.join("|");
}

export type CellStatus = "passed" | "failed" | "running" | "pending";

export function getCellStatus(
  task: Task | undefined,
  exp: ExperimentDetail,
): CellStatus {
  if (!task) return "pending";
  const validation = exp.results[task.id];
  if (validation) return validation.passed ? "passed" : "failed";
  if (["running", "dispatched"].includes(task.status)) return "running";
  if (task.status === "completed") return "running"; // completed but no eval yet
  return "pending";
}

export const CELL_COLORS: Record<CellStatus, string> = {
  passed:  "bg-green-900/40 text-green-400 border-green-700/30",
  failed:  "bg-red-900/40 text-red-400 border-red-700/30",
  running: "bg-blue-900/40 text-blue-400 border-blue-700/30",
  pending: "bg-gray-800/40 text-gray-500 border-gray-700/30",
};

export const CELL_ICONS: Record<CellStatus, string> = {
  passed:  "✓",
  failed:  "✗",
  running: "↻",
  pending: "⏳",
};

// ─── Timeline helpers ───────────────────────────────────────────────────────

export const EVENT_BADGE: Record<string, string> = {
  created:        "bg-blue-900/30 text-blue-400 border-blue-700/40",
  forked:         "bg-purple-900/30 text-purple-400 border-purple-700/40",
  task_started:   "bg-blue-900/30 text-blue-400 border-blue-700/40",
  task_completed: "bg-green-900/30 text-green-400 border-green-700/40",
  task_failed:    "bg-red-900/30 text-red-400 border-red-700/40",
  resumed:        "bg-amber-900/30 text-amber-400 border-amber-700/40",
  moved_stub:     "bg-amber-900/30 text-amber-400 border-amber-700/40",
  metric_best:    "bg-green-900/30 text-green-400 border-green-700/40",
  note:           "bg-gray-800 text-gray-300 border-gray-700",
  decision:       "bg-purple-900/30 text-purple-400 border-purple-700/40",
  artifact:       "bg-cyan-900/30 text-cyan-400 border-cyan-700/40",
  checkpoint:     "bg-teal-900/30 text-teal-400 border-teal-700/40",
};

// Pull a path/uri out of an artifact/checkpoint event payload. Returns the
// raw locator (path or uri) plus the artifact_type label when present so the
// timeline can render a compact "[type] locator" link.
export function artifactLocator(
  data: Record<string, unknown> | undefined,
): { locator: string; type?: string; name?: string; step?: number } | null {
  if (!data) return null;
  const uri = typeof data.uri === "string" ? data.uri.trim() : "";
  const path = typeof data.path === "string" ? data.path.trim() : "";
  const loc = uri || path;
  if (!loc) return null;
  const type = typeof data.artifact_type === "string" ? data.artifact_type : undefined;
  const name = typeof data.name === "string" ? data.name : undefined;
  const step = typeof data.step === "number" ? data.step : undefined;
  return { locator: loc, type, name, step };
}

export function formatEventData(
  data: Record<string, unknown> | undefined,
): string | null {
  if (!data) return null;
  try {
    const s = JSON.stringify(data);
    if (s === "{}") return null;
    return s.length > 240 ? s.slice(0, 237) + "..." : s;
  } catch {
    return null;
  }
}

// ─── Lineage tree helpers ───────────────────────────────────────────────────

export function findNodePath(
  roots: ExperimentTreeNode[],
  targetId: string,
): { root: ExperimentTreeNode; path: ExperimentTreeNode[] } | null {
  for (const root of roots) {
    const path: ExperimentTreeNode[] = [];
    const dfs = (node: ExperimentTreeNode): boolean => {
      path.push(node);
      if (node.id === targetId) return true;
      for (const c of node.children) {
        if (dfs(c)) return true;
      }
      path.pop();
      return false;
    };
    if (dfs(root)) return { root, path };
  }
  return null;
}

// Count descendants of `node` (the node itself is NOT included). The lineage
// rail uses this to label folded branches as "+N hidden" where N covers every
// hidden descendant — including grandchildren — not just direct children.
export function countSubtreeNodes(node: ExperimentTreeNode): number {
  let n = 0;
  for (const c of node.children) {
    n += 1 + countSubtreeNodes(c);
  }
  return n;
}

// Sort sibling nodes for lineage continuity and rail readability.
//
// Priority (lowest numeric first):
//  1) Focus-path nodes always lead.
//  2) Child-bearing nodes (continuation branches) before leaves.
//  3) keep/fork decisions before rerun/drop/undecided decisions.
//  4) Among child-bearing nodes, deeper/more-descendant branches first.
//  5) Failed/drop leaves sink to the end.
//  6) Preserve API order for true ties (stable via index).
//
// This helper is pure; callers recurse into returned arrays.
export function sortLineageChildren(
  children: ExperimentTreeNode[],
  pathIds: Set<string>,
  subtreeCounts?: Map<string, number>,
): ExperimentTreeNode[] {
  type Key = readonly [number, number, number, number, number];

  const decorated = children.map((node, idx) => {
    const onPath = pathIds.has(node.id) ? 0 : 1;
    const hasKids = node.children.length > 0 ? 0 : 1;
    const isPromotedDecision = node.decision === "keep" || node.decision === "fork" ? 0 : 1;
    const childDepth =
      node.children.length > 0 ? subtreeCounts?.get(node.id) ?? countSubtreeNodes(node) : 0;
    const leafTone =
      node.children.length === 0 && (node.status === "failed" || node.decision === "drop")
        ? 1
        : 0;

    return {
      node,
      idx,
      key: [onPath, hasKids, isPromotedDecision, -childDepth, leafTone] as Key,
    };
  });

  decorated.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) {
      if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    }
    return a.idx - b.idx;
  });
  return decorated.map((d) => d.node);
}

export type LineageTone = "current" | "path" | "active" | "muted";

// Decide the visual tone for a lineage node. The order matters:
//   1. current  — the focused experiment always wins.
//   2. path     — ancestors on the selected spine stay highlighted.
//   3. muted    — failed runs, dropped decisions, and undecided leaf branches
//                 fold into the background so live work pops visually. A leaf
//                 with status "running" is intentionally NOT muted so an
//                 in-flight run keeps drawing attention until it terminates.
//   4. active   — everything else (passed, partial, running with kids, etc.).
export function lineageNodeTone(
  node: ExperimentTreeNode,
  isCurrent: boolean,
  onPath: boolean,
): LineageTone {
  if (isCurrent) return "current";
  if (onPath) return "path";
  if (
    node.status === "failed" ||
    node.decision === "drop" ||
    (node.children.length === 0 && node.decision === null && node.status !== "running")
  ) {
    return "muted";
  }
  return "active";
}

// ─── Research call next-action copy ─────────────────────────────────────────

export const NEXT_ACTION: Record<
  string,
  { label: string; hint: string; tone: string }
> = {
  keep: {
    label: "Promote → fork next stage",
    hint: "Use this checkpoint as a parent for the next sweep.",
    tone: "border-green-400/30 bg-green-500/10 text-green-200",
  },
  fork: {
    label: "Branch from this run",
    hint: "Open a narrower fork to test the variant.",
    tone: "border-purple-400/30 bg-purple-500/10 text-purple-200",
  },
  rerun: {
    label: "Re-run for more evidence",
    hint: "Keep collecting before deciding keep / drop.",
    tone: "border-blue-400/30 bg-blue-500/10 text-blue-200",
  },
  drop: {
    label: "Fold into background",
    hint: "Preserve as evidence; do not extend.",
    tone: "border-amber-400/30 bg-amber-500/10 text-amber-200",
  },
};

export const NEXT_ACTION_DEFAULT = {
  label: "Awaiting decision",
  hint: "Choose keep / fork / rerun / drop to advance.",
  tone: "border-white/[0.08] bg-white/[0.04] text-gray-300",
};
