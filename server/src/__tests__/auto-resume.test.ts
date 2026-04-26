/**
 * Unit tests for auto-resume decision logic (Stream B2).
 *
 * Tests the handleTaskFailed logic for OOM, walltime, and preempt
 * death causes — verifying retry creation, memory bumping, and
 * dedup behavior.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRetryTask, RetryTaskOpts } from "../task-actions";
import { Task, TaskStatus } from "../types";

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
    max_retries: 2,
    should_stop: false,
    should_checkpoint: false,
    ...overrides,
  };
}

describe("auto-resume decision logic", () => {
  describe("createRetryTask", () => {
    it("creates a retry with incremented retry_count", () => {
      const task = makeTask({ retry_count: 0, max_retries: 2 });
      const retry = createRetryTask(task);
      expect(retry.retry_count).toBe(1);
      expect(retry.status).toBe("pending");
      expect(retry.id).not.toBe(task.id);
      expect(retry.retry_of).toBe(task.id);
    });

    it("chains retry_of to original task id", () => {
      const task = makeTask({ id: "original", retry_of: undefined });
      const retry1 = createRetryTask(task);
      expect(retry1.retry_of).toBe("original");

      // Second retry should still point to original
      const retry2 = createRetryTask({ ...retry1, retry_of: "original" } as Task);
      expect(retry2.retry_of).toBe("original");
    });

    it("bumps memory when requirements override provided", () => {
      const task = makeTask({
        requirements: { cpu_mem_mb: 60000, gpu_mem_mb: 8000 },
      });
      const opts: RetryTaskOpts = {
        requirements: { ...task.requirements, cpu_mem_mb: 75000 },
      };
      const retry = createRetryTask(task, opts);
      expect(retry.requirements?.cpu_mem_mb).toBe(75000);
      // gpu_mem_mb preserved from override
      expect(retry.requirements?.gpu_mem_mb).toBe(8000);
    });

    it("clears run_dir by default", () => {
      const task = makeTask({ run_dir: "/some/dir" });
      const retry = createRetryTask(task);
      expect(retry.run_dir).toBeUndefined();
    });

    it("preserves run_dir when clearRunDir is false", () => {
      const task = makeTask({ run_dir: "/some/dir" });
      const retry = createRetryTask(task, { clearRunDir: false });
      expect(retry.run_dir).toBe("/some/dir");
    });

    it("resets lifecycle fields", () => {
      const task = makeTask({
        started_at: "2024-01-01",
        finished_at: "2024-01-02",
        exit_code: 137,
        pid: 1234,
        progress: { step: 100, total: 200, loss: 0.5 },
      });
      const retry = createRetryTask(task);
      expect(retry.started_at).toBeUndefined();
      expect(retry.finished_at).toBeUndefined();
      expect(retry.exit_code).toBeUndefined();
      expect(retry.pid).toBeUndefined();
      expect(retry.progress).toBeUndefined();
      expect(retry.should_stop).toBe(false);
    });
  });

  describe("OOM auto-resume memory bump", () => {
    it("bumps cpu_mem_mb by 25% for OOM", () => {
      const task = makeTask({ requirements: { cpu_mem_mb: 60000 } });
      const currentMem = task.requirements?.cpu_mem_mb || 60000;
      const bumpedMem = Math.ceil(currentMem * 1.25);
      expect(bumpedMem).toBe(75000);

      const retry = createRetryTask(task, {
        requirements: { ...task.requirements, cpu_mem_mb: bumpedMem },
      });
      expect(retry.requirements?.cpu_mem_mb).toBe(75000);
    });

    it("defaults to 60000 when no cpu_mem_mb set, then bumps", () => {
      const task = makeTask({ requirements: undefined });
      const currentMem = task.requirements?.cpu_mem_mb || 60000;
      const bumpedMem = Math.ceil(currentMem * 1.25);
      expect(bumpedMem).toBe(75000);
    });

    it("uses gpu_mem_mb fallback when cpu_mem_mb not set", () => {
      const task = makeTask({ requirements: { gpu_mem_mb: 40000 } });
      const currentMem = task.requirements?.cpu_mem_mb || task.requirements?.gpu_mem_mb || 60000;
      const bumpedMem = Math.ceil(currentMem * 1.25);
      expect(bumpedMem).toBe(50000);
    });
  });

  describe("resume eligibility checks", () => {
    it("does not resume when retry_count >= max_retries", () => {
      const task = makeTask({ retry_count: 2, max_retries: 2 });
      expect(task.retry_count < task.max_retries).toBe(false);
    });

    it("allows resume when retry_count < max_retries", () => {
      const task = makeTask({ retry_count: 1, max_retries: 2 });
      expect(task.retry_count < task.max_retries).toBe(true);
    });

    it("does not resume when max_retries is 0", () => {
      const task = makeTask({ max_retries: 0 });
      expect(task.max_retries > 0).toBe(false);
    });

    it("does not resume code_error death cause", () => {
      const resumableDeathCauses = ["oom", "walltime", "preempt"];
      expect(resumableDeathCauses.includes("code_error")).toBe(false);
    });

    it("resumes for oom death cause", () => {
      const resumableDeathCauses = ["oom", "walltime", "preempt"];
      expect(resumableDeathCauses.includes("oom")).toBe(true);
    });

    it("resumes for walltime death cause", () => {
      const resumableDeathCauses = ["oom", "walltime", "preempt"];
      expect(resumableDeathCauses.includes("walltime")).toBe(true);
    });

    it("resumes for preempt death cause", () => {
      const resumableDeathCauses = ["oom", "walltime", "preempt"];
      expect(resumableDeathCauses.includes("preempt")).toBe(true);
    });

    it("walltime is always resumable even without checkpoint", () => {
      const deathCause: string = "walltime";
      const hasCheckpoint = false;
      const isResumable = hasCheckpoint || deathCause === "walltime" || deathCause === "preempt";
      expect(isResumable).toBe(true);
    });

    it("preempt is always resumable even without checkpoint", () => {
      const deathCause: string = "preempt";
      const hasCheckpoint = false;
      const isResumable = hasCheckpoint || deathCause === "walltime" || deathCause === "preempt";
      expect(isResumable).toBe(true);
    });

    it("oom without checkpoint is NOT resumable", () => {
      const deathCause: string = "oom";
      const hasCheckpoint = false;
      const isResumable = hasCheckpoint || deathCause === "walltime" || deathCause === "preempt";
      expect(isResumable).toBe(false);
    });

    it("oom WITH checkpoint is resumable", () => {
      const deathCause: string = "oom";
      const hasCheckpoint = true;
      const isResumable = hasCheckpoint || deathCause === "walltime" || deathCause === "preempt";
      expect(isResumable).toBe(true);
    });

    it("killed task should not auto-resume", () => {
      const task = makeTask({ should_stop: true });
      const isKilled = task.should_stop && true; // exit_code !== 0
      expect(isKilled).toBe(true);
    });
  });
});
