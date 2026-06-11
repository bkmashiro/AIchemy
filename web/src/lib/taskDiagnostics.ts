import type { Task } from "./api";

export type TaskDiagnosisTone = "neutral" | "blocked" | "failed" | "running";

export interface TaskDiagnosis {
  code: string;
  label: string;
  tone: TaskDiagnosisTone;
}

export function taskDiagnosis(task: Task): TaskDiagnosis {
  if (task.status === "blocked") {
    if (task.target_stub_id) {
      return { code: "waiting_for_target_stub", label: "waiting for target stub", tone: "blocked" };
    }
    if (task.requirements?.gpu_mem_mb || task.requirements?.gpu_type?.length) {
      return { code: "waiting_for_capacity", label: "waiting for matching capacity", tone: "blocked" };
    }
    if ((task.dispatch_attempts ?? 0) > 0) {
      return { code: "dispatch_attempts_exhausted", label: "dispatch attempts exhausted", tone: "blocked" };
    }
    return { code: "scheduler_blocked", label: "scheduler blocked", tone: "blocked" };
  }

  if (task.status === "failed") {
    if (task.death_cause === "oom" || task.exit_code === 137) {
      return { code: "oom", label: "oom", tone: "failed" };
    }
    if (task.death_cause === "killed" || task.exit_code === -15 || task.exit_code === 143) {
      return { code: "terminated", label: "terminated", tone: "failed" };
    }
    if (task.death_cause) {
      return { code: task.death_cause, label: task.death_cause.replace(/_/g, " "), tone: "failed" };
    }
    return { code: "failed", label: "failed", tone: "failed" };
  }

  if (task.status === "running") {
    return { code: "running", label: "running", tone: "running" };
  }

  return { code: task.status, label: task.status, tone: "neutral" };
}

export function operatorCommandsForTask(task: Task): string[] {
  const commands = [
    `alch tasks get ${task.id}`,
    `alch tasks logs ${task.id} --tail 200`,
  ];
  if (task.run_dir) commands.push(`ls -la ${task.run_dir}`);
  return commands;
}

export function diagnosisToneClass(tone: TaskDiagnosisTone): string {
  switch (tone) {
    case "blocked":
      return "text-purple-300 border-purple-700/40 bg-purple-900/20";
    case "failed":
      return "text-red-300 border-red-700/40 bg-red-900/20";
    case "running":
      return "text-blue-300 border-blue-700/40 bg-blue-900/20";
    default:
      return "text-gray-400 border-gray-700/40 bg-gray-900/20";
  }
}
