import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useViewport,
  type Edge as FlowEdge,
  type Node as FlowNode,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

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
  {
    id: "curiosity-seed-c",
    name: "jema_v2_curiosity_seed_c",
    shortName: "seed_c",
    status: "passed",
    description: "Third seed on the kept curiosity recipe; used to stress same-stage sibling density.",
    family: "jema_v2/pretrain",
    parentId: "curiosity-resume-t4",
    branch: "curiosity",
    hypothesis: "The kept recipe should survive seed variance without falling below the promotion threshold.",
    expected: "zN >= 0.867 and eval loss remains within 0.02 of resume_t4.",
    forkReason: "Realistic seed fan-out after one promising checkpoint.",
    decision: "keep",
    decisionReason: "Confirms the recipe is not seed-specific.",
    criteria: { zN: ">=0.867", eval_loss: "<=1.79" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.1, stub: "t4-07", seed: 3 },
    metrics: { zN: 0.868, eval_loss: 1.779, step: 42000 },
  },
  {
    id: "curiosity-seed-d",
    name: "jema_v2_curiosity_seed_d",
    shortName: "seed_d",
    status: "partial",
    description: "Lower-performing seed kept visible as a leaf so the rail sorter has to push it right.",
    family: "jema_v2/pretrain",
    parentId: "curiosity-resume-t4",
    branch: "curiosity",
    hypothesis: "A weak seed should still stay above baseline if the recipe is robust.",
    expected: "zN >= 0.860 with no collapse.",
    forkReason: "Seed fan-out for robustness testing.",
    decision: "drop",
    decisionReason: "Below the keep threshold; preserve as evidence but mute it.",
    criteria: { zN: ">=0.867", eval_loss: "<=1.79" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.1, stub: "t4-08", seed: 4 },
    metrics: { zN: 0.861, eval_loss: 1.805, step: 42000 },
  },
  {
    id: "curiosity-seed-e",
    name: "jema_v2_curiosity_seed_e",
    shortName: "seed_e",
    status: "running",
    description: "Late seed still running; should appear as another leaf in the same stage.",
    family: "jema_v2/pretrain",
    parentId: "curiosity-resume-t4",
    branch: "curiosity",
    hypothesis: "More seed pressure should not destroy the graph layout.",
    expected: "zN tracks seed_b/seed_c after 30k steps.",
    forkReason: "Stress-test real seed batches.",
    decision: "rerun",
    decisionReason: "Running; not promoted yet.",
    criteria: { zN: ">=0.867", eval_loss: "<=1.79" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.1, stub: "t4-09", seed: 5 },
    metrics: { zN: 0.866, eval_loss: 1.788, step: 27000 },
  },
  {
    id: "curiosity-wide-lr",
    name: "jema_v2_curiosity_wide_lr_probe",
    shortName: "wide_lr",
    status: "failed",
    description: "Aggressive LR probe that collapsed early; should fold into the background.",
    family: "jema_v2/pretrain",
    parentId: "curiosity-low-lr",
    branch: "curiosity",
    hypothesis: "Maybe the low LR was too conservative.",
    expected: "Faster zN rise without loss explosion.",
    forkReason: "Optimizer sensitivity probe from the first curiosity fork.",
    decision: "drop",
    decisionReason: "Collapsed by step 7k; not useful except as negative evidence.",
    criteria: { zN: ">=0.86", eval_loss: "<=1.80" },
    config: { lr: 0.00026, batch: 48, curiosity: true, dropout: 0.1, stub: "a30-05", seed: 9 },
    metrics: { zN: 0.602, eval_loss: 3.41, step: 7200 },
  },
  {
    id: "dropout-005-seed-b",
    name: "jema_v2_dropout_005_seed_b",
    shortName: "drop005_s2",
    status: "passed",
    description: "Second seed for dropout=0.05; promoted into optimizer tuning.",
    family: "jema_v2/pretrain",
    parentId: "regularize-dropout-005",
    branch: "ablation",
    hypothesis: "Dropout 0.05 should beat the kept recipe consistently.",
    expected: "zN >= 0.878 on two seeds.",
    forkReason: "Validate the regularization candidate before optimizer tuning.",
    decision: "keep",
    decisionReason: "Best regularization variant; continue from here.",
    criteria: { zN: ">=0.878", eval_loss: "<=1.78" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.05, stub: "t4-10", seed: 2 },
    metrics: { zN: 0.881, eval_loss: 1.762, step: 42000 },
  },
  {
    id: "dropout-005-seed-c",
    name: "jema_v2_dropout_005_seed_c",
    shortName: "drop005_s3",
    status: "partial",
    description: "A middling dropout seed; should remain a right-side leaf.",
    family: "jema_v2/pretrain",
    parentId: "regularize-dropout-005",
    branch: "ablation",
    hypothesis: "Dropout 0.05 should stay above resume_t4 even in weaker seeds.",
    expected: "zN >= 0.874.",
    forkReason: "Seed fan-out for regularization sweep.",
    decision: "rerun",
    decisionReason: "Close enough to rerun, not enough to promote.",
    criteria: { zN: ">=0.878", eval_loss: "<=1.78" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.05, stub: "t4-11", seed: 3 },
    metrics: { zN: 0.875, eval_loss: 1.781, step: 36000 },
  },
  {
    id: "dropout-010-seed-b",
    name: "jema_v2_dropout_010_seed_b",
    shortName: "drop010_s2",
    status: "partial",
    description: "Control seed for the original dropout=0.1 recipe.",
    family: "jema_v2/pretrain",
    parentId: "curiosity-resume-t4",
    branch: "ablation",
    hypothesis: "Original dropout may be slightly too conservative but stable.",
    expected: "zN around resume_t4 with lower variance.",
    forkReason: "Control point for the dropout sweep.",
    decision: "drop",
    decisionReason: "Stable but dominated by dropout=0.05.",
    criteria: { zN: ">=0.872", eval_loss: "<=1.78" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.1, stub: "t4-12", seed: 6 },
    metrics: { zN: 0.872, eval_loss: 1.776, step: 42000 },
  },
  {
    id: "no-dropout-seed-b",
    name: "jema_v2_no_dropout_seed_b",
    shortName: "nodrop_s2",
    status: "failed",
    description: "No-dropout seed that diverged; should be folded/muted.",
    family: "jema_v2/pretrain",
    parentId: "ablate-no-dropout",
    branch: "ablation",
    hypothesis: "No dropout might improve zN but risks loss spikes.",
    expected: "No divergence before 30k steps.",
    forkReason: "Validate whether the no-dropout win survives another seed.",
    decision: "drop",
    decisionReason: "Diverged; keep only as negative evidence.",
    criteria: { zN: ">=0.88", eval_loss: "<=1.79" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.0, stub: "t4-13", seed: 2 },
    metrics: { zN: 0.744, eval_loss: 2.31, step: 17000 },
  },
  {
    id: "adamw-decay-001",
    name: "jema_v2_adamw_decay_001",
    shortName: "wd_001",
    status: "passed",
    description: "Optimizer branch from the promoted dropout=0.05 seed.",
    family: "jema_v2/pretrain",
    parentId: "dropout-005-seed-b",
    branch: "ablation",
    hypothesis: "A little weight decay improves representation smoothness without hurting zN.",
    expected: "zN >= 0.884 and eval loss <= 1.75.",
    forkReason: "Regularization sweep found dropout=0.05; now tune optimizer regularization.",
    decision: "keep",
    decisionReason: "Promote into eval stress tests.",
    criteria: { zN: ">=0.884", eval_loss: "<=1.75" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.05, weight_decay: 0.01, stub: "t4-14" },
    metrics: { zN: 0.886, eval_loss: 1.742, step: 42000 },
  },
  {
    id: "adamw-decay-003",
    name: "jema_v2_adamw_decay_003",
    shortName: "wd_003",
    status: "partial",
    description: "Higher weight decay branch; likely too conservative.",
    family: "jema_v2/pretrain",
    parentId: "dropout-005-seed-b",
    branch: "ablation",
    hypothesis: "More decay may improve loss at some zN cost.",
    expected: "eval loss improves without zN dropping below 0.878.",
    forkReason: "Optimizer sweep sibling.",
    decision: "drop",
    decisionReason: "Loss improved but zN fell too much.",
    criteria: { zN: ">=0.878", eval_loss: "<=1.74" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.05, weight_decay: 0.03, stub: "t4-15" },
    metrics: { zN: 0.876, eval_loss: 1.735, step: 42000 },
  },
  {
    id: "adamw-beta2-095",
    name: "jema_v2_adamw_beta2_095",
    shortName: "beta2_095",
    status: "running",
    description: "Momentum branch that should stay as a visible non-promoted sibling.",
    family: "jema_v2/pretrain",
    parentId: "dropout-005-seed-b",
    branch: "ablation",
    hypothesis: "Lower beta2 reacts faster after curiosity spikes.",
    expected: "Faster recovery after spike without worse eval loss.",
    forkReason: "Optimizer sweep sibling.",
    decision: "rerun",
    decisionReason: "Still running; possible backup branch.",
    criteria: { zN: ">=0.884", eval_loss: "<=1.75" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.05, beta2: 0.95, stub: "t4-16" },
    metrics: { zN: 0.883, eval_loss: 1.751, step: 30000 },
  },
  {
    id: "eval-hard-seed-1",
    name: "jema_v2_eval_hard_seed_1",
    shortName: "eval_hard_s1",
    status: "passed",
    description: "Hard-eval seed on the promoted optimizer branch.",
    family: "jema_v2/eval",
    parentId: "adamw-decay-001",
    branch: "resume",
    hypothesis: "The promoted branch should hold up on harder eval seeds.",
    expected: "zN >= 0.882 on hard eval.",
    forkReason: "Final stress test before default promotion.",
    decision: "keep",
    decisionReason: "Hard eval passed.",
    criteria: { zN: ">=0.882", eval_loss: "<=1.76" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.05, weight_decay: 0.01, eval_seed: 1, stub: "t4-17" },
    metrics: { zN: 0.884, eval_loss: 1.752, step: 42000 },
  },
  {
    id: "eval-hard-seed-2",
    name: "jema_v2_eval_hard_seed_2",
    shortName: "eval_hard_s2",
    status: "partial",
    description: "Second hard-eval seed; intentionally a leaf.",
    family: "jema_v2/eval",
    parentId: "adamw-decay-001",
    branch: "resume",
    hypothesis: "Hard eval should not be seed-specific.",
    expected: "zN >= 0.882 on hard eval.",
    forkReason: "Hard-eval seed fan-out.",
    decision: "rerun",
    decisionReason: "Close but wants one more checkpoint.",
    criteria: { zN: ">=0.882", eval_loss: "<=1.76" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.05, weight_decay: 0.01, eval_seed: 2, stub: "t4-18" },
    metrics: { zN: 0.881, eval_loss: 1.759, step: 42000 },
  },
  {
    id: "eval-hard-seed-3",
    name: "jema_v2_eval_hard_seed_3",
    shortName: "eval_hard_s3",
    status: "failed",
    description: "Hard-eval seed that hit an infra failure; folded by default.",
    family: "jema_v2/eval",
    parentId: "adamw-decay-001",
    branch: "resume",
    hypothesis: "Infra failures should not dominate the lineage view.",
    expected: "Visible only when folded branches are expanded.",
    forkReason: "Hard-eval seed fan-out.",
    decision: "drop",
    decisionReason: "Worker died; rerun later if needed.",
    criteria: { zN: ">=0.882", eval_loss: "<=1.76" },
    config: { lr: 0.00018, batch: 48, curiosity: true, dropout: 0.05, weight_decay: 0.01, eval_seed: 3, stub: "t4-19" },
    metrics: { zN: 0.0, eval_loss: 9.99, step: 600 },
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
    id: "batch-stage",
    title: "Batch-size exploration",
    purpose: "Folded after OOM and the narrower retry under-performed the curiosity branch.",
    parentStageId: "baseline-stage",
    parentRunId: "baseline",
    runIds: ["curiosity-higher-batch", "batch-64-retry"],
    folded: true,
    state: "folded",
  },
  {
    id: "curiosity-stage",
    title: "Curiosity objective",
    purpose: "Find an LR + resume recipe where curiosity beats baseline without collapse.",
    parentStageId: "baseline-stage",
    parentRunId: "baseline",
    promotedRunId: "curiosity-resume-t4",
    runIds: ["curiosity-low-lr", "curiosity-resume-t4", "curiosity-seed-b", "curiosity-seed-c", "curiosity-seed-e", "curiosity-wide-lr", "curiosity-seed-d"],
    state: "decided",
  },
  {
    id: "regularization-stage",
    title: "Regularization sweep",
    purpose: "Tune dropout from the kept resume checkpoint.",
    parentStageId: "curiosity-stage",
    parentRunId: "curiosity-resume-t4",
    runIds: ["regularize-dropout-005", "dropout-005-seed-b", "ablate-no-dropout", "dropout-005-seed-c", "dropout-010-seed-b", "no-dropout-seed-b"],
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
    id: "optimizer-stage",
    title: "Optimizer sweep",
    purpose: "Fan out from the promoted dropout seed to test weight decay and momentum under realistic branch pressure.",
    parentStageId: "regularization-stage",
    parentRunId: "dropout-005-seed-b",
    promotedRunId: "adamw-decay-001",
    runIds: ["adamw-decay-001", "adamw-beta2-095", "adamw-decay-003"],
    state: "decided",
  },
  {
    id: "hard-eval-stage",
    title: "Hard eval seed stress",
    purpose: "Final hard-eval fan-out from the promoted optimizer run; includes normal leaves and folded infra failure.",
    parentStageId: "optimizer-stage",
    parentRunId: "adamw-decay-001",
    promotedRunId: "eval-hard-seed-1",
    runIds: ["eval-hard-seed-1", "eval-hard-seed-2", "eval-hard-seed-3"],
    state: "active",
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

// Graph canvas: stages are horizontal swimlane bands. Topology is the only
// thing rendered in the graph: GitLens-style small dots and rail edges. Run
// details live outside the graph and open on dot click.
const CANVAS_W = 1180;
const BAND_H = 116;
const BAND_GAP = 28;
const DOT_R = 6;
const STAGE_LABEL_W = 184;
const RAIL_START_X = 50;
const RUN_GAP_X = 58;
const CANVAS_PAD_Y = 10;

function isFoldedRun(exp: DemoExperiment) {
  return exp.status === "failed" || exp.decision === "drop";
}

function sortRunsForRail(
  runs: DemoExperiment[],
  stage: DemoStage,
  directChildRuns: Map<string, number>,
  childStages: Map<string, number>,
) {
  const originalIndex = new Map(stage.runIds.map((id, index) => [id, index]));
  return [...runs].sort((a, b) => {
    const score = (exp: DemoExperiment) => {
      const childStageCount = childStages.get(exp.id) ?? 0;
      const childRunCount = directChildRuns.get(exp.id) ?? 0;
      const hasChildren = childStageCount + childRunCount > 0;
      const noChildrenPenalty = hasChildren ? 0 : 100;
      const promotedBonus = exp.id === stage.promotedRunId ? -100 : 0;
      const childStageBonus = childStageCount * -18;
      const childRunBonus = childRunCount * -8;
      const statusPenalty = isFoldedRun(exp) ? 40 : 0;
      return promotedBonus + childStageBonus + childRunBonus + noChildrenPenalty + statusPenalty;
    };
    return score(a) - score(b) || (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0);
  });
}

function getBandY(bandIndex: number) {
  return CANVAS_PAD_Y + bandIndex * (BAND_H + BAND_GAP);
}
function getDotY(bandIndex: number) {
  return getBandY(bandIndex) + BAND_H / 2;
}
function getDotX(runIndex: number) {
  return RAIL_START_X + runIndex * RUN_GAP_X;
}

type CanvasRunNode = {
  id: string;
  exp: DemoExperiment;
  stageId: string;
  bandIndex: number;
  runIndex: number;
  dotX: number;
  dotY: number;
  muted: boolean;
  selected: boolean;
};

type CanvasStageBand = {
  id: string;
  stage: DemoStage;
  bandIndex: number;
  y: number;
  height: number;
  folded: boolean;
  selected: boolean;
  visibleRunIds: string[];
  hiddenFoldedCount: number;
};

type CanvasEdge = {
  id: string;
  fromRunId: string;
  toStageId: string;
  toRunId?: string;
  muted: boolean;
  emphasized: boolean;
  siblingIndex: number;
  siblingCount: number;
};

function buildCanvasGraph(
  visibleStages: DemoStage[],
  visibleRunsByStage: Map<string, DemoExperiment[]>,
  selectedRunId: string,
  selectedStageId: string | undefined,
  hiddenFoldedCountByStage: Map<string, number>,
): { bands: CanvasStageBand[]; nodes: CanvasRunNode[]; edges: CanvasEdge[] } {
  const bands: CanvasStageBand[] = visibleStages.map((stage, idx) => ({
    id: stage.id,
    stage,
    bandIndex: idx,
    y: getBandY(idx),
    height: BAND_H,
    folded: !!stage.folded,
    selected: stage.id === selectedStageId,
    visibleRunIds: (visibleRunsByStage.get(stage.id) ?? []).map((r) => r.id),
    hiddenFoldedCount: hiddenFoldedCountByStage.get(stage.id) ?? 0,
  }));

  const nodes: CanvasRunNode[] = [];
  for (const band of bands) {
    const runs = visibleRunsByStage.get(band.id) ?? [];
    runs.forEach((exp, runIndex) => {
      nodes.push({
        id: exp.id,
        exp,
        stageId: band.id,
        bandIndex: band.bandIndex,
        runIndex,
        dotX: getDotX(runIndex),
        dotY: getDotY(band.bandIndex),
        muted: band.folded || isFoldedRun(exp),
        selected: exp.id === selectedRunId,
      });
    });
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const bandById = new Map(bands.map((b) => [b.id, b]));

  type Pending = { stage: DemoStage; parentStage: DemoStage; sourceRunId: string; targetRunId?: string };
  const pending: Pending[] = [];
  for (const band of bands) {
    const stage = band.stage;
    if (!stage.parentStageId || !stage.parentRunId) continue;
    const parentBand = bandById.get(stage.parentStageId);
    if (!parentBand) continue;
    if (!nodeById.has(stage.parentRunId)) continue;
    pending.push({
      stage,
      parentStage: parentBand.stage,
      sourceRunId: stage.parentRunId,
      targetRunId: band.visibleRunIds[0],
    });
  }

  for (const node of nodes) {
    if (!node.exp.parentId) continue;
    const parentNode = nodeById.get(node.exp.parentId);
    if (!parentNode || parentNode.stageId !== node.stageId) continue;
    const band = bandById.get(node.stageId);
    if (!band) continue;
    pending.push({
      stage: band.stage,
      parentStage: band.stage,
      sourceRunId: parentNode.id,
      targetRunId: node.id,
    });
  }

  const groupCounts = new Map<string, number>();
  for (const p of pending) {
    groupCounts.set(p.sourceRunId, (groupCounts.get(p.sourceRunId) ?? 0) + 1);
  }
  const groupSeen = new Map<string, number>();

  const edges: CanvasEdge[] = pending.map((p) => {
    const siblingIndex = groupSeen.get(p.sourceRunId) ?? 0;
    groupSeen.set(p.sourceRunId, siblingIndex + 1);
    const siblingCount = groupCounts.get(p.sourceRunId) ?? 1;
    const muted = !!p.stage.folded || !!p.parentStage.folded;
    const emphasized = p.parentStage.promotedRunId === p.sourceRunId || p.stage.promotedRunId === p.targetRunId;
    return {
      id: `${p.sourceRunId}->${p.targetRunId ?? p.stage.id}`,
      fromRunId: p.sourceRunId,
      toStageId: p.stage.id,
      toRunId: p.targetRunId,
      muted,
      emphasized,
      siblingIndex,
      siblingCount,
    };
  });

  return { bands, nodes, edges };
}

const DOT_NODE_SIZE = 24;
const BAND_NODE_W = CANVAS_W - 16;
const FLOW_PAD = 32;

const HANDLE_STYLE: CSSProperties = {
  width: 1,
  height: 1,
  minWidth: 1,
  minHeight: 1,
  opacity: 0,
  background: "transparent",
  border: "none",
  pointerEvents: "none",
};

type DotNodeData = {
  node: CanvasRunNode;
  selected: boolean;
  onSelect: (id: string) => void;
};

type DotFlowNode = FlowNode<DotNodeData, "dot">;

function DotNode({ data }: NodeProps<DotFlowNode>) {
  const { node, selected, onSelect } = data;
  const branch = BRANCH[node.exp.branch];
  return (
    <div
      className={cn(
        "grid h-full w-full place-items-center rounded-full transition",
        selected ? "bg-white/[0.06]" : "hover:bg-white/[0.045]",
        node.muted && !selected && "opacity-45 hover:opacity-80",
      )}
    >
      <Handle id="top" type="target" position={Position.Top} style={HANDLE_STYLE} isConnectable={false} />
      <Handle id="left" type="target" position={Position.Left} style={HANDLE_STYLE} isConnectable={false} />
      <Handle id="bottom" type="source" position={Position.Bottom} style={HANDLE_STYLE} isConnectable={false} />
      <Handle id="right" type="source" position={Position.Right} style={HANDLE_STYLE} isConnectable={false} />
      <button
        type="button"
        onClick={() => onSelect(node.id)}
        aria-pressed={selected}
        aria-label={`Open ${node.exp.name} graph dot`}
        title={`${node.exp.shortName} · zN ${node.exp.metrics.zN} · ${node.exp.status}`}
        className="grid h-full w-full cursor-pointer place-items-center rounded-full bg-transparent"
      >
        <span
          className={cn(
            "block rounded-full border",
            selected ? "border-white/85" : "border-black/40",
          )}
          style={{
            width: DOT_R * 2,
            height: DOT_R * 2,
            backgroundColor: branch.color,
            boxShadow: selected
              ? `0 0 0 5px ${branch.glow}, 0 0 18px ${branch.color}`
              : `0 0 10px ${branch.glow}`,
          }}
        />
      </button>
    </div>
  );
}

const nodeTypes = { dot: DotNode };

function BandsLayer({
  bands,
  expById,
  totalH,
}: {
  bands: CanvasStageBand[];
  expById: Map<string, DemoExperiment>;
  totalH: number;
}) {
  const { x, y, zoom } = useViewport();
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        style={{
          transform: `translate(${x}px, ${y}px) scale(${zoom})`,
          transformOrigin: "0 0",
          position: "absolute",
          top: 0,
          left: 0,
          width: CANVAS_W,
          height: totalH,
        }}
      >
        {bands.map((band) => {
          const promotedRun = band.stage.promotedRunId ? expById.get(band.stage.promotedRunId) : undefined;
          const parentRun = band.stage.parentRunId ? expById.get(band.stage.parentRunId) : undefined;
          const state = band.stage.state ?? "active";
          const visibleCount = band.visibleRunIds.length;
          const railY = BAND_H / 2;
          const railX1 = visibleCount > 0 ? getDotX(0) - 18 - 8 : 0;
          const railX2 = visibleCount > 0 ? getDotX(visibleCount - 1) + 18 - 8 : 0;
          return (
            <div
              key={band.id}
              className={cn(
                "absolute rounded-2xl border",
                band.folded ? "border-dashed border-white/[0.05] bg-white/[0.012]" : "border-white/[0.06] bg-white/[0.02]",
                band.selected && "ring-1 ring-indigo-400/25",
              )}
              style={{ left: 8, top: band.y, width: BAND_NODE_W, height: band.height }}
            >
              <div
                className="absolute top-0 flex h-full flex-col gap-1.5 overflow-hidden px-3 py-3"
                style={{ left: STAGE_LABEL_W, width: BAND_NODE_W - STAGE_LABEL_W - 12 }}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <h3 className={cn("min-w-0 truncate text-xs font-semibold tracking-[-0.01em]", band.folded ? "text-gray-400" : "text-gray-100")}>{band.stage.title}</h3>
                  <span className={cn("rounded border px-1 py-px text-[9px] uppercase leading-none", STAGE_STATE_BADGE[state])}>{state}</span>
                </div>
                <p className="line-clamp-3 text-[10px] leading-snug text-gray-500">{band.stage.purpose}</p>
                <div className="mt-auto flex flex-wrap items-center gap-1 text-[10px] text-gray-500">
                  <span className="rounded border border-white/[0.05] bg-black/20 px-1.5 py-px">
                    {band.stage.runIds.length} run{band.stage.runIds.length > 1 ? "s" : ""}
                  </span>
                  {promotedRun && (
                    <span className="max-w-[140px] truncate rounded-full border border-emerald-400/25 bg-emerald-500/10 px-1.5 py-px text-emerald-200">
                      ↑ {promotedRun.shortName}
                    </span>
                  )}
                  {parentRun && (
                    <span className="max-w-[140px] truncate rounded border border-white/[0.05] bg-black/20 px-1.5 py-px font-mono text-gray-500">
                      ↳ {parentRun.shortName}
                    </span>
                  )}
                  {band.hiddenFoldedCount > 0 && (
                    <span className="rounded border border-amber-400/25 bg-amber-500/10 px-1.5 py-px text-amber-200">
                      +{band.hiddenFoldedCount} folded
                    </span>
                  )}
                </div>
              </div>
              {visibleCount > 0 && (
                <svg
                  className="pointer-events-none absolute inset-0"
                  width={BAND_NODE_W}
                  height={band.height}
                  aria-hidden
                >
                  <line
                    x1={railX1}
                    y1={railY}
                    x2={railX2}
                    y2={railY}
                    stroke="#27272a"
                    strokeWidth={1.4}
                    strokeLinecap="round"
                    opacity={band.folded ? 0.35 : 0.62}
                  />
                </svg>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function buildFlow(
  bands: CanvasStageBand[],
  nodes: CanvasRunNode[],
  edges: CanvasEdge[],
  selectedRunId: string,
  onSelectRun: (id: string) => void,
): { flowNodes: DotFlowNode[]; flowEdges: FlowEdge[] } {
  const bandById = new Map(bands.map((b) => [b.id, b]));
  const flowNodes: DotFlowNode[] = nodes.map((n) => ({
    id: n.id,
    type: "dot",
    position: { x: n.dotX - DOT_NODE_SIZE / 2, y: n.dotY - DOT_NODE_SIZE / 2 },
    data: { node: n, selected: n.id === selectedRunId, onSelect: onSelectRun },
    width: DOT_NODE_SIZE,
    height: DOT_NODE_SIZE,
    draggable: false,
    selectable: false,
    connectable: false,
    deletable: false,
  }));

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const flowEdges: FlowEdge[] = edges.flatMap((edge) => {
    const source = nodeById.get(edge.fromRunId);
    if (!source) return [];
    const targetBand = bandById.get(edge.toStageId);
    if (!targetBand) return [];
    const targetRun = edge.toRunId ? nodeById.get(edge.toRunId) : undefined;
    if (!targetRun) return [];
    const sameBand = source.stageId === targetRun.stageId;
    const isSelectedEdge = edge.fromRunId === selectedRunId || edge.toRunId === selectedRunId;
    const stroke = edge.emphasized ? "#7c7cff" : isSelectedEdge ? "#a5b4fc" : "#3f3f46";
    const strokeWidth = edge.emphasized ? 2.5 : isSelectedEdge ? 2.25 : 1.75;
    const opacity = edge.muted ? 0.35 : edge.emphasized ? 0.95 : isSelectedEdge ? 0.95 : 0.72;
    return [
      {
        id: edge.id,
        source: edge.fromRunId,
        target: targetRun.id,
        sourceHandle: sameBand ? "right" : "bottom",
        targetHandle: sameBand ? "left" : "top",
        type: sameBand ? "straight" : "smoothstep",
        pathOptions: sameBand ? undefined : { borderRadius: 6 },
        style: {
          stroke,
          strokeWidth,
          opacity,
          strokeDasharray: edge.muted ? "5 4" : undefined,
        },
      } as FlowEdge,
    ];
  });

  return { flowNodes, flowEdges };
}

function LineageFlow({
  bands,
  nodes,
  edges,
  selectedRunId,
  expById,
  onSelectRun,
}: {
  bands: CanvasStageBand[];
  nodes: CanvasRunNode[];
  edges: CanvasEdge[];
  selectedRunId: string;
  expById: Map<string, DemoExperiment>;
  onSelectRun: (id: string) => void;
}) {
  const totalH = bands.length === 0
    ? 200
    : bands[bands.length - 1].y + BAND_H + CANVAS_PAD_Y;

  const { flowNodes, flowEdges } = useMemo(
    () => buildFlow(bands, nodes, edges, selectedRunId, onSelectRun),
    [bands, nodes, edges, selectedRunId, onSelectRun],
  );

  return (
    <ReactFlowProvider>
      <div
        className="relative w-full bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.045)_1px,transparent_0)] [background-size:20px_20px]"
        style={{ width: "100%", height: Math.max(totalH + FLOW_PAD * 2, 360) }}
      >
        <BandsLayer bands={bands} expById={expById} totalH={totalH} />
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          colorMode="dark"
          style={{ background: "transparent" }}
          defaultViewport={{ x: -24, y: FLOW_PAD, zoom: 1 }}
          minZoom={0.25}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          panOnScroll
          zoomOnPinch
          panOnDrag
          selectNodesOnDrag={false}
          translateExtent={[
            [-CANVAS_W * 0.5, -totalH * 0.5],
            [CANVAS_W * 1.5, totalH * 1.5],
          ]}
        >
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </ReactFlowProvider>
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
    const directChildRuns = new Map<string, number>();
    for (const exp of experiments) {
      if (!exp.parentId) continue;
      directChildRuns.set(exp.parentId, (directChildRuns.get(exp.parentId) ?? 0) + 1);
    }
    const childStages = new Map<string, number>();
    for (const stage of stages) {
      if (!stage.parentRunId) continue;
      childStages.set(stage.parentRunId, (childStages.get(stage.parentRunId) ?? 0) + 1);
    }

    const map = new Map<string, { normal: DemoExperiment[]; folded: DemoExperiment[] }>();
    for (const stage of stages) {
      const stageRuns = stage.runIds
        .map((id) => expById.get(id))
        .filter((exp): exp is DemoExperiment => !!exp);
      const orderedRuns = sortRunsForRail(stageRuns, stage, directChildRuns, childStages);
      const normal: DemoExperiment[] = [];
      const folded: DemoExperiment[] = [];
      for (const exp of orderedRuns) {
        if (isFoldedRun(exp)) folded.push(exp);
        else normal.push(exp);
      }
      map.set(stage.id, { normal, folded });
    }
    return map;
  }, [stages, expById, experiments]);

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

  const stageStateCounts = useMemo(() => {
    let active = 0;
    let decided = 0;
    for (const s of visibleStages) {
      if (s.folded) continue;
      if (s.state === "decided") decided++;
      else active++;
    }
    return { active, decided };
  }, [visibleStages]);

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

  const hiddenFoldedCountByStage = useMemo(() => {
    const map = new Map<string, number>();
    for (const stage of visibleStages) {
      const buckets = runsByStage.get(stage.id) ?? { normal: [], folded: [] };
      const selectedFoldedRun = buckets.folded.find((exp) => exp.id === selected.id);
      const hidden = showFoldedBranches
        ? 0
        : Math.max(0, buckets.folded.length - (selectedFoldedRun ? 1 : 0));
      map.set(stage.id, hidden);
    }
    return map;
  }, [visibleStages, runsByStage, showFoldedBranches, selected.id]);

  const { bands, nodes, edges } = useMemo(
    () => buildCanvasGraph(visibleStages, visibleRunsByStage, selected.id, selectedStage?.id, hiddenFoldedCountByStage),
    [visibleStages, visibleRunsByStage, selected.id, selectedStage?.id, hiddenFoldedCountByStage],
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
              <div className="min-w-0">
                <h2 className="text-sm font-medium text-gray-200">Stage graph</h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <span className="rounded border border-blue-400/20 bg-blue-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-blue-300">
                    {stageStateCounts.active} active
                  </span>
                  <span className="rounded border border-emerald-400/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-300">
                    {stageStateCounts.decided} decided
                  </span>
                  <span className="rounded border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-300">
                    {visibleRunsCount} run{visibleRunsCount === 1 ? "" : "s"}
                  </span>
                  {foldedCount > 0 && (
                    <span className="rounded border border-amber-400/25 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-200">
                      {foldedCount} folded
                    </span>
                  )}
                </div>
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

            <div className="flex items-center gap-x-4 gap-y-1.5 overflow-x-auto border-b border-white/[0.06] bg-white/[0.012] px-4 py-2 text-[10.5px] text-gray-500">
              <span className="flex shrink-0 items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: "#7c7cff", boxShadow: "0 0 8px rgba(124,124,255,0.6)" }}
                  aria-hidden
                />
                <span><span className="text-gray-300">dot</span> = run</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <span className="inline-block h-2.5 w-5 rounded-sm border border-white/15 bg-white/[0.04]" aria-hidden />
                <span><span className="text-gray-300">band</span> = stage</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <svg width="22" height="6" viewBox="0 0 22 6" aria-hidden>
                  <line x1="0" y1="3" x2="22" y2="3" stroke="#7c7cff" strokeWidth="2" />
                </svg>
                <span><span className="text-indigo-300">solid</span> = promoted / continued</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <svg width="22" height="6" viewBox="0 0 22 6" aria-hidden>
                  <line x1="0" y1="3" x2="22" y2="3" stroke="#6b7280" strokeWidth="1.5" strokeDasharray="3 3" />
                </svg>
                <span><span className="text-gray-400">dashed</span> = folded / dropped</span>
              </span>
              <span className="ml-auto shrink-0 hidden text-gray-600 sm:inline">tap a dot to inspect</span>
            </div>

            <div className="p-2 sm:p-3">
              <div className="rounded-xl border border-white/[0.05] bg-black/15">
                <LineageFlow
                  bands={bands}
                  nodes={nodes}
                  edges={edges}
                  selectedRunId={selected.id}
                  expById={expById}
                  onSelectRun={selectExperiment}
                />
              </div>
            </div>
            <div className="border-t border-white/[0.06] px-3 py-2 sm:px-4 sm:py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2 font-mono text-[11px]">
                <span className="flex shrink-0 items-center gap-1.5">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: BRANCH[selected.branch].color, boxShadow: `0 0 10px ${BRANCH[selected.branch].glow}` }}
                    aria-hidden
                  />
                  <span className="truncate text-gray-100">{selected.shortName}</span>
                </span>
                {selectedStage && (
                  <span className="hidden truncate text-[11px] text-gray-500 sm:inline">
                    in <span className="text-gray-300">{selectedStage.title}</span>
                  </span>
                )}
                <span className={cn("rounded border px-1.5 py-0.5 text-[10px] uppercase leading-none", BADGE[selected.status])}>{selected.status}</span>
                <span className={cn("rounded border px-1.5 py-0.5 text-[10px] uppercase leading-none", BADGE[selected.decision ?? "note"])}>{selected.decision ?? "open"}</span>
                {Object.entries(selected.metrics).slice(0, 2).map(([key, value]) => (
                  <span key={key} className="flex items-center gap-1 text-gray-500">
                    <span className="text-gray-500">{key}</span>
                    <span className="text-gray-200">{value}</span>
                  </span>
                ))}
                {parent && (
                  <button
                    type="button"
                    onClick={() => selectExperiment(parent.id)}
                    className="text-indigo-300 transition hover:text-indigo-200"
                    title={`Parent: ${parent.name}`}
                  >
                    ↳ {parent.shortName}
                  </button>
                )}
                {forks.length > 0 && (
                  <span className="text-gray-500">
                    <span className="text-gray-200">{forks.length}</span> fork{forks.length === 1 ? "" : "s"}
                  </span>
                )}
                {diff.length > 0 && (
                  <span className="flex items-center gap-1 text-gray-500">
                    <span>changed</span>
                    {diff.slice(0, 4).map((row) => (
                      <span key={row.key} className="rounded border border-white/[0.06] bg-black/30 px-1 py-px text-[10px] text-gray-300">{row.key}</span>
                    ))}
                    {diff.length > 4 && <span className="text-gray-600">+{diff.length - 4}</span>}
                  </span>
                )}
                <button
                  onClick={() => setDetailsOpen((open) => !open)}
                  className="ml-auto shrink-0 rounded-md border border-indigo-400/25 bg-indigo-500/15 px-3 py-1.5 font-sans text-xs text-indigo-200 transition hover:bg-indigo-500/25"
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
