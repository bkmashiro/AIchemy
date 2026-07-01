import type {
  ExperimentDiffSummary,
  ExperimentRecommendation,
  ExperimentResearchReportBlock,
  ExperimentResearchReportLeaderEntry,
  ExperimentResearchReportResponse,
} from "../../lib/api";
import { decisionLabelForFilter, formatMetricDelta, recommendationBadgeClass, recommendationLabel } from "./experimentDetailUtils";

export type FamilyCompareDirection = "min" | "max";

const DASH = "—";

export interface FamilyCompareBoardRow {
  id: string;
  experiment: string;
  name: string;
  status: ExperimentResearchReportBlock["status"];
  recommendation: string | null;
  recommendationLabel: string | null;
  recommendationClass: string;
  bestMetric: string;
  bestMetricValue: number | null;
  best: number | null;
  bestLabel: string;
  deltaVsBest: number | null;
  deltaBest: number | null;
  deltaVsBestFormatted: string;
  deltaVsParent: number | null;
  deltaVsBaseline: number | null;
  deltaBaseline: number | null;
  deltaVsParentFormatted: string;
  deltaVsBaselineFormatted: string;
  configDiffCount: number | null;
  configCount: number | null;
  taskCount: number;
  decision: string | null;
  isWinner: boolean;
  isRegression: boolean;
}

export type FamilyCompareDerivedRow = FamilyCompareBoardRow;

export const EMPTY_REPORT: ExperimentResearchReportResponse = {
  filters: { family: null, decision: null, status: null, limit: 50 },
  generated_at: "",
  counts: { total: 0, by_status: {}, by_decision: {} },
  metric: null,
  leaderboard: [],
  experiments: [],
};

type ReportBlockWithExtras = ExperimentResearchReportBlock & {
  recommendation?: ExperimentRecommendation | null;
  diff_summary?: ExperimentDiffSummary | null;
  config_change_count?: number | null;
  config_count?: number | null;
  config_diff_count?: number | null;
  config_diff?: Record<string, unknown> | null;
};

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeDirection(direction: string | null | undefined): FamilyCompareDirection {
  return direction === "max" ? "max" : "min";
}

function trimNumberText(text: string): string {
  return text
    .replace(/(\.\d*?[1-9])0+(e|$)/, "$1$2")
    .replace(/\.0+(e|$)/, "$1")
    .replace(/\.$/, "");
}

export function formatFamilyCompareMetric(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6)) {
    return trimNumberText(value.toExponential(3));
  }
  return trimNumberText(value.toPrecision(6));
}

export function formatFamilyCompareDelta(
  direction: FamilyCompareDirection,
  delta: number | null,
): string {
  if (delta == null) return DASH;
  return formatMetricDelta(delta, direction) ?? DASH;
}

function taskCount(taskCounts: ExperimentResearchReportBlock["task_counts"]): number {
  return Object.values(taskCounts ?? {}).reduce((sum, raw) => {
    const value = toFiniteNumber(raw);
    return value == null ? sum : sum + value;
  }, 0);
}

function configDiffCount(exp: ReportBlockWithExtras): number | null {
  const summary = toFiniteNumber(exp.diff_summary?.config_change_count);
  if (summary != null) return summary;
  const explicit = toFiniteNumber(exp.config_change_count ?? exp.config_count ?? exp.config_diff_count);
  if (explicit != null) return explicit;
  if (exp.config_diff && !Array.isArray(exp.config_diff) && typeof exp.config_diff === "object") {
    return Object.keys(exp.config_diff).length;
  }
  return null;
}

function blockRecommendation(exp: ReportBlockWithExtras): ExperimentRecommendation | null {
  return exp.recommendation ?? null;
}

function sortRowsByRankOrName<T extends { id: string; experiment: string }>(
  rows: T[],
  rankById: Map<string, number>,
): T[] {
  return [...rows].sort((a, b) => {
    const ar = rankById.get(a.id);
    const br = rankById.get(b.id);
    if (ar != null || br != null) {
      if (ar != null && br != null && ar !== br) return ar - br;
      if (ar != null && br == null) return -1;
      if (ar == null && br != null) return 1;
    }
    const byName = a.experiment.localeCompare(b.experiment);
    return byName !== 0 ? byName : a.id.localeCompare(b.id);
  });
}

export function getReportDirection(report: ExperimentResearchReportResponse): FamilyCompareDirection {
  return normalizeDirection(report.metric?.direction);
}

export function getReportWinnerId(leaderboard: ExperimentResearchReportLeaderEntry[]): string | null {
  const winner = leaderboard.find((row) => row.rank === 1) ?? leaderboard[0];
  return winner?.id ?? null;
}

export function getBaselineValue(leaderboard: ExperimentResearchReportLeaderEntry[]): number | null {
  const winner = leaderboard.find((row) => row.rank === 1) ?? leaderboard[0];
  return toFiniteNumber(winner?.value);
}

export function buildFamilyCompareRows(
  report: ExperimentResearchReportResponse,
): FamilyCompareBoardRow[] {
  const direction = getReportDirection(report);
  const metricName = report.metric?.name ?? null;
  const rankById = new Map<string, number>();
  const leaderboardById = new Map<string, ExperimentResearchReportLeaderEntry>();
  for (const row of report.leaderboard ?? []) {
    leaderboardById.set(row.id, row);
    if (Number.isFinite(row.rank)) rankById.set(row.id, row.rank);
  }

  const winnerId = getReportWinnerId(report.leaderboard ?? []);
  const baseline = metricName ? getBaselineValue(report.leaderboard ?? []) : null;

  const rows: FamilyCompareBoardRow[] = report.experiments.map((raw) => {
    const exp = raw as ReportBlockWithExtras;
    const leader = leaderboardById.get(exp.id);
    const leaderValue = metricName && leader?.metric === metricName ? toFiniteNumber(leader.value) : null;
    const primaryValue = metricName && exp.primary_metric?.metric === metricName
      ? toFiniteNumber(exp.primary_metric.best)
      : null;
    const bestMetricValue = leaderValue ?? primaryValue;
    const recommendation = blockRecommendation(exp);
    const recommendationText = recommendationLabel(recommendation) ?? exp.decision ?? null;
    const parentDelta =
      metricName &&
      recommendation?.metric === metricName &&
      normalizeDirection(recommendation.direction) === direction
        ? toFiniteNumber(recommendation.delta)
        : null;
    const bestLabel = formatFamilyCompareMetric(bestMetricValue);
    const deltaBest = bestMetricValue == null || baseline == null ? null : bestMetricValue - baseline;
    const cfg = configDiffCount(exp);

    return {
      id: exp.id,
      experiment: exp.name,
      name: exp.name,
      status: exp.status,
      recommendation: recommendationText,
      recommendationLabel: recommendationText,
      recommendationClass: recommendationBadgeClass(recommendationText),
      bestMetric: bestLabel,
      bestMetricValue,
      best: bestMetricValue,
      bestLabel,
      deltaVsBest: deltaBest,
      deltaBest,
      deltaVsBestFormatted: formatFamilyCompareDelta(direction, deltaBest),
      deltaVsParent: parentDelta,
      deltaVsBaseline: parentDelta,
      deltaBaseline: parentDelta,
      deltaVsParentFormatted: formatFamilyCompareDelta(direction, parentDelta),
      deltaVsBaselineFormatted: formatFamilyCompareDelta(direction, parentDelta),
      configDiffCount: cfg,
      configCount: cfg,
      taskCount: taskCount(exp.task_counts),
      decision: decisionLabelForFilter(exp.decision ?? null) ?? exp.decision,
      isWinner:
        winnerId != null
          ? exp.id === winnerId
          : bestMetricValue != null && baseline != null && bestMetricValue === baseline,
      isRegression:
        bestMetricValue == null || baseline == null
          ? false
          : direction === "min"
            ? bestMetricValue > baseline
            : bestMetricValue < baseline,
    };
  });

  return sortRowsByRankOrName(rows, rankById);
}
