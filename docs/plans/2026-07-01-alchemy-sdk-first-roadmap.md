# Alchemy SDK-first Roadmap

> **For Hermes:** When Yuzhe later sends `/goal`, first read this roadmap and `docs/plans/2026-07-01-sdk-first-experiment-system.md`. Then implement the next smallest unchecked milestone with TDD. Do not launch GPU experiments unless explicitly told. Commit after each coherent slice.

**Goal:** Make the Alchemy SDK the practical, canonical interface for defining, running, tracking, and deciding experiments: code is experiment, code is config.

**Architecture:** Keep Alchemy's existing philosophy: server/stub are the durable scheduler/runtime substrate; SDK is the research-facing experiment runtime; CLI/Web are inspection and operations surfaces. Strengthen what already exists instead of bolting on a new framework: `Experiment` defines science, `Alchemy`/`TrainingContext` report runtime truth, server persists/indexes, stubs execute.

**Tech Stack:** Python SDK (`sdk/alchemy_sdk`), Python stub (`stub/alchemy_stub`), TypeScript server (`server/src`), SQLite-backed store, Web/CLI readers, pytest + Vitest.

---

## 0. Context and design read

Current SDK already has the right seeds:

- `sdk/alchemy_sdk/experiment.py`
  - Defines `Experiment`, `TaskNode`, DAG validation, config snapshots, per-task `resolved_config`, submit path.
  - Weakness: too thin; no first-class storage, grid, spec object, metric schema, result schema, or strict config guardrails.
- `sdk/alchemy_sdk/client.py`
  - Defines `Alchemy`, params, strict managed-mode `param()`, `log()`, `log_eval()`, `log_config()`, `checkpoint()`, `done()`.
  - Strength: already zero-tolerance in managed mode for missing params.
  - Weakness: runtime events are task-oriented, not experiment/grid-oriented enough.
- `sdk/alchemy_sdk/context.py`
  - Defines `TrainingContext`, `run_dir`, artifact/checkpoint directories, `log()`, `log_eval()`.
  - Strength: run_dir is server-authoritative and fails loudly in managed mode.
  - Weakness: no typed `write_result()`, no declared output validation, no experiment event attachment helper.
- `sdk/alchemy_sdk/managed.py` / `callbacks.py`
  - Existing managed training and callback adapters report loss/metrics.
  - Weakness: useful but not the central path for experiment definition.
- `sdk/alchemy_sdk/experiments.py`
  - Existing lineage client: summary, diff, manifest, timeline, artifacts, decisions, research reports/bundles.
  - Strength: useful read/write endpoints already exist.
  - Weakness: reads are not yet tied back to SDK-authored spec/grid param points.
- Server already has experiments, grids, task metrics, criteria, event timelines, research bundles.
  - Weakness: metrics buffers are partly ephemeral; experiment/task schemas are not authoritative enough.

Conclusion: do not create a separate experiment system. Refactor the SDK into the front door for the existing one 喵.

---

## 1. Non-negotiable product principles

1. **Practical first.** Every slice must make the next JEMA run safer or easier. No abstract framework work without a concrete script shape.
2. **SDK is canonical.** Python experiment code owns experiment name, family, params, storage, config, task graph, metrics, outputs, and decisions.
3. **Server is substrate.** Server stores, schedules, indexes, and exposes. It does not become the place where research intent is hand-authored.
4. **Stub executes.** Stub materializes run dirs/configs/env and reports truth. It should not invent experiment semantics.
5. **CLI/Web inspect and operate.** They summarize, compare, debug, restart, and inspect. They do not become competing config authors.
6. **No silent drift.** Unknown config keys, missing params, duplicate refs, bad storage roots, missing outputs, and schema mismatches fail loudly.
7. **Storage is experiment metadata.** `storage.root`, `run_dir`, artifact root, replay/data roots, and generated config location must be visible in the SDK spec and server payload.
8. **Compatibility over rewrites.** Existing task API, CLI commands, and old scripts keep working. Add the SDK-first golden path incrementally.
9. **TDD by default.** For behavior changes: RED → GREEN → REFACTOR. If the first test passes immediately, the test is wrong.
10. **Small commits.** One feature/fix per commit. Push when a slice is verified.

---

## 2. Operating model for future `/goal` work

When implementing from this roadmap:

1. Read this file.
2. Read `docs/plans/2026-07-01-sdk-first-experiment-system.md`.
3. Check `git status --short` and recent commits.
4. Inspect the exact files for the next milestone; do not trust stale memory.
5. Pick the **first unchecked milestone** that is still valid.
6. If inspection shows the milestone is wrong, update this roadmap first, commit the roadmap correction, then implement the corrected smallest slice.
7. Write failing tests before production code.
8. Run focused tests after each RED/GREEN cycle.
9. Run the relevant package gate before commit.
10. Commit with SSH signing (`git commit -S`) using the project author convention if needed.
11. Do not submit GPU/SLURM jobs unless Yuzhe explicitly asks.

Recommended `/goal` prompt:

```text
Read docs/plans/2026-07-01-alchemy-sdk-first-roadmap.md and docs/plans/2026-07-01-sdk-first-experiment-system.md. Implement the next smallest unchecked milestone with strict TDD. Practical first. Preserve Alchemy's server/stub/SDK design philosophy. If you discover the roadmap is wrong, update the roadmap first, commit that correction, then continue. Do not launch GPU experiments.
```

---

## 3. Roadmap index

| Stage | Name | Outcome | Risk | Status |
|---|---|---|---|---|
| A | SDK spec snapshot | Experiment has a strict serializable spec | Low | DONE |
| B | Grid expansion | Params and templated refs become SDK-owned | Medium | DONE |
| C | Storage and dry-run preflight | Run dirs/storage are visible before submit | Low | IN PROGRESS — C1 done |
| D | Runtime result API | Training/eval writes typed results/artifacts | Medium | TODO |
| E | Metric schema and curves | Loss/metrics tied to experiment refs/params | Medium | TODO |
| F | Server persistence hardening | Server preserves SDK-authored schemas/specs | Medium | TODO |
| G | CLI/Web inspection | Users can inspect SDK experiments without guessing | Medium | TODO |
| H | JEMA dogfood migration | One real JEMA experiment script uses SDK-first path | High | TODO, blocked until storage cleared / user says run |

---

## Stage A — SDK spec snapshot

**User value:** before submitting anything, a user can inspect exactly what experiment Alchemy thinks exists.

**Desired API:**

```python
exp = (
    Experiment("jema-smoke", family="jema")
    .storage(root="/vol/gpudata/ys25-MySpace/alchemy-runs")
    .base_config({"train": {"batch_size": 64}})
)
spec = exp.to_spec()
```

**Implementation slices:**

### A1. Add `Experiment.storage()` — DONE 2026-07-01

Implemented in `sdk/alchemy_sdk/experiment.py` with focused tests in `sdk/tests/test_experiment_spec.py`.

Verified:

```bash
cd sdk && uv run pytest tests/test_experiment_spec.py tests/test_experiment_lineage.py -q
# 24 passed
```

Files:
- Modify: `sdk/alchemy_sdk/experiment.py`
- Test: `sdk/tests/test_experiment_spec.py`

Behavior:
- `.storage(root=...)` stores a deep-copied storage block in the spec.
- Accept optional `artifact_root`, `replay_root`, `data_root` later only if immediately used. Start with `root` and optional `artifact_root`.
- Reject empty strings.
- Do not touch submit behavior yet unless tests require payload inclusion.

Tests:
- `Experiment("x").storage(root="/runs").to_spec()["storage"]["root"] == "/runs"`
- Empty root raises `ValueError`.
- Mutating caller-provided values cannot mutate spec.

Verification:

```bash
cd sdk && uv run pytest tests/test_experiment_spec.py -q
```

Commit:

```bash
git add sdk/alchemy_sdk/experiment.py sdk/tests/test_experiment_spec.py
git commit -S -m "feat(sdk): add experiment storage spec"
```

### A2. Add `Experiment.base_config()` and immutable `to_spec()` — DONE 2026-07-01

Implemented `base_config()` and `metadata` snapshot fields in `to_spec()`.

Verified:

```bash
cd sdk && uv run pytest tests/test_experiment_spec.py tests/test_experiment_lineage.py -q
# 27 passed
```

Behavior:
- `.base_config(mapping)` replaces `exp.config` through an explicit method while keeping existing `exp.config = ...` compatibility.
- `to_spec()` returns a new deep-copied dict every call.
- Include `name`, `description`, `family`, `hypothesis`, `expected_outcome`, `storage`, `config`, `tasks`.
- Include lightweight metadata when available: git commit, cwd, SDK package version if easy. If version is messy, stamp `sdk_version="unknown"` explicitly instead of guessing.

Tests:
- Caller mutation after `.base_config()` does not alter `to_spec()`.
- Mutating returned `to_spec()` does not mutate experiment internals.
- Existing `exp.config = {...}` still appears in `to_spec()`.

### A3. Make dry-run return the spec — DONE 2026-07-01

Implemented `Experiment.dry_run()` as local DAG validation plus `to_spec()` with no submit import/network path.

Verified:

```bash
cd sdk && uv run pytest tests/test_experiment_spec.py tests/test_experiment_lineage.py -q
# 29 passed
```

Current `submit(dry_run=True)` prints the DAG and returns a dummy `ExperimentResult`. Keep compatibility, but add a side-effect-free programmatic path:

- Add `exp.dry_run()` returning the spec/preflight dict.
- Or add `submit(dry_run=True, return_spec=True)` only if API stays clean.

Prefer `dry_run()` because it is explicit.

Tests:
- `dry_run()` validates DAG and returns spec without network submit.
- No import/use of `submit_experiment` during dry-run.

Stop condition for Stage A:
- A user can write an experiment object and call `to_spec()` / `dry_run()` to see canonical config/storage/task structure without server.

---

## Stage B — Grid expansion owned by SDK

**User value:** no more hand-written task copies or YAML grids for common sweeps.

**Desired API:**

```python
exp = Experiment("grid").params(seed=[1, 2], lr=[1e-4, 3e-4])
train = exp.task("train-{seed}-{lr}", script="train.py")
eval = exp.task("eval-{seed}-{lr}", script="eval.py", depends_on=[train])
```

**Implementation slices:**

### B1. Add ordered `params(**space)` — DONE 2026-07-01

Implemented ordered `params()` plus `param_space` and deterministic `param_points` in `to_spec()`.

Verified:

```bash
cd sdk && uv run pytest tests/test_experiment_grid.py tests/test_experiment_spec.py tests/test_experiment_lineage.py -q
# 32 passed
```

Behavior:
- Preserve insertion order.
- Values must be non-empty lists/tuples.
- Scalar values are rejected for now; practical strictness beats magic.
- `to_spec()` includes `param_space` and expanded `param_points`.
- Expansion order is deterministic: lexical by insertion order, product in declaration order.

Tests:
- `seed=[1,2], lr=[0.1,0.2]` gives 4 points in stable order.
- Empty list raises.
- Scalar raises with useful message.

### B2. Expand task ref templates — DONE 2026-07-01

Implemented template ref expansion in canonical task specs, including `ref_template`, `param_point`, duplicate detection, and fail-loud missing-key errors. `submit()` now uses the same expanded specs as `to_spec()` / `dry_run()`.

Verified:

```bash
cd sdk && uv run pytest tests/test_experiment_grid.py tests/test_experiment_spec.py tests/test_experiment_lineage.py -q
# 35 passed
```

Behavior:
- If no params exist, existing task behavior remains unchanged.
- If params exist and ref contains `{key}`, expand one task per param point.
- Rendered refs must be unique; duplicates fail loudly.
- Each expanded task spec includes `param_point` and original `ref_template`.

Tests:
- `train-{seed}` expands `train-1`, `train-2`.
- Duplicate rendered refs raise.
- Missing template key raises before submit.

### B3. Resolve same-point dependencies — DONE 2026-07-01

Implemented same-param dependency rendering for expanded task templates. Template tasks can depend on global tasks; global tasks fail loudly if they depend on expanded tasks without an explicit future policy.

Verified:

```bash
cd sdk && uv run pytest tests/test_experiment_grid.py tests/test_experiment_spec.py tests/test_experiment_lineage.py -q
# 38 passed
```

Behavior:
- `depends_on=[train]` from `eval-{seed}` points to `train-{same seed}` by default.
- Cross-point/global dependencies must be explicit later; do not infer cross products.
- If templates have incompatible param coverage, fail with a clear error.

Tests:
- `eval-{seed}` depends on matching `train-{seed}`.
- `eval-{seed}` depending on `aggregate` works only if `aggregate` is non-expanded or marked as global.
- Incompatible template fails.

Practical note:
- If global dependency API is needed, use `depends_on_all=[aggregate]` or `scope="global"` after inspecting current task model. Do not design both unless needed.

Stop condition for Stage B:
- SDK can define a small grid DAG and dry-run expanded task refs/dependencies without touching server.

---

## Stage C — Storage and preflight hardening

**User value:** catch bitbucket/run_dir/storage mistakes before burning SLURM time.

### C1. Storage warnings in dry-run — DONE 2026-07-01

Implemented `dry_run()["warnings"]` with explicit storage warnings for grid experiments missing `.storage(root=...)` and `/vol/bitbucket` task paths without an SDK storage root.

Verified:

```bash
cd sdk && uv run pytest tests/test_experiment_spec.py tests/test_experiment_grid.py -q
# 21 passed
```

Behavior:
- Dry-run returns `warnings: []`.
- Warn if any run/output path contains `/vol/bitbucket` and no explicit `.storage(root=...)` is set.
- Warn if storage root is absent for grid experiments.
- Do not make these fatal yet; fatal comes only when Yuzhe agrees.

Tests:
- Bitbucket path produces warning.
- Explicit gpudata storage has no warning.

### C2. Submit payload includes SDK storage spec

Behavior:
- `submit()` forwards storage to `submit_experiment()` payload.
- Server can ignore initially, but must not break.

Tests:
- Mock `submit_experiment()` and assert storage/spec metadata is sent.

### C3. Config sidecar declaration for legacy scripts

Behavior:
- Task can declare `config_mode="yaml_file"` or similar.
- SDK stores `resolved_config` and tells runtime to materialize it to `run_dir/config.yaml` eventually.
- First slice can stop at payload/spec; stub materialization is separate.

Do not overbuild a runner. Legacy scripts are still common; just make SDK the source of the config.

Stop condition for Stage C:
- Dry-run makes storage/config/run-dir intent explicit enough to review before running.

---

## Stage D — Runtime result API

**User value:** eval results stop being random JSON files parsed after the fact.

**Desired API:**

```python
ctx.write_result(
    {"retrieval_at5": 0.71, "coverage": {"reward_rate": 0.12}},
    schema={"retrieval_at5": float, "coverage.reward_rate": float},
)
```

### D1. Add local `TrainingContext.write_result()`

Behavior:
- Writes JSON atomically under `run_dir/results.json` by default.
- Creates parent dirs with existing group-writable helper.
- Returns path.
- Does not require server attachment in first slice.

Tests:
- Writes valid JSON.
- Atomic temp file does not remain after success.
- Works in no-op local context using temp run_dir.

### D2. Add schema validation

Behavior:
- Support simple schema: dotpath → type or string type name.
- Missing required key raises.
- Wrong type raises.
- Extra keys allowed initially; add `strict=True` later only if needed.

Tests:
- Missing nested key fails.
- Wrong float/string type fails.
- Bool does not count as number unless explicitly bool.

### D3. Attach result as experiment artifact/event when context has enough identity

Behavior:
- If `ALCHEMY_EXPERIMENT_ID` or equivalent exists, attach event through SDK/server path.
- If not available, write locally and log a non-fatal warning or no-op. Do not invent IDs.

Need to inspect stub/server env injection before implementing.

Stop condition for Stage D:
- Evaluation scripts can use one SDK call to produce standard result artifacts.

---

## Stage E — Metrics schema and curves

**User value:** loss/metrics curves are discoverable by experiment/grid param, not by manually knowing task IDs.

### E1. Task metric schema declaration

API:

```python
exp.task(
    "train-{seed}",
    script="train.py",
    metrics={"loss": "min", "retrieval_at5": "max"},
)
```

Behavior:
- Validate direction: `min`, `max`, maybe `latest` later.
- Serialize as `metric_schema` in task spec.
- Do not change runtime metric reporting yet.

Tests:
- Valid schema appears in dry-run spec.
- Invalid direction raises.

### E2. Runtime metric key validation in managed mode

Behavior:
- If task declares metric schema and runtime reports undeclared metric, decide whether to warn or fail.
- Start practical: dry-run/server can expose schema; runtime strictness can be opt-in (`strict_metrics=True`).

Do not block existing scripts by default.

### E3. Curves by experiment ref and param filter

API candidate:

```python
ExperimentClient().curves("exp-name", metric="loss", params={"seed": 1})
```

Behavior:
- Resolve experiment → task refs → task IDs → existing `/api/tasks/:id/metrics` endpoints.
- Return deterministic mapping: `ref -> metric -> points`.
- If server lacks persisted curves, return what exists and mark `source="ring_buffer"`.

Important discovered issue:
- Current server metrics are partly in-memory ring buffers. Roadmap must not pretend they are durable. Persisting curves is Stage F, not hidden in E.

Stop condition for Stage E:
- SDK can fetch currently available curves through experiment/task refs.

---

## Stage F — Server persistence hardening

**User value:** SDK-authored schema/result/metric data survives restarts and powers Web/CLI.

### F1. Preserve SDK spec fields on experiment submit

Behavior:
- Server keeps unknown-safe but typed fields: `storage`, `param_space`, `param_points`, `metric_schema`, `result_schema`, `ref_template`.
- Fetching experiment returns those fields intact.

Tests:
- POST experiment with SDK fields; GET returns them.
- SQLite reload preserves them.

### F2. Durable metric curve persistence

Current issue:
- `server/src/metrics.ts` uses ring buffers. Good for live UI, bad for experiment records.

Practical first step:
- Persist final/eval metrics and result events before trying to persist every training step.
- If training curves need durability, store downsampled points or periodic snapshots; do not dump millions of points into SQLite blindly.

Decision needed before implementation:
- Retention granularity: all points, every N seconds, or ring-buffer snapshots into artifact file.

### F3. Result artifact indexing

Behavior:
- Result events/artifacts should be queryable by experiment and task ref.
- Summary endpoint should expose best/final result metrics using declared direction.

Stop condition for Stage F:
- A server restart does not lose SDK-authored experiment intent or final results.

---

## Stage G — CLI/Web inspection

**User value:** use CLI/Web to decide next experiments, not to reverse-engineer state.

### G1. `alch experiments inspect <ref>` reads SDK spec

Behavior:
- Show storage, param space, task templates, expanded task counts, schemas, outputs, warnings.
- JSON mode for agents/scripts.

Tests:
- Fake API payload renders expected fields.

### G2. `alch experiments curves <ref>`

Behavior:
- Fetch curves through SDK client and export JSON/CSV.
- Do not make plotting a dependency.

### G3. Web read-only inspector

Respect Yuzhe UI preference:
- Dense, polished, GitLens/VSCode-like.
- Stable grouped branches.
- Low-radius/full-width.
- Muted/folded failed leaves.
- Use-case routes: Decide next / Compare / Audit / Handoff.

Do this after SDK/server data is real. UI before data model is decoration. 不行。

Stop condition for Stage G:
- The same SDK-created experiment can be inspected from CLI and Web without manual task ID lookup.

---

## Stage H — JEMA dogfood migration

**User value:** prove the SDK path by replacing one real painful workflow.

Blocked until Yuzhe explicitly allows new experiment work and storage is clean.

Candidate first dogfood:
- A dry-run-only JEMA Atari coverage/replay/eval grid script.
- It should not submit jobs initially.
- It should output spec JSON and Markdown summary.

Acceptance:
- One Python file defines experiment, config, params, task graph, storage, metrics, outputs.
- `exp.dry_run()` catches missing storage/config/ref mistakes.
- Later `exp.submit()` should be the only switch from planning to running.

---

## 4. Discovery rules: allowed to change the roadmap

This roadmap is not scripture. It is a working design. While implementing, update it when reality disagrees.

Update roadmap first if you discover:

- Existing server payload shape already supports a field differently.
- A proposed API conflicts with existing SDK behavior.
- A smaller practical slice exists.
- A stage hides a risky migration.
- Tests reveal a design that is hard to use.
- Runtime/stub lacks identity needed for experiment event attachment.
- Metrics durability assumptions are false.

Roadmap update protocol:

1. Patch this file with the discovered fact and revised next slice.
2. Commit the roadmap correction.
3. Then implement code.

Good commit messages:

```bash
git commit -S -m "docs: update SDK roadmap after metrics inspection"
git commit -S -m "docs: revise SDK result attachment plan"
```

---

## 5. Definition of done per slice

A slice is done only when:

- Tests were written first and observed failing for the intended reason.
- Focused tests pass.
- Relevant package build/test gate passes.
- Roadmap checkbox/status is updated if the milestone is complete.
- Commit is small and signed.
- No GPU/SLURM experiment was launched unless explicitly requested.

Minimum gates:

```bash
# SDK-only slice
cd sdk && uv run pytest -q

# Server slice
cd server && npm test -- --run && npm run build

# Stub slice
cd stub && uv run pytest -q
python -m py_compile alchemy_stub/config.py alchemy_stub/daemon.py
```

Use narrower focused tests during development; run broader gates before commit.

---

## 6. Near-term recommended order

Do these first, in order:

1. A1 `Experiment.storage()`
2. A2 `Experiment.base_config()` + immutable `to_spec()`
3. A3 `dry_run()` returns spec/preflight dict
4. B1 `params(**space)`
5. B2 template ref expansion
6. B3 same-point dependency resolution
7. C1 storage warnings
8. E1 metric schema declaration
9. D1 local `write_result()`
10. D2 result schema validation

Why this order:
- It gives immediate value without server/stub deployment.
- It keeps the SDK API shape honest before persistence/UI work.
- It prevents the old failure mode: experiments whose config/storage exists outside Alchemy's model.

---

## 7. API style constraints

Prefer:

```python
Experiment("x").storage(root="...").base_config({...}).params(seed=[1, 2])
```

Avoid:

```python
Experiment("x", giant_constructor_with_everything=True)
```

Prefer explicit failure:

```python
al.param("seed")  # managed mode: missing seed raises
```

Avoid silent defaults:

```python
al.param("seed", 42)  # forbidden in managed mode already; keep that spirit
```

Prefer declarative task metadata:

```python
exp.task("train-{seed}", script="train.py", metrics={"loss": "min"}, outputs=["final.pt"])
```

Avoid magic path parsing:

```python
# Do not infer result schema from arbitrary filenames.
```

Prefer payload compatibility:

```python
spec["metric_schema"] = {...}
```

Avoid breaking old scripts:

```python
# Existing raw_args/config_overrides users must continue working.
```

---

## 8. Open questions to resolve only when needed

Do not block Stage A/B on these:

1. Should metric curves be fully durable or downsampled?
2. Should config schema use pydantic, JSON schema, or simple dotpath validation?
3. Should callable tasks be supported directly, or should SDK only emit script/module commands?
4. Should Web become a spec editor? Current answer: no, read-only/ops first.
5. Should strict metric schema be default? Current answer: not yet; opt-in after dogfood.
6. How should global/cross-point dependencies be expressed? Defer until a real aggregate task needs it.

---

## 9. Final target shape

A real experiment should be explainable by reading one Python file and one dry-run spec:

```python
from alchemy_sdk import Experiment

exp = (
    Experiment("atari-coverage500", family="jema-atari")
    .storage(root="/vol/gpudata/ys25-MySpace/alchemy-runs")
    .base_config({
        "project": "jema-v2",
        "train": {"batch_size": 64, "max_steps": 200_000},
    })
    .params(game=["Pong", "Breakout"], seed=[1234, 4242])
)

replay = exp.task(
    "replay-{game}-{seed}",
    script="scripts/replay.py",
    outputs=["replay/manifest.json", "audit.json"],
)

train = exp.task(
    "train-{game}-{seed}",
    script="scripts/train.py",
    depends_on=[replay],
    metrics={"loss": "min", "retrieval_at5": "max"},
    outputs=["final.pt", "train_summary.json"],
)

eval = exp.task(
    "eval-{game}-{seed}",
    script="scripts/eval.py",
    depends_on=[train],
    result_schema={"retrieval_at5": float, "coverage.reward_rate": float},
)

spec = exp.dry_run()
# exp.submit() only when explicitly ready
```

That is the direction. Use Go for services if this grows new infrastructure. For now, Python SDK + existing TS server is enough. 重构，但别造新屎山 喵。
