# Alchemy v2 Performance, Capacity, and Campaign Roadmap

> **For Hermes:** Read `ROADMAP_V2.2.md` and this file first. Implement the first unchecked milestone with TDD and small signed commits. If code evidence contradicts this roadmap, patch and commit the roadmap before continuing.

**Goal:** Make Alchemy responsive at current registry size and turn managed Slurm capacity into a queue-aware, observable, campaign-oriented substrate across A16/A30/A40/T4.

**Architecture:** Keep Alchemy's task scheduler canonical. Separate three concerns: task admission and priority, capacity planning and Slurm allocation, and campaign orchestration. Persist logical allocation/lease identities before a stub is online so tasks and campaigns never depend on a transient stub ID. Keep deploy/restart and production rollout separate from development.

**Tech stack:** Node.js/TypeScript + Express + Socket.IO + SQLite/Drizzle, Python controller and SDK/CLI, React/Vite.

**Implementation status (2026-07-30):**

- [x] Milestone 0 — bounded SQLite-backed collection queries, brief pagination, one-pass status aggregation, and non-overlapping visibility-aware Web polling.
- [x] Milestone 0.5 — stable mnemonic aliases and direct canonical ref resolution for Experiment/Task.
- [x] Retained Stream K — persisted TTL-bounded, non-preemptive effective priority with explicit expedite/unexpedite APIs.
- [x] Retained Stream L — native SDK experiment wait with explicit successful terminal-status contract.
- [x] Milestone 1 — configuration-driven GPU target catalog, durable idempotent allocation records, custom job names, and canonical managed submission path.
- [x] Milestone 2 — controller snapshots automatically reconcile allocation state and exact `job_id -> stub_id` binding.
- [x] Milestone 3 — recommend-only planner preserves explicit partition/QOS/GPU constraints and explains observed ranking.
- [~] Milestone 4 — logical routing plus a restart-safe, serial campaign reconciler now cover the full bounded lifecycle with stable side-effect keys, bounded retries/runtime, release/closeout proof, and persisted unresolved cleanup obligations; concrete production smoke/DAG/acquire/release adapters remain intentionally unwired.
- [x] Milestone 5 — target/allocation/campaign CLI controls and managed-only, pinned-safe bulk cancellation with default dry-run.
- [x] Milestone 6 — Capacity & Campaigns Web operations view with serial polling, target snapshot timestamps, planner recommendations/rejections, ownership and allocation→stub→active-task binding, predicted queue start, policy audit events, campaign transition timeline/cleanup obligations, and dry-run release previews.
- [x] Milestone 7 — append-only policy audit events, stable recommendation idempotency, exact server-catalog validation, server-owned recommendation injection, real active-task/campaign cleanup release guards, and a persisted one-way kill switch; default remains recommend-only and no automatic production policy is configured.

---

## 1. Product boundaries

- Tasks declare workload requirements; they do not choose a physical GPU model unless the workload truly requires one.
- The scheduler decides which **online stub** can execute a ready task. The capacity planner decides which **Slurm allocation** should be requested for unmet ready demand.
- Priority orders ready work. Resource requirements determine compatibility. QOS/partition state affects capacity acquisition, not scientific semantics.
- A Slurm allocation exists before its stub. Persist it immediately after submission and bind `job_id -> stub_id` when registration arrives.
- Campaigns are bounded, persisted state machines. They may perform only declared transitions: acquire capacity, wait, run a managed smoke, submit a frozen DAG, wait, drain, release, and close out.
- No destructive preemption in this roadmap. Never kill unrelated running work to satisfy a new campaign.
- Automatic planning starts in recommend-only mode. Real `sbatch/scancel` requires explicit policy enablement and audited ownership.
- Development tests use temporary state and mocked Slurm/controller responses. Do not request production APIs, submit Slurm jobs, deploy, restart, or touch live tasks while implementing.

## 2. Verified current gaps

### Performance

- `GET /api/experiments` is unpaginated and returns full experiment blobs. At the audited state size, 1,183 records occupy 24.95 MB; a brief projection is about 317 KB.
- Experiment/grid status derivation calls `getGridTasks()` per item. `getGridTasks()` scans and JSON-parses every archived task before filtering by `grid_id`, producing `E × T` work.
- `GET /api/tasks` paginates only after loading, parsing, filtering, counting, and sorting the full task corpus.
- Web pages use overlapping `setInterval` polling without an in-flight guard. A slow endpoint creates a request storm.
- SDK/CLI experiment commands resolve known UUIDs by first enumerating `/experiments`.

### Managed Slurm capacity

- `alch slurm submit` and `stubs canary` hard-code A30/A40/T4 choices in `sdk/alchemy_sdk/cli/main.py`; A16 cannot be selected even when deploy/cluster configuration supports it.
- `server/src/deploy.ts` hard-codes generated job names as `train_stub_<target>`; the controller path hard-codes `train_ct`.
- Capacity selection is manual. Alchemy does not compare compatible A16/A30/A40/T4 options using ready queue demand, task priority/resources, QOS limits, partition pressure, or already-pending allocations.
- Slurm submission generally returns only a job ID. Queue reason, predicted start, pending age, partition pressure, and allocation-to-stub binding are not first-class records.
- A task can target a current `stub_id`, but cannot target a pending allocation/lease before the stub registers.
- The CLI has no persisted campaign primitive and no safe one-command cancellation of a user-owned batch/campaign.

## 3. Priority order

```text
P0  Milestone 0 — stop collection/API request amplification
P1  Milestone 0.5 — unified mnemonic aliases and ref resolution
P1  Retained Stream K — audited non-preemptive expedite/effective priority
P1  Retained Stream L — result contracts and native experiment waiting
P1  Milestone 1 — generic GPU target catalog and persisted allocation records
P1  Milestone 2 — Slurm queue observability and allocation-to-stub binding
P1  Milestone 3 — queue-aware multi-GPU capacity planner, recommend-only
P1  Milestone 4 — logical pending-capacity routing and queued campaigns
P2  Milestone 5 — Slurm/campaign CLI and safe batch cancellation
P2  Retained Stream M1/M2 — operator doctor and immutable runtimes
P2  Milestone 6 — Web capacity/campaign operations UI
P3  Milestone 7 — policy-enabled automatic acquisition after audit
P3  verified checkpoint/resume preemption
```

Milestone 0 is independent and should land first because current collection endpoints can saturate the server. Streams K and L remain live work from `ROADMAP_V2.2.md`: the planner consumes K's audited `effective_priority`, while campaigns must use L's canonical artifact/result/wait contracts rather than inventing a second completion model. Milestones 1–2 form the substrate for 3–6. Milestone 4 supersedes only M3's logical-routing slice; M1 operator diagnostics and M2 immutable runtimes remain separate P2 work. Do not implement campaign automation on transient job IDs, opaque queue state, or guessed result paths.

### Retained-stream integration gates

- **Stream K:** expedite changes pending order only, is TTL/audit bounded, triggers scheduling, and never bypasses resource/QOS compatibility. Capacity planning reads `effective_priority`; it does not create a second priority field.
- **Stream L:** campaign `wait` and closeout consume canonical replacement refs, artifact validation status, protocol status, and one experiment-level completion result. A process exit code alone cannot advance a campaign to scientific completion.
- **Stream M1/M2:** `alch doctor` includes target/controller/allocation capability without secrets; frozen campaign manifests bind an immutable runtime/protocol identity.

---

## Milestone 0 — Collection API performance (P0)

**User value:** Experiments, Grids, Tasks, dashboard, and CLI remain responsive as history grows.

### 0.1 Eliminate per-item archive scans

Add request-scoped/bulk task grouping so a list/report/tree request reads tasks at most once and groups them by `grid_id`. Then normalize `tasks.grid_id` into a real indexed column and make `getGridTasks(gridId)` query only matching rows.

**Files:**
- Modify: `server/src/store/schema.ts`
- Modify: `server/src/store/index.ts`
- Modify: `server/src/api/experiments.ts`
- Modify: `server/src/api/grids.ts`
- Test: `server/src/__tests__/experiment-api.test.ts`
- Test: `server/src/__tests__/experiments-tree.test.ts`
- Test: `server/tests/store.test.ts`

### 0.2 Add compact server-side catalogs

Introduce compact, cursor- or offset-paginated list contracts. List responses must exclude `task_specs`, `sdk_spec`, result details, logs, and full configs unless explicitly requested by a detail endpoint.

```text
GET /api/experiments?view=summary&limit=50&cursor=...
GET /api/grids?view=summary&limit=50&cursor=...
GET /api/tasks?limit=50&offset=...&status=...
```

Return separate `items`, `next_cursor`/`offset`, `total`, and lightweight facets/counts. Keep the legacy full experiment-list contract temporarily for compatibility, but migrate Web and SDK away from it before deprecation.

### 0.3 Stop polling storms

Replace naked intervals with one shared polling helper or query layer that provides:

- at most one in-flight request per key;
- abort on unmount/filter change;
- next poll scheduled only after completion;
- pause while the tab is hidden;
- backoff after failure;
- no all-family research report until the user requests it.

**Files:**
- Modify: `web/src/pages/ExperimentsPage.tsx`
- Modify: `web/src/components/experiments/ExperimentReviewWorkspace.tsx`
- Modify: `web/src/pages/GridsPage.tsx`
- Modify: `web/src/pages/TasksPage.tsx`
- Create or modify: `web/src/lib/` shared polling utility
- Test: corresponding `web/src/**/__tests__/*`

### 0.4 Direct experiment resolution

Known UUIDs must call exact endpoints directly. Add a compact server resolver for human name/code ID without downloading the collection.

```text
GET /api/experiments/resolve?ref=<uuid|name|code_id>
```

Migrate `ExperimentClient.resolve()` and CLI `find_experiment()`.

**Acceptance gates:**

- 1,200 experiments / 5,500 tasks fixture: first experiment catalog response below 1 MB and one bulk/indexed task lookup, never one archive scan per experiment.
- Task pagination filters/sorts in SQLite; it does not parse all archived task JSON to return 50 rows.
- A ten-minute simulated slow response never creates a second in-flight request for the same page/query.
- Known UUID `show/summary/recommend/manifest/timeline/bundle` never accesses the collection endpoint.
- Legacy callers remain covered until the compatibility endpoint is explicitly removed.

---

## Milestone 0.5 — Unified mnemonic aliases and ref resolution (P1)

**User value:** Operators and agents can refer to durable objects with short, pronounceable refs instead of copying UUIDs, while UUIDs remain canonical.

### 0.5.1 Canonical identity model

Every supported object exposes three distinct identities:

```text
id       immutable canonical UUID
alias    immutable server-generated mnemonic ref
name     optional mutable/semantic display name
```

Initial object kinds are `task` and `experiment`; future `campaign`, `capacity_lease`, and `slurm_allocation` creation must use the same service. Stub semantic names remain the existing user-facing ref and do not gain a redundant alias.

Alias format is type-prefixed and globally unambiguous:

```text
exp-amber-otter-7k2m
task-cobalt-fox-2p9r
camp-gentle-tiger-9m4x
lease-bright-raven-3d6w
alloc-silent-cedar-8k2p
```

The word list is versioned, curated for spelling/pronunciation, and fixed once released. Generation is deterministic from canonical ID plus collision nonce, persisted at creation/backfill, protected by a unique index, and never recomputed for display. Collision handling extends/changes the hash suffix; it never silently reassigns an existing alias.

### 0.5.2 One resolver

All API/CLI `<ref>` handling uses one canonical resolver with strict precedence:

```text
exact canonical ID
-> exact alias
-> exact domain name/code_id where supported
-> fail not-found or fail-ambiguous
```

No prefix guessing and no first-match behavior. Resolution returns canonical `id`, `alias`, `kind`, and display name. Internal dependencies, task refs, DB relations, socket payloads, and audit events continue storing canonical IDs only.

### 0.5.3 Persistence and rollout

Create a generic alias registry rather than separate module-specific implementations:

```text
object_aliases(alias PRIMARY KEY, object_kind, object_id, created_at, scheme_version)
UNIQUE(object_kind, object_id)
```

Backfill existing tasks/experiments idempotently in bounded transactions. New object creation persists the object and alias atomically. API responses add `alias` without removing `id`; list/detail/diagnosis/log output prefers alias visually but includes canonical ID where audit/debugging needs it.

```text
GET /api/refs/:ref
GET /api/experiments/resolve?ref=...
```

Task and experiment exact routes accept canonical ID or exact alias after store-level resolution. SDK/CLI avoids collection enumeration and accepts either form.

**Files:**
- Create: `server/src/aliases.ts`
- Modify: `server/src/store/schema.ts`
- Modify: `server/src/store/index.ts`
- Create: `server/src/api/refs.ts`
- Modify: `server/src/api/tasks.ts`
- Modify: `server/src/api/experiments.ts`
- Modify: `server/src/types.ts`
- Modify: `server/src/index.ts`
- Modify: `sdk/alchemy_sdk/experiments.py`
- Modify: `sdk/alchemy_sdk/cli/main.py`
- Test: `server/src/__tests__/aliases.test.ts`
- Test: `server/src/__tests__/api-tasks.test.ts`
- Test: `server/src/__tests__/experiment-api.test.ts`
- Test: `sdk/tests/test_cli.py`
- Test: `sdk/tests/test_experiment_lineage.py`

**Acceptance gates:**

- Existing and newly created tasks/experiments have stable aliases across restart.
- Aliases are globally unique, immutable, type-prefixed, and collision-safe.
- Task/experiment detail routes accept alias and return both `id` and `alias`.
- Known UUID and alias CLI operations do not enumerate collection endpoints.
- Ambiguous names fail visibly; aliases never use name fallback.
- Internal persisted relationships continue using canonical UUIDs.
- Backfill is idempotent and does not rewrite task/experiment scientific payloads.

---

## Milestone 1 — Generic GPU target catalog and allocation records (P1)

**User value:** A16 becomes a supported managed target, and adding future GPU types requires configuration rather than CLI code edits.

### 1.1 Config-driven target catalog

Remove argparse `choices` as the source of truth. Expose configured managed targets and capabilities through a compact API:

```text
GET /api/capacity/targets
```

Each target includes stable ID, aliases, partition, GRES, GPU model/class, VRAM, default QOS/memory/walltime, tags, enabled state, and controller capability. Add `slurm-a16` to deploy configuration with values verified from cluster config; never guess partition/GRES/QOS.

### 1.2 Persist allocations before stub registration

Create a `slurm_allocations` table:

```text
id                       logical allocation UUID
job_id                   nullable until sbatch acknowledgement
campaign_id              nullable
capacity_lease_id        nullable
managed_target_id
gpu_class
partition / qos / gres
requested_resources
job_name
owner / managed_by / pinned
state                    requested|submitted|pending|running|stub_online|draining|released|failed
queue_reason
requested_at / submitted_at / eligible_at / predicted_start_at / started_at / online_at / released_at
stub_id                  nullable until bound
last_observed_at
error
```

Idempotency keys must prevent duplicate allocations after client/controller timeouts.

### 1.3 One canonical submission path

Converge `server/src/deploy.ts` and controller `slurm.submit` around one typed request/response contract. Both paths must support `job_name`, ownership, campaign/lease IDs, and structured status. Do not leave separate hard-coded `train_stub_*` and `train_ct` semantics.

**Files:**
- Modify: `deploy-config.yaml`
- Modify: `server/src/types.ts`
- Modify: `server/src/store/schema.ts`
- Modify: `server/src/store/index.ts`
- Modify: `server/src/deploy.ts`
- Modify: `server/src/api/deploy.ts`
- Create: `server/src/api/capacity.ts`
- Modify: `controller/alchemy_controller/daemon.py`
- Modify: `sdk/alchemy_sdk/cli/main.py`
- Test: `server/src/__tests__/deploy.test.ts`
- Create: controller tests for target parsing/submission contract
- Test: `sdk/tests/test_cli.py`

**Acceptance gates:**

- A16 appears from configuration and can be selected without adding a new argparse branch.
- Submission persists an allocation record before waiting for a stub.
- Retrying a timed-out request with the same idempotency key cannot create a second job.
- Job name is sanitized, length-bounded, persisted, and identical in generated sbatch metadata and API output.
- Existing A30/A40/T4 commands remain compatible.

---

## Milestone 2 — Slurm observability and binding (P1)

**User value:** Operators can see why a job is queued, when it may start, partition pressure, and which stub eventually belongs to it without manual SSH.

### 2.1 Enrich controller snapshots

Collect structured data from `squeue`, `squeue --start` where supported, and `sinfo`:

```text
job_id, job_name, state, reason, pending_since, elapsed,
eligible_time, predicted_start_at, partition, qos, requested_gres,
requested_mem, requested_cpus, node, user
```

Partition summaries expose total/idle/allocated/drained nodes and GPUs, pending counts by reason/QOS, and snapshot timestamp. Unknown start estimates stay `null`; never fabricate ETA.

### 2.2 Persist and reconcile observations

The server reconciles controller snapshots into `slurm_allocations`. Missing jobs require explicit reconciliation states rather than immediately assuming release. Preserve the timeout/late-side-effect grace window.

### 2.3 Bind job to stub

On stub registration with `slurm_job_id`, bind the matching allocation atomically and expose:

```text
allocation_id -> job_id -> stub_id
```

If multiple candidates or mismatched target metadata appear, fail visibly and do not silently bind the wrong stub.

### 2.4 Read surfaces

```text
GET /api/capacity/allocations
GET /api/capacity/allocations/:id
GET /api/capacity/partitions
GET /api/capacity/allocations/:id/diagnosis
```

`diagnosis` reports queue reason, pending age, predicted start if available, partition/QOS pressure, and suggested operator action.

**Files:**
- Modify: `controller/alchemy_controller/daemon.py`
- Modify: `server/src/socket/controller.ts`
- Modify: `server/src/socket/stub.ts`
- Modify: `server/src/api/cluster.ts`
- Modify: `server/src/api/capacity.ts`
- Modify: `server/src/store/index.ts`
- Test: controller parser/reconciliation tests
- Test: `server/src/__tests__/stub-identity.test.ts`
- Create: `server/src/__tests__/capacity-controller.test.ts`

**Acceptance gates:**

- A pending job displays the real Slurm reason and pending age.
- Predicted start is clearly nullable and source-labelled.
- Stub registration binds the exact `slurm_job_id` to one allocation.
- Controller disconnect marks observations stale without deleting allocations.
- No status endpoint performs SSH directly from the Web request path.

---

## Milestone 3 — Queue-aware multi-GPU capacity planner (P1)

**User value:** Alchemy recommends the best available A16/A30/A40/T4 lane using real ready demand rather than a hard-coded GPU choice.

### 3.1 Demand model

Input only compatible **ready pending** tasks. Exclude blocked descendants, stale exact targets, tasks that fail admission, and work already covered by online or pending allocations. Group demand by:

- effective priority;
- GPU compatibility set and minimum VRAM;
- CPU memory/cores;
- required runtime/Python environment;
- QOS or deadline policy where explicitly declared;
- campaign/lease ownership.

### 3.2 Deterministic candidate scoring

For each configured target, explain:

```text
compatible task count and highest priority
online idle slots
already-pending allocations
partition idle capacity
queue reason and predicted start
QOS eligibility/caps
fit waste (VRAM/memory)
policy cost/preference
```

Return a ranked plan with rejection reasons. Prefer an existing compatible idle stub, then an already-pending owned allocation, then the smallest suitable target with the best queue outlook. Never scatter speculative submissions across several GPU classes for the same demand.

### 3.3 Recommend-only API first

```text
GET  /api/capacity/plan
POST /api/capacity/reconcile?mode=recommend
```

Persist plan snapshots and reasons. Run simulation against fixtures and read-only captured controller snapshots before enabling mutation.

### 3.4 Policy model

Replace the A30-only assumptions in Stream J with configurable pools:

```yaml
pools:
  - id: general-gpu
    targets: [slurm-a16, slurm-t4, slurm-a30, slurm-a40]
    max_total: 3
    max_pending: 2
    max_concurrent_per_stub: 1
    scale_down_idle_s: 600
    acquire_mode: recommend
```

Caps count online, pending, manual, campaign-owned, and autoscaler-owned allocations according to explicit ownership policy.

**Files:**
- Create: `server/src/capacity/planner.ts`
- Create: `server/src/capacity/reconciler.ts`
- Modify: `server/src/capacity/` from Stream J if present
- Modify: `server/src/scheduler.ts` only to reuse canonical compatibility/admission functions
- Modify: `server/src/api/capacity.ts`
- Test: `server/src/__tests__/capacity-controller.test.ts`
- Test: `server/tests/scheduler.test.ts`

**Acceptance gates:**

- An A16-compatible workload can select A16 when it is the best available target.
- A workload requiring more VRAM rejects A16/T4 with explicit reasons and selects a compatible target.
- Priority changes ranking but never bypasses resource incompatibility or QOS limits.
- Existing idle compatible capacity wins over creating a new job.
- Pending allocations are counted; repeated reconcile is idempotent.
- Recommend mode performs no `sbatch/scancel`.

---

## Milestone 4 — Logical pending-capacity routing and queued campaigns (P1)

**User value:** Submit work against a pending managed allocation and express `card online -> CUDA smoke -> submit DAG -> drain -> release` without a custom watcher.

### 4.1 Logical targeting

Extend task routing with mutually exclusive selectors:

```text
target_stub_id
target_capacity_lease_id
target_pool_id
```

A task bound to a pending lease remains pending with `capacity_pending`, not `target_stub_offline`. When the allocation's stub binds to the lease, scheduling proceeds automatically. If the allocation fails/expires, diagnosis points to the lease and campaign rather than a dead transient stub ID.

### 4.2 Campaign model

Persist:

```text
campaigns
campaign_steps
campaign_events
```

Canonical state machine:

```text
planned
-> acquiring_capacity
-> capacity_pending
-> stub_online
-> smoke_running
-> smoke_passed
-> dag_submitted
-> workload_running
-> draining
-> releasing
-> completed
```

Every transition has an idempotency key, actor, timestamp, input/output artifact, and failure policy. Failed smoke or DAG submission moves to `failed_cleanup_required`, performs bounded owned-resource cleanup, and never submits formal work.

### 4.3 Frozen DAG handoff

A queued campaign stores a frozen submission manifest or an immutable code/protocol reference before acquiring capacity. The campaign may submit only that declared DAG after smoke admission. It cannot redesign work based on results.

### 4.4 Recovery

Campaign reconciliation survives server/controller reconnects and client exit. It recovers late-created allocations, canonical task IDs, drain state, and cleanup obligations without duplicate jobs or experiments.

### 4.5 API

```text
POST   /api/campaigns
GET    /api/campaigns
GET    /api/campaigns/:id
POST   /api/campaigns/:id/start
POST   /api/campaigns/:id/cancel
POST   /api/campaigns/:id/reconcile
GET    /api/campaigns/:id/events
```

**Files:**
- Modify: `server/src/types.ts`
- Modify: `server/src/store/schema.ts`
- Modify: `server/src/store/index.ts`
- Create: `server/src/campaigns/`
- Create: `server/src/api/campaigns.ts`
- Modify: `server/src/scheduler.ts`
- Modify: `sdk/alchemy_sdk/experiment.py`
- Test: `server/src/__tests__/campaigns.test.ts`
- Test: `sdk/tests/test_experiment_spec.py`

**Acceptance gates:**

- A frozen task/DAG can target a lease before any stub ID exists.
- Stub registration automatically unblocks lease-targeted work.
- Smoke failure creates no formal experiment/task and releases only campaign-owned capacity.
- Replaying every reconcile transition is idempotent.
- Cancellation never releases a manual/pinned or unrelated allocation.
- Campaign closeout proves zero active canonical tasks and terminal/released owned allocations.

---

## Milestone 5 — CLI operations and safe batch cancellation (P2)

**User value:** Capacity and campaigns are identifiable and manageable without hand-written SSH or watchers.

### 5.1 Dynamic submission

```bash
alch slurm targets
alch slurm submit a16 --job-name jema-d1-smoke --count 1 --campaign <id>
alch slurm plan --for-experiment <id>
```

Target validation comes from the server catalog. `--job-name` is optional, sanitized, and echoed in dry-run/output.

### 5.2 Visibility

```bash
alch slurm ls [--state pending|running] [--campaign <id>]
alch slurm status <allocation-or-job-id>
alch slurm why <allocation-or-job-id>
alch slurm partitions
```

Default output includes allocation ID, job ID, job name, target, state, queue reason, pending age, predicted start when available, campaign, lease, and bound stub.

### 5.3 Safe cancellation

```bash
alch slurm cancel <allocation-or-job-id> [--yes]
alch slurm cancel-batch --campaign <id> [--yes]
alch campaigns cancel <id> [--yes]
```

Batch cancellation is preview-only without `--yes`. It lists exact owned allocations and active tasks, refuses unrelated/manual/pinned jobs, drains online stubs first when work is active, and records partial failures. A single command must not mean blind `scancel` over arbitrary IDs.

### 5.4 Campaign CLI

```bash
alch campaigns create --manifest campaign.yaml
alch campaigns start <id>
alch campaigns show <id>
alch campaigns wait <id>
alch campaigns reconcile <id>
```

**Files:**
- Modify: `sdk/alchemy_sdk/cli/main.py`
- Create: `sdk/alchemy_sdk/capacity.py`
- Create: `sdk/alchemy_sdk/campaigns.py`
- Test: `sdk/tests/test_cli.py`
- Create: `sdk/tests/test_capacity.py`
- Create: `sdk/tests/test_campaigns.py`

**Acceptance gates:**

- A16 works without hard-coded parser choices.
- Custom job names reach the persisted allocation and sbatch script.
- Batch cancellation dry-run shows the exact effect and mutates nothing.
- `--yes` cancels only campaign-owned allocations and reports every result.
- CLI never asks users to SSH for ordinary queue diagnosis.

---

## Milestone 6 — Web operations UI (P2)

**Implementation status (2026-07-30): complete.** The combined Capacity & Campaigns view uses the Milestone 0 serial polling hook and exposes target observation timestamps, explicit planner recommendations and rejection explanations, ownership and allocation→stub→active-task links, predicted queue starts, policy audit events, campaign transition timelines and cleanup obligations, plus dry-run-only release previews.

Add Capacity and Campaign views using server snapshots, not browser-triggered SSH:

- target/partition cards with stale timestamp;
- pending/running allocations with reason and predicted start;
- `allocation -> stub -> tasks` linkage;
- planner recommendation with candidate rejection explanations;
- campaign state timeline and cleanup obligations;
- guarded drain/release/cancel previews.

Use the non-overlapping polling contract from Milestone 0.

**Files:**
- Create: `web/src/pages/CapacityPage.tsx`
- Create: `web/src/pages/CampaignsPage.tsx`
- Modify: `web/src/lib/api.ts`
- Modify: router/navigation files under `web/src/`
- Test: page/component tests under `web/src/**/__tests__/`

**Acceptance gates:**

- UI clearly distinguishes Slurm pending, job running, stub online, task assigned, and campaign complete.
- Queue reason and snapshot age are visible.
- No action button silently cancels unrelated jobs.
- Slow controller/API responses cannot overlap polling.

---

## Milestone 7 — Policy-enabled automatic acquisition (P3)

**Implementation status (2026-07-30): policy substrate complete, rollout disabled.** Policy reconciliation applies at most one action, preserves explicit recommendation resources, uses stable recommendation identities for idempotent retries, rejects non-catalog server recommendations, and requires a server-owned provider before automatic acquisition. Release eligibility is derived from persisted active tasks and campaign state rather than caller-injected pseudo-fields, and therefore excludes manual, pinned, busy, and unresolved-campaign allocations. Every recommendation/action is appended to an immutable policy-event ledger, and `/policy/disable` persists a one-way kill switch to recommend-only across restarts. No automatic policy is wired in the server, so no production acquisition or release is enabled.

Only after several days of recommend-only snapshots match operator decisions:

- enable acquisition per pool, not globally;
- retain explicit max total/pending caps;
- acquire at most one allocation per reconcile;
- preserve cooldown/hysteresis;
- never release manual/pinned allocations;
- emit an auditable reason for every `sbatch`, drain, and release;
- provide an immediate kill switch back to recommend-only.

Automatic release remains limited to idle, owned, unpinned allocations with no assigned/running/paused task and no unresolved campaign cleanup.

## 4. Cross-cutting data model

```text
Task
  -> target_stub_id?                 exact live worker
  -> target_capacity_lease_id?       logical pending/replaceable capacity
  -> target_pool_id?                 compatible managed pool

Campaign
  -> frozen_manifest
  -> capacity_lease_id
  -> allocation_ids[]
  -> canonical_experiment_id?
  -> canonical_task_refs

CapacityLease
  -> pool/requirements/owner/policy
  -> active allocation(s)

SlurmAllocation
  -> target/partition/qos/resources
  -> job_id
  -> queue observation
  -> stub_id?
```

Do not collapse these identities. Job IDs are scheduler instances; stub IDs are connected workers; leases are logical capacity intent; campaigns are workflow ownership.

## 5. Verification matrix

Run focused gates after every slice and full gates before merging:

```bash
cd server && npm run build
cd server && npm test -- --run
cd sdk && uv run pytest
cd controller && uv run pytest
cd web && npm test -- --run
```

Add fixture-based scale tests for 1,200 experiments / 5,500 tasks and parser fixtures for realistic `sinfo`, `squeue`, `squeue --start`, QOS-cap, Resources, Priority, drained-node, stale-controller, and unknown-ETA outputs.

Production deployment is not part of roadmap implementation. After merge, deployment requires a separate authorization, an active-task/stub safety check, and a small gated smoke.

## 6. Operating model for future sessions

1. Read `ROADMAP_V2.2.md` and this file.
2. Run `git status` and inspect the current implementation; do not assume milestone status from prose.
3. Select the first unchecked acceptance gate in priority order.
4. Write a failing focused test.
5. Implement the smallest behavior that passes.
6. Run focused tests, then the relevant package suite.
7. Stage explicit files and create a small signed commit.
8. Update this roadmap when a milestone lands or evidence changes the design.
9. Never deploy/restart or exercise production Slurm as part of development without explicit authorization.

## 7. Copy-paste `/goal` handoff

```text
/goal Continue Alchemy v2 maintenance from /Users/yuzhe/projects/alchemy-v2/docs/plans/2026-07-30-alchemy-maintenance-roadmap.md. Read ROADMAP_V2.2.md and CLAUDE.md first, inspect git status and current tests, then implement the first unfinished acceptance gate in priority order with RED-GREEN-REFACTOR and small signed commits. Keep task scheduling, capacity planning, and campaign orchestration separate. Use isolated state and mocked controller/Slurm fixtures; do not request production APIs, submit jobs, deploy, restart, or touch live tasks. If code evidence invalidates the roadmap, patch and commit the roadmap before continuing.
```
