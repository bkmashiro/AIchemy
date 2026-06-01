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

// Git-style commit-graph layout.
// Why inline (no dependency): the existing graph libraries we evaluated either
// render the whole graph as one global SVG (gitgraph.js, react-d3-tree) — which
// re-creates the alignment-drift problem we are fixing — or are heavy node-edge
// frameworks (reactflow, @xyflow/react) whose UX is canvas-style pan/zoom, not
// the row-aligned clickable list this inspector needs. The algorithm below is
// ~40 lines and fits both UX and bundle constraints.
type GraphRow = {
  exp: DemoExperiment;
  index: number;
  lane: number;
  parentLane?: number;
};

function isFoldedBranch(exp: DemoExperiment) {
  return exp.branch === "batch" || exp.status === "failed" || exp.decision === "drop";
}

function buildLanes(experiments: DemoExperiment[]): {
  rows: GraphRow[];
  laneCount: number;
  laneColor: string[];
} {
  const expLane = new Map<string, number>();
  const firstChildClaimed = new Set<string>();
  const laneColor: string[] = [];
  const rows: GraphRow[] = [];
  let nextLane = 0;

  experiments.forEach((exp, index) => {
    let lane: number;
    let parentLane: number | undefined;
    if (exp.parentId && expLane.has(exp.parentId)) {
      parentLane = expLane.get(exp.parentId);
      if (!firstChildClaimed.has(exp.parentId)) {
        lane = parentLane!;
        firstChildClaimed.add(exp.parentId);
      } else {
        lane = nextLane++;
        laneColor[lane] = BRANCH[exp.branch].color;
      }
    } else {
      lane = nextLane++;
      laneColor[lane] = BRANCH[exp.branch].color;
    }
    expLane.set(exp.id, lane);
    rows.push({ exp, index, lane, parentLane });
  });

  return { rows, laneCount: nextLane, laneColor };
}

function computeLaneRanges(rows: GraphRow[], laneCount: number) {
  const first = new Array<number>(laneCount).fill(Number.POSITIVE_INFINITY);
  const lastUse = new Array<number>(laneCount).fill(Number.NEGATIVE_INFINITY);
  for (const row of rows) {
    first[row.lane] = Math.min(first[row.lane], row.index);
    lastUse[row.lane] = Math.max(lastUse[row.lane], row.index);
    if (row.parentLane !== undefined && row.parentLane !== row.lane) {
      // The parent lane stays "in use" through the fork row so the connector
      // curve at row R has a continuous vertical above it (drawn as the
      // bottom-half of row R-1 etc.). The fork row itself skips the parent's
      // top-half line because the curve replaces it.
      lastUse[row.parentLane] = Math.max(lastUse[row.parentLane], row.index);
    }
  }
  return { first, lastUse };
}

const LANE_W = 18;
const NODE_R = 7;

function laneCx(lane: number) {
  return lane * LANE_W + LANE_W / 2;
}

function RowGraph({
  row,
  ranges,
  laneCount,
  laneColor,
  isSelected,
  isMuted,
}: {
  row: GraphRow;
  ranges: { first: number[]; lastUse: number[] };
  laneCount: number;
  laneColor: string[];
  isSelected: boolean;
  isMuted?: boolean;
}) {
  const width = laneCount * LANE_W;
  const branchColor = BRANCH[row.exp.branch].color;
  const branchGlow = BRANCH[row.exp.branch].glow;
  const isFork = row.parentLane !== undefined && row.parentLane !== row.lane;
  const cx = laneCx(row.lane);

  // For each lane, decide whether to draw a top-half line (above the node row,
  // y=0..50) and/or a bottom-half line (y=50..100). A lane is "alive above"
  // this row if some earlier row owned it AND it is still in use at or below
  // this row. "Alive below" mirrors that downward.
  const segments: Array<{ lane: number; top: boolean; bottom: boolean; color: string; ownLane: boolean }> = [];
  for (let L = 0; L < laneCount; L++) {
    const aliveAbove = ranges.first[L] < row.index && ranges.lastUse[L] >= row.index;
    const aliveBelow = ranges.first[L] <= row.index && ranges.lastUse[L] > row.index;
    const ownLane = L === row.lane;
    // Fork row: parent lane's top-half is replaced by the curve. Skip it.
    const top = aliveAbove && !(isFork && L === row.parentLane);
    const bottom = aliveBelow;
    if (top || bottom) {
      segments.push({ lane: L, top, bottom, color: ownLane ? branchColor : laneColor[L], ownLane });
    }
  }

  // SVG draws lines and curves in viewBox y=[0,100]; preserveAspectRatio="none"
  // is safe because we only draw vertical lines (no aspect distortion) plus
  // one curve that remains visually acceptable under uniform y-scaling. The
  // node circle is a positioned HTML element below to stay round at any row
  // height.
  return (
    <div className="relative shrink-0" style={{ width }}>
      <svg
        width={width}
        height="100%"
        viewBox={`0 0 ${width} 100`}
        preserveAspectRatio="none"
        className="absolute inset-0 block"
        aria-hidden
      >
        {segments.map((seg) => {
          const sx = laneCx(seg.lane);
          const strokeWidth = seg.ownLane ? 2 : 1.75;
          return (
            <g key={`seg-${seg.lane}`}>
              {seg.top && (
                <line
                  x1={sx}
                  y1={0}
                  x2={sx}
                  y2={50}
                  stroke={seg.color}
                  strokeWidth={strokeWidth}
                  opacity={isMuted ? 0.18 : seg.ownLane ? 0.78 : 0.4}
                />
              )}
              {seg.bottom && (
                <line
                  x1={sx}
                  y1={50}
                  x2={sx}
                  y2={100}
                  stroke={seg.color}
                  strokeWidth={strokeWidth}
                  opacity={isMuted ? 0.14 : seg.ownLane ? 0.55 : 0.4}
                />
              )}
            </g>
          );
        })}
        {isFork && (
          <path
            d={`M ${laneCx(row.parentLane!)} 0 C ${laneCx(row.parentLane!)} 30, ${cx} 22, ${cx} 50`}
            stroke={branchColor}
            strokeWidth={2}
            fill="none"
            opacity={isMuted ? 0.22 : 0.85}
          />
        )}
      </svg>
      <span
        className={cn(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 rounded-full border-2 bg-[#0f1011] transition",
          isSelected ? "scale-110" : "",
        )}
        style={{
          left: cx - NODE_R,
          width: NODE_R * 2,
          height: NODE_R * 2,
          borderColor: branchColor,
          opacity: isMuted ? 0.45 : 1,
          boxShadow: isMuted
            ? `0 0 0 1px ${branchGlow}`
            : isSelected
              ? `0 0 0 4px ${branchGlow}, 0 0 18px ${branchGlow}`
              : `0 0 0 2px ${branchGlow}, 0 0 10px ${branchGlow}`,
        }}
      />
    </div>
  );
}

export default function ExperimentLineageDemo() {
  const [experiments, setExperiments] = useState(demoExperiments);
  const [selectedId, setSelectedId] = useState("curiosity-resume-t4");
  const [events, setEvents] = useState(seedEvents);
  const [note, setNote] = useState("");
  const [decision, setDecision] = useState<DemoDecision>("keep");
  const [reason, setReason] = useState("");
  const [focusOnly, setFocusOnly] = useState(false);
  const [showFoldedBranches, setShowFoldedBranches] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const selected = experiments.find((e) => e.id === selectedId) ?? experiments[0];
  const parent = selected.parentId ? experiments.find((e) => e.id === selected.parentId) : undefined;
  const forks = experiments.filter((e) => e.parentId === selected.id);
  const childrenByParent = useMemo(() => {
    const map = new Map<string, DemoExperiment[]>();
    for (const exp of experiments) {
      if (!exp.parentId) continue;
      map.set(exp.parentId, [...(map.get(exp.parentId) ?? []), exp]);
    }
    return map;
  }, [experiments]);

  const visibleExperiments = useMemo(() => {
    const base = (() => {
      if (!focusOnly) return experiments;
      const keep = new Set<string>([selected.id]);
      let cursor: DemoExperiment | undefined = selected;
      while (cursor?.parentId) {
        keep.add(cursor.parentId);
        cursor = experiments.find((exp) => exp.id === cursor?.parentId);
      }
      for (const child of childrenByParent.get(selected.id) ?? []) keep.add(child.id);
      if (selected.parentId) {
        for (const sibling of childrenByParent.get(selected.parentId) ?? []) keep.add(sibling.id);
      }
      return experiments.filter((exp) => keep.has(exp.id));
    })();
    if (showFoldedBranches || isFoldedBranch(selected)) return base;
    return base.filter((exp) => !isFoldedBranch(exp));
  }, [childrenByParent, experiments, focusOnly, selected, showFoldedBranches]);

  const foldedBranches = useMemo(
    () => experiments.filter((exp) => isFoldedBranch(exp) && !visibleExperiments.some((visible) => visible.id === exp.id)),
    [experiments, visibleExperiments],
  );

  const timeline = events.filter((e) => e.experimentId === selected.id);

  const { rows, laneCount, laneColor } = useMemo(() => buildLanes(visibleExperiments), [visibleExperiments]);
  const ranges = useMemo(() => computeLaneRanges(rows, laneCount), [rows, laneCount]);

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
    if (exp && isFoldedBranch(exp)) setShowFoldedBranches(true);
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
            <h1 className="text-3xl font-medium tracking-[-0.04em] text-white md:text-4xl">Experiment lineage graph</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-400">
              Commit-graph-style rail for research experiments. Each lane is a live branch tip; forks split, first child inherits the parent lane.
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
                <h2 className="text-sm font-medium text-gray-200">Branch graph</h2>
                <p className="text-xs text-gray-500">{rows.length} runs · {laneCount} live lanes</p>
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
                    {focusOnly ? "Show full family" : "Focus neighborhood"}
                  </button>
                  <button
                    onClick={() => setShowFoldedBranches((value) => !value)}
                    className={cn(
                      "rounded-md border px-3 py-1.5 text-xs transition",
                      showFoldedBranches ? "border-amber-400/25 bg-amber-500/10 text-amber-200" : "border-white/[0.08] bg-white/[0.03] text-gray-400 hover:bg-white/[0.06]",
                    )}
                  >
                    {showFoldedBranches ? "Hide folded" : `${foldedBranches.length} folded`}
                  </button>
                </div>
                <select
                  value={selectedId}
                  onChange={(e) => selectExperiment(e.target.value)}
                  className="w-full min-w-0 max-w-full truncate rounded-md border border-white/[0.08] bg-[#191a1b] px-3 py-1.5 text-xs text-gray-200 outline-none sm:w-60"
                  aria-label="Select experiment"
                >
                  {experiments.map((exp) => (
                    <option key={exp.id} value={exp.id}>{exp.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="p-2 sm:p-3">
              <ul className="divide-y divide-white/[0.05] overflow-hidden rounded-xl border border-white/[0.05] bg-black/15">
                {rows.map((row) => {
                  const { exp } = row;
                  const branch = BRANCH[exp.branch];
                  const isSelected = exp.id === selected.id;
                  const branchForks = childrenByParent.get(exp.id)?.length ?? 0;
                  const changedLabels = summarizeDiff(exp);
                  const parentName = exp.parentId ? experiments.find((node) => node.id === exp.parentId)?.shortName : undefined;
                  const isMuted = isFoldedBranch(exp);

                  return (
                    <li key={exp.id}>
                      <button
                        onClick={() => selectExperiment(exp.id)}
                        aria-pressed={isSelected}
                        aria-label={`Open ${exp.name}`}
                        className={cn(
                          "group flex w-full items-stretch gap-2 px-2 text-left transition duration-150 sm:gap-3 sm:px-3",
                          isSelected ? "bg-indigo-500/[0.09]" : "hover:bg-white/[0.035]",
                          isMuted && !isSelected && "opacity-45 hover:opacity-70",
                        )}
                        style={{ minHeight: 78 }}
                      >
                        <RowGraph
                          row={row}
                          ranges={ranges}
                          laneCount={laneCount}
                          laneColor={laneColor}
                          isSelected={isSelected}
                          isMuted={isMuted && !isSelected}
                        />

                        <div className="min-w-0 flex-1 py-3">
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-medium tracking-[-0.01em] text-gray-100">{exp.shortName}</span>
                            <span className={cn("rounded border px-1.5 py-0.5 text-[10px] uppercase", BADGE[exp.status])}>{exp.status}</span>
                            <span className={cn("rounded-full px-1.5 py-0.5 text-[10px]", branch.bg, branch.text)}>{branch.label}</span>
                            {branchForks > 0 && (
                              <span className="rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-gray-400">
                                {branchForks} fork{branchForks > 1 ? "s" : ""}
                              </span>
                            )}
                            {isMuted && (
                              <span className="rounded border border-white/[0.05] bg-black/20 px-1.5 py-0.5 text-[10px] text-gray-500">folded end</span>
                            )}
                          </div>
                          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
                            {parentName && (
                              <span className="rounded border border-white/[0.05] bg-black/20 px-1.5 py-0.5 font-mono text-[10px] text-gray-500">↳ {parentName}</span>
                            )}
                            {changedLabels.map((label) => (
                              <span key={label} className="rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-gray-400">
                                {label}
                              </span>
                            ))}
                            <span className={cn("rounded border px-1.5 py-0.5 text-[10px] uppercase", BADGE[exp.decision ?? "note"])}>{exp.decision ?? "open"}</span>
                          </div>
                        </div>

                        <div className="hidden shrink-0 items-center justify-end gap-2 py-3 pr-1 sm:flex">
                          <div className="text-right">
                            <div className="font-mono text-xs text-gray-200">zN {exp.metrics.zN}</div>
                            <div className="font-mono text-[10px] text-gray-500">loss {exp.metrics.eval_loss}</div>
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="border-t border-white/[0.06] px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-mono text-xs text-gray-200">{selected.shortName}</span>
                    <span className={cn("rounded border px-1.5 py-0.5 text-[10px] uppercase", BADGE[selected.decision ?? "note"])}>{selected.decision ?? "open"}</span>
                    {diff.slice(0, 3).map((row) => (
                      <span key={row.key} className="rounded border border-white/[0.06] bg-black/20 px-1.5 py-0.5 font-mono text-[10px] text-gray-400">{row.key}</span>
                    ))}
                  </div>
                  <p className="mt-1 truncate text-xs text-gray-500">Tap a node to open details. Compact labels stay on the rail.</p>
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
