/**
 * criteria.ts — Parse and evaluate experiment success criteria.
 *
 * Supported formats:
 *   "> 0.3"           -> value > 0.3
 *   "< 0.5"           -> value < 0.5
 *   ">= 0.3"          -> value >= 0.3
 *   "<= 0.5"          -> value <= 0.5
 *   ">= 0.3 && < 0.8" -> 0.3 <= value < 0.8
 */

import { CriterionResult } from "./types";

interface Comparison {
  op: ">" | "<" | ">=" | "<=";
  value: number;
}

const OP_REGEX = /^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/;

function parseComparison(expr: string): Comparison {
  const m = expr.trim().match(OP_REGEX);
  if (!m) throw new Error(`Invalid criterion expression: "${expr}"`);
  return { op: m[1] as Comparison["op"], value: parseFloat(m[2]) };
}

function evalComparison(comp: Comparison, value: number): boolean {
  switch (comp.op) {
    case ">":  return value > comp.value;
    case "<":  return value < comp.value;
    case ">=": return value >= comp.value;
    case "<=": return value <= comp.value;
  }
}

/**
 * Parse a criterion expression string into a predicate function.
 * Supports single comparisons and range expressions joined by &&.
 */
export function parseCriterion(expr: string): (value: number) => boolean {
  const parts = expr.split("&&").map((s) => s.trim());
  const comparisons = parts.map(parseComparison);
  return (value: number) => comparisons.every((comp) => evalComparison(comp, value));
}

/**
 * Evaluate all criteria against provided metrics.
 *
 * - If a metric key is absent from metrics, the criterion is marked pending (ok=false)
 *   but does not cause overall failure — it simply prevents `passed` from being true.
 * - Overall `passed` = all criteria present AND all pass.
 */
export function evaluateCriteria(
  criteria: Record<string, string>,
  metrics: Record<string, number>,
): { passed: boolean; pending: boolean; details: Record<string, CriterionResult> } {
  const details: Record<string, CriterionResult> = {};
  let allPresent = true;
  let allOk = true;

  for (const [metric, expr] of Object.entries(criteria)) {
    if (!(metric in metrics)) {
      // Metric not yet reported — pending, not failed
      allPresent = false;
      continue;
    }
    const value = metrics[metric];
    const predicate = parseCriterion(expr);
    const ok = predicate(value);
    details[metric] = { value, threshold: expr, ok };
    if (!ok) allOk = false;
  }

  return {
    passed: allPresent && allOk,
    pending: !allPresent,
    details,
  };
}
