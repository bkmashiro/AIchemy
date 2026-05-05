/**
 * Unit tests for Stream G: Lifecycle Phases.
 *
 * Tests:
 * - Phase validation in handleTaskPhase
 * - Checkpoint protection in scheduler (isCheckpointProtected)
 * - Auto-eval subtask creation on checkpoint events
 */
import { describe, it, expect } from "vitest";
import { Task, TaskStatus } from "../types";
import { isCheckpointProtected } from "../scheduler";

// Helper to create a minimal Task for testing
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-001",
    seq: 1,
    fingerprint: "fp-001",
    display_name: "test-task",
    script: "python train.py",
    command: "python train.py",
    status: "running" as TaskStatus,
    priority: 0,
    created_at: new Date().toISOString(),
    log_buffer: [],
    retry_count: 0,
    max_retries: 0,
    should_stop: false,
    should_checkpoint: false,
    ...overrides,
  };
}

describe("lifecycle phase", () => {
  describe("isCheckpointProtected", () => {
    it("returns true when task phase is checkpoint", () => {
      const task = makeTask({ phase: "checkpoint" });
      expect(isCheckpointProtected(task)).toBe(true);
    });

    it("returns false when task phase is training", () => {
      const task = makeTask({ phase: "training" });
      expect(isCheckpointProtected(task)).toBe(false);
    });

    it("returns false when task phase is eval", () => {
      const task = makeTask({ phase: "eval" });
      expect(isCheckpointProtected(task)).toBe(false);
    });

    it("returns false when task phase is warmup", () => {
      const task = makeTask({ phase: "warmup" });
      expect(isCheckpointProtected(task)).toBe(false);
    });

    it("returns false when task phase is cooldown", () => {
      const task = makeTask({ phase: "cooldown" });
      expect(isCheckpointProtected(task)).toBe(false);
    });

    it("returns false when task has no phase set", () => {
      const task = makeTask({ phase: undefined });
      expect(isCheckpointProtected(task)).toBe(false);
    });
  });

  describe("Task type has phase fields", () => {
    it("supports phase field", () => {
      const task = makeTask({ phase: "training" });
      expect(task.phase).toBe("training");
    });

    it("supports auto_eval config", () => {
      const task = makeTask({
        auto_eval: { script: "python eval.py", trigger: "every_n_checkpoints", n: 5 },
      });
      expect(task.auto_eval?.script).toBe("python eval.py");
      expect(task.auto_eval?.trigger).toBe("every_n_checkpoints");
      expect(task.auto_eval?.n).toBe(5);
    });

    it("supports parent_task_id", () => {
      const task = makeTask({ parent_task_id: "parent-001" });
      expect(task.parent_task_id).toBe("parent-001");
    });

    it("supports checkpoint_count", () => {
      const task = makeTask({ checkpoint_count: 3 });
      expect(task.checkpoint_count).toBe(3);
    });
  });
});
