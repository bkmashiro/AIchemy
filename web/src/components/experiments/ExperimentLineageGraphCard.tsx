import { Link } from "react-router-dom";
import type { ExperimentTreeNode, Task } from "../../lib/api";
import {
  DECISION_BADGE,
  countSubtreeNodes,
  diffChipLabels,
  findNodePath,
  lineageNodeTone,
  recommendationBadgeClass,
  recommendationLabel,
  sortLineageChildren,
  decisionLabelForFilter,
  type LineageTone,
} from "./experimentDetailUtils";

type RailRow = {
  node: ExperimentTreeNode;
  depth: number;
  isCurrent: boolean;
  onPath: boolean;
  tone: LineageTone;
  isLast: boolean;
  hasVisibleChildren: boolean;
  foldedCount?: number;
  // rails[d] = true iff column d should show a vertical line passing through
  // this row (i.e. ancestor at depth d has a later sibling). Length === depth.
  rails: boolean[];
  // railOnPath[d] = true iff the ancestor at depth d is on the selected path,
  // so the rail at that column should render with the path-highlight color.
  railOnPath: boolean[];
};

function taskPriority(status: Task["status"]): number {
  switch (status) {
    case "running":
      return 0;
    case "completed":
      return 1;
    case "pending":
    case "queued":
    case "dispatched":
    case "paused":
      return 2;
    case "failed":
    case "killed":
    case "lost":
      return 3;
    default:
      return 2;
  }
}

function orderTaskLinks(tasks: Task[]): Task[] {
  return tasks
    .map((task, index) => ({ task, index, priority: taskPriority(task.status) }))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.index - b.index;
    })
    .map((entry) => entry.task);
}

function taskStatusChipClass(status: Task["status"]): string {
  switch (status) {
    case "running":
      return "text-blue-400 border-blue-700/60";
    case "completed":
      return "text-green-400 border-green-700/60";
    case "failed":
    case "killed":
    case "lost":
      return "text-red-400 border-red-700/60";
    default:
      return "text-gray-500 border-gray-700/60";
  }
}

function countHiddenDescendantsFromVisibleSubset(
  node: ExperimentTreeNode,
  visibleNodeIds: Set<string>,
  subtreeCounts: Map<string, number>,
): number {
  let hidden = 0;

  for (const child of node.children) {
    if (visibleNodeIds.has(child.id)) {
      hidden += countHiddenDescendantsFromVisibleSubset(child, visibleNodeIds, subtreeCounts);
    } else {
      hidden += 1 + (subtreeCounts.get(child.id) ?? countSubtreeNodes(child));
    }
  }

  return hidden;
}

function buildSubtreeCountMap(roots: ExperimentTreeNode[]): Map<string, number> {
  const counts = new Map<string, number>();

  const walk = (node: ExperimentTreeNode): number => {
    let count = 0;
    for (const child of node.children) {
      count += 1 + walk(child);
    }
    counts.set(node.id, count);
    return count;
  };

  roots.forEach(walk);
  return counts;
}

const FOLD_DEPTH_LIMIT = 2;

function flattenLineage(
  root: ExperimentTreeNode,
  currentId: string,
  pathIds: Set<string>,
  sortPathIds: Set<string>,
  subtreeCounts: Map<string, number>,
): RailRow[] {
  const rows: RailRow[] = [];
  // ancestorIsLast[d] = "ancestor of current walk at depth d is last sibling"
  const ancestorIsLast: boolean[] = [];
  // ancestorOnPath[d] = "ancestor at depth d lies on the selected spine"
  const ancestorOnPath: boolean[] = [];

  const walk = (node: ExperimentTreeNode, depth: number, isLast: boolean) => {
    const onPath = pathIds.has(node.id);
    const isCurrent = node.id === currentId;
    const tone = lineageNodeTone(node, isCurrent, onPath);

    const sortedChildren = sortLineageChildren(node.children, sortPathIds, subtreeCounts);
    const renderChildren =
      sortedChildren.length > 0 &&
      (depth < FOLD_DEPTH_LIMIT || onPath || isCurrent);

    let foldedCount: number | undefined;
    if (!renderChildren && sortedChildren.length > 0) {
      foldedCount = sortedChildren.reduce(
        (sum, c) => sum + 1 + (subtreeCounts.get(c.id) ?? countSubtreeNodes(c)),
        0,
      );
    }

    const rails: boolean[] = [];
    const railOnPath: boolean[] = [];
    for (let d = 0; d < depth; d++) {
      rails.push(!ancestorIsLast[d]);
      railOnPath.push(!!ancestorOnPath[d]);
    }

    rows.push({
      node,
      depth,
      isCurrent,
      onPath,
      tone,
      isLast,
      hasVisibleChildren: renderChildren,
      foldedCount,
      rails,
      railOnPath,
    });

    if (renderChildren) {
      ancestorIsLast[depth] = isLast;
      ancestorOnPath[depth] = onPath || isCurrent;
      sortedChildren.forEach((child, i) =>
        walk(child, depth + 1, i === sortedChildren.length - 1),
      );
      ancestorIsLast.pop();
      ancestorOnPath.pop();
    }
  };

  walk(root, 0, true);
  return rows;
}

const DOT_TONE: Record<LineageTone, string> = {
  current: "bg-indigo-400 ring-2 ring-indigo-400/30",
  path: "bg-indigo-300/80",
  active: "bg-gray-400/80",
  muted: "bg-gray-600/60",
};

const NAME_TONE: Record<LineageTone, string> = {
  current: "text-indigo-200",
  path: "text-gray-100",
  active: "text-gray-200",
  muted: "text-gray-500",
};

const RAIL_LINE = "bg-gray-700";
const RAIL_LINE_PATH = "bg-indigo-400/40";

const COL_W = 18; // px per gutter column

function RailCell({ through, onPath }: { through: boolean; onPath: boolean }) {
  const color = onPath ? RAIL_LINE_PATH : RAIL_LINE;
  return (
    <div className="relative shrink-0" style={{ width: COL_W }}>
      {through && (
        <div
          className={`absolute top-0 bottom-0 w-px ${color}`}
          style={{ left: COL_W / 2 - 0.5 }}
        />
      )}
    </div>
  );
}

function ConnectorCell({
  drawBelow,
  onPath,
}: {
  drawBelow: boolean;
  onPath: boolean;
}) {
  const color = onPath ? RAIL_LINE_PATH : RAIL_LINE;
  return (
    <div className="relative shrink-0" style={{ width: COL_W }}>
      <div
        className={`absolute top-0 w-px ${color}`}
        style={{ left: COL_W / 2 - 0.5, height: "50%" }}
      />
      <div
        className={`absolute h-px ${color}`}
        style={{ top: "calc(50% - 0.5px)", left: COL_W / 2, right: 0 }}
      />
      {drawBelow && (
        <div
          className={`absolute bottom-0 w-px ${RAIL_LINE}`}
          style={{ left: COL_W / 2 - 0.5, top: "50%" }}
        />
      )}
    </div>
  );
}

function DotCell({
  tone,
  drawBelow,
  onPath,
}: {
  tone: LineageTone;
  drawBelow: boolean;
  onPath: boolean;
}) {
  const color = onPath ? RAIL_LINE_PATH : RAIL_LINE;
  return (
    <div className="relative shrink-0" style={{ width: COL_W }}>
      {drawBelow && (
        <div
          className={`absolute bottom-0 w-px ${color}`}
          style={{ left: COL_W / 2 - 0.5, top: "50%" }}
        />
      )}
      <div
        className={`absolute rounded-full ${DOT_TONE[tone]}`}
        style={{
          left: COL_W / 2 - 4,
          top: "calc(50% - 4px)",
          width: 8,
          height: 8,
        }}
      />
    </div>
  );
}

function RailRowView({
  row,
  onSelectExperiment,
}: {
  row: RailRow;
  onSelectExperiment: (id: string) => void;
}) {
  const {
    node,
    depth,
    rails,
    railOnPath,
    isCurrent,
    onPath,
    tone,
    isLast,
    hasVisibleChildren,
    foldedCount,
  } = row;
  const decisionLabel = decisionLabelForFilter(node.decision) ?? node.decision ?? null;
  const decisionBadge = node.decision
    ? DECISION_BADGE[node.decision] || "bg-gray-800 text-gray-400 border-gray-700"
    : null;
  const rawRecommendationText = recommendationLabel(node.recommendation);
  const recommendationText =
    rawRecommendationText &&
    rawRecommendationText.toLowerCase() !== decisionLabel?.toLowerCase()
      ? rawRecommendationText
      : null;
  const recommendationBadge =
    recommendationText != null
      ? recommendationBadgeClass(recommendationText)
      : null;
  const recommendationTitle = recommendationText
    ? [
        `Recommendation: ${recommendationText}`,
        node.recommendation?.verdict ? `verdict: ${node.recommendation.verdict}` : null,
        node.recommendation?.reason ? `reason: ${node.recommendation.reason}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  const diffChips = diffChipLabels(node);
  const rowBg = isCurrent
    ? "bg-indigo-500/10 ring-1 ring-inset ring-indigo-400/30"
    : onPath
      ? "bg-white/[0.02]"
      : "";
  const drawBelowAtDot = hasVisibleChildren;
  const drawBelowAtConnector = !isLast;
  const labelClass = NAME_TONE[tone];

  return (
    <div
      className={`flex items-stretch min-h-[24px] ${rowBg}`}
      data-lineage-tone={tone}
      data-lineage-on-path={onPath || isCurrent ? "true" : undefined}
    >
      {rails.map((through, d) => (
        <RailCell key={d} through={through} onPath={railOnPath[d] ?? false} />
      ))}
      {depth > 0 && (
        <ConnectorCell drawBelow={drawBelowAtConnector} onPath={onPath} />
      )}
      <DotCell tone={tone} drawBelow={drawBelowAtDot} onPath={onPath || isCurrent} />
      <div className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1 text-xs">
        {isCurrent ? (
          <span className={`font-mono truncate ${labelClass}`}>{node.name}</span>
        ) : (
          <button
            type="button"
            onClick={() => onSelectExperiment(node.id)}
            aria-label={`Preview ${node.name}`}
            className={`font-mono truncate text-left hover:text-blue-300 ${labelClass}`}
          >
            {node.name}
          </button>
        )}
        {decisionBadge && (
          <span
            className={`shrink-0 text-[9px] px-1 py-px rounded border ${decisionBadge}`}
            data-lineage-decision-chip
          >
            {decisionLabel}
          </span>
        )}
        {recommendationText && recommendationBadge && (
          <span
            className={`shrink-0 text-[9px] px-1 py-px rounded border ${recommendationBadge}`}
            title={recommendationTitle}
            aria-label={`Recommendation: ${recommendationText}`}
            data-lineage-recommendation-chip
          >
            {recommendationText}
          </span>
        )}
        {diffChips.map((chip, index) => (
          <span
            key={`${index}-${chip}`}
            className="shrink-0 text-[9px] px-1 py-px rounded border border-gray-700 bg-white/5"
            title={chip}
            aria-label={`Diff: ${chip}`}
            data-lineage-diff-chip
          >
            {chip}
          </span>
        ))}
        {node.goal_metric && (
          <span className="shrink-0 text-[10px] text-gray-500 font-mono">
            {node.goal_direction === "min" ? "↓" : "↑"}
            {node.goal_metric}
          </span>
        )}
        {foldedCount !== undefined && foldedCount > 0 && (
          <span
            className="shrink-0 text-[10px] text-gray-500 italic"
            title={`${foldedCount} descendant run${foldedCount === 1 ? "" : "s"} hidden — select this run to expand the branch`}
          >
            +{foldedCount} hidden
          </span>
        )}
        {node.fork_reason && (
          <span
            className="text-[10px] text-gray-600 truncate ml-1"
            title={node.fork_reason}
          >
            — {node.fork_reason}
          </span>
        )}
      </div>
    </div>
  );
}

function SelectedDetailStrip({
  node,
  pageId,
  tasks,
  hiddenDescendants,
}: {
  node: ExperimentTreeNode;
  pageId: string;
  tasks?: Task[];
  hiddenDescendants: number;
}) {
  const statusClass =
    node.status === "passed"
      ? "text-green-400"
      : node.status === "partial"
        ? "text-orange-400"
        : node.status === "failed"
          ? "text-red-400"
          : "text-blue-400";
  const decisionLabel = decisionLabelForFilter(node.decision) ?? node.decision ?? null;
  const decisionBadge = node.decision
    ? DECISION_BADGE[node.decision] || "bg-gray-800 text-gray-400 border-gray-700"
    : null;
  const rawRecommendationText = recommendationLabel(node.recommendation);
  const recommendationText =
    rawRecommendationText &&
    rawRecommendationText.toLowerCase() !== decisionLabel?.toLowerCase()
      ? rawRecommendationText
      : null;
  const recommendationBadge =
    recommendationText != null
      ? recommendationBadgeClass(recommendationText)
      : null;
  const recommendationTitle = recommendationText
    ? [
        `Recommendation: ${recommendationText}`,
        node.recommendation?.verdict ? `verdict: ${node.recommendation.verdict}` : null,
        node.recommendation?.reason ? `reason: ${node.recommendation.reason}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  const diffChips = diffChipLabels(node);
  const isPage = node.id === pageId;
  const orderedTasks = orderTaskLinks(tasks ?? []);
  const shownTasks = orderedTasks.slice(0, 3);
  const hiddenTaskCount = orderedTasks.length - shownTasks.length;

  return (
    <div
      className="mt-3 border-t border-gray-800 pt-2 text-[11px] text-gray-400 flex flex-wrap items-center gap-x-3 gap-y-1"
      data-lineage-selected-strip
    >
      <span className="text-[10px] uppercase tracking-wide text-gray-600">
        {isPage ? "Viewing page" : "Preview selected"}
      </span>
      <span className="font-mono text-indigo-200 truncate max-w-[14rem]">{node.name}</span>
      <span className="text-gray-600 font-mono truncate max-w-[10rem]">{node.id}</span>
      <span className={`font-mono ${statusClass}`}>Status: {node.status}</span>
      {decisionBadge && (
        <span
          className={`text-[9px] px-1 py-px rounded border ${decisionBadge}`}
          aria-label={`Decision: ${decisionLabel}`}
        >
          Decision: {decisionLabel}
        </span>
      )}
      {recommendationText && recommendationBadge && (
        <span
          className={`text-[9px] px-1 py-px rounded border ${recommendationBadge}`}
          title={recommendationTitle}
          aria-label={`Recommendation: ${recommendationText}`}
          data-lineage-recommendation-chip
        >
          Recommendation: {recommendationText}
        </span>
      )}
      {hiddenDescendants > 0 && (
        <span className="text-[10px] text-gray-500 whitespace-nowrap">
          +{hiddenDescendants} hidden descendants folded
        </span>
      )}
      {diffChips.map((chip, index) => (
        <span
          key={`selected-${index}-${chip}`}
          className="shrink-0 text-[9px] px-1 py-px rounded border border-gray-700 bg-white/5"
          title={chip}
          aria-label={`Diff: ${chip}`}
          data-lineage-diff-chip
        >
          {chip}
        </span>
      ))}
      {node.goal_metric && (
        <span className="font-mono text-gray-500">
          goal {node.goal_direction === "min" ? "↓" : "↑"}
          {node.goal_metric}
        </span>
      )}
      {node.fork_reason && (
        <span className="text-gray-500 italic truncate" title={node.fork_reason}>
          fork: {node.fork_reason}
        </span>
      )}
      <span
        className={`text-[10px] uppercase tracking-wide ${
          orderedTasks.length === 0 ? "text-gray-500" : "text-gray-600"
        }`}
      >
        Tasks: {orderedTasks.length}
      </span>
      {orderedTasks.length > 0 &&
        shownTasks.map((task) => (
          <Link
            key={task.id}
            to={`/tasks/${task.id}`}
            title={task.display_name}
            aria-label={`${task.display_name} (#${task.seq} · ${task.status})`}
            className={`text-[10px] px-1.5 py-0.5 rounded border ${taskStatusChipClass(
              task.status,
            )} hover:opacity-90 bg-white/5`}
          >
            <span
              className="max-w-[10rem] truncate inline-block align-middle mr-1"
              title={task.display_name}
            >
              {task.display_name}
            </span>
            <span className="shrink-0">
              #{task.seq} · {task.status}
            </span>
          </Link>
        ))}
      {hiddenTaskCount > 0 && <span className="text-gray-600 text-[10px]">+{hiddenTaskCount} more</span>}
      {!isPage && (
        <Link
          to={`/experiments/${node.id}`}
          className="ml-auto text-blue-400 hover:text-blue-300"
        >
          Open detail
        </Link>
      )}
    </div>
  );
}

export function ExperimentLineageGraphCard({
  roots,
  currentId,
  pageId = currentId,
  selectedTasks,
  onSelectExperiment,
}: {
  roots: ExperimentTreeNode[] | null;
  currentId: string;
  pageId?: string;
  selectedTasks?: Task[];
  onSelectExperiment: (id: string) => void;
}) {
  if (roots === null) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h2 className="text-sm font-medium text-gray-400 mb-3">Lineage graph</h2>
        <p className="text-xs text-gray-600">Loading...</p>
      </div>
    );
  }

  const found = findNodePath(roots, currentId);
  const pathIds = new Set(found?.path.map((n) => n.id) ?? []);
  const focusPath = findNodePath(roots, pageId);
  const sortPathIds = new Set(focusPath?.path.map((n) => n.id) ?? pathIds);
  const subtreeCounts = buildSubtreeCountMap(roots);
  const rows = found
    ? flattenLineage(found.root, currentId, pathIds, sortPathIds, subtreeCounts)
    : [];
  const selected = found?.path[found.path.length - 1];
  const visibleNodeIds = new Set(rows.map((row) => row.node.id));
  const totalNodeCount = found ? 1 + (subtreeCounts.get(found.root.id) ?? countSubtreeNodes(found.root)) : 0;
  const hiddenNodeCount = Math.max(totalNodeCount - rows.length, 0);
  const selectedHiddenDescendants =
    selected && visibleNodeIds.size > 0
      ? countHiddenDescendantsFromVisibleSubset(selected, visibleNodeIds, subtreeCounts)
      : 0;
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-gray-400">Lineage graph</h2>
        <span className="text-xs text-gray-600">
          {roots.length} root{roots.length === 1 ? "" : "s"}
          {rows.length > 0 && ` · ${rows.length} shown`}
          {hiddenNodeCount > 0 && ` · ${hiddenNodeCount} hidden`}
        </span>
      </div>
      {!found ? (
        <p className="text-xs text-gray-600">No lineage data for this experiment.</p>
      ) : (
        <>
          <div className="max-h-72 overflow-y-auto -mx-1 px-1">
            {rows.map((row) => (
              <RailRowView
                key={row.node.id}
                row={row}
                onSelectExperiment={onSelectExperiment}
              />
            ))}
          </div>
          {selected && (
            <SelectedDetailStrip
              node={selected}
              pageId={pageId}
              tasks={selectedTasks}
              hiddenDescendants={selectedHiddenDescendants}
            />
          )}
        </>
      )}
    </div>
  );
}
