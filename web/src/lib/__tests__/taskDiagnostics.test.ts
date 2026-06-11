import { describe, expect, it } from "vitest";
import type { Task } from "../api";
import { operatorCommandsForTask, taskDiagnosis } from "../taskDiagnostics";

function task(overrides: Partial<Task>): Task {
  return {
    id: "task-1",
    seq: 1,
    fingerprint: "fp",
    display_name: "task one",
    script: "/tmp/train.py",
    command: "python /tmp/train.py",
    status: "pending",
    priority: 5,
    created_at: "2026-06-01T00:00:00.000Z",
    log_buffer: [],
    retry_count: 0,
    max_retries: 0,
    should_stop: false,
    should_checkpoint: false,
    ...overrides,
  } as Task;
}

describe("task diagnostics", () => {
  it("explains target-stub blocked tasks", () => {
    expect(taskDiagnosis(task({ status: "blocked", target_stub_id: "stub-dead", dispatch_attempts: 2 }))).toEqual({
      code: "waiting_for_target_stub",
      label: "waiting for target stub",
      tone: "blocked",
    });
  });

  it("explains OOM failures", () => {
    expect(taskDiagnosis(task({ status: "failed", death_cause: "oom", exit_code: 137 }))).toMatchObject({
      code: "oom",
      label: "oom",
      tone: "failed",
    });
  });

  it("builds copyable operator commands", () => {
    expect(operatorCommandsForTask(task({ id: "task-abc", run_dir: "/tmp/run-a" }))).toEqual([
      "alch tasks get task-abc",
      "alch tasks logs task-abc --tail 200",
      "ls -la /tmp/run-a",
    ]);
  });
});
