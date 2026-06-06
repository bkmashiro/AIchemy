# Research Lineage / GitLens for ML Experiments Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

## Status

Phase 1 (intent / decision / timeline / detail panel), Phase 2
(lineage tree, summary, compare, GitLens-style rail with detached labels,
selected-path continuity), and the research-loop closeout (artifact /
checkpoint metadata events, `fork-plan` dry-run, server-side `ls` filters) are
**implemented**. The implementation tasks below are kept for context but
should be read as "shipped, not pending":

- Server: `server/src/api/experiments.ts`, `server/src/store/index.ts`
  (`experiment_events` table), `server/src/experiment-summary.ts`.
- SDK: `sdk/alchemy_sdk/experiment.py`, `sdk/alchemy_sdk/submit.py`,
  `sdk/alchemy_sdk/experiments.py` (read-only client; now also exposes
  `timeline()`, `fork_plan()`, and filtered `list(family=, decision=,
  status=)`), `sdk/alchemy_sdk/cli/main.py` (`experiments ls/show/timeline/
  note/decide/tree/compare/summary/diff/manifest/artifact/checkpoint/
  fork-plan`).
- Web: `web/src/pages/ExperimentsPage.tsx` +
  `web/src/components/experiments/*` (Intent, Decision, Lineage, Timeline,
  Matrix, GitLens lineage rail, Config diff, Research call cards).

Open follow-ups (not started):

- Timeline ordering + pagination: show experiment timeline events newest-first
  by default, with explicit pagination / cursor controls so long-running
  experiments do not render an unbounded event list. Keep an affordance to read
  oldest-first only when reconstructing a complete story.
- Recommendation wording pass: `rerun` is too operational and sounds like
  blindly repeating a job. For research guidance, test labels such as
  `Needs stronger evidence`, `Run fuller experiment`, or `Insufficient evidence`
  while preserving the underlying API enum until a migration is justified.
- Lineage graph → Research call coupling: clicking a lineage node should update
  the right-side Research call / compare context in-place, without a full page
  navigation. Keep `Open detail` as the explicit route change. This makes the
  graph a selector, not a link farm.
- Stable subtree ordering contract: every experiment detail view should render
  the same family subtree in the same sibling order for a given page/root. The
  selected preview may change highlight/detail content, but must not reorder the
  graph. Only changing the page/root focus may alter promoted-path ordering.
- automatic recommendations driven by `goal_metric`/`goal_direction`;
- on-tree key-diff chips (currently only in the dedicated diff card);
- selected-lineage task links: when the lineage graph preview/highlight points
  at another experiment, the selected detail strip should expose associated
  task links directly (for example task count plus running/best/first task
  chips linking to `/tasks/:id`) instead of forcing users to open the
  experiment detail page and scroll to the Tasks table;
- graph-canvas / spatial layout beyond the current vertical rail;
- mutating `add_note` / `decide` / `add_artifact` / `add_checkpoint`
  helpers on `ExperimentClient`. Deliberately deferred to preserve the
  client's read-only contract — use the `alch experiments …` CLI for now,
  or call the `POST/PATCH` endpoints directly.

**Goal:** Turn Alchemy's existing Experiment feature into a research lineage system: a GitLens-like view where researchers can see what changed, why it changed, what ran, what failed, what won, and where each experiment fork came from.

**Architecture:** Reuse the existing Experiment SDK/API/Web surfaces. Add persistent timeline/decision metadata, explicit intent fields, CLI annotation/query commands, and a web detail panel first. Do **not** create a parallel tracking service; Alchemy remains the source of truth for tasks, metrics, configs, artifacts, and lineage.

**Tech Stack:** TypeScript/Node server with SQLite-backed store, React/Vite web dashboard, Python SDK/operator CLI (`alch`), existing task metrics/export pipeline.

---

## Product Bar

Alchemy should become **GitLens for ML experiments**:

- each experiment is a research commit;
- each fork has a parent and a structured config diff;
- each task/run is execution evidence;
- each failure/retry/resume is timeline evidence, not lost log noise;
- each decision (`keep`, `drop`, `rerun`, `fork`) is recorded with a reason;
- CLI and web expose the same lineage model.

The core question the UI must answer in seconds:

> Compared to the parent, what changed, what happened, did it improve, and what should we do next?

MVP must make **one experiment detail page tell a research story**. The full tree/graph comes after that, 喵。

---

## Current State Audit

Existing useful code:

- `sdk/alchemy_sdk/experiment.py`
  - `Experiment.config`
  - `Experiment.fork()`
  - `config_diff`
  - task DAG and `resolved_config`
- `server/src/api/experiments.ts`
  - `POST /api/experiments`
  - `GET /api/experiments`
  - `GET /api/experiments/:id`
  - `GET /api/experiments/:id/diff`
  - `POST /api/experiments/:id/retry-failed`
  - partial git tracking manifest hooks
- `web/src/pages/ExperimentsPage.tsx`
  - list/detail page exists, but not lineage-first
- `sdk/alchemy_sdk/cli/main.py`
  - operator CLI exists for stubs/tasks; extend it with `experiments` commands
- `docs/experiment-config-lineage.md`
  - good conceptual design; needs productized implementation

Known gaps:

- no experiment timeline/event log;
- no explicit hypothesis/decision fields;
- no CLI for experiment notes/decisions/timeline;
- web detail page does not explain intent, decision, or history;
- operational events like OOM/resume/moved-stub are not attached to experiment history;
- `resolved_config` exists on tasks but is not surfaced as a comparison primitive.

---

## Non-Negotiable MVP Cut

Claude Code challenged the first draft correctly: the original 10-task plan was a roadmap, not an MVP. Ship this first:

1. **Intent metadata plumbing**
   - `hypothesis`, `expected_outcome`, `fork_reason`, nullable `decision`, `decision_reason`.
2. **Timeline + decision API**
   - dedicated event persistence;
   - append notes;
   - set decision;
   - read timeline with synthesized task lifecycle events.
3. **Minimal CLI**
   - `alch experiments ls/show/timeline/note/decide`.
4. **Web detail panel**
   - keep the existing list layout;
   - add Intent, Decision, Timeline sections to the existing experiment detail page.

Defer until Phase 2:

- `/experiments/tree`;
- two-pane GitLens layout;
- CLI `tree/diff/compare`;
- summary/compare metric aggregation;
- graph canvas;
- automatic recommendations.

Reason: timeline + decision is the smallest thing researchers actually feel. A tree is cosmetic until a single experiment page tells the story well.

---

## Data Model

### Experiment extensions

Modify `server/src/types.ts` `Experiment` with optional fields. Existing experiments must deserialize without migration pain.

```ts
export type ExperimentDecision = "keep" | "drop" | "rerun" | "fork";

export interface Experiment {
  id: string;
  name: string;
  description?: string;

  // Existing lineage fields.
  parent_name?: string;
  parent_id?: string;
  config?: Record<string, any>;
  config_diff?: Record<string, { old: any; new: any }>;

  // New research metadata.
  family?: string;
  hypothesis?: string;
  expected_outcome?: string;
  fork_reason?: string;

  // Nullable by omission. Do not store "unknown" by default.
  decision?: ExperimentDecision;
  decision_reason?: string;
  decision_at?: string;

  // Phase 2 only.
  goal_metric?: string;
  goal_direction?: "min" | "max";
  summary_metrics?: Record<string, number>;
  best_metrics?: Record<string, number>;
}
```

Important: `decision === undefined` means “never decided”. Do not store `unknown`; it destroys the difference between unset and explicitly undecided.

### Timeline events

Add a small event model. This is the soul of the feature.

```ts
export type ExperimentEventKind =
  | "created"
  | "forked"
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "resumed"
  | "moved_stub"
  | "metric_best"
  | "note"
  | "decision";

export interface ExperimentEvent {
  id: string;
  experiment_id: string;
  task_id?: string;
  kind: ExperimentEventKind;
  message: string;
  created_at: string;
  actor?: string;
  data?: Record<string, any>;
  deleted_at?: string;
}
```

Storage rule: timeline events are append-only. Production paths must not hard-delete events. If deletion is ever needed, soft-redact with `deleted_at`.

### Event persistence

Do **not** store timeline events in the same JSON blob pattern as grids/experiments. That is fine for small records, wrong for an append-only event log.

Add a dedicated SQLite table:

```sql
CREATE TABLE IF NOT EXISTS experiment_events (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  actor TEXT,
  data_json TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_experiment_events_experiment_time
  ON experiment_events (experiment_id, created_at);
```

Store methods:

- `addExperimentEvent(event)`
- `getExperimentEvents(experimentId)`
- `softDeleteExperimentEvent(eventId)` only if needed later

Do not delete events when deleting an experiment. Existing `DELETE /experiments/:id` does not delete tasks; preserving events matches audit semantics.

---

## API Design — Phase 1

### `POST /api/experiments`

Extend existing create path with optional fields:

```json
{
  "name": "curiosity_s42",
  "hypothesis": "Curiosity improves zn without destabilizing loss",
  "expected_outcome": "zn +10%, loss stable",
  "fork_reason": "baseline plateaued",
  "family": "pretrain_nh",
  "parent_name": "pretrain_nh_baseline"
}
```

Rules:

- Resolve `parent_id` at write time using existing `parent_name` logic.
- Freeze `parent_id` once stored.
- Do not re-resolve parent by name at read time; that creates nondeterministic history.

### `GET /api/experiments/:id/timeline`

Returns stored events plus synthesized task lifecycle events.

```json
{
  "experiment_id": "...",
  "events": [
    {"kind":"created","message":"Created experiment", "created_at":"..."},
    {"kind":"task_failed","task_id":"...","message":"OOM on clapper-a30-245999"},
    {"kind":"resumed","message":"Resubmitted with --resume on kingfisher-t4-246249"},
    {"kind":"decision","message":"Marked keep: best zn so far"}
  ]
}
```

Synthesis rules:

- derive lifecycle events from task `created_at`, `started_at`, `finished_at`, `status`, `exit_code`, `stub_id`;
- stored manual events win when same `(kind, task_id)` exists;
- sort by `created_at` ascending in API response;
- UI may reverse order.

### `POST /api/experiments/:id/events`

Append a note or operational event.

Request:

```json
{
  "kind": "note",
  "message": "A30 OOM; resumed on T4",
  "task_id": "optional",
  "data": {"stub":"kingfisher-t4-246249"}
}
```

Validation:

- `kind` must be in allowlist;
- `message` required, max 4096 chars;
- `data` must be a JSON object if present;
- serialized `data` max 8192 bytes;
- `experiment_id` must exist.

Security:

- Do not trust `actor` from request body.
- Derive actor server-side from auth context if available.
- Until auth identity exists, set actor to a stable server-derived value like `operator` or omit it.

### `PATCH /api/experiments/:id/decision`

Set decision metadata and append a timeline event.

Request:

```json
{
  "decision": "keep",
  "reason": "best zn so far; loss stable"
}
```

Response: updated experiment.

Rules:

- `decision` must be one of `keep|drop|rerun|fork`;
- `reason` required, max 4096 chars;
- set `decision_at`;
- append `decision` event;
- no task side effects.

---

## API Design — Phase 2

### `GET /api/experiments/tree`

Returns lineage forest from frozen `parent_id` edges only.

No name-based read-time parent matching. If `parent_id` is missing, the experiment is a root.

### `GET /api/experiments/:id/summary`

Derived metric/runtime summary.

Do not guess “best” using brittle heuristics like “loss means lower is better”. Require explicit fields:

```ts
goal_metric?: string;
goal_direction?: "min" | "max";
```

Metric precedence when aggregating:

1. `task.eval_metrics`
2. `task.metrics`
3. numeric fields from `task.progress`

If `goal_metric` is missing, show latest/mean/std but do not mark a winner.

### `GET /api/experiments/compare?ids=a,b,c`

Cap at 6 IDs. Internally fan out to summary/diff logic. Defer until summary is stable.

---

## CLI Design

Extend `sdk/alchemy_sdk/cli/main.py` with an `experiments` group.

### Phase 1 commands

```bash
alch experiments ls
alch experiments show <id-or-name>
alch experiments timeline <id-or-name>
alch experiments note <id-or-name> "A30 OOM; resumed on T4"
alch experiments decide <id-or-name> keep|drop|rerun|fork --reason "best zn so far"
```

Rules:

- accept experiment ID or unique name;
- resolve by fetching `/experiments` and matching exact ID/name;
- if ambiguous, fail loudly;
- output JSON by default;
- do not print tokens;
- write commands (`note`, `decide`) must go through the server API and must not mutate SQLite directly;
- if future `--offline` or direct-state mode is added, refuse writes there.

Note: current `--local --state-db` only reads token and still writes through HTTP. That is safe. The unsafe thing would be direct SQLite mutation; do not add that.

### Phase 2 commands

```bash
alch experiments tree
alch experiments diff <id-or-name> [--parent]
alch experiments compare <id-or-name> <id-or-name> [...]
```

---

## Web Design — Phase 1

Do **not** replace the list with a tree in Phase 1. Keep current `ExperimentsPage` list/detail flow and add story sections to the detail page.

Modify `web/src/pages/ExperimentsPage.tsx`.

### Add sections to detail page

1. **Intent**
   - hypothesis
   - expected outcome
   - fork reason
   - parent link if available

2. **Decision**
   - decision pill;
   - decision reason;
   - decision timestamp;
   - neutral empty state when no decision exists.

3. **Timeline**
   - events from `/timeline`;
   - synthesized task events and manual notes;
   - failure badges: `OOM`, `timeout`, `resumed`, `stale stub` when data supports them.

4. **Existing task table stays**
   - do not regress current experiment detail behavior.

5. **Diff stays available**
   - existing `/diff` endpoint can be rendered as a simple path table if already easy;
   - if not, defer visual polish.

### Phase 2 web

Only after Phase 1 is useful:

- two-pane lineage tree;
- sibling compare;
- summary metric cards;
- key diff chips on tree nodes.

---

## SDK Ergonomics — Phase 1

Modify `sdk/alchemy_sdk/experiment.py` and `submit.py` minimally.

```python
exp = Experiment(
    "curiosity_s42",
    description="Curiosity policy resume",
    hypothesis="Curiosity improves zn without destabilizing loss",
    expected_outcome="zn +10%, loss stable",
)

child = base.fork(
    "curiosity_s42",
    reason="try curiosity policy after baseline plateau",
)
```

POST optional fields:

- `hypothesis`
- `expected_outcome`
- `fork_reason`
- `family`

No heavy DSL. No mandatory schema.

---

## Implementation Tasks

### Task 1: Extend TypeScript experiment types

**Objective:** Add intent, decision, and event types without behavior changes.

**Files:**

- Modify: `server/src/types.ts`

**Steps:**

1. Add `ExperimentDecision`, `ExperimentEventKind`, `ExperimentEvent`.
2. Extend `Experiment` with optional metadata fields.
3. Run `cd server && npm run build`.

Expected: TypeScript compiles.

### Task 2: Add dedicated event persistence

**Objective:** Store append-only timeline events in SQLite.

**Files:**

- Modify: `server/src/store/index.ts`
- Test: API tests through `experiments.ts`

**Steps:**

1. Create `experiment_events` table and index during DB init.
2. Add `addExperimentEvent(event)`.
3. Add `getExperimentEvents(experimentId)`.
4. Ensure legacy state without the table boots cleanly.
5. Do not delete events when deleting experiments.

### Task 3: Add timeline and decision API

**Objective:** Make notes/decisions writeable and timeline readable.

**Files:**

- Modify: `server/src/api/experiments.ts`
- Test: `server/src/__tests__/experiments-lineage.test.ts`

**Endpoints:**

- `GET /experiments/:id/timeline`
- `POST /experiments/:id/events`
- `PATCH /experiments/:id/decision`

**Acceptance tests:**

1. Create experiment.
2. POST note event.
3. GET timeline includes note.
4. PATCH decision to `keep` with reason.
5. GET experiment returns `decision=keep` and `decision_reason`.
6. GET timeline includes decision event.
7. Bad decision value returns 400.
8. Oversized data returns 400.

### Task 4: Plumb intent fields through create API and SDK

**Objective:** Let experiments carry hypothesis and fork reason from creation.

**Files:**

- Modify: `server/src/api/experiments.ts`
- Modify: `sdk/alchemy_sdk/experiment.py`
- Modify: `sdk/alchemy_sdk/submit.py`
- Test: SDK tests + server API tests

**Acceptance tests:**

1. SDK dry construction accepts fields.
2. submit payload includes fields.
3. server stores fields.
4. fork reason is stored when `fork(reason=...)` is used.

### Task 5: Extend `alch experiments` CLI minimally

**Objective:** Allow Akashi/Yuzhe to query and annotate experiments without web UI.

**Files:**

- Modify: `sdk/alchemy_sdk/cli/main.py`
- Test: `sdk/tests/test_cli.py`

**Commands:**

- `ls` → `GET /experiments`
- `show` → `GET /experiments/:id`
- `timeline` → `GET /experiments/:id/timeline`
- `note` → `POST /experiments/:id/events`
- `decide` → `PATCH /experiments/:id/decision`

**Special requirement:** resolve ID-or-name by fetching `/experiments` and matching exact ID/name. If ambiguous, fail loudly.

### Task 6: Add web Intent/Decision/Timeline detail panel

**Objective:** Make a single experiment page tell the research story.

**Files:**

- Modify: `web/src/pages/ExperimentsPage.tsx`
- Modify: `web/src/lib/api.ts` if needed

**Acceptance:**

- existing list still works;
- existing detail task table still works;
- detail page shows Intent section;
- detail page shows Decision section;
- detail page shows Timeline section;
- empty states are explicit: “no decision yet”, “no timeline notes yet”, “no parent/config snapshot”.

### Task 7: Phase 2 lineage tree endpoint and UI

**Objective:** Add GitLens-like tree after the detail page is useful.

**Files:**

- Modify: `server/src/api/experiments.ts`
- Modify: `web/src/pages/ExperimentsPage.tsx`
- Modify: `sdk/alchemy_sdk/cli/main.py`

**Rules:**

- use frozen `parent_id` only;
- no read-time name-parent guess;
- old experiments with no parent are roots;
- cache or keep response compact.

### Task 8: Phase 2 summary/compare

**Objective:** Add result comparison without lying.

**Files:**

- Create or modify: `server/src/experiment-summary.ts`
- Modify: `server/src/api/experiments.ts`
- Modify: web and CLI

**Rules:**

- metric precedence: `eval_metrics > metrics > progress`;
- only numeric metrics;
- no best/winner unless `goal_metric` and `goal_direction` exist;
- cap compare IDs at 6.

---

## Safety / Operational Rules

- Do not deploy or restart running Alchemy services as part of implementation.
- Do not mutate existing experiment records except via explicit API calls.
- Timeline is append-only; no hard-delete in production paths.
- Notes/decisions must not cancel, retry, or move tasks.
- CLI write commands require explicit subcommands; no hidden side effects in read commands.
- Never print auth tokens.
- Actor is server-derived, never trusted from client body.
- Existing experiments without parent/config must still render as roots or neutral detail pages.
- If metrics are missing, UI must say “no structured metrics yet” rather than parsing random logs in the browser.

---

## Verification Commands

Server:

```bash
cd server
npm run build
npm test -- --run src/__tests__/experiments-lineage.test.ts
npm test -- --run
```

SDK CLI:

```bash
cd sdk
uv run pytest tests/test_cli.py
uv run alch experiments --help
```

Web:

```bash
cd web
npm run build
```

Manual local smoke, no deploy:

```bash
cd sdk
uv run alch --local --state-db ../state.db experiments ls
uv run alch --local --state-db ../state.db experiments timeline <experiment-id>
```

---

## Claude Code Review Notes Incorporated

Claude Code reviewed the first draft and forced these changes:

- cut MVP from 10 roadmap tasks to timeline/decision/detail-panel first;
- dedicated `experiment_events` SQLite table instead of JSON blob persistence;
- actor must be server-derived, not request-body trusted;
- no hard-delete of events when experiments are deleted;
- no read-time parent-name re-resolution;
- web detail panel first, two-pane tree later;
- no heuristic “loss means lower is better” winner logic without explicit `goal_metric`;
- CLI writes must stay server-mediated, never direct SQLite mutation.

Correct call, 喵。
