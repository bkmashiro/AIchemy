# Alchemy v2.2 Roadmap — Implementation Spec

## Priority Tiers

### P0 — Critical bugs (affect current usage)
### P1 — Core infrastructure (reduce manual work significantly)
### P2 — Features (improve workflow)
### P3 — Nice-to-have (polish)

---

## Stream A: Stub Identity & Reconnection (P0)

**Problem:** Stub reconnects get new ID → server sees zombie stubs, tasks become orphans.
Lost task dedup also broken — disconnect creates duplicate "lost" entries.

**Files:** `server/src/socket/stub.ts`, `server/src/store/index.ts`, `server/src/scheduler.ts`

### A1. Fix computeStubId consistency
- Server `computeStubId` uses `sha256(hostname|gpu.name|gpu.count|defaultCwd|slurmJobId)[:12]`
- Stub computes `sha256(hostname + gpu_indices + default_cwd [+ slurm_job_id])[:12]`
- These formulas DIFFER → same stub gets different ID on reconnect
- **Fix:** Align both sides to identical formula. Stub should send its computed ID on connect; server validates/accepts.

### A2. Reconnect reconciliation
- When stub connects with existing stub_id that's "offline":
  - Transition to "online", reuse record
  - Don't create duplicate stub entry
  - Reconcile task states (stub reports running PIDs → server recovers "lost" tasks)
- Remove the 3000ms reconnect rate limiter (or make it configurable)

### A3. Lost task dedup
- On disconnect, mark tasks "lost" only once
- If task already "lost", don't create duplicate event
- Auto-retry should check if retry already exists before creating another

**Tests:** smoke-tests already cover reconnection scenarios. Verify existing tests pass, add unit tests for computeStubId.

---

## Stream B: Auto-Resume & Resource Awareness (P1)

**Problem:** SLURM walltime/OOM/preempt kills require manual resume. Current host-memory telemetry intentionally measures whole-machine pressure, including other users' processes; the authoritative task/stub memory ceiling is the SLURM allocation (`--mem` / cgroup). The missing piece is not replacing host telemetry, but exposing host pressure and SLURM allocation separately and using declared/reserved per-task resources for admission.

**Files:** `server/src/socket/stub.ts`, `server/src/scheduler.ts`, `server/src/store/index.ts`, `stub/alchemy_stub/daemon.py`, `stub/alchemy_stub/process_mgr.py`

### B1. Task death classification
Stub already gets exit code + signal. Add classification:
```typescript
type DeathCause = 'success' | 'code_error' | 'oom' | 'walltime' | 'preempt' | 'lost';
```

**Stub-side detection:**
- SIGKILL + check `/proc/<pid>/oom_score_adj` or dmesg → `oom`
- SIGTERM from SLURM (`SLURM_JOB_ID` set + exit signal 15) → `walltime` or `preempt`
- Non-zero exit + no checkpoint → `code_error`
- Non-zero exit + has checkpoint → `resumable_failure`

Report `death_cause` in `task.failed` / `task.completed` socket events.

### B2. Auto-resume logic (server)
When task reaches `failed`/`lost` state:
1. Check `death_cause` — only resume for `oom`, `walltime`, `preempt`
2. Check run_dir has checkpoint (stub reports this)
3. Check retry count < max_retries (default 2 for auto-resume)
4. Create new task with `--resume <run_dir>` flag, same params
5. For OOM: increase `--mem` constraint by 25% (e.g. 60G → 80G)
6. **Never modify training params** — purely transparent infrastructure retry

### B3. Separate host pressure, SLURM allocation, and task reservations
- Preserve whole-host telemetry (`MemTotal`, `MemAvailable`, aggregate GPU usage). It correctly includes other users and is useful as a pressure/safety signal.
- Treat `slurm_constraints.mem_mb` / cgroup memory limit as the authoritative ceiling available to the stub. Do not compare a task only against physical host total.
- Display these layers explicitly:
  - `host_mem_total_mb`, `host_mem_used_mb` — whole node, includes other users;
  - `user_mem_rss_mb` — aggregate processes owned by the Unix user across the node; useful attribution, but may include other Slurm jobs and can double-count shared pages;
  - `allocation_mem_limit_mb`, `allocation_mem_current_mb` — this Slurm job/cgroup; authoritative for the stub's actual usage and hard ceiling;
  - `task_process_rss_mb` — process-tree attribution inside the allocation when available;
  - `reserved_task_mem_mb`, `reserved_task_vram_mb` — Alchemy admission reservations.
- Stub startup continues to read `SLURM_MEM_PER_NODE`, `SLURM_JOB_NUM_NODES`, `SLURM_CPUS_ON_NODE`; cgroup values override only when they represent a tighter effective limit.
- Dashboard labels must prevent interpreting host usage as this job's usage.

**Tests:** Add smoke test for death classification. Unit-test allocation precedence, host-vs-allocation labels, and reservation accounting.

---

## Stream C: Stub Environment Config (P1)

**Problem:** Users write boilerplate `export PATH=... && cd ...` in every task script. Should be stub-level default.

**Files:** `stub/alchemy_stub/config.py`, `stub/alchemy_stub/__main__.py`, `stub/alchemy_stub/process_mgr.py`, `server/src/socket/stub.ts`, `server/src/api/stubs.ts`

### C1. Structured default_env
Replace string-based `--env-setup` with structured env config:

**Stub CLI:**
```
--default-env KEY=VALUE   (repeatable, or JSON file)
--default-env-file /path/to/env.yaml
```

**Config format (YAML):**
```yaml
default_cwd: /vol/bitbucket/ys25/jema
default_env:
  PATH: /vol/bitbucket/ys25/conda-envs/jema/bin:$PATH
  PYTHONPATH: /vol/bitbucket/ys25/jema:$PYTHONPATH
  TORCH_HOME: /vol/bitbucket/ys25/.cache/torch
```

### C2. Task env_overrides
Tasks can specify `env_overrides: {KEY: VALUE}` to merge with stub defaults.
- Override replaces existing key
- `$PATH`-style expansion supported for PATH-like vars
- Task submission API accepts `env_overrides` field

### C3. Execution order
1. Start with clean env (inherit stub process env)
2. Apply `default_env` from stub config
3. Apply `env_overrides` from task
4. Set `ALCHEMY_*` vars (task_id, params, etc.)
5. `cd` to task cwd (or default_cwd)
6. Execute script

**Backward compat:** Keep `--env-setup` working as fallback (deprecated). If both set, structured env applies first, then env-setup shell commands.

**Tests:** Unit test env merging logic. Smoke test task execution with custom env.

---

## Stream D: MCP Server (P2)

**Problem:** Agents (like me) interact with alchemy via raw curl/REST. MCP server enables native tool integration.

**Files:** New `server/src/mcp/` directory, or standalone `mcp-server/` package.

### D1. MCP Tool Definitions
```
alchemy.submit_task    — Submit a task (script, name, params, tags)
alchemy.list_tasks     — List/filter tasks (status, name, tag, limit)
alchemy.get_task       — Get task detail by ID
alchemy.kill_task      — Kill a task
alchemy.retry_task     — Retry a failed task
alchemy.list_stubs     — List stubs with status
alchemy.cluster_status — GPU availability snapshot
alchemy.task_logs      — Get recent log output
```

### D2. Implementation
- Use `@modelcontextprotocol/sdk` (Node.js) or standalone Python MCP server
- Wrap existing REST API internally — MCP is a thin adapter layer
- Auth via MCP config (token in server settings)
- SSE transport for real-time task status updates

### D3. Claude Code integration
- Publish as MCP server config for Claude Code / other agents
- Document in SDK.md

**Tests:** Integration test each MCP tool against running server.

---

## Stream E: GPU Cost Statistics (P3)

**Problem:** Want to track GPU usage cost for fun/accounting.

**Files:** `server/src/store/index.ts`, `server/src/api/metrics.ts`, `web/src/pages/Dashboard.tsx`

### E1. Cost tracking
- On task completion, compute `gpu_hours = duration × gpu_count`
- Apply rate card: A100=$2/hr, A40=$1/hr, A30=$0.7/hr, RTX4080=$0.5/hr
- Store cumulative cost per task, per user, per experiment
- GPU type comes from stub registration data

### E2. Dashboard widget
- Total GPU-hours consumed (all time, last 7d, last 30d)
- Total estimated cost ($)
- Cost breakdown by GPU type, by experiment
- Fun metric: "tuition ROI: XX%"

### E3. API endpoint
- **GET /metrics/cost** — Cost summary with time range filter
- **GET /metrics/cost/breakdown** — By GPU type, experiment, time period

**Tests:** Unit test cost calculation. Verify rates apply correctly.

---

## Stream F: Frontend Polish (P3)

### F1. Operation confirmation dialogs
- Kill/pause: proper modal dialog (not browser `confirm()`)
- Show task name, status, stub info
- Batch operations: "Kill 5 tasks?" with list preview

### F2. Lifecycle phase display
- When implemented (Stream G), show phase badge on task row
- Color-coded: warmup=blue, training=green, eval=yellow, checkpoint=purple

---

## Stream G: Lifecycle Phases & Auto-Eval (P2, future)

### G1. Phase reporting
SDK reports current phase: `warmup`, `training`, `eval`, `checkpoint`, `cooldown`
Server stores and displays. Enables smarter scheduling (don't kill during checkpoint).

### G2. Auto-eval subtask
On checkpoint event, optionally create child eval task.
Config: `auto_eval: {script: "python eval.py --ckpt {checkpoint_path}", trigger: "every_n_checkpoints: 5"}`

---

## Dependency Graph & Parallelism

```
Stream A (stub identity)     ← independent, P0
Stream B (auto-resume)       ← depends on A (needs reliable reconnect)
Stream C (env config)        ← independent, P1
Stream D (MCP)               ← independent, P2
Stream E (cost stats)        ← independent, P3
Stream F (frontend)          ← independent, P3
Stream G (lifecycle/eval)    ← independent, P2, future
```

**Parallel execution plan:**
- **Wave 1:** A + C + E (all independent)
- **Wave 2:** B (after A lands) + D (independent)
- **Wave 3:** F + G (after core is stable)

---

## Assignment

| Stream | Complexity | Agent |
|--------|-----------|-------|
| A (stub identity) | High — touches core socket/state | Opus |
| B (auto-resume) | Medium — new feature, clear spec | Sonnet |
| C (env config) | Medium — stub refactor | Sonnet |
| D (MCP server) | Medium — new module, wraps existing API | Sonnet |
| E (cost stats) | Low — additive feature | Sonnet |
| F (frontend) | Low — UI only | Sonnet |
| G (lifecycle) | Medium — cross-cutting | Future |

---

# 2026-07 Operational Roadmap Addendum

This addendum is authoritative for queueing, capacity, memory admission, result delivery, and operator UX. If it conflicts with earlier wording, this section wins.

## Operating boundaries

- Host memory telemetry is whole-machine pressure and correctly includes other users. Preserve it.
- The Slurm allocation/cgroup limit is the authoritative ceiling for an Alchemy stub.
- `max_concurrent` is only a process-slot ceiling. It is not a memory scheduler.
- Automatic capacity may manage at most three total A30 jobs for the user, counting manual, autoscaler-owned, online, and Slurm-pending jobs.
- Automatic capacity never releases manually owned or pinned jobs.
- Priority changes do not preempt running work in the first implementation.
- Every mutation must be auditable and idempotent.

## Stream H: Pending-task assignment explainability (P0)

**User problem:** Pending tasks do not show why they cannot be assigned. Operators cannot distinguish no capacity, slot exhaustion, memory pressure, stale exact targeting, dependency blocking, missing Python environments, or GPU mismatch.

**Current code:** `server/src/scheduler.ts` computes `rejectReason()` internally, but reasons are only written to logs. The task API, experiment snapshot, CLI, and Web UI do not expose a structured explanation.

**Files:**
- Modify: `server/src/scheduler.ts`
- Modify: `server/src/api/tasks.ts`
- Modify: `server/src/api/experiments.ts`
- Modify: `server/src/types.ts`
- Modify: `sdk/alchemy_sdk/cli/main.py`
- Modify: `web/src/` task/experiment inspector components
- Test: `server/src/__tests__/scheduler.test.ts`
- Test: `server/src/__tests__/api-tasks.test.ts`
- Test: `sdk/tests/`

### H1. Pure assignment diagnosis

Add a side-effect-free function:

```ts
type StubRejection = {
  stub_id: string;
  stub_name: string;
  reason_code:
    | "offline"
    | "target_stub_mismatch"
    | "target_stub_offline"
    | "tag_mismatch"
    | "gpu_type_mismatch"
    | "gpu_memory_insufficient"
    | "cpu_memory_insufficient"
    | "python_env_missing"
    | "slots_full"
    | "stub_draining";
  details: Record<string, string | number | boolean>;
};

type AssignmentDiagnosis = {
  task_id: string;
  task_status: string;
  ready: boolean;
  summary_code: string;
  next_action: string;
  compatible_stub_count: number;
  online_stub_count: number;
  rejections: StubRejection[];
  computed_at: string;
};
```

The diagnostic function must reuse the exact hard-constraint logic used by scheduling. Do not maintain a second divergent implementation.

### H2. API and snapshots

Add:

```text
GET /api/tasks/:id/assignment-diagnosis
GET /api/experiments/:id/assignment-diagnosis
```

Experiment response groups pending/blocked tasks by `summary_code` and includes canonical task refs. Blocked DAG tasks report dependency state separately instead of pretending to be capacity failures.

Expose a compact diagnosis in `GET /api/experiments/:id/status-snapshot`:

```json
{
  "pending_reasons": {
    "slots_full": 3,
    "target_stub_offline": 1
  }
}
```

### H3. CLI and Web

Add:

```bash
alch tasks why <task-id>
alch experiments why <experiment-id>
```

Task rows show one stable reason badge. Inspector shows per-stub rejection details, required versus available resources, exact target status, and suggested action.

### H acceptance gates

- A pending task with no online stubs reports `no_online_stubs`.
- Exact target offline reports `target_stub_offline`, not generic no candidate.
- A full stub reports running/limit values.
- Memory rejection reports requested, reserved, allocation limit, and current pressure separately.
- Diagnostics are read-only and do not assign, requeue, reprioritize, or append lifecycle events.
- Scheduler and diagnosis tests prove identical eligibility outcomes for the same task/stub fixtures.

**Implementation status (2026-07-11):** H1/H2, both CLI commands, and task-inspector rejection details are implemented. Status snapshots now include `pending_reasons`. A compact task-row reason badge remains UI follow-up; the authoritative API and CLI path is available now.

## Stream I: Reservation-aware memory admission (P0)

**User problem:** Increasing `max_concurrent` can dispatch several memory-heavy tasks that initialize together and OOM.

**Root cause:** With live GPU telemetry, `availableVram()` uses current free memory but does not subtract memory reserved by newly assigned tasks that have not allocated yet. `max_concurrent` limits count only. Task resource requirements are optional, so unknown tasks can share a GPU unsafely.

**Files:**
- Modify: `server/src/scheduler.ts`
- Modify: `server/src/types.ts`
- Modify: `server/src/store/schema.ts`
- Modify: `server/src/store/index.ts`
- Modify: `stub/alchemy_stub/daemon.py`
- Modify: `stub/alchemy_stub/process_mgr.py`
- Modify: `sdk/alchemy_sdk/experiment.py`
- Test: `server/src/__tests__/scheduler.test.ts`
- Test: `stub/tests/test_cgroup_memory.py`
- Test: `sdk/tests/test_experiment_spec.py`

### I1. Resource declaration

Extend task requirements:

```ts
requirements: {
  gpu_type?: string[];
  gpu_mem_mb?: number;
  cpu_mem_mb?: number;
  cpu_cores?: number;
  exclusive_gpu?: boolean;
}
```

Unknown GPU-memory requirements default to `exclusive_gpu=true` for GPU tasks. The SDK dry-run warns when GPU work lacks an explicit reservation.

### I2. Reservation ledger

Persist resource reservations for `assigned`, `running`, and `paused` tasks. Admission uses the Slurm/cgroup allocation as the ceiling:

```text
allocation budget
- assigned reservations
- running reservations
- safety headroom
= allocatable remainder
```

Keep whole-host and same-user pressure as additional diagnostic/safety signals; never relabel either as this Slurm job's actual use. The allocation cgroup is the authoritative actual-use boundary. Avoid double-counting running telemetry and declared reservation: define and test one conservative formula.

Reservations are admission estimates, not hard enforcement. A task may exceed its reservation. On overage, Alchemy records `reservation_overage_mb`, stops admitting new siblings to that allocation, and marks the stub memory-pressured. It must not kill or pause the over-budget task automatically. CPU hard isolation may later use nested cgroups or Slurm steps where supported; GPU-memory hard limits are not portable without MIG/application cooperation.

For GPU memory, subtract assigned reservations even before NVML usage rises. Use a configurable 10–15% safety headroom for CUDA context, workspace, and fragmentation. Running usage above reservation creates reservation debt and reduces allocatable remainder to zero until pressure clears.

### I3. Per-task peak telemetry

Stub reports per-task:

```text
pid
rss_mb
peak_rss_mb
gpu_memory_mb
peak_gpu_memory_mb
oom_gpu
oom_cpu
```

Where exact per-process GPU attribution is unavailable, label it unavailable; do not fabricate a split from whole-device usage.

### I4. OOM learning and retry

Store peak usage by task fingerprint. A future submission may use a conservative p95 estimate when no explicit requirement is provided. First runs remain exclusive. An OOM retry may increase reservation or request exclusive placement, but must not silently change training hyperparameters.

### I acceptance gates

- Two assigned tasks cannot both consume the same unreserved free VRAM.
- Whole-host memory, same-user aggregate memory, allocation memory, per-task process memory, and reservations remain distinct fields.
- An 80 GiB Slurm allocation is the hard CPU-memory ceiling even when the host has more RAM.
- Other users' host usage remains visible as pressure; same-user usage is diagnostic and may span multiple jobs.
- Reservation overage blocks new sibling admission and is observable, but does not destructively kill the running task.
- Unknown GPU tasks run exclusively.
- `max_concurrent=5` cannot override failed memory admission.
- OOM classification identifies the failed task and does not kill/retry unrelated siblings as one unit.

**Implementation status (2026-07-11):** the I1/I2 admission core is implemented for `gpu_mem_mb`, `cpu_mem_mb`, and `exclusive_gpu`. Assigned/running/paused task declarations form the persisted reservation ledger; Slurm allocation memory is the CPU ceiling; GPU admission subtracts assigned reservations before telemetry rises; headroom defaults to 15% GPU / 5% CPU and is configurable with `ALCHEMY_GPU_MEMORY_HEADROOM_RATIO` / `ALCHEMY_CPU_MEMORY_HEADROOM_RATIO`. Attributed reservation overage exposes pressure in assignment diagnostics and blocks new siblings without killing work. `cpu_cores`, peak telemetry/OOM classification (I3), and learned retry estimates (I4) remain follow-up and are not claimed complete.

## Stream J: Capacity leases and A30 autoscaling (P1, after H and I)

**User problem:** Agents manually add and release cards. Independent 600-second stub idle timers may release several cards together and do not understand server-side ready work. Manual scripts and an autoscaler could fight.

**Current behavior:** Slurm stubs default to `idle_timeout=600`; the stub checks every 30 seconds and self-cancels when it has no local running process. This remains a safety fallback, not the desired pool controller.

**Files:**
- Create: `server/src/capacity/`
- Create: `server/src/api/capacity.ts`
- Modify: `server/src/store/schema.ts`
- Modify: `server/src/store/index.ts`
- Modify: `server/src/index.ts`
- Modify: `sdk/alchemy_sdk/cli/main.py`
- Modify: `web/src/` capacity page
- Test: `server/src/__tests__/capacity-controller.test.ts`

### J1. Ownership and leases

Persist:

```text
managed_by = manual | autoscaler
pool_id
capacity_lease_id
pinned
created_reason
slurm_job_id
requested_at
online_at
last_busy_at
```

Autoscaler only drains/releases `managed_by=autoscaler && pinned=false`. Manual `alch slurm submit` defaults to manual+pinned. Watchers release their lease, not arbitrary job IDs.

### J2. Pool policy

Initial A30 pool:

```yaml
pool_id: slurm-a30-auto
min_warm: 0
max_total_a30: 3
max_concurrent_per_stub: 1
walltime: 3-00:00:00
scale_up_backlog_s: 30
scale_up_cooldown_s: 60
scale_down_idle_s: 600
scale_down_step: 1
scale_down_cooldown_s: 300
recent_activity_warm_window_s: 1800
```

`max_total_a30=3` counts manual, autoscaler-owned, online, and Slurm-pending A30 jobs. This prevents QOS spam and script/controller races.

### J3. Demand model

Scale from compatible **ready pending** work only. Exclude blocked descendants, stale exact targets, tasks rejected by memory admission, and already provisioned Slurm jobs. Desired replicas are bounded by both queue demand and the global three-A30 cap.

Scale up one card per reconcile, then re-evaluate; allow rapid consecutive reconciles until the cap. Newly launched cards do not imply ownership of a particular task unless a capacity lease or compatible routing constraint says so.

### J4. Gradual scale-down and hysteresis

When no compatible ready work exists and a stub has no assigned/running task for 600 seconds:

```text
drain oldest idle autoscaler stub
release one Slurm job
wait 300 seconds
reconcile again
```

Do not let all stubs independently disappear together. If the queue was active in the previous 30 minutes, optionally retain one warm card. A later burst creates a new Slurm job; a cancelled job cannot be resurrected.

Keep stub-local `idle_timeout` as a longer fail-safe once the controller is authoritative, or make it lease-aware so targeted pending work prevents self-cancellation.

### J5. APIs and rollout

```text
GET    /api/capacity/pools
GET    /api/capacity/status
POST   /api/capacity/reconcile
POST   /api/capacity/leases
PATCH  /api/capacity/leases/:id
DELETE /api/capacity/leases/:id
```

Roll out in `recommend-only` mode first. Record proposed scale actions for several days. Enable real `sbatch/scancel` only after simulation shows no interference with manual jobs.

### J acceptance gates

- Total A30 jobs never exceeds three, including manual and Slurm-pending jobs.
- Manual/pinned jobs are never auto-released.
- Blocked DAG leaves do not cause scaling.
- Scale-down releases only one card per cooldown.
- A queue burst during cooldown can immediately reverse desired capacity without duplicate submissions.
- Reconcile is idempotent under repeated/concurrent calls.
- Every capacity action includes actor, reason, lease, and prior/new desired state.

## Stream K: Expedited queue API (P1)

**User value:** Operators sometimes need an evaluation or blocking task to run before ordinary pending work.

**Current behavior:** Tasks already have integer `priority`; the global queue sorts by descending priority then creation time, and `PATCH /tasks/:id` can update priority. The missing pieces are explicit semantics, TTL, audit, experiment scope, and UI. Priority updates should trigger immediate re-scheduling rather than waiting for the 30-second periodic loop.

**Files:**
- Modify: `server/src/api/tasks.ts`
- Modify: `server/src/api/experiments.ts`
- Modify: `server/src/store/schema.ts`
- Modify: `server/src/scheduler.ts`
- Modify: `sdk/alchemy_sdk/cli/main.py`
- Modify: `web/src/` queue controls
- Test: `server/src/__tests__/api-tasks.test.ts`

### K1. API

```text
POST /api/tasks/:id/expedite
POST /api/experiments/:id/expedite
```

Request:

```json
{
  "class": "urgent",
  "ttl_s": 1800,
  "reason": "blocking formal evaluation"
}
```

Persist `base_priority`, `effective_priority`, `expedite_class`, `expedite_until`, `expedite_actor`, and `expedite_reason`. TTL expiry restores base priority. Experiment expedite affects current/future ready leaves, not all blocked descendants indiscriminately.

### K2. No destructive preemption in v1

Expedite only reorders pending/assigned work. It never kills a running task. Later preemption requires all of:

```text
preemptible=true
checkpoint_contract=verified
resume_contract=verified
not checkpoint-protected
```

The future sequence is checkpoint request, artifact/checksum confirmation, graceful stop, urgent task, then resume. No verified resume contract means no preemption.

### K acceptance gates

- Expedited pending task moves ahead immediately and the scheduler is triggered.
- TTL restores original priority.
- Actor and reason are auditable.
- Running tasks are untouched.
- Capacity and assignment diagnosis reflect the new effective priority.
- Experiment expedite respects dependencies and canonical replacement refs.

## Stream L: Result contracts and native experiment waiting (P1)

**User problem:** `exit_code=0` can be confused with research success; result artifacts may be absent from Alchemy even when files exist. Agents repeatedly write custom watchers and sometimes guess the wrong artifact directory.

**Files:**
- Modify: `server/src/api/experiments.ts`
- Modify: `server/src/api/tasks.ts`
- Modify: `server/src/store/schema.ts`
- Modify: `sdk/alchemy_sdk/experiment.py`
- Modify: `sdk/alchemy_sdk/cli/main.py`
- Add tests across server and SDK

### L1. Four independent statuses

Expose:

```text
execution_status
artifact_validation_status
protocol_status
research_decision
```

`completed` means process completion only. Experiment UI must not render process success as research success.

### L2. Artifact contract

On successful exit, validate declared outputs, path safety, size, and checksum. Persist canonical artifact records. `result_schema` validation is fail-loud. Declared output paths are authoritative; watchers and clients never infer `artifacts/` versus `results/`.

### L3. Native wait and aggregation

Add:

```bash
alch experiments wait <id> --aggregate-results --notify
```

The status snapshot returns canonical replacement task IDs, terminal counts, missing/invalid artifacts, compact metrics, and decision summary. Capacity lease release is explicit and separate from result aggregation.

### L acceptance gates

- `5/5 execution completed, research 0/1` is represented without ambiguity.
- Missing declared artifacts make artifact validation fail even with exit code zero.
- Replacement attempts resolve to canonical refs.
- One experiment produces one completion notification, not per-task spam.
- A watcher can fetch artifacts through SDK methods without guessing filesystem paths.

## Stream M: Operator configuration, immutable runtimes, and logical routing (P2)

### M1. Operator diagnostics

`alch doctor` reports server reachability, configured state DB path, auth source, and only a boolean credential-discovered status. It never prints a credential. A 401 response includes actionable operator-config guidance instead of encouraging project-local token wrappers.

### M2. Immutable runtime builds

Evolve `RuntimeProfile` from shared cwd/env defaults to a Git-SHA and dependency-lock-addressed runtime manifest with build/cache status. Remove repeated absolute `PYTHONPATH` assembly once the package is installed into the immutable environment.

### M3. Logical capacity routing

Allow tasks to target `capacity_lease_id` or logical pool requirements instead of a transient stub ID. If a Slurm stub expires and is recreated under the same valid lease, pending tasks remain schedulable rather than becoming stranded on the old ID.

## Updated implementation order

```text
P0: H assignment diagnosis
P0: I reservation-aware memory admission
P1: J capacity leases + recommend-only autoscaler
P1: K non-preemptive expedite API
P1: L result contracts + native wait
P2: M operator doctor + immutable runtime + logical lease routing
P3: verified checkpoint/resume preemption
```

Do not enable real autoscaling before H and I land: without explainability and reservation-aware admission, autoscaling only multiplies opaque pending states and OOMs.

## Development operating model

Future implementation sessions must:

- read this addendum first;
- inspect `git status` and current tests;
- choose the first unfinished stream in updated priority order;
- use RED-GREEN-REFACTOR for each behavior;
- keep server tests on isolated temporary state/ports;
- never test development code against production state;
- commit small signed slices with explicit staging;
- update this roadmap when implementation evidence invalidates an assumption;
- keep deployment/restart separate and require explicit authorization.
