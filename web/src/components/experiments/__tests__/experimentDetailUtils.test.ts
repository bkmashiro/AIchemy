import { describe, expect, it } from "vitest";
import type { ExperimentRecommendation, ExperimentTreeNode } from "../../../lib/api";
import {
  recommendationBadgeClass,
  recommendationLabel,
  formatMetricDelta,
  diffChipLabels,
  sortLineageChildren,
  countSubtreeNodes,
} from "../experimentDetailUtils";

function mkRecommendation(overrides: Partial<ExperimentRecommendation>): ExperimentRecommendation {
  return {
    action: null,
    verdict: null,
    reason: null,
    metric: null,
    value: null,
    baseline_value: null,
    delta: null,
    direction: null,
    ...overrides,
  };
}

function mkLineageNode(
  overrides: Partial<ExperimentTreeNode> & { id: string; name: string },
): ExperimentTreeNode {
  return {
    status: "running",
    family: null,
    parent_id: null,
    decision: null,
    fork_reason: null,
    goal_metric: null,
    goal_direction: null,
    recommendation: null,
    diff_summary: null,
    created_at: "2026-06-06T00:00:00Z",
    children: [],
    ...overrides,
  } as ExperimentTreeNode;
}

function briefNode(
  overrides: Partial<ExperimentTreeNode> & { id: string; name: string },
): ExperimentTreeNode {
  return mkLineageNode(overrides);
}

function ids(nodes: ExperimentTreeNode[]): string[] {
  return nodes.map((n) => n.id);
}

function seededFanoutTree() {
  const focusLeaf = mkLineageNode({
    id: "focus-path-leaf",
    name: "focus-path-leaf",
    status: "running",
    decision: "rerun",
  });

  const branchKeepDeep = mkLineageNode({
    id: "branch-keep-deep",
    name: "branch-keep-deep",
    status: "passed",
    decision: "keep",
    children: [
      mkLineageNode({
        id: "keep-a1",
        name: "keep-a1",
        decision: "fork",
        children: [
          mkLineageNode({ id: "keep-a1-1", name: "keep-a1-1", status: "running" }),
          mkLineageNode({ id: "keep-a1-2", name: "keep-a1-2", status: "passed" }),
        ],
      }),
      mkLineageNode({
        id: "keep-a2",
        name: "keep-a2",
        decision: "rerun",
        children: [
          mkLineageNode({
            id: "keep-a2-1",
            name: "keep-a2-1",
            status: "passed",
            children: [
              mkLineageNode({ id: "keep-a2-1-1", name: "keep-a2-1-1", status: "running" }),
            ],
          }),
        ],
      }),
      mkLineageNode({
        id: "keep-a3",
        name: "keep-a3",
        decision: "keep",
        children: [
          mkLineageNode({ id: "keep-a3-1", name: "keep-a3-1", status: "passed" }),
          mkLineageNode({ id: "keep-a3-2", name: "keep-a3-2", status: "running" }),
        ],
      }),
    ],
  });

  const branchForkWide = mkLineageNode({
    id: "branch-fork-wide",
    name: "branch-fork-wide",
    status: "running",
    decision: "fork",
    children: [
      mkLineageNode({
        id: "fork-b1",
        name: "fork-b1",
        children: [
          mkLineageNode({ id: "fork-b1-1", name: "fork-b1-1", status: "passed" }),
          mkLineageNode({ id: "fork-b1-2", name: "fork-b1-2", status: "running" }),
          mkLineageNode({ id: "fork-b1-3", name: "fork-b1-3", status: "failed" }),
        ],
      }),
      mkLineageNode({ id: "fork-b2", name: "fork-b2", status: "passed" }),
      mkLineageNode({ id: "fork-b3", name: "fork-b3", status: "running" }),
      mkLineageNode({
        id: "fork-b4",
        name: "fork-b4",
        children: [
          mkLineageNode({ id: "fork-b4-1", name: "fork-b4-1", status: "running" }),
        ],
      }),
    ],
  });

  const branchRerunWide = mkLineageNode({
    id: "branch-rerun-wide",
    name: "branch-rerun-wide",
    decision: "rerun",
    status: "running",
    children: [
      mkLineageNode({
        id: "rerun-c1",
        name: "rerun-c1",
        decision: "fork",
        children: [
          mkLineageNode({ id: "rerun-c1-1", name: "rerun-c1-1", status: "running" }),
          mkLineageNode({ id: "rerun-c1-2", name: "rerun-c1-2", status: "passed" }),
        ],
      }),
      mkLineageNode({ id: "rerun-c2", name: "rerun-c2", status: "running" }),
      mkLineageNode({ id: "rerun-c3", name: "rerun-c3", status: "passed" }),
      mkLineageNode({ id: "rerun-c4", name: "rerun-c4", status: "failed" }),
    ],
  });

  const rootChildren: ExperimentTreeNode[] = [
    focusLeaf,
    branchKeepDeep,
    branchForkWide,
    branchRerunWide,
    mkLineageNode({ id: "leaf-active-a", name: "leaf-active-a", status: "running" }),
    mkLineageNode({ id: "leaf-active-b", name: "leaf-active-b", status: "passed" }),
    mkLineageNode({ id: "leaf-failed", name: "leaf-failed", status: "failed" }),
    mkLineageNode({ id: "leaf-drop", name: "leaf-drop", status: "running", decision: "drop" }),
  ];

  return {
    focusLeaf,
    rootChildren,
    branchKeepDeep,
    branchForkWide,
    branchRerunWide,
  };
}

describe("recommendationBadgeClass", () => {
  it("maps known recommendation actions/verdicts to decision colors", () => {
    expect(recommendationBadgeClass("keep")).toBe("bg-green-900/30 text-green-400 border-green-700/40");
    expect(recommendationBadgeClass("DROP")).toBe("bg-red-900/30 text-red-400 border-red-700/40");
    expect(recommendationBadgeClass("  rerun  ")).toBe("bg-blue-900/30 text-blue-400 border-blue-700/40");
  });

  it("falls back to cyan recommendation chip for unknown values", () => {
    expect(recommendationBadgeClass("maybe"))
      .toBe("bg-cyan-900/30 text-cyan-400 border-cyan-700/40");
    expect(recommendationBadgeClass(""))
      .toBe("bg-cyan-900/30 text-cyan-400 border-cyan-700/40");
    expect(recommendationBadgeClass(null)).toBe("bg-cyan-900/30 text-cyan-400 border-cyan-700/40");
  });
});

describe("recommendationLabel", () => {
  it("prefers action when present", () => {
    const rec = mkRecommendation({
      action: "Fork this run",
      verdict: "keep",
    });
    expect(recommendationLabel(rec)).toBe("Fork this run");
  });

  it("falls back to verdict only when action is absent", () => {
    const rec = mkRecommendation({
      action: "   ",
      verdict: "drop",
    });
    expect(recommendationLabel(rec)).toBe("drop");
  });

  it("returns null when no action or verdict exists", () => {
    expect(recommendationLabel(null)).toBeNull();
    expect(recommendationLabel(mkRecommendation({}))).toBeNull();
  });
});

describe("formatMetricDelta", () => {
  it("adds directional arrows and stable precision", () => {
    expect(formatMetricDelta(1.23456, "max")).toBe("↑ +1.2346");
    expect(formatMetricDelta(-0.25, "min")).toBe("↓ -0.2500");
  });

  it("uses sign for unknown directions", () => {
    expect(formatMetricDelta(0.1)).toBe("+0.1000");
    expect(formatMetricDelta(-0.1)).toBe("-0.1000");
  });

  it("returns null for null/invalid deltas", () => {
    expect(formatMetricDelta(null)).toBeNull();
    expect(formatMetricDelta(Number.NaN)).toBeNull();
    expect(formatMetricDelta(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("diffChipLabels", () => {
  it("builds compact labels for diff summary fields", () => {
    const node = briefNode({
      id: "child-1",
      name: "child",
      status: "passed",
      diff_summary: {
        config_changed: true,
        config_change_count: 3,
        metric_delta: -0.4,
        metric: "loss",
        direction: "min",
        status_changed_from_parent: true,
        parent_status: "running",
      },
    });

    expect(diffChipLabels(node)).toEqual([
      "loss: ↓ -0.4000",
      "config +3",
      "status running→passed",
    ]);
  });

  it("returns an empty list when no diff summary exists", () => {
    expect(diffChipLabels(briefNode({ id: "root", name: "root" }))).toEqual([]);
  });

  it("omits optional diff fields that are absent", () => {
    const node = briefNode({
      id: "child-2",
      name: "child2",
      diff_summary: {
        config_changed: false,
        config_change_count: 0,
        metric_delta: null,
        metric: null,
        direction: null,
        status_changed_from_parent: null,
        parent_status: null,
      },
    });

    expect(diffChipLabels(node)).toEqual([]);
  });
});

describe("lineage sorting", () => {
  it("keeps focused-path siblings first and prefers continuation branches over leaves", () => {
    const { focusLeaf, rootChildren } = seededFanoutTree();
    const sortPathIds = new Set([focusLeaf.id]);

    const sorted = sortLineageChildren(rootChildren, sortPathIds);

    expect(ids(sorted)).toEqual([
      "focus-path-leaf",
      "branch-keep-deep",
      "branch-fork-wide",
      "branch-rerun-wide",
      "leaf-active-a",
      "leaf-active-b",
      "leaf-failed",
      "leaf-drop",
    ]);
  });

  it("sorts promoted branches by depth and preserves API order when tied", () => {
    const rootChildren = [
      mkLineageNode({
        id: "tie-leaf-b",
        name: "tie-leaf-b",
        status: "running",
      }),
      mkLineageNode({
        id: "branch-rerun-shallow",
        name: "branch-rerun-shallow",
        decision: "rerun",
        status: "running",
        children: [
          mkLineageNode({ id: "branch-rerun-shallow-child", name: "branch-rerun-shallow-child" }),
        ],
      }),
      mkLineageNode({
        id: "branch-keep-shallow",
        name: "branch-keep-shallow",
        decision: "keep",
        status: "passed",
        children: [
          mkLineageNode({ id: "branch-keep-shallow-child", name: "branch-keep-shallow-child" }),
        ],
      }),
      mkLineageNode({
        id: "branch-keep-deep",
        name: "branch-keep-deep",
        decision: "keep",
        status: "passed",
        children: [
          mkLineageNode({
            id: "branch-keep-deep-child",
            name: "branch-keep-deep-child",
            children: [
              mkLineageNode({
                id: "branch-keep-deep-grandchild",
                name: "branch-keep-deep-grandchild",
              }),
            ],
          }),
        ],
      }),
      mkLineageNode({
        id: "branch-keep-medium",
        name: "branch-keep-medium",
        decision: "keep",
        status: "running",
        children: [
          mkLineageNode({
            id: "branch-keep-medium-child",
            name: "branch-keep-medium-child",
            children: [
              mkLineageNode({
                id: "branch-keep-medium-grandchild",
                name: "branch-keep-medium-grandchild",
              }),
            ],
          }),
        ],
      }),
      mkLineageNode({
        id: "tie-leaf-a",
        name: "tie-leaf-a",
        status: "passed",
      }),
    ];

    const sorted = sortLineageChildren(rootChildren, new Set<string>());

    expect(ids(sorted)).toEqual([
      "branch-keep-deep",
      "branch-keep-medium",
      "branch-keep-shallow",
      "branch-rerun-shallow",
      "tie-leaf-b",
      "tie-leaf-a",
    ]);
  });
});

describe("folded-branch accounting", () => {
  it("counts all descendants recursively for subtree folding", () => {
    const { branchKeepDeep, branchForkWide, branchRerunWide, rootChildren } = seededFanoutTree();

    expect(countSubtreeNodes(branchKeepDeep)).toBe(9);
    expect(countSubtreeNodes(branchForkWide)).toBe(8);
    expect(countSubtreeNodes(branchRerunWide)).toBe(6);

    const root = mkLineageNode({
      id: "seed-root",
      name: "seed-root",
      children: rootChildren,
    });

    expect(countSubtreeNodes(root)).toBe(31);
  });
});
