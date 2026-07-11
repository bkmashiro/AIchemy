/**
 * scheduler.ts — Constraint-aware task scheduler.
 *
 * Scoring: hard constraints (GPU mem, GPU type, CPU mem, online) → -Infinity.
 * Soft scoring: idle ratio, queue depth, grid locality, VRAM waste.
 *
 * Triggers: new task in global queue, stub comes online, task completes, 30s periodic.
 */

import path from "path";
import { Namespace } from "socket.io";
import { store } from "./store";
import { Stub, Task } from "./types";
import { reliableEmitToStub } from "./reliable";
import { logger } from "./log";
import { assignTask, failTask } from "./task-actions";
import { notifyDispatched } from "./discord";
import { buildCommandArgv } from "./command";

// ─── Resource accounting and eligibility ─────────────────────────────────────

const DEFAULT_GPU_HEADROOM_RATIO = 0.15;
const DEFAULT_CPU_HEADROOM_RATIO = 0.05;
const ACTIVE_RESERVATION_STATUSES = new Set(["assigned", "running", "paused"]);

function configuredHeadroomRatio(envName: string, fallback: number): number {
  const value = Number(process.env[envName]);
  return Number.isFinite(value) && value >= 0 && value <= 0.5 ? value : fallback;
}

export type AssignmentReasonCode =
  | "no_online_stubs"
  | "target_stub_offline"
  | "target_stub_mismatch"
  | "dependency_blocked"
  | "invalid_resource_requirement"
  | "slots_full"
  | "gpu_type_mismatch"
  | "tag_mismatch"
  | "python_env_missing"
  | "gpu_memory_insufficient"
  | "gpu_memory_unknown_requires_exclusive"
  | "cpu_memory_insufficient"
  | "stub_draining"
  | "stub_offline";

export interface StubCapacity {
  slots: { active: number; limit: number; available: number };
  cpu: {
    allocation_mb: number | null;
    host_used_mb: number | null;
    host_total_mb: number | null;
    running_reserved_mb: number;
    assigned_reserved_mb: number;
    headroom_mb: number;
    allocatable_mb: number | null;
    reservation_overage_mb: number;
    memory_pressure: boolean;
    source: "slurm_allocation" | "host" | "unknown";
  };
  gpu: {
    total_mb: number;
    live_used_mb: number | null;
    running_reserved_mb: number;
    assigned_reserved_mb: number;
    headroom_mb: number;
    allocatable_mb: number;
    reservation_overage_mb: number;
    memory_pressure: boolean;
    unknown_active_tasks: number;
  };
}

export interface StubEligibility {
  stub_id: string;
  stub_name: string;
  status: Stub["status"];
  eligible: boolean;
  reasons: AssignmentReasonCode[];
  capacity: StubCapacity;
}

export interface AssignmentDiagnosis {
  task_id: string;
  status: Task["status"];
  task_status: Task["status"];
  ready: boolean;
  schedulable: boolean;
  blocker: AssignmentReasonCode | null;
  summary_code: string;
  next_action: string;
  compatible_stub_count: number;
  online_stub_count: number;
  dependencies: string[];
  requested: {
    target_stub_id?: string;
    target_tags?: string[];
    python_env?: string;
    gpu_type?: string[];
    gpu_mem_mb?: number;
    cpu_mem_mb?: number;
  };
  eligible_stub_ids: string[];
  stubs: StubEligibility[];
  rejections: Array<{
    stub_id: string;
    stub_name: string;
    reason_code: AssignmentReasonCode;
    details: Record<string, string | number | boolean | null>;
  }>;
  computed_at: string;
}

function normalizeGpuName(name: string): string {
  return name.toLowerCase().replace(/[\s\-_]/g, "").replace("nvidia", "").replace("geforce", "");
}

function activeReservationTasks(stub: Stub): Task[] {
  return stub.tasks.filter((task) => ACTIVE_RESERVATION_STATUSES.has(task.status));
}

function isGpuTask(task: Task): boolean {
  return Boolean(
    task.requirements?.gpu_mem_mb
    || task.requirements?.gpu_type?.length
    || task.requirements?.exclusive_gpu,
  );
}

function requiresExclusiveGpu(task: Task): boolean {
  return isGpuTask(task) && (
    task.requirements?.exclusive_gpu === true
    || validPositiveRequirement(task.requirements?.gpu_mem_mb) === 0
  );
}

function validPositiveRequirement(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function hasInvalidResourceRequirement(task: Task): boolean {
  const requirements = task.requirements;
  if (!requirements) return false;
  return [requirements.cpu_mem_mb, requirements.gpu_mem_mb]
    .some((value) => value !== undefined && validPositiveRequirement(value) === 0);
}

function sumReservations(tasks: Task[], resource: "cpu_mem_mb" | "gpu_mem_mb"): number {
  return tasks.reduce((sum, task) => sum + validPositiveRequirement(task.requirements?.[resource]), 0);
}

export function getStubCapacity(stub: Stub): StubCapacity {
  const active = activeReservationTasks(stub);
  const running = active.filter((task) => task.status === "running" || task.status === "paused");
  const assigned = active.filter((task) => task.status === "assigned");

  const telemetryGpus = stub.gpu_stats?.gpus || [];
  const gpuTotal = telemetryGpus.length > 0
    ? telemetryGpus.reduce((sum, gpu) => sum + gpu.memory_total_mb, 0)
    : stub.gpu.vram_total_mb * Math.max(1, stub.gpu.count || 1);
  const gpuLiveUsed = telemetryGpus.length > 0
    ? telemetryGpus.reduce((sum, gpu) => sum + gpu.memory_used_mb, 0)
    : null;
  const gpuRunningReserved = sumReservations(running, "gpu_mem_mb");
  const gpuAssignedReserved = sumReservations(assigned, "gpu_mem_mb");
  const gpuHeadroom = Math.ceil(gpuTotal * configuredHeadroomRatio(
    "ALCHEMY_GPU_MEMORY_HEADROOM_RATIO",
    DEFAULT_GPU_HEADROOM_RATIO,
  ));
  // Live telemetry may already include running tasks. max() avoids double-counting
  // them while assigned reservations close the pre-allocation race.
  const gpuCommitted = Math.max(gpuLiveUsed || 0, gpuRunningReserved) + gpuAssignedReserved;

  const allocation = stub.slurm_constraints?.mem_mb || stub.system_stats?.mem_total_mb;
  const cpuSource: StubCapacity["cpu"]["source"] = stub.slurm_constraints?.mem_mb
    ? "slurm_allocation"
    : stub.system_stats?.mem_total_mb
      ? "host"
      : "unknown";
  const cpuRunningReserved = sumReservations(running, "cpu_mem_mb");
  const cpuAssignedReserved = sumReservations(assigned, "cpu_mem_mb");
  const cpuHeadroom = allocation ? Math.ceil(allocation * configuredHeadroomRatio(
    "ALCHEMY_CPU_MEMORY_HEADROOM_RATIO",
    DEFAULT_CPU_HEADROOM_RATIO,
  )) : 0;
  const hostUsed = stub.system_stats?.mem_used_mb ?? null;
  // Host telemetry is pressure, not Slurm-job usage. Only workstation admission
  // compares against it; Slurm admission is bounded by its allocation.
  const cpuCommitted = cpuSource === "host"
    ? Math.max(hostUsed || 0, cpuRunningReserved) + cpuAssignedReserved
    : cpuRunningReserved + cpuAssignedReserved;
  const perTask = stub.system_stats?.per_task || {};
  const cpuReservationOverage = active.reduce((sum, task) => {
    const actual = perTask[task.id]?.mem_mb;
    const declared = task.requirements?.cpu_mem_mb;
    const reserved = validPositiveRequirement(declared);
    return sum + (actual !== undefined && declared !== undefined ? Math.max(0, actual - reserved) : 0);
  }, 0);
  const gpuReservationOverage = active.reduce((sum, task) => {
    const actual = perTask[task.id]?.gpu_mem_mb;
    const declared = task.requirements?.gpu_mem_mb;
    const reserved = validPositiveRequirement(declared);
    return sum + (actual !== undefined && declared !== undefined ? Math.max(0, actual - reserved) : 0);
  }, 0);
  const cpuPressure = cpuReservationOverage > 0;
  const gpuPressure = gpuReservationOverage > 0;

  return {
    slots: {
      active: active.length,
      limit: stub.max_concurrent,
      available: Math.max(0, stub.max_concurrent - active.length),
    },
    cpu: {
      allocation_mb: allocation ?? null,
      host_used_mb: hostUsed,
      host_total_mb: stub.system_stats?.mem_total_mb ?? null,
      running_reserved_mb: cpuRunningReserved,
      assigned_reserved_mb: cpuAssignedReserved,
      headroom_mb: cpuHeadroom,
      allocatable_mb: allocation === undefined || cpuPressure
        ? (allocation === undefined ? null : 0)
        : Math.max(0, allocation - cpuHeadroom - cpuCommitted),
      reservation_overage_mb: cpuReservationOverage,
      memory_pressure: cpuPressure,
      source: cpuSource,
    },
    gpu: {
      total_mb: gpuTotal,
      live_used_mb: gpuLiveUsed,
      running_reserved_mb: gpuRunningReserved,
      assigned_reserved_mb: gpuAssignedReserved,
      headroom_mb: gpuHeadroom,
      allocatable_mb: gpuPressure ? 0 : Math.max(0, gpuTotal - gpuHeadroom - gpuCommitted),
      reservation_overage_mb: gpuReservationOverage,
      memory_pressure: gpuPressure,
      unknown_active_tasks: active.filter((task) => requiresExclusiveGpu(task)).length,
    },
  };
}

export function evaluateStubEligibility(stub: Stub, task: Task): StubEligibility {
  const reasons: AssignmentReasonCode[] = [];
  const capacity = getStubCapacity(stub);

  if (hasInvalidResourceRequirement(task)) reasons.push("invalid_resource_requirement");

  if (task.target_stub_id && stub.id !== task.target_stub_id) reasons.push("target_stub_mismatch");
  if (stub.status !== "online") {
    reasons.push(task.target_stub_id === stub.id ? "target_stub_offline" : "stub_offline");
  }
  if (stub.max_concurrent === 0) reasons.push("stub_draining");
  if (task.target_tags?.length) {
    const stubTags = new Set(stub.tags || []);
    if (!task.target_tags.every((tag) => stubTags.has(tag))) reasons.push("tag_mismatch");
  }
  if (task.requirements?.gpu_type?.length) {
    const stubNorm = normalizeGpuName(stub.gpu.name);
    const matches = task.requirements.gpu_type.some(
      (type) => normalizeGpuName(type) === stubNorm || stubNorm.includes(normalizeGpuName(type)),
    );
    if (!matches) reasons.push("gpu_type_mismatch");
  }
  if (task.python_env && stub.available_envs) {
    if (!stub.available_envs.some((env) => env.name === task.python_env)) reasons.push("python_env_missing");
  }
  if (stub.max_concurrent > 0 && capacity.slots.available <= 0) reasons.push("slots_full");

  const candidateGpuExclusive = requiresExclusiveGpu(task);
  // Exclusive means exclusive placement on the entire stub, not merely no GPU
  // sibling: CPU siblings can still create host-memory and initialization pressure.
  if (capacity.gpu.memory_pressure) {
    reasons.push("gpu_memory_insufficient");
  } else if ((candidateGpuExclusive && capacity.slots.active > 0) || capacity.gpu.unknown_active_tasks > 0) {
    reasons.push("gpu_memory_unknown_requires_exclusive");
  } else if (task.requirements?.gpu_mem_mb && capacity.gpu.allocatable_mb < task.requirements.gpu_mem_mb) {
    reasons.push("gpu_memory_insufficient");
  }
  if (capacity.cpu.memory_pressure) {
    reasons.push("cpu_memory_insufficient");
  } else if (
    task.requirements?.cpu_mem_mb
    && capacity.cpu.allocatable_mb !== null
    && capacity.cpu.allocatable_mb < task.requirements.cpu_mem_mb
  ) {
    reasons.push("cpu_memory_insufficient");
  }

  return {
    stub_id: stub.id,
    stub_name: stub.name,
    status: stub.status,
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    capacity,
  };
}

const BLOCKER_PRIORITY: AssignmentReasonCode[] = [
  "target_stub_offline",
  "target_stub_mismatch",
  "no_online_stubs",
  "stub_draining",
  "invalid_resource_requirement",
  "slots_full",
  "gpu_type_mismatch",
  "tag_mismatch",
  "python_env_missing",
  "gpu_memory_unknown_requires_exclusive",
  "gpu_memory_insufficient",
  "cpu_memory_insufficient",
  "stub_offline",
];

function nextActionForBlocker(blocker: AssignmentReasonCode | null): string {
  switch (blocker) {
    case "dependency_blocked": return "wait_for_or_repair_dependencies";
    case "no_online_stubs": return "start_compatible_stub";
    case "target_stub_offline": return "restart_target_or_retarget";
    case "target_stub_mismatch": return "fix_target_stub_id";
    case "stub_draining": return "wait_or_undrain_stub";
    case "invalid_resource_requirement": return "fix_positive_resource_requirements";
    case "slots_full": return "wait_for_slot";
    case "gpu_memory_insufficient":
    case "gpu_memory_unknown_requires_exclusive":
    case "cpu_memory_insufficient": return "wait_for_memory_or_retarget";
    case "gpu_type_mismatch":
    case "tag_mismatch":
    case "python_env_missing": return "fix_requirements_or_retarget";
    default: return "none";
  }
}

function buildDiagnosis(
  task: Task,
  stubs: Stub[],
  rows: StubEligibility[],
  blocker: AssignmentReasonCode | null,
  requested: AssignmentDiagnosis["requested"],
): AssignmentDiagnosis {
  const eligible = rows.filter((row) => row.eligible).map((row) => row.stub_id);
  const ready = task.status === "pending";
  return {
    task_id: task.id,
    status: task.status,
    task_status: task.status,
    ready,
    schedulable: ready && eligible.length > 0,
    blocker,
    summary_code: blocker || (ready ? "assignable" : task.status),
    next_action: nextActionForBlocker(blocker),
    compatible_stub_count: eligible.length,
    online_stub_count: stubs.filter((stub) => stub.status === "online").length,
    dependencies: [...(task.depends_on || [])],
    requested,
    eligible_stub_ids: eligible,
    stubs: rows,
    rejections: rows.flatMap((row) => row.reasons.map((reason) => ({
      stub_id: row.stub_id,
      stub_name: row.stub_name,
      reason_code: reason,
      details: {
        requested_gpu_mem_mb: task.requirements?.gpu_mem_mb ?? null,
        requested_cpu_mem_mb: task.requirements?.cpu_mem_mb ?? null,
        gpu_allocatable_mb: row.capacity.gpu.allocatable_mb,
        gpu_assigned_reserved_mb: row.capacity.gpu.assigned_reserved_mb,
        gpu_reservation_overage_mb: row.capacity.gpu.reservation_overage_mb,
        gpu_memory_pressure: row.capacity.gpu.memory_pressure,
        cpu_allocatable_mb: row.capacity.cpu.allocatable_mb,
        cpu_allocation_mb: row.capacity.cpu.allocation_mb,
        cpu_host_used_mb: row.capacity.cpu.host_used_mb,
        cpu_reservation_overage_mb: row.capacity.cpu.reservation_overage_mb,
        cpu_memory_pressure: row.capacity.cpu.memory_pressure,
        slots_active: row.capacity.slots.active,
        slots_limit: row.capacity.slots.limit,
      },
    }))),
    computed_at: new Date().toISOString(),
  };
}

export function diagnoseTaskAssignment(task: Task, stubs: Stub[] = store.getAllStubs()): AssignmentDiagnosis {
  const requested: AssignmentDiagnosis["requested"] = {
    target_stub_id: task.target_stub_id,
    target_tags: task.target_tags,
    python_env: task.python_env,
    gpu_type: task.requirements?.gpu_type,
    gpu_mem_mb: task.requirements?.gpu_mem_mb,
    cpu_mem_mb: task.requirements?.cpu_mem_mb,
  };

  if (task.status === "blocked") {
    return buildDiagnosis(task, stubs, [], "dependency_blocked", requested);
  }

  const rows = stubs.map((stub) => evaluateStubEligibility(stub, task));
  const eligible = rows.filter((row) => row.eligible).map((row) => row.stub_id);
  let blocker: AssignmentReasonCode | null = null;
  if (task.status === "pending" && eligible.length === 0) {
    const target = task.target_stub_id ? stubs.find((stub) => stub.id === task.target_stub_id) : undefined;
    if (target?.status === "offline") {
      blocker = "target_stub_offline";
    } else if (task.target_stub_id && !target) {
      blocker = "target_stub_mismatch";
    } else if (!stubs.some((stub) => stub.status === "online")) {
      blocker = "no_online_stubs";
    } else {
      const reasonSet = new Set(rows.flatMap((row) => row.reasons));
      blocker = BLOCKER_PRIORITY.find((reason) => reasonSet.has(reason)) || null;
    }
  }

  return buildDiagnosis(task, stubs, rows, blocker, requested);
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export function scoreStub(stub: Stub, task: Task): number {
  const eligibility = evaluateStubEligibility(stub, task);
  if (!eligibility.eligible) return -Infinity;
  const { capacity } = eligibility;

  // Soft scoring
  let s = 0;

  // Idle ratio bonus (0–40 points)
  s += 40 * capacity.slots.available / Math.max(1, capacity.slots.limit);

  // Grid locality: prefer stubs already running tasks from the same grid
  if (task.grid_id) {
    const gridTasks = store.getGridTasks(task.grid_id);
    const gridStubIds = new Set(gridTasks.map((t) => t.stub_id).filter(Boolean));
    if (gridStubIds.has(stub.id)) {
      s += 20;
    }
  }

  // VRAM waste penalty: avoid over-provisioning after reservations/headroom.
  if (task.requirements?.gpu_mem_mb) {
    s -= (capacity.gpu.allocatable_mb - task.requirements.gpu_mem_mb) / 1000;
  }

  // User affinity: prefer stubs owned by the same user who submitted the task
  if (task.submitted_by && stub.user) {
    if (task.submitted_by === stub.user) {
      s += 30;
    } else {
      s -= 50;
    }
  }

  return s;
}

// ─── Compute server-authoritative run_dir ────────────────────────────────────

/**
 * Compute run_dir for a task at dispatch time.
 * Priority: task.run_dir > stub.default_output_dir > (stub.default_cwd or cwd) / "runs"
 * Final path: base_output_dir / fingerprint[:12]
 */
export function computeRunDir(task: Task, stub: Stub): string {
  // If task has an explicit run_dir set by user, use it as-is (treat as full path)
  if (task.run_dir) {
    return task.run_dir;
  }

  // Determine base_output_dir
  let baseOutputDir: string;
  if (stub.default_output_dir) {
    baseOutputDir = stub.default_output_dir;
  } else {
    const base = task.cwd ?? stub.deploy_default_cwd ?? stub.default_cwd ?? process.cwd();
    baseOutputDir = path.join(base, "runs");
  }

  const fp = task.fingerprint || task.id;
  return path.join(baseOutputDir, fp.slice(0, 12));
}

// ─── Build run payload ────────────────────────────────────────────────────────

/** Resolve python_env name to activation command using stub's available_envs. */
function resolveEnvSetup(task: Task, stub: Stub): string | undefined {
  if (!task.python_env) return task.env_setup;
  const envs = stub.available_envs || [];
  const match = envs.find((e) => e.name === task.python_env);
  if (!match) return task.env_setup;

  // Use the activate command from stub's env discovery if available
  const activateCmd = match.activate
    || (match.type === "venv" ? `source ${match.path}/bin/activate` : `micromamba activate ${match.path}`);

  // Prepend to existing env_setup if any
  return task.env_setup ? `${activateCmd} && ${task.env_setup}` : activateCmd;
}

export function buildRunPayload(task: Task, stub: Stub): object {
  const run_dir = computeRunDir(task, stub);

  // ─── Stub-level environment inheritance ──────────────────────────────────
  // Task-level settings always win; stub deploy defaults fill in the gaps.

  // cwd: task > stub.deploy_default_cwd > stub.default_cwd
  const cwd = task.cwd ?? stub.deploy_default_cwd ?? stub.default_cwd;

  // env_setup: task (via resolveEnvSetup) > stub.deploy_env_setup
  const resolvedEnvSetup = resolveEnvSetup(task, stub) ?? stub.deploy_env_setup;

  // env: start with stub.deploy_default_env, overlay task.env on top (task wins)
  let env: Record<string, string> | undefined;
  if (stub.deploy_default_env || task.env) {
    env = { ...(stub.deploy_default_env ?? {}), ...(task.env ?? {}) };
  }

  const payload: Record<string, any> = {
    task_id: task.id,
    command: task.command,
    command_argv: buildCommandArgv(task),
    cwd,
    env,
    env_overrides: task.env_overrides,
    env_setup: resolvedEnvSetup,
    run_dir,
    params: task.param_overrides,
    outputs: task.outputs,
    metric_schema: task.metric_schema,
  };

  // Include resolved_config so stub can inject ALCHEMY_CONFIG
  if (task.resolved_config) {
    payload.resolved_config = task.resolved_config;
  }

  return payload;
}

// ─── Checkpoint phase protection ─────────────────────────────────────────────

/**
 * Check if a task is currently in the checkpoint phase.
 * Tasks in checkpoint phase should NOT be preempted or killed — interrupting
 * a checkpoint write can corrupt the saved state and waste all training progress.
 */
export function isCheckpointProtected(task: Task): boolean {
  return task.phase === "checkpoint";
}

// ─── Dispatch queued tasks for a stub ────────────────────────────────────────

export function maybeDispatch(stub: Stub): void {
  if (stub.status !== "online") return;

  // Count only truly running tasks toward slots; "assigned" tasks are queued
  // waiting for task.run to be dispatched — they don't hold a slot yet.
  const active = stub.tasks.filter((t) => t.status === "running" || t.status === "paused").length;
  const slots = stub.max_concurrent - active;
  if (slots <= 0) return;

  const queued = stub.tasks
    .filter((t) => t.status === "assigned")
    .sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at));

  logger.info("maybeDispatch", { stub: stub.name, active, slots, queued: queued.length, total_tasks: stub.tasks.length });

  const toDispatch = queued.slice(0, slots);

  for (const task of toDispatch) {
    const run_dir = computeRunDir(task, stub);
    // Persist computed run_dir into task so write lock and display work correctly
    const updated = assignTask(stub.id, task.id, run_dir);
    reliableEmitToStub(stub.id, "task.run", buildRunPayload(task, stub));
    logger.info("task.dispatch", { task_seq: task.seq, stub: stub.name, display_name: task.display_name, run_dir });
    if (updated) notifyDispatched(updated).catch(() => {});

    // Dispatch timeout: if no task.started within 30s, recover to pending (up to 3 attempts)
    // Only act if task is still in "dispatched" status on the SAME stub (not recovered/moved)
    const dispatchTaskId = task.id;
    const dispatchStubId = stub.id;
    setTimeout(() => {
      const t = store.findTask(dispatchTaskId);
      if (t && t.task.status === "assigned" && !t.archived && t.stubId === dispatchStubId) {
        const attempts = (t.task.dispatch_attempts ?? 0) + 1;
        logger.warn("task.dispatch_timeout", { task_id: dispatchTaskId, stub: dispatchStubId, attempt: attempts });
        if (attempts >= 3) {
          failTask(dispatchStubId, dispatchTaskId, -3, {
            error_message: `Dispatch timeout: no task.started after ${attempts} attempts`,
          });
          logger.warn("task.dispatch_failed_permanent", { task_id: dispatchTaskId, attempts });
        } else {
          // Move back to global queue as pending for retry, atomically.
          const prevTask = t.task;
          const stub2 = store.getStub(dispatchStubId);
          if (stub2) {
            const taskIdx = stub2.tasks.findIndex((t2) => t2.id === dispatchTaskId);
            if (taskIdx !== -1) {
              stub2.tasks.splice(taskIdx, 1);
            }
            const recovered: Task = {
              ...prevTask,
              status: "pending",
              stub_id: undefined,
              dispatch_attempts: attempts,
            };
            // Write both changes in one transaction via the DB directly
            store.requeueDispatchedTask(stub2, recovered);
            if (_webNsRef) _webNsRef.emit("task.update", recovered);
            logger.info("task.dispatch_recovered", { task_id: dispatchTaskId, attempt: attempts });
            triggerSchedule();
          }
        }
      }
    }, 30_000);
  }
}

// ─── Main schedule loop ───────────────────────────────────────────────────────

let _scheduling = false;

export function schedule(): void {
  // Re-entrancy guard — prevent over-dispatch from concurrent triggers
  if (_scheduling) return;
  _scheduling = true;
  try {
    _scheduleInner();
  } finally {
    _scheduling = false;
  }
}

function _scheduleInner(): void {
  const stubs = store.getOnlineStubs();
  if (stubs.length === 0) return;

  // Dispatch any queued tasks already on stubs (e.g. after retry/status reset)
  for (const stub of stubs) {
    maybeDispatch(stub);
  }

  // Only schedule pending tasks, not blocked ones (blocked wait for DAG deps)
  const queue = store.getGlobalQueue().filter(t => t.status !== "blocked");
  if (queue.length === 0) return;

  for (const task of queue) {
    // Re-fetch stubs each iteration — previous assignment mutates store
    const freshStubs = store.getOnlineStubs();
    const candidates = freshStubs
      .map((s) => ({ stub: s, score: scoreStub(s, task) }))
      .filter((c) => c.score > -Infinity)
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      const diagnosis = diagnoseTaskAssignment(task, store.getAllStubs());
      logger.info("scheduler.no_candidate", {
        task_seq: task.seq,
        display_name: task.display_name,
        blocker: diagnosis.blocker,
        stubs: diagnosis.stubs.map((row) => ({ stub_id: row.stub_id, reasons: row.reasons })),
      });
      continue;
    }

    const best = candidates[0].stub;
    logger.info("scheduler.assign", { task_seq: task.seq, stub: best.name, score: candidates[0].score });
    const moved = store.moveToStubQueue(task.id, best.id);
    if (moved) {
      // Broadcast task assignment so frontend stays in sync
      if (_webNsRef) _webNsRef.emit("task.update", moved);
      const updatedStub = store.getStub(best.id);
      if (updatedStub) {
        maybeDispatch(updatedStub);
      }
    }
  }
}

// ─── Trigger helpers ─────────────────────────────────────────────────────────

export function triggerSchedule(): void {
  try {
    schedule();
  } catch (err) {
    logger.error("scheduler.error", { error: String(err) });
  }
}

// ─── Periodic scheduling ─────────────────────────────────────────────────────

let _webNsRef: Namespace | undefined;

export function getWebNs(): Namespace | undefined {
  return _webNsRef;
}

export function startScheduler(_webNs: Namespace, _stubNs: Namespace): void {
  _webNsRef = _webNs;
  // Periodic schedule: every 30s
  setInterval(() => triggerSchedule(), 30_000);
  // Also drain immediately on startup (tasks may be pending)
  setTimeout(() => triggerSchedule(), 1_000);

  // Hourly zombie stub cleanup
  setInterval(() => {
    const pruned = store.pruneStaleStubs();
    if (pruned > 0) logger.info("scheduler.prune_stubs", { pruned });
  }, 3600_000);
}
