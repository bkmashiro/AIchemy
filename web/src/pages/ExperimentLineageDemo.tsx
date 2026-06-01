import { useMemo, useState, type ReactNode } from "react";

type DemoDecision = "keep" | "drop" | "rerun" | "fork";
type DemoEventKind = "created" | "forked" | "note" | "decision" | "task_failed" | "resumed" | "metric_best" | "checkpoint";
type DemoStatus = "running" | "passed" | "partial" | "failed";

type DemoExperiment = {
  id: string;
  name: string;
  shortName: string;
  status: DemoStatus;
  description: string;
  family: string;
  parentId?: string;
  branch: "baseline" | "curiosity" | "batch" | "resume" | "ablation";
  hypothesis: string;
  expected: string;
  forkReason?: string;
  decision?: DemoDecision;
  decisionReason?: string;
  criteria: Record<string, string>;
  config: Record<string, unknown>;
  metrics: Record<string, number>;
};

type DemoEvent = {
  id: string;
  experimentId: string;
  kind: DemoEventKind;
  message: string;
  actor: string;
  age: string;
  data?: Record<string, unknown>;
};

type DemoStage = {
  id: string;
  title: string;
  purpose: string;
  parentStageId?: string;
  parentRunId?: string;
  promotedRunId?: string;
  runIds: string[];
  folded?: boolean;
  state?: "active" | "decided" | "folded";
};

type BranchStyle = {
  label: string;
  color: string;
  glow: string;
  bg: string;
  text: string;
};

const BRANCH: Record<DemoExperiment["branch"], BranchStyle> = {
  baseline: { label: "baseline", color: "#8b949e", glow: "rgba(139,148,158,0.28)", bg: "bg-slate-500/10", text: "text-slate-300" },
  curiosity: { label: "curiosity", color: "#7c7cff", glow: "rgba(124,124,255,0.36)", bg: "bg-indigo-500/10", text: "text-indigo-300" },
  batch: { label: "batch", color: "#f59e0b", glow: "rgba(245,158,11,0.32)", bg: "bg-amber-500/10", text: "text-amber-300" },
  resume: { label: "resume", color: "#10b981", glow: "rgba(16,185,129,0.32)", bg: "bg-emerald-500/10", text: "text-emerald-300" },
  ablation: { label: "ablation", color: "#ec4899", glow: "rgba(236,72,153,0.32)", bg: "bg-pink-500/10", text: "text-pink-300" },
};

const BADGE: Record<string, string> = {
  running: "bg-blue-500/10 text-blue-300 border-blue-400/20",
  passed: "bg-emerald-500/10 text-emerald-300 border-emerald-400/20",
  partial: "bg-amber-500/10 text-amber-300 border-amber-400/20",
  failed: "bg-red-500/10 text-red-300 border-red-400/20",
  keep: "bg-emerald-500/10 text-emerald-300 border-emerald-400/20",
  drop: "bg-red-500/10 text-red-300 border-red-400/20",
  rerun: "bg-blue-500/10 text-blue-300 border-blue-400/20",
  fork: "bg-violet-500/10 text-violet-300 border-violet-400/20",
  created: "bg-blue-500/10 text-blue-300 border-blue-400/20",
  forked: "bg-violet-500/10 text-violet-300 border-violet-400/20",
  note: "bg-white/[0.04] text-gray-300 border-white/[0.08]",
  decision: "bg-violet-500/10 text-violet-300 border-violet-400/20",
  task_failed: "bg-red-500/10 text-red-300 border-red-400/20",
  resumed: "bg-amber-500/10 text-amber-300 border-amber-400/20",
  metric_best: "bg-emerald-500/10 text-emerald-300 border-emerald-400/20",
  checkpoint: "bg-cyan-500/10 text-cyan-300 border-cyan-400/20",
};

const STAGE_STATE_BADGE: Record<NonNullable<DemoStage["state"]>, string> = {
  active: "bg-blue-500/10 text-blue-300 border-blue-400/20",
  decided: "bg-emerald-500/10 text-emerald-300 border-emerald-400/20",
  folded: "bg-white/[0.05] text-gray-500 border-white/[0.08]",
};

const STAGE_DOT_COLOR: Record<NonNullable<DemoStage["state"]>, string> = {
  active: "#7c7cff",
  decided: "#10b981",
  folded: "#52525b",
};

const demoExperiments: DemoExperiment[] = [
  {
    id: "baseline",
    name: "jema_v2_baseline_a30",
    shortName: "baseline_a30",
    status: "partial",
    description: "Baseline JEMA v2 run before curiosity objective changes.",
    family: "jema_v2/pretrain",
    branch: "baseline",
    hypothesis: "Stable pretraining should hold zN above 0.82 without loss spikes.",
    expected: "zN >= 0.82, eval loss <= 1.9, no OOM on A30.",
    decision: "fork",
    decisionReason: "Good enough signal, but A30 memory pressure needs narrower forks.",
    criteria: { zN: ">=0.82", eval_loss: "<=1.90" },
    config: { lr: 0.0003, batch: 64, curiosity: false, dropout: 0.1, stub: "a30-01" },
    metrics: { zN: 0.821, eval_loss: 1.94, step: 18000 },
  },
  {
    id: "curiosity-low-lr",
    name: "jema_v2_curiosity_low_lr",
    shortName: "curiosity_low_lr",
    status: "running",
    description: "Fork with lower LR and curiosity objective enabled.",
    family: "jema_v2/pretrain",
    parentId: "baseline",
    branch: "curiosity",
    hypothesis: "Curiosity objective improves zN if LR is reduced enough to avoid collapse.",
    expected: "zN >= 0.86 and smoother loss curve than baseline.",
    forkReason: "Baseline showed usable zN but loss instability after 18k steps.",
    decision: "rerun",
    decisionReason: "Promising zN, but resume on T4 before keeping it.",
    criteria: { zN: ">=0.86", eval_loss: "<=1.80" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.1, stub: "t4-02" },
    metrics: { zN: 0.858, eval_loss: 1.81, step: 24000 },
  },
  {
    id: "curiosity-resume-t4",
    name: "jema_v2_curiosity_resume_t4",
    shortName: "resume_t4",
    status: "passed",
    description: "Continuation of the low-LR branch after moving off the A30 stub.",
    family: "jema_v2/pretrain",
    parentId: "curiosity-low-lr",
    branch: "resume",
    hypothesis: "Same objective should stabilize once the memory pressure is removed.",
    expected: "zN >= 0.865, loss spike disappears after resume.",
    forkReason: "A30 run hit OOM; resume branch records environment change explicitly.",
    decision: "keep",
    decisionReason: "Best current result; use as parent for ablations.",
    criteria: { zN: ">=0.865", eval_loss: "<=1.78" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.1, stub: "t4-02" },
    metrics: { zN: 0.872, eval_loss: 1.76, step: 42000 },
  },
  {
    id: "curiosity-seed-b",
    name: "jema_v2_curiosity_seed_b",
    shortName: "seed_b",
    status: "running",
    description: "Parallel seed on the kept curiosity branch; still extending while ablations run.",
    family: "jema_v2/pretrain",
    parentId: "curiosity-resume-t4",
    branch: "curiosity",
    hypothesis: "A second seed should keep the zN gain without the checkpoint-specific spike.",
    expected: "zN within 0.005 of resume_t4 and smoother eval loss.",
    forkReason: "Validate the kept branch before promoting it as the new default.",
    decision: "rerun",
    decisionReason: "Still running; keep as a live sibling branch.",
    criteria: { zN: ">=0.867", eval_loss: "<=1.79" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.1, stub: "t4-04", seed: 2 },
    metrics: { zN: 0.869, eval_loss: 1.78, step: 31000 },
  },
  {
    id: "curiosity-long-run-t4",
    name: "jema_v2_curiosity_long_run_t4",
    shortName: "long_run_t4",
    status: "running",
    description: "Extended-horizon validation of the kept resume checkpoint to confirm zN stability past 60k steps.",
    family: "jema_v2/pretrain",
    parentId: "curiosity-resume-t4",
    branch: "resume",
    hypothesis: "If the kept checkpoint is real, zN should hold or improve under 2x training horizon without drift.",
    expected: "zN holds within +/-0.003 of resume_t4 through step 80k.",
    forkReason: "Need long-horizon evidence before promoting curiosity branch as the new default.",
    decision: "rerun",
    decisionReason: "Still extending the horizon; checkpoint stability is the gate.",
    criteria: { zN: ">=0.870", eval_loss: "<=1.78" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.1, stub: "t4-06", max_steps: 80000 },
    metrics: { zN: 0.871, eval_loss: 1.77, step: 58000 },
  },
  {
    id: "regularize-dropout-005",
    name: "jema_v2_regularize_dropout_005",
    shortName: "dropout_005",
    status: "partial",
    description: "Middle-ground ablation that keeps some regularization while testing capacity.",
    family: "jema_v2/pretrain",
    parentId: "curiosity-resume-t4",
    branch: "ablation",
    hypothesis: "Lower dropout improves representation quality without the full instability of dropout=0.",
    expected: "zN +0.006, eval loss regression <= 0.015.",
    forkReason: "Ablation ladder from the kept resume checkpoint.",
    decision: "fork",
    decisionReason: "Promising but behind the live seed branch.",
    criteria: { zN: ">=0.878", eval_loss: "<=1.78" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.05, stub: "t4-05" },
    metrics: { zN: 0.876, eval_loss: 1.775, step: 22000 },
  },
  {
    id: "ablate-no-dropout",
    name: "jema_v2_ablate_no_dropout",
    shortName: "ablate_dropout",
    status: "running",
    description: "Ablation fork testing whether dropout is hiding useful representation capacity.",
    family: "jema_v2/pretrain",
    parentId: "curiosity-resume-t4",
    branch: "ablation",
    hypothesis: "Removing dropout improves zN but may hurt eval loss stability.",
    expected: "zN +0.01 with eval_loss regression <= 0.03.",
    forkReason: "Resume branch became the best checkpoint; isolate regularization next.",
    decision: "rerun",
    decisionReason: "Early signal positive; needs another seed.",
    criteria: { zN: ">=0.88", eval_loss: "<=1.79" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.0, stub: "t4-03" },
    metrics: { zN: 0.879, eval_loss: 1.8, step: 16000 },
  },
  {
    id: "curiosity-higher-batch",
    name: "jema_v2_curiosity_higher_batch",
    shortName: "higher_batch",
    status: "failed",
    description: "Sibling fork testing whether higher batch fixes gradient noise.",
    family: "jema_v2/pretrain",
    parentId: "baseline",
    branch: "batch",
    hypothesis: "Higher batch reduces variance without hurting zN.",
    expected: "Lower loss variance and no OOM.",
    forkReason: "Baseline variance looked optimizer-related.",
    decision: "drop",
    decisionReason: "OOM twice; not worth more cluster time.",
    criteria: { zN: ">=0.84", eval_loss: "<=1.85" },
    config: { lr: 0.0003, batch: 96, curiosity: true, dropout: 0.1, stub: "a30-03" },
    metrics: { zN: 0.0, eval_loss: 9.99, step: 6200 },
  },
  {
    id: "batch-64-retry",
    name: "jema_v2_batch64_retry",
    shortName: "batch64_retry",
    status: "partial",
    description: "Narrower retry of the failed high-batch branch.",
    family: "jema_v2/pretrain",
    parentId: "curiosity-higher-batch",
    branch: "batch",
    hypothesis: "Batch 64 keeps the variance gain without OOM.",
    expected: "No OOM and zN recovers to baseline + curiosity levels.",
    forkReason: "High batch failed for memory, not necessarily for model quality.",
    decision: "fork",
    decisionReason: "Worth one narrower run, but not the mainline.",
    criteria: { zN: ">=0.85", eval_loss: "<=1.83" },
    config: { lr: 0.00024, batch: 64, curiosity: true, dropout: 0.1, stub: "a30-04" },
    metrics: { zN: 0.847, eval_loss: 1.84, step: 19000 },
  },
];

const seedEvents: DemoEvent[] = [
  { id: "e1", experimentId: "baseline", kind: "created", message: "Created baseline experiment", actor: "operator", age: "2d ago" },
  { id: "e2", experimentId: "baseline", kind: "metric_best", message: "Best zN reached 0.821 at step 18k", actor: "eval", age: "31h ago", data: { zN: 0.821, step: 18000 } },
  { id: "e3", experimentId: "baseline", kind: "decision", message: "Marked fork: usable signal, but memory pressure needs narrower branches", actor: "operator", age: "30h ago", data: { decision: "fork" } },
  { id: "e4", experimentId: "curiosity-low-lr", kind: "forked", message: "Forked from baseline_a30", actor: "operator", age: "26h ago", data: { lr: "0.0003 -> 0.00018", curiosity: "false -> true" } },
  { id: "e5", experimentId: "curiosity-low-lr", kind: "task_failed", message: "A30 OOM at step 12k", actor: "scheduler", age: "18h ago", data: { stub: "a30-01", exit_code: 137 } },
  { id: "e6", experimentId: "curiosity-low-lr", kind: "resumed", message: "Resumed on t4-02 with batch 48", actor: "operator", age: "16h ago", data: { stub: "t4-02", batch: 48 } },
  { id: "e7", experimentId: "curiosity-low-lr", kind: "decision", message: "Marked rerun: promising zN, but validate resume branch first", actor: "operator", age: "2h ago", data: { decision: "rerun" } },
  { id: "e8", experimentId: "curiosity-resume-t4", kind: "checkpoint", message: "Checkpoint promoted from resumed run", actor: "eval", age: "90m ago", data: { checkpoint: "step-42000", zN: 0.872 } },
  { id: "e9", experimentId: "curiosity-resume-t4", kind: "decision", message: "Marked keep: best current result", actor: "operator", age: "42m ago", data: { decision: "keep" } },
  { id: "e10", experimentId: "ablate-no-dropout", kind: "forked", message: "Forked from resume_t4 to test dropout=0", actor: "operator", age: "38m ago", data: { dropout: "0.1 -> 0.0" } },
  { id: "e11", experimentId: "ablate-no-dropout", kind: "metric_best", message: "Early zN reached 0.879", actor: "eval", age: "12m ago", data: { zN: 0.879, step: 16000 } },
  { id: "e12", experimentId: "curiosity-higher-batch", kind: "forked", message: "Forked from baseline_a30", actor: "operator", age: "25h ago", data: { batch: "64 -> 96" } },
  { id: "e13", experimentId: "curiosity-higher-batch", kind: "decision", message: "Marked drop: OOM twice; not worth more cluster time", actor: "operator", age: "20h ago", data: { decision: "drop" } },
  { id: "e14", experimentId: "batch-64-retry", kind: "forked", message: "Forked from higher_batch with safer memory envelope", actor: "operator", age: "9h ago", data: { batch: "96 -> 64", lr: "0.0003 -> 0.00024" } },
];

const demoStages: DemoStage[] = [
  {
    id: "baseline-stage",
    title: "Baseline pretraining",
    purpose: "Establish a stable zN/loss reference before tuning curiosity.",
    promotedRunId: "baseline",
    runIds: ["baseline"],
    state: "decided",
  },
  {
    id: "curiosity-stage",
    title: "Curiosity objective",
    purpose: "Find an LR + resume recipe where curiosity beats baseline without collapse.",
    parentStageId: "baseline-stage",
    parentRunId: "baseline",
    promotedRunId: "curiosity-resume-t4",
    runIds: ["curiosity-low-lr", "curiosity-resume-t4", "curiosity-seed-b"],
    state: "decided",
  },
  {
    id: "regularization-stage",
    title: "Regularization sweep",
    purpose: "Tune dropout from the kept resume checkpoint.",
    parentStageId: "curiosity-stage",
    parentRunId: "curiosity-resume-t4",
    runIds: ["regularize-dropout-005", "ablate-no-dropout"],
    state: "active",
  },
  {
    id: "long-run-validation-stage",
    title: "Long-run validation",
    purpose: "Confirm the kept resume checkpoint holds under a 2x training horizon before promoting it.",
    parentStageId: "curiosity-stage",
    parentRunId: "curiosity-resume-t4",
    runIds: ["curiosity-long-run-t4"],
    state: "active",
  },
  {
    id: "batch-stage",
    title: "Batch-size exploration",
    purpose: "Folded after OOM and the narrower retry under-performed the curiosity branch.",
    parentStageId: "baseline-stage",
    parentRunId: "baseline",
    runIds: ["curiosity-higher-batch", "batch-64-retry"],
    folded: true,
    state: "folded",
  },
];

function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-[0.2em] text-gray-500">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function JsonPill({ data }: { data: Record<string, unknown> }) {
  return (
    <pre className="mt-2 rounded-md border border-white/[0.06] bg-black/30 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-gray-500 overflow-x-auto">
      {JSON.stringify(data)}
    </pre>
  );
}

function MetricCard({ name, value }: { name: string; value: number }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.025] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div className="text-[10px] uppercase tracking-[0.18em] text-gray-500">{name}</div>
      <div className="mt-1 font-mono text-sm text-gray-100">{value}</div>
    </div>
  );
}

// Stage/cohort graph: vertical axis is research stages (purposes / decisions),
// horizontal inside each stage is sibling runs competing for promotion. Edges
// are anchored to the specific source run chip (since a "branch" is from a
// chosen run, not from a stage), curving left/down into the child stage rail
// dot. The SVG overlay is full-width so chip anchors are addressable; chips
// stay clickable because the overlay is pointer-events-none.
const STAGE_H = 228;
const GRAPH_W = 52;
const STAGE_X = 22;
const STAGE_NODE_R = 8;

// Layout constants for deriving deterministic run-chip anchors. Match the
// classes used on the <li>, the spacer, the StageCard, and RunChip. We use
// the sm-breakpoint values; the demo card is rendered at sm width and up.
const LIST_PADDING_X = 12; // sm:px-3 on the <li>
const LIST_GAP = 12; // sm:gap-3 between rail spacer and StageCard
const STAGE_CARD_PADDING_X = 12; // p-3 on StageCard
const RUN_CHIP_W = 200;
const RUN_CHIP_GAP = 8; // gap-2 between chips
const CHIPS_START_X = LIST_PADDING_X + GRAPH_W + LIST_GAP + STAGE_CARD_PADDING_X;
// Chip vertical center within its stage row (calibrated against STAGE_H=228).
const RUN_ANCHOR_Y = 162;
const RUN_ANCHOR_INSET_X = 18; // anchor a bit inside the chip's left edge

function isFoldedRun(exp: DemoExperiment) {
  return exp.status === "failed" || exp.decision === "drop";
}

type StageNode = {
  id: string;
  stage: DemoStage;
  row: number;
  cy: number;
};

type StageEdge =
  | { id: string; kind: "rail"; fromRow: number; toRow: number; muted: boolean }
  | {
      id: string;
      kind: "run";
      fromRunId: string;
      fromStageId: string;
      fromRow: number;
      toRow: number;
      fromChipIndex: number;
      siblingIndex: number;
      siblingCount: number;
      muted: boolean;
      emphasized?: boolean;
    };

function buildStageGraph(
  stages: DemoStage[],
  visibleRunsByStage: Map<string, DemoExperiment[]>,
): { nodes: StageNode[]; edges: StageEdge[] } {
  const rowById = new Map<string, number>();
  stages.forEach((stage, idx) => rowById.set(stage.id, idx));
  const nodes: StageNode[] = stages.map((stage, row) => ({
    id: stage.id,
    stage,
    row,
    cy: row * STAGE_H + STAGE_H / 2,
  }));

  type Pending = {
    stage: DemoStage;
    fromRow: number;
    toRow: number;
    parentStage: DemoStage;
    runIndex: number | null;
  };
  const pending: Pending[] = [];
  for (const stage of stages) {
    if (!stage.parentStageId) continue;
    const fromRow = rowById.get(stage.parentStageId);
    const toRow = rowById.get(stage.id);
    if (fromRow === undefined || toRow === undefined) continue;
    const parentStage = stages.find((s) => s.id === stage.parentStageId);
    if (!parentStage) continue;
    let runIndex: number | null = null;
    if (stage.parentRunId) {
      const runs = visibleRunsByStage.get(stage.parentStageId) ?? [];
      const idx = runs.findIndex((r) => r.id === stage.parentRunId);
      if (idx >= 0) runIndex = idx;
    }
    pending.push({ stage, fromRow, toRow, parentStage, runIndex });
  }

  // Group run-anchored edges by source run so we can space siblings apart.
  const groupCounts = new Map<string, number>();
  for (const p of pending) {
    if (p.runIndex === null || !p.stage.parentRunId) continue;
    const key = `${p.stage.parentStageId}::${p.stage.parentRunId}`;
    groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
  }
  const groupSeen = new Map<string, number>();

  const edges: StageEdge[] = [];
  for (const p of pending) {
    const muted = !!p.stage.folded || !!p.parentStage.folded;
    if (p.runIndex !== null && p.stage.parentRunId) {
      const key = `${p.stage.parentStageId}::${p.stage.parentRunId}`;
      const siblingIndex = groupSeen.get(key) ?? 0;
      groupSeen.set(key, siblingIndex + 1);
      const siblingCount = groupCounts.get(key) ?? 1;
      const emphasized = p.parentStage.promotedRunId === p.stage.parentRunId;
      edges.push({
        id: `${p.stage.parentRunId}->${p.stage.id}`,
        kind: "run",
        fromRunId: p.stage.parentRunId,
        fromStageId: p.stage.parentStageId!,
        fromRow: p.fromRow,
        toRow: p.toRow,
        fromChipIndex: p.runIndex,
        siblingIndex,
        siblingCount,
        muted,
        emphasized,
      });
    } else {
      // Fallback: source run is hidden (or no parentRunId) — draw a muted
      // dashed rail edge so the lineage is still readable.
      edges.push({
        id: `${p.stage.parentStageId}->${p.stage.id}`,
        kind: "rail",
        fromRow: p.fromRow,
        toRow: p.toRow,
        muted: muted || !!p.stage.parentRunId,
      });
    }
  }
  return { nodes, edges };
}

function railEdgePath(fromRow: number, toRow: number) {
  const fromY = fromRow * STAGE_H + STAGE_H / 2 + STAGE_NODE_R;
  const toY = toRow * STAGE_H + STAGE_H / 2 - STAGE_NODE_R;
  const skip = toRow - fromRow;
  if (skip <= 1) {
    return `M ${STAGE_X} ${fromY} L ${STAGE_X} ${toY}`;
  }
  const bulge = STAGE_X + 18;
  const midY = (fromY + toY) / 2;
  return `M ${STAGE_X} ${fromY} C ${bulge} ${fromY + (midY - fromY) * 0.55}, ${bulge} ${toY - (toY - midY) * 0.55}, ${STAGE_X} ${toY}`;
}

function runEdgePath(edge: Extract<StageEdge, { kind: "run" }>) {
  const chipLeftX = CHIPS_START_X + edge.fromChipIndex * (RUN_CHIP_W + RUN_CHIP_GAP);
  // Fan out sibling edges from the same chip so multiple outgoing branches
  // don't overlap into one line.
  const fanSpread = Math.max(0, edge.siblingCount - 1);
  const fanOffset = fanSpread === 0 ? 0 : (edge.siblingIndex - fanSpread / 2) * 22;
  const sx = chipLeftX + RUN_ANCHOR_INSET_X + fanOffset;
  const sy = edge.fromRow * STAGE_H + RUN_ANCHOR_Y + 18; // bottom-ish of chip
  const tx = STAGE_X;
  const ty = edge.toRow * STAGE_H + STAGE_H / 2 - STAGE_NODE_R;
  // Curve left first, then down into the child rail dot. Control points pull
  // leftward early so the curve reads as "this run forks into that stage".
  const c1x = sx - 60 - fanOffset * 0.3;
  const c1y = sy + 24;
  const c2x = tx;
  const c2y = ty - 60;
  return `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`;
}

function StageGraphOverlay({
  nodes,
  edges,
  selectedStageId,
  selectedRunId,
}: {
  nodes: StageNode[];
  edges: StageEdge[];
  selectedStageId: string | undefined;
  selectedRunId: string;
}) {
  const height = nodes.length * STAGE_H;
  return (
    <svg
      width="100%"
      height={height}
      className="pointer-events-none absolute inset-0"
      aria-hidden
    >
      {/* Faint vertical rail behind the dots so the spine still reads. */}
      {nodes.length > 1 && (
        <line
          x1={STAGE_X}
          y1={STAGE_NODE_R + 4}
          x2={STAGE_X}
          y2={(nodes.length - 1) * STAGE_H + STAGE_H / 2 - STAGE_NODE_R}
          stroke="#1f1f23"
          strokeWidth={1}
        />
      )}
      {edges.map((edge) => {
        if (edge.kind === "rail") {
          return (
            <path
              key={edge.id}
              d={railEdgePath(edge.fromRow, edge.toRow)}
              stroke="#3f3f46"
              strokeWidth={2}
              fill="none"
              opacity={edge.muted ? 0.3 : 0.7}
              strokeDasharray={edge.muted ? "4 3" : undefined}
              strokeLinecap="round"
            />
          );
        }
        const isSelectedEdge = edge.fromRunId === selectedRunId;
        const stroke = edge.emphasized ? "#7c7cff" : isSelectedEdge ? "#a5b4fc" : "#3f3f46";
        const width = edge.emphasized ? 2.5 : isSelectedEdge ? 2.25 : 1.75;
        const opacity = edge.muted ? 0.35 : edge.emphasized ? 0.92 : isSelectedEdge ? 0.95 : 0.75;
        return (
          <path
            key={edge.id}
            d={runEdgePath(edge)}
            stroke={stroke}
            strokeWidth={width}
            fill="none"
            opacity={opacity}
            strokeDasharray={edge.muted ? "5 4" : undefined}
            strokeLinecap="round"
          />
        );
      })}
      {nodes.map((node) => {
        const state = node.stage.state ?? "active";
        const color = STAGE_DOT_COLOR[state];
        const isSelected = node.id === selectedStageId;
        const muted = !!node.stage.folded;
        const r = isSelected ? STAGE_NODE_R + 1 : STAGE_NODE_R;
        return (
          <g key={node.id} opacity={muted && !isSelected ? 0.55 : 1}>
            {isSelected && <circle cx={STAGE_X} cy={node.cy} r={r + 7} fill={color} opacity={0.18} />}
            <circle cx={STAGE_X} cy={node.cy} r={r} fill="#0f1011" stroke={color} strokeWidth={2} />
            {isSelected && <circle cx={STAGE_X} cy={node.cy} r={r - 3} fill={color} />}
          </g>
        );
      })}
    </svg>
  );
}

function RunChip({
  exp,
  selected,
  onClick,
  summary,
  muted,
}: {
  exp: DemoExperiment;
  selected: boolean;
  onClick: () => void;
  summary: string[];
  muted: boolean;
}) {
  const branch = BRANCH[exp.branch];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={`Open ${exp.name}`}
      className={cn(
        "flex w-[200px] shrink-0 flex-col gap-1.5 rounded-xl border px-3 py-2 text-left transition",
        selected
          ? "border-indigo-400/45 bg-indigo-500/[0.10] shadow-[0_0_0_1px_rgba(124,124,255,0.4),0_10px_28px_-12px_rgba(124,124,255,0.5)]"
          : "border-white/[0.06] bg-white/[0.025] hover:border-white/[0.12] hover:bg-white/[0.05]",
        muted && !selected && "opacity-55 hover:opacity-90",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: branch.color, boxShadow: `0 0 10px ${branch.glow}` }}
        />
        <span className="truncate text-xs font-medium text-gray-100">{exp.shortName}</span>
        <span className={cn("ml-auto rounded border px-1.5 py-0.5 text-[9px] uppercase", BADGE[exp.status])}>{exp.status}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1 font-mono text-[10px]">
        <span className="rounded border border-white/[0.06] bg-black/25 px-1.5 py-0.5 text-gray-200">zN {exp.metrics.zN}</span>
        {summary.slice(0, 2).map((label) => (
          <span key={label} className="rounded border border-white/[0.05] bg-white/[0.025] px-1.5 py-0.5 text-gray-400">
            {label}
          </span>
        ))}
      </div>
      {exp.decision && (
        <div className="flex">
          <span className={cn("rounded border px-1.5 py-0.5 text-[10px] uppercase", BADGE[exp.decision])}>{exp.decision}</span>
        </div>
      )}
    </button>
  );
}

function StageCard({
  stage,
  runs,
  hiddenFoldedCount,
  selectedRunId,
  onSelectRun,
  promotedRun,
  parentRun,
  summarizeDiff,
}: {
  stage: DemoStage;
  runs: DemoExperiment[];
  hiddenFoldedCount: number;
  selectedRunId: string;
  onSelectRun: (id: string) => void;
  promotedRun?: DemoExperiment;
  parentRun?: DemoExperiment;
  summarizeDiff: (exp: DemoExperiment) => string[];
}) {
  const state = stage.state ?? "active";
  const isFoldedStage = !!stage.folded;
  return (
    <div
      className={cn(
        "flex h-full flex-col gap-2.5 rounded-2xl border bg-white/[0.025] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]",
        isFoldedStage ? "border-white/[0.04] bg-white/[0.015]" : "border-white/[0.07]",
      )}
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className={cn("text-sm font-semibold tracking-[-0.01em]", isFoldedStage ? "text-gray-300" : "text-gray-100")}>
              {stage.title}
            </h3>
            <span className={cn("rounded border px-1.5 py-0.5 text-[10px] uppercase", STAGE_STATE_BADGE[state])}>{state}</span>
            {promotedRun && (
              <span className="rounded-full border border-emerald-400/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-200">
                promoted · {promotedRun.shortName}
              </span>
            )}
            {parentRun && (
              <span className="rounded border border-white/[0.05] bg-black/20 px-1.5 py-0.5 font-mono text-[10px] text-gray-500">
                ↳ {parentRun.shortName}
              </span>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">{stage.purpose}</p>
        </div>
        <div className="text-right text-[10px] uppercase tracking-[0.18em] text-gray-600">
          {stage.runIds.length} run{stage.runIds.length > 1 ? "s" : ""}
        </div>
      </div>
      <div className="-mx-1 flex items-stretch gap-2 overflow-x-auto px-1 pb-1">
        {runs.map((exp) => (
          <RunChip
            key={exp.id}
            exp={exp}
            selected={exp.id === selectedRunId}
            onClick={() => onSelectRun(exp.id)}
            summary={summarizeDiff(exp)}
            muted={isFoldedStage || isFoldedRun(exp)}
          />
        ))}
        {hiddenFoldedCount > 0 && (
          <span className="flex shrink-0 items-center self-stretch rounded-xl border border-amber-400/25 bg-amber-500/10 px-3 text-[11px] text-amber-200">
            +{hiddenFoldedCount} folded
          </span>
        )}
      </div>
    </div>
  );
}

export default function ExperimentLineageDemo() {
  const [experiments, setExperiments] = useState(demoExperiments);
  const [stages] = useState(demoStages);
  const [selectedId, setSelectedId] = useState("curiosity-resume-t4");
  const [events, setEvents] = useState(seedEvents);
  const [note, setNote] = useState("");
  const [decision, setDecision] = useState<DemoDecision>("keep");
  const [reason, setReason] = useState("");
  const [focusOnly, setFocusOnly] = useState(false);
  const [showFoldedBranches, setShowFoldedBranches] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const expById = useMemo(() => new Map(experiments.map((e) => [e.id, e])), [experiments]);

  const selected = experiments.find((e) => e.id === selectedId) ?? experiments[0];
  const parent = selected.parentId ? experiments.find((e) => e.id === selected.parentId) : undefined;
  const forks = experiments.filter((e) => e.parentId === selected.id);

  const selectedStage = useMemo(
    () => stages.find((s) => s.runIds.includes(selected.id)),
    [stages, selected.id],
  );

  const stageSiblings = useMemo(() => {
    if (!selectedStage) return [] as DemoExperiment[];
    return selectedStage.runIds
      .filter((id) => id !== selected.id)
      .map((id) => expById.get(id))
      .filter((exp): exp is DemoExperiment => !!exp);
  }, [selectedStage, selected.id, expById]);

  const runsByStage = useMemo(() => {
    const map = new Map<string, { normal: DemoExperiment[]; folded: DemoExperiment[] }>();
    for (const stage of stages) {
      const normal: DemoExperiment[] = [];
      const folded: DemoExperiment[] = [];
      for (const id of stage.runIds) {
        const exp = expById.get(id);
        if (!exp) continue;
        if (isFoldedRun(exp)) folded.push(exp);
        else normal.push(exp);
      }
      map.set(stage.id, { normal, folded });
    }
    return map;
  }, [stages, expById]);

  const visibleStages = useMemo(() => {
    const selectedStageId = selectedStage?.id;
    const selectedInFoldedStage = !!selectedStage?.folded;
    let base = stages;
    if (focusOnly && selectedStageId) {
      const keep = new Set<string>([selectedStageId]);
      const ss = stages.find((s) => s.id === selectedStageId);
      if (ss?.parentStageId) keep.add(ss.parentStageId);
      for (const child of stages) {
        if (child.parentStageId === selectedStageId) keep.add(child.id);
      }
      base = stages.filter((s) => keep.has(s.id));
    }
    if (showFoldedBranches || selectedInFoldedStage) return base;
    return base.filter((s) => !s.folded);
  }, [stages, focusOnly, selectedStage, showFoldedBranches]);

  const visibleStageIds = useMemo(() => new Set(visibleStages.map((s) => s.id)), [visibleStages]);

  const visibleRunsCount = useMemo(() => {
    let total = 0;
    for (const stage of visibleStages) {
      const buckets = runsByStage.get(stage.id);
      if (!buckets) continue;
      total += buckets.normal.length;
      if (showFoldedBranches) total += buckets.folded.length;
    }
    return total;
  }, [visibleStages, runsByStage, showFoldedBranches]);

  const foldedCount = useMemo(() => {
    let total = 0;
    for (const stage of stages) {
      const buckets = runsByStage.get(stage.id);
      if (!buckets) continue;
      const isHiddenStage = !visibleStageIds.has(stage.id);
      if (isHiddenStage) {
        total += buckets.normal.length + buckets.folded.length;
      } else if (!showFoldedBranches) {
        total += buckets.folded.length;
      }
    }
    return total;
  }, [stages, runsByStage, visibleStageIds, showFoldedBranches]);

  const visibleRunsByStage = useMemo(() => {
    const map = new Map<string, DemoExperiment[]>();
    for (const stage of visibleStages) {
      const buckets = runsByStage.get(stage.id) ?? { normal: [], folded: [] };
      const selectedFoldedRun = buckets.folded.find((exp) => exp.id === selected.id);
      const ordered = showFoldedBranches
        ? [...buckets.normal, ...buckets.folded]
        : selectedFoldedRun
          ? [...buckets.normal, selectedFoldedRun]
          : buckets.normal;
      map.set(stage.id, ordered);
    }
    return map;
  }, [visibleStages, runsByStage, showFoldedBranches, selected.id]);

  const { nodes, edges } = useMemo(
    () => buildStageGraph(visibleStages, visibleRunsByStage),
    [visibleStages, visibleRunsByStage],
  );

  const timeline = events.filter((e) => e.experimentId === selected.id);

  const diff = useMemo(() => {
    if (!parent) return [];
    const keys = Array.from(new Set([...Object.keys(parent.config), ...Object.keys(selected.config)]));
    return keys
      .map((key) => ({ key, before: parent.config[key], after: selected.config[key] }))
      .filter((row) => JSON.stringify(row.before) !== JSON.stringify(row.after));
  }, [parent, selected]);

  function selectExperiment(id: string) {
    const exp = experiments.find((x) => x.id === id);
    setSelectedId(id);
    setDecision(exp?.decision ?? "keep");
    setReason("");
    setDetailsOpen(true);
    if (exp) {
      const stage = stages.find((s) => s.runIds.includes(id));
      if (stage?.folded || isFoldedRun(exp)) setShowFoldedBranches(true);
    }
  }

  function summarizeDiff(exp: DemoExperiment) {
    if (!exp.parentId) return ["root"];
    const base = experiments.find((candidate) => candidate.id === exp.parentId);
    if (!base) return ["fork"];
    const keys = Array.from(new Set([...Object.keys(base.config), ...Object.keys(exp.config)]));
    const changed = keys.filter((key) => JSON.stringify(base.config[key]) !== JSON.stringify(exp.config[key]));
    return changed.length > 0 ? changed.slice(0, 3) : ["runtime"];
  }

  function addNote() {
    if (!note.trim()) return;
    setEvents((prev) => [
      ...prev,
      {
        id: `local-${prev.length + 1}`,
        experimentId: selected.id,
        kind: "note",
        message: note.trim(),
        actor: "demo-user",
        age: "now",
      },
    ]);
    setNote("");
  }

  function setDemoDecision() {
    if (!reason.trim()) return;
    setExperiments((prev) =>
      prev.map((exp) => (exp.id === selected.id ? { ...exp, decision, decisionReason: reason.trim() } : exp)),
    );
    setEvents((prev) => [
      ...prev,
      {
        id: `local-${prev.length + 1}`,
        experimentId: selected.id,
        kind: "decision",
        message: `Marked ${decision}: ${reason.trim()}`,
        actor: "demo-user",
        age: "now",
        data: { decision },
      },
    ]);
    setReason("");
  }

  return (
    <div className="min-h-screen bg-[#08090a] text-[#f7f8f8] [font-feature-settings:'cv01','ss03']">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(113,112,255,0.16),transparent_34%),radial-gradient(circle_at_82%_18%,rgba(16,185,129,0.12),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.035),transparent_22%)]" />

      <header className="relative z-10 flex min-h-14 flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] bg-[#0f1011]/85 px-4 py-3 backdrop-blur-xl sm:px-5">
        <div className="flex items-center gap-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">⚖️</div>
          <span className="text-sm font-semibold tracking-tight">Alchemy</span>
          <span className="rounded-full border border-white/[0.06] bg-white/[0.025] px-2 py-0.5 text-[11px] text-gray-400">Experiment lineage demo</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.8)]" />
          No server · no token · no mutable state
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-[1560px] space-y-4 p-3 sm:space-y-5 sm:p-5">
        <section className="flex flex-col gap-4 rounded-2xl border border-white/[0.06] bg-white/[0.025] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 font-mono text-[11px] text-indigo-300">/demo/experiments-lineage</div>
            <h1 className="text-3xl font-medium tracking-[-0.04em] text-white md:text-4xl">Experiment lineage — stage graph</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-400">
              The vertical rail walks research stages — each one a decision point with its own purpose. Same-purpose sibling runs sit side-by-side inside the stage; promotion picks one and the next stage forks from it.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {Object.entries(BRANCH).map(([key, style]) => (
              <span key={key} className={cn("rounded-full border border-white/[0.06] px-2.5 py-1 text-[11px]", style.bg, style.text)}>
                <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: style.color, boxShadow: `0 0 10px ${style.glow}` }} />
                {style.label}
              </span>
            ))}
          </div>
        </section>

        <section className="grid grid-cols-1 gap-5">
          <div className="overflow-hidden rounded-2xl border border-white/[0.06] bg-[#0f1011]/90 shadow-[0_20px_80px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.035)]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
              <div>
                <h2 className="text-sm font-medium text-gray-200">Stage graph</h2>
                <p className="text-xs text-gray-500">
                  {visibleStages.length} stage{visibleStages.length === 1 ? "" : "s"} · {visibleRunsCount} run{visibleRunsCount === 1 ? "" : "s"}
                  {foldedCount > 0 ? ` · ${foldedCount} folded` : ""}
                </p>
              </div>
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
                  <button
                    onClick={() => setFocusOnly((value) => !value)}
                    className={cn(
                      "rounded-md border px-3 py-1.5 text-xs transition",
                      focusOnly ? "border-indigo-400/30 bg-indigo-500/15 text-indigo-200" : "border-white/[0.08] bg-white/[0.03] text-gray-300 hover:bg-white/[0.06]",
                    )}
                  >
                    {focusOnly ? "Show all stages" : "Focus stage"}
                  </button>
                  <button
                    onClick={() => setShowFoldedBranches((value) => !value)}
                    className={cn(
                      "rounded-md border px-3 py-1.5 text-xs transition",
                      showFoldedBranches ? "border-amber-400/25 bg-amber-500/10 text-amber-200" : "border-white/[0.08] bg-white/[0.03] text-gray-400 hover:bg-white/[0.06]",
                    )}
                  >
                    {showFoldedBranches ? "Hide folded" : `${foldedCount} folded`}
                  </button>
                </div>
                <select
                  value={selectedId}
                  onChange={(e) => selectExperiment(e.target.value)}
                  className="w-full min-w-0 max-w-full truncate rounded-md border border-white/[0.08] bg-[#191a1b] px-3 py-1.5 text-xs text-gray-200 outline-none sm:w-60"
                  aria-label="Select experiment"
                >
                  {stages.map((stage) => (
                    <optgroup key={stage.id} label={stage.title}>
                      {stage.runIds.map((id) => {
                        const exp = expById.get(id);
                        if (!exp) return null;
                        return (
                          <option key={exp.id} value={exp.id}>{exp.name}</option>
                        );
                      })}
                    </optgroup>
                  ))}
                </select>
              </div>
            </div>

            <div className="p-2 sm:p-3">
              <div className="relative overflow-hidden rounded-xl border border-white/[0.05] bg-black/15">
                <StageGraphOverlay nodes={nodes} edges={edges} selectedStageId={selectedStage?.id} selectedRunId={selected.id} />
                <ul className="relative">
                  {visibleStages.map((stage) => {
                    const buckets = runsByStage.get(stage.id) ?? { normal: [], folded: [] };
                    const selectedFoldedRun = buckets.folded.find((exp) => exp.id === selected.id);
                    const runs = showFoldedBranches
                      ? [...buckets.normal, ...buckets.folded]
                      : selectedFoldedRun
                        ? [...buckets.normal, selectedFoldedRun]
                        : buckets.normal;
                    const hiddenFoldedCount = showFoldedBranches ? 0 : Math.max(0, buckets.folded.length - (selectedFoldedRun ? 1 : 0));
                    const promotedRun = stage.promotedRunId ? expById.get(stage.promotedRunId) : undefined;
                    const parentRun = stage.parentRunId ? expById.get(stage.parentRunId) : undefined;
                    return (
                      <li key={stage.id} className="relative" style={{ height: STAGE_H }}>
                        <div className="flex h-full items-stretch gap-2 px-2 py-2 sm:gap-3 sm:px-3">
                          <div className="shrink-0" style={{ width: GRAPH_W }} aria-hidden />
                          <div className="min-w-0 flex-1">
                            <StageCard
                              stage={stage}
                              runs={runs}
                              hiddenFoldedCount={hiddenFoldedCount}
                              selectedRunId={selected.id}
                              onSelectRun={selectExperiment}
                              promotedRun={promotedRun}
                              parentRun={parentRun}
                              summarizeDiff={summarizeDiff}
                            />
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
            <div className="border-t border-white/[0.06] px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-mono text-xs text-gray-200">{selected.shortName}</span>
                    {selectedStage && (
                      <span className="rounded border border-white/[0.05] bg-black/20 px-1.5 py-0.5 text-[10px] text-gray-400">
                        in {selectedStage.title}
                      </span>
                    )}
                    <span className={cn("rounded border px-1.5 py-0.5 text-[10px] uppercase", BADGE[selected.decision ?? "note"])}>{selected.decision ?? "open"}</span>
                    {diff.slice(0, 3).map((row) => (
                      <span key={row.key} className="rounded border border-white/[0.06] bg-black/20 px-1.5 py-0.5 font-mono text-[10px] text-gray-400">{row.key}</span>
                    ))}
                  </div>
                  <p className="mt-1 truncate text-xs text-gray-500">Tap a run chip to drill in. Folded stages stay collapsed by default.</p>
                </div>
                <button
                  onClick={() => setDetailsOpen((open) => !open)}
                  className="rounded-md border border-indigo-400/25 bg-indigo-500/15 px-3 py-1.5 text-xs text-indigo-200 transition hover:bg-indigo-500/25"
                >
                  {detailsOpen ? "Hide details" : "Open details"}
                </button>
              </div>
            </div>
          </div>

          <aside className={cn("space-y-5", !detailsOpen && "hidden")}>
            <section className="rounded-2xl border border-white/[0.06] bg-[#0f1011]/90 p-4 shadow-[0_20px_80px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.035)]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: BRANCH[selected.branch].color, boxShadow: `0 0 14px ${BRANCH[selected.branch].glow}` }} />
                    <span className={cn("text-[11px]", BRANCH[selected.branch].text)}>{BRANCH[selected.branch].label}</span>
                    {selectedStage && (
                      <span className="rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-0.5 text-[10px] text-gray-400">
                        {selectedStage.title}
                      </span>
                    )}
                  </div>
                  <h2 className="truncate text-xl font-medium tracking-[-0.03em] text-white">{selected.name}</h2>
                  <p className="mt-1 text-sm leading-6 text-gray-400">{selected.description}</p>
                </div>
                <span className={cn("rounded-md border px-2 py-1 text-[10px] uppercase", BADGE[selected.status])}>{selected.status}</span>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2">
                {Object.entries(selected.metrics).map(([key, value]) => <MetricCard key={key} name={key} value={value} />)}
              </div>
            </section>

            <section className="rounded-2xl border border-white/[0.06] bg-[#0f1011]/90 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
              <h3 className="mb-3 text-sm font-medium text-gray-200">Inspector</h3>
              <div className="space-y-4 text-sm">
                <Field label="Family"><span className="font-mono text-xs text-gray-300">{selected.family}</span></Field>
                {parent && (
                  <Field label="Parent">
                    <button onClick={() => selectExperiment(parent.id)} className="font-mono text-xs text-indigo-300 hover:text-indigo-200">{parent.name}</button>
                  </Field>
                )}
                <Field label="Hypothesis"><p className="text-gray-300">{selected.hypothesis}</p></Field>
                <Field label="Expected"><p className="text-gray-300">{selected.expected}</p></Field>
                {selected.forkReason && <Field label="Fork reason"><p className="text-gray-300">{selected.forkReason}</p></Field>}
                {stageSiblings.length > 0 && (
                  <Field label={`Stage siblings (${stageSiblings.length})`}>
                    <div className="flex flex-wrap gap-1.5">
                      {stageSiblings.map((sib) => (
                        <button
                          key={sib.id}
                          onClick={() => selectExperiment(sib.id)}
                          className={cn("rounded-md border border-white/[0.06] px-2 py-1 font-mono text-[11px] hover:border-indigo-400/30", BRANCH[sib.branch].bg, BRANCH[sib.branch].text)}
                        >
                          {sib.shortName}
                        </button>
                      ))}
                    </div>
                  </Field>
                )}
                {forks.length > 0 && (
                  <Field label={`Forks (${forks.length})`}>
                    <div className="flex flex-wrap gap-1.5">
                      {forks.map((fork) => (
                        <button
                          key={fork.id}
                          onClick={() => selectExperiment(fork.id)}
                          className={cn("rounded-md border border-white/[0.06] px-2 py-1 font-mono text-[11px] hover:border-indigo-400/30", BRANCH[fork.branch].bg, BRANCH[fork.branch].text)}
                        >
                          {fork.shortName}
                        </button>
                      ))}
                    </div>
                  </Field>
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-white/[0.06] bg-[#0f1011]/90 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-medium text-gray-200">Decision</h3>
                <span className={cn("rounded-md border px-2 py-1 text-[10px] uppercase", BADGE[selected.decision ?? "note"])}>{selected.decision ?? "undecided"}</span>
              </div>
              {selected.decisionReason && <p className="mb-4 text-sm leading-6 text-gray-300">{selected.decisionReason}</p>}
              <div className="space-y-2 rounded-xl border border-white/[0.06] bg-black/20 p-3">
                <div className="flex items-center gap-2">
                  <select value={decision} onChange={(e) => setDecision(e.target.value as DemoDecision)} className="rounded-md border border-white/[0.08] bg-[#191a1b] px-2 py-1.5 text-xs text-gray-200 outline-none">
                    <option value="keep">keep</option>
                    <option value="drop">drop</option>
                    <option value="rerun">rerun</option>
                    <option value="fork">fork</option>
                  </select>
                  <button onClick={setDemoDecision} className="rounded-md border border-indigo-400/25 bg-indigo-500/15 px-3 py-1.5 text-xs text-indigo-200 transition hover:bg-indigo-500/25">Set decision</button>
                </div>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason..." rows={2} className="w-full resize-none rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1.5 text-xs text-gray-200 outline-none placeholder:text-gray-600" />
              </div>
            </section>
          </aside>
        </section>

        <section className={cn("grid grid-cols-1 gap-5 xl:grid-cols-2", !detailsOpen && "hidden")}>
          <div className="rounded-2xl border border-white/[0.06] bg-[#0f1011]/90 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium text-gray-200">Config diff</h2>
              <span className="text-xs text-gray-500">vs parent</span>
            </div>
            {!parent ? (
              <p className="text-xs text-gray-500">Root experiment has no parent diff.</p>
            ) : (
              <div className="overflow-hidden rounded-xl border border-white/[0.06]">
                <table className="w-full text-xs">
                  <thead className="bg-white/[0.03] text-gray-500">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Key</th>
                      <th className="px-3 py-2 text-left font-medium">Parent</th>
                      <th className="px-3 py-2 text-left font-medium">Current</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {diff.length === 0 ? (
                      <tr className="bg-black/10">
                        <td colSpan={3} className="px-3 py-4 text-center text-xs text-gray-500">
                          No config changes from parent. This node records runtime / checkpoint lineage only.
                        </td>
                      </tr>
                    ) : diff.map((row) => (
                      <tr key={row.key} className="bg-black/10">
                        <td className="px-3 py-2 font-mono text-gray-400">{row.key}</td>
                        <td className="px-3 py-2 font-mono text-red-300/85">{String(row.before)}</td>
                        <td className="px-3 py-2 font-mono text-emerald-300/85">{String(row.after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-white/[0.06] bg-[#0f1011]/90 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium text-gray-200">Node timeline</h2>
              <span className="text-xs text-gray-500">{timeline.length} events on selected experiment</span>
            </div>
            <div className="mb-4 space-y-2 rounded-xl border border-white/[0.06] bg-black/20 p-3">
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a mock note to this node..." rows={2} className="w-full resize-none rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1.5 text-xs text-gray-200 outline-none placeholder:text-gray-600" />
              <div className="flex justify-end">
                <button onClick={addNote} className="rounded-md border border-indigo-400/25 bg-indigo-500/15 px-3 py-1.5 text-xs text-indigo-200 transition hover:bg-indigo-500/25">Add note</button>
              </div>
            </div>
            <ul className="space-y-2">
              {timeline.map((ev) => (
                <li key={ev.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("rounded border px-1.5 py-0.5 text-[10px]", BADGE[ev.kind])}>{ev.kind}</span>
                    <span className="text-gray-300">{ev.message}</span>
                    <span className="ml-auto text-gray-600">{ev.age}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-gray-600">by {ev.actor}</div>
                  {ev.data && <JsonPill data={ev.data} />}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
    </div>
  );
}
