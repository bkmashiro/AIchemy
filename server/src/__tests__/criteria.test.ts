import { describe, it, expect } from "vitest";
import { parseCriterion, evaluateCriteria } from "../criteria";

describe("parseCriterion", () => {
  it("parses > comparison", () => {
    const fn = parseCriterion("> 0.3");
    expect(fn(0.5)).toBe(true);
    expect(fn(0.3)).toBe(false);
    expect(fn(0.1)).toBe(false);
  });

  it("parses < comparison", () => {
    const fn = parseCriterion("< 0.5");
    expect(fn(0.3)).toBe(true);
    expect(fn(0.5)).toBe(false);
    expect(fn(0.8)).toBe(false);
  });

  it("parses >= comparison", () => {
    const fn = parseCriterion(">= 0.3");
    expect(fn(0.3)).toBe(true);
    expect(fn(0.5)).toBe(true);
    expect(fn(0.29)).toBe(false);
  });

  it("parses <= comparison", () => {
    const fn = parseCriterion("<= 0.5");
    expect(fn(0.5)).toBe(true);
    expect(fn(0.3)).toBe(true);
    expect(fn(0.51)).toBe(false);
  });

  it("parses range expression (>= 0.3 && < 0.8)", () => {
    const fn = parseCriterion(">= 0.3 && < 0.8");
    expect(fn(0.3)).toBe(true);
    expect(fn(0.5)).toBe(true);
    expect(fn(0.79)).toBe(true);
    expect(fn(0.8)).toBe(false);
    expect(fn(0.29)).toBe(false);
  });

  it("handles negative numbers", () => {
    const fn = parseCriterion("> -0.5");
    expect(fn(0)).toBe(true);
    expect(fn(-0.5)).toBe(false);
    expect(fn(-1)).toBe(false);
  });

  it("handles zero", () => {
    const fn = parseCriterion("> 0");
    expect(fn(0.001)).toBe(true);
    expect(fn(0)).toBe(false);
    expect(fn(-0.001)).toBe(false);
  });

  it("exact boundary values", () => {
    const fn = parseCriterion(">= 0.3");
    expect(fn(0.3)).toBe(true);
    expect(fn(0.2999999)).toBe(false);
  });

  it("throws on invalid expression", () => {
    expect(() => parseCriterion("foo")).toThrow();
    expect(() => parseCriterion("== 0.3")).toThrow();
    expect(() => parseCriterion("")).toThrow();
  });
});

describe("evaluateCriteria", () => {
  it("all pass", () => {
    const result = evaluateCriteria(
      { silhouette: "> 0.3", nmi: "> 0.1" },
      { silhouette: 0.5, nmi: 0.4 },
    );
    expect(result.passed).toBe(true);
    expect(result.pending).toBe(false);
    expect(result.details.silhouette.ok).toBe(true);
    expect(result.details.nmi.ok).toBe(true);
  });

  it("some fail", () => {
    const result = evaluateCriteria(
      { silhouette: "> 0.3", nmi: "> 0.5" },
      { silhouette: 0.5, nmi: 0.2 },
    );
    expect(result.passed).toBe(false);
    expect(result.pending).toBe(false);
    expect(result.details.silhouette.ok).toBe(true);
    expect(result.details.nmi.ok).toBe(false);
    expect(result.details.nmi.value).toBe(0.2);
  });

  it("missing metric is pending, not failed", () => {
    const result = evaluateCriteria(
      { silhouette: "> 0.3", nmi: "> 0.1" },
      { silhouette: 0.5 },
    );
    // Not passed because nmi is missing
    expect(result.passed).toBe(false);
    expect(result.pending).toBe(true);
    // silhouette was checked and passed
    expect(result.details.silhouette.ok).toBe(true);
    // nmi not in details (missing = pending)
    expect(result.details.nmi).toBeUndefined();
  });

  it("all metrics missing", () => {
    const result = evaluateCriteria(
      { silhouette: "> 0.3" },
      {},
    );
    expect(result.passed).toBe(false);
    expect(result.pending).toBe(true);
    expect(Object.keys(result.details)).toHaveLength(0);
  });

  it("empty criteria with any metrics → passed", () => {
    const result = evaluateCriteria({}, { foo: 1.0 });
    expect(result.passed).toBe(true);
    expect(result.pending).toBe(false);
  });
});
