import type { ExperimentTreeNode } from "../../lib/api";
import { DECISION_BADGE, findNodePath } from "./experimentDetailUtils";

function TreeNodeRow({
  node,
  depth,
  currentId,
  selectedPathIds,
  onSelectExperiment,
}: {
  node: ExperimentTreeNode;
  depth: number;
  currentId: string;
  selectedPathIds: Set<string>;
  onSelectExperiment: (id: string) => void;
}) {
  const isCurrent = node.id === currentId;
  const onPath = selectedPathIds.has(node.id);
  const statusColor =
    node.status === "passed" ? "text-green-400" :
    node.status === "partial" ? "text-orange-400" :
    node.status === "failed" ? "text-red-400" :
    "text-blue-400";
  const decisionBadge = node.decision
    ? DECISION_BADGE[node.decision] || "bg-gray-800 text-gray-400 border-gray-700"
    : null;

  return (
    <>
      <li
        className={`flex items-center gap-2 py-1 px-2 rounded text-xs ${
          isCurrent ? "bg-indigo-500/10 ring-1 ring-inset ring-indigo-400/30" :
          onPath ? "bg-white/[0.02]" : ""
        }`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <span className={`shrink-0 text-[10px] ${statusColor}`}>●</span>
        {isCurrent ? (
          <span className="font-mono text-indigo-200 truncate">{node.name}</span>
        ) : (
          <button
            type="button"
            onClick={() => onSelectExperiment(node.id)}
            className="font-mono text-blue-400 hover:text-blue-300 truncate text-left"
          >
            {node.name}
          </button>
        )}
        {decisionBadge && (
          <span className={`shrink-0 text-[9px] px-1 py-px rounded border ${decisionBadge}`}>
            {node.decision}
          </span>
        )}
        {node.goal_metric && (
          <span className="shrink-0 text-[10px] text-gray-500 font-mono">
            {node.goal_direction === "min" ? "↓" : "↑"}{node.goal_metric}
          </span>
        )}
        {node.fork_reason && (
          <span className="text-[10px] text-gray-600 truncate ml-1" title={node.fork_reason}>
            — {node.fork_reason}
          </span>
        )}
      </li>
      {node.children.map((child) => (
        <TreeNodeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          currentId={currentId}
          selectedPathIds={selectedPathIds}
          onSelectExperiment={onSelectExperiment}
        />
      ))}
    </>
  );
}

export function ExperimentLineageGraphCard({
  roots,
  currentId,
  onSelectExperiment,
}: {
  roots: ExperimentTreeNode[] | null;
  currentId: string;
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

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-gray-400">Lineage graph</h2>
        <span className="text-xs text-gray-600">
          {roots.length} root{roots.length === 1 ? "" : "s"}
        </span>
      </div>
      {!found ? (
        <p className="text-xs text-gray-600">No lineage data for this experiment.</p>
      ) : (
        <ul className="space-y-0.5 max-h-72 overflow-y-auto">
          <TreeNodeRow
            node={found.root}
            depth={0}
            currentId={currentId}
            selectedPathIds={new Set(found.path.map((n) => n.id))}
            onSelectExperiment={onSelectExperiment}
          />
        </ul>
      )}
    </div>
  );
}
