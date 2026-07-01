# SDK-first Experiment System Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make Alchemy SDK the authoritative interface for experiment definition, hyperparameter grids, live metrics, artifacts/results, and lineage so research code is experiment code and configuration.

**Architecture:** Python SDK owns the experiment spec and produces strict, serializable task/grid/experiment payloads. Training/eval code logs metrics, results, checkpoints, and artifacts through SDK primitives; server persists and indexes them; CLI/Web become readers/operators, not ad-hoc config sources. Existing REST/task APIs remain compatible, but the golden path is SDK-first.

**Tech Stack:** Python SDK (`sdk/alchemy_sdk`), Node/TypeScript server (`server/src/api`, `server/src/store`, `server/src/socket`), SQLite state, Web dashboard readers, pytest + Vitest TDD.

---

## Current diagnosis

Alchemy has the pieces but not the center of gravity:

- `sdk/alchemy_sdk/experiment.py` can define DAG tasks and config snapshots, but it is thin and underused.
- `sdk/alchemy_sdk/context.py` / callbacks can log loss/metrics, but result schemas, summary artifacts, and hyperparameter curves are not first-class enough.
- `server/src/api/grids.ts` and `server/src/api/experiments.ts` persist grid/experiment objects, but research scripts still often hand-roll YAMLs, raw args, result JSON paths, and post-hoc summary parsing.
- The current pain came from operational drift: cwd/run_dir/storage decisions lived outside the experiment object. That should not happen again.

Conclusion: strengthen the SDK. The experiment object should be the source of truth for config, grid expansion, task wiring, storage roots, metrics, result schemas, artifacts, and decisions.

## Non-goals

- Do not launch experiments while `/vol/bitbucket` is full.
- Do not deploy/restart Alchemy server/stubs in this implementation plan.
- Do not replace existing REST APIs; add SDK-first affordances over them.
- Do not add another YAML framework. YAML can be emitted for legacy scripts, but SDK should be canonical.

## Target user shape

```python
from alchemy_sdk import Experiment

exp = (
    Experiment("atari-coverage500", family="jema-atari-parametric")
    .storage(root="/vol/gpudata/ys25-MySpace/alchemy-runs")
    .base_config({
        "project": "jema-v2",
        "dataset": {"root": "/vol/gpudata/ys25-MySpace/jema-atari-replay"},
        "train": {"max_steps": 200_000, "batch_size": 64},
    })
    .params(
        game=["Pong", "Breakout", "Freeway"],
        policy=["coverage"],
        seed=[1234, 4242, 7777],
    )
)

replay = exp.task(
    "replay-{game}-{policy}-{seed}",
    script="scripts/generate_atari_replay.py",
    config=lambda p, c: c | {"game": p.game, "policy": p.policy, "seed": p.seed},
    outputs=["replay/manifest.json", "audit.json"],
)

train = exp.task(
    "train-{game}-{policy}-{seed}",
    script="scripts/train_atari_parametric.py",
    depends_on=[replay],
    metrics={"loss": "min", "smoothness_spearman": "max", "retrieval_at5": "max"},
    outputs=["final.pt", "train_summary.json"],
)

eval = exp.task(
    "eval-{game}-{policy}-{seed}",
    script="scripts/eval_atari_parametric.py",
    depends_on=[train],
    result_schema={
        "smoothness_spearman": float,
        "retrieval_at5": float,
        "coverage.reward_rate": float,
    },
    decision={"promote_if": "mean(retrieval_at5) >= 0.65 and min(coverage.reward_rate) > 0"},
)

exp.submit()
```

## Design principles

1. **Code is config.** SDK spec is canonical. Generated YAML/CLI args are projections.
2. **Config is strict.** Unknown keys and missing required keys fail before task submission.
3. **Metrics are typed streams.** Loss/curve data must be indexed by task, ref, param point, metric name, and step.
4. **Results are typed artifacts.** Final JSONs should be declared, validated, attached to experiment events, and summarized.
5. **Storage is part of experiment spec.** `storage.root`, `run_dir`, replay roots, and artifact roots must be explicit and visible.
6. **No silent drift.** SDK should stamp git commit, script paths, config hash, SDK version, and storage root into experiment metadata.
7. **CLI/Web are views.** They inspect and operate on SDK-created state, not reinvent experiment config.

---

## Phase 1: SDK experiment spec hardening

### Task 1: Add an immutable ExperimentSpec model

**Objective:** Introduce a serializable internal spec that captures base config, params, tasks, storage, metadata, and submit options before hitting the server.

**Files:**
- Modify: `sdk/alchemy_sdk/experiment.py`
- Create: `sdk/tests/test_experiment_spec.py`

**TDD:**
1. Write failing tests for:
   - `Experiment("x").storage(root="/runs").to_spec()` includes `storage.root`.
   - `base_config()` deep-copies input; later caller mutations do not affect spec.
   - `to_spec()` includes SDK version and git commit when available.
2. Run:
   - `cd sdk && uv run pytest tests/test_experiment_spec.py -q`
3. Implement minimal chainable methods:
   - `storage(root: str, artifact_root: str | None = None)`
   - `base_config(config: Mapping[str, Any])`
   - `to_spec() -> dict[str, Any]`
4. Re-run focused tests.
5. Commit:
   - `git commit -S -m "feat(sdk): add experiment spec snapshot"`

### Task 2: Add strict config key validation

**Objective:** Stop hidden defaults and typo drift before queueing GPU work.

**Files:**
- Modify: `sdk/alchemy_sdk/experiment.py`
- Test: `sdk/tests/test_experiment_spec.py`

**TDD:**
1. Tests:
   - unknown override path raises `ValueError` unless `allow_new=True` is explicit.
   - missing required config path raises before submit.
   - task config lambda returning non-mapping raises.
2. Add methods:
   - `require_config(*dotpaths: str)`
   - `override(path, value, allow_new=False)` helper for task specs.
3. Verify:
   - `cd sdk && uv run pytest tests/test_experiment_spec.py -q`

### Task 3: Make task refs templated over parameter points

**Objective:** SDK should own grid expansion instead of hand-written repeated tasks.

**Files:**
- Modify: `sdk/alchemy_sdk/experiment.py`
- Test: `sdk/tests/test_experiment_grid.py`

**TDD:**
1. Tests:
   - `.params(seed=[1,2], lr=[1e-4,3e-4])` expands 4 points deterministically.
   - `task("train-{seed}-{lr}")` renders unique refs.
   - duplicate rendered refs fail loudly.
2. Implement:
   - `params(**space)` stores ordered param space.
   - task templates expand in `to_task_specs()` / `submit()`.
   - task spec gets `param_point` metadata.
3. Verify:
   - `cd sdk && uv run pytest tests/test_experiment_grid.py -q`

### Task 4: Preserve dependency templates across expanded refs

**Objective:** `depends_on=[replay]` should mean same param point by default; cross-product dependencies must be explicit.

**Files:**
- Modify: `sdk/alchemy_sdk/experiment.py`
- Test: `sdk/tests/test_experiment_grid.py`

**TDD:**
1. Tests:
   - `eval-{seed}` depends on `train-{seed}` for each seed.
   - all-to-one dependency requires `depends_on_all=[aggregate]` or explicit API; default does not create wrong edges.
2. Implement dependency resolver.
3. Verify focused tests.

---

## Phase 2: Metrics and result tracking as SDK primitives

### Task 5: Add metric declarations to task specs

**Objective:** Experiments declare expected metrics and optimization direction; server/Web can summarize curves consistently.

**Files:**
- Modify: `sdk/alchemy_sdk/experiment.py`
- Modify: `server/src/types.ts`
- Modify: `server/src/api/experiments.ts` if payload validation exists there
- Test: `sdk/tests/test_experiment_spec.py`, relevant server Vitest test

**TDD:**
1. Tests:
   - `task(..., metrics={"loss":"min", "retrieval_at5":"max"})` serializes metric schema.
   - invalid direction raises.
2. Server type accepts `metric_schema` without dropping it.
3. Verify:
   - `cd sdk && uv run pytest tests/test_experiment_spec.py -q`
   - `cd server && npm test -- --run src/__tests__/experiments-lineage.test.ts`

### Task 6: Add result schema validation helper

**Objective:** Eval scripts can validate and submit final result JSONs through SDK instead of writing untracked files.

**Files:**
- Modify: `sdk/alchemy_sdk/context.py`
- Modify: `sdk/alchemy_sdk/experiments.py`
- Create/modify: `sdk/tests/test_context_results.py`

**TDD:**
1. Tests:
   - `ctx.write_result({"retrieval_at5": 0.7})` writes `results.json` under run_dir.
   - declared schema missing required key raises.
   - nested dotpath schema validates `coverage.reward_rate`.
   - result is logged as experiment artifact/event when task has experiment context.
2. Implement:
   - `TrainingContext.write_result(metrics, name="results.json", schema=None)`
   - `ExperimentClient.add_result(...)` wrapper over artifact/event API.
3. Verify focused SDK tests.

### Task 7: Add curve export API

**Objective:** SDK can fetch loss/metric curves by experiment ref/param point, not raw task IDs.

**Files:**
- Modify: `sdk/alchemy_sdk/experiments.py`
- Modify: `server/src/api/metrics.ts` only if needed
- Test: `sdk/tests/test_experiments_client.py`

**TDD:**
1. Tests with fake client responses:
   - `client.curves(exp_id, metric="loss")` returns `{ref: [points...]}`.
   - param filters map to task IDs through experiment task refs.
2. Implement read-only SDK method using existing metrics endpoints where possible.
3. Verify SDK tests.

---

## Phase 3: Submission UX: code-as-experiment

### Task 8: Add `Experiment.script_task` for Python module functions

**Objective:** Let users define tasks as Python callables/modules and have SDK generate safe `argv` / config injection.

**Files:**
- Modify: `sdk/alchemy_sdk/experiment.py`
- Test: `sdk/tests/test_experiment_script_task.py`

**TDD:**
1. Tests:
   - module path + function name serializes to `argv=["--config", "$ALCHEMY_CONFIG"]` style command without shell quoting.
   - config is passed via `resolved_config`, not raw CLI flags.
2. Implement minimal helper; do not build a full runner yet.
3. Verify.

### Task 9: Add generated config sidecar for legacy scripts

**Objective:** Preserve old `--config path.yaml` scripts while making SDK canonical.

**Files:**
- Modify: `sdk/alchemy_sdk/experiment.py`
- Modify: `stub/alchemy_stub/daemon.py` if config materialization belongs stub-side
- Test: SDK/stub tests

**TDD:**
1. Tests:
   - task with `config_mode="yaml_file"` declares that stub should materialize `resolved_config` to run_dir/config.yaml.
   - run payload includes config mode.
2. Implement minimal payload support.
3. Verify no old task behavior changes.

### Task 10: Add SDK submit preflight summary

**Objective:** `exp.submit(dry_run=True)` should show all refs, param points, cwd/run_dir root, outputs, metrics, result schemas, and dependencies.

**Files:**
- Modify: `sdk/alchemy_sdk/experiment.py`
- Test: `sdk/tests/test_experiment_dry_run.py`

**TDD:**
1. Tests snapshot the dry-run output or returned dict.
2. Include storage risk warnings when paths contain `/vol/bitbucket` and no explicit storage root is set.
3. Verify focused tests.

---

## Phase 4: Server/Web support for SDK-created experiments

### Task 11: Persist metric/result schema in experiment/task spec

**Objective:** Server must retain SDK-declared schemas so Web and CLI can render summaries without guessing.

**Files:**
- Modify: `server/src/types.ts`
- Modify: `server/src/api/experiments.ts`
- Modify: store tests if normalization drops unknown keys
- Test: relevant Vitest tests

**TDD:**
1. Submit experiment payload with `metric_schema`, `result_schema`, `storage`.
2. Fetch experiment and assert fields preserved.
3. Verify build.

### Task 12: Add `alch experiments summarize` SDK-backed view

**Objective:** CLI summarizes config, grid params, best metrics, result artifacts, failed/missing outputs.

**Files:**
- Modify: `sdk/alchemy_sdk/cli/main.py`
- Modify: `sdk/alchemy_sdk/experiments.py`
- Test: `sdk/tests/test_cli.py`

**TDD:**
1. Fake API payload and assert summary contains param columns, best metric, artifact locator.
2. JSON mode returns machine-readable summary.
3. Verify SDK tests.

### Task 13: Web read-only experiment inspector improvements

**Objective:** Web should show SDK spec, param grid, curves, result artifacts, and decision gates.

**Files:**
- Modify: `web/src/...` exact paths after inspection
- Test: Web Vitest tests

**TDD:**
1. Add fixture experiment with SDK schema fields.
2. Render shows param filters, metric chart input, result table, storage root.
3. Verify:
   - `cd web && npm run build && npm test -- --run`

---

## Verification matrix

Per SDK slice:

```bash
cd sdk && uv run pytest tests/test_experiment_spec.py tests/test_experiment_grid.py -q
cd sdk && uv run pytest tests/test_cli.py -q
```

Per server slice:

```bash
cd server && npm test -- --run src/__tests__/experiments-lineage.test.ts src/__tests__/api-tasks.test.ts
cd server && npm run build
```

Per stub/context slice:

```bash
cd stub && uv run pytest tests/test_daemon.py tests/test_env_config.py -q
python -m py_compile alchemy_stub/config.py alchemy_stub/daemon.py
```

Full gate before deploy:

```bash
cd sdk && TMPDIR=/tmp uv run pytest -q
cd server && npm test -- --run && npm run build
cd stub && uv run pytest -q
```

## First implementation slice

Start with Phase 1 Tasks 1-4 only. That gives immediate leverage without touching production runtime:

1. `Experiment.storage()`
2. `Experiment.base_config()`
3. `Experiment.params()` grid expansion
4. templated task refs + same-point dependency expansion
5. strict dry-run spec output

No deploy needed. No GPU tasks. No experiment launch.

## Decision

Yes: SDK should be strengthened. Alchemy should stop being only a task queue and become the experiment runtime. The queue runs processes; the SDK defines science.
