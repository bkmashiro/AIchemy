import type {
  Task,
  ExperimentDetail,
  ExperimentTreeNode,
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

// ─── Matrix helpers ─────────────────────────────────────────────────────────

export type MatrixKeys = {
  rowKey: string;
  colKey: string;
  extraKeys: string[];
  rowValues: unknown[];
  colValues: unknown[];
};

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

  const rowValues = rowKey ? ((paramSpace[rowKey] as unknown[]) ?? [""]) : [""];
  const colValues = colKey ? ((paramSpace[colKey] as unknown[]) ?? [""]) : [""];
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
};

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
