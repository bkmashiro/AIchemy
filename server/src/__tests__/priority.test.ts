import { beforeEach, describe, expect, it } from "vitest";
import { effectiveTaskPriority } from "../priority";
import { store } from "../store";
import type { Task } from "../types";

function task(id: string, priority: number, expediteUntil?: string): Task {
  return {
    id, name: id, display_name: id, script: "train.py", command: "train.py",
    status: "pending", priority, seq: priority, created_at: `2026-01-01T00:00:0${priority}Z`,
    log_buffer: [], retry_count: 0, max_retries: 0,
    ...(expediteUntil ? {
      base_priority: priority,
      expedite_class: "urgent" as const,
      expedite_until: expediteUntil,
      expedite_reason: "deadline",
      expedite_actor: "tester",
    } : {}),
  } as unknown as Task;
}

describe("effective task priority", () => {
  beforeEach(() => store.reset());

  it("orders a temporary expedite ahead without mutating base priority", () => {
    const expedited = task("low", 1, "2999-01-01T00:00:00Z");
    store.addToGlobalQueue(task("high", 10));
    store.addToGlobalQueue(expedited);
    expect(store.getGlobalQueue().map((item) => item.id)).toEqual(["low", "high"]);
    expect(expedited.priority).toBe(1);
    expect(effectiveTaskPriority(expedited)).toBe(1001);
  });

  it("expires automatically back to base priority", () => {
    expect(effectiveTaskPriority(task("expired", 4, "2000-01-01T00:00:00Z"))).toBe(4);
  });
});
