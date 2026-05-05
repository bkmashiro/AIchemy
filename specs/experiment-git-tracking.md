# Spec: Git-based Experiment Tracking

**Author:** Akashi (CTO)
**Date:** 2026-04-30
**Status:** Draft
**Priority:** P1

---

## Motivation

Currently experiments are tracked by naming convention (`mixed_vicreg_rd128_ga_snorm_s42`). There's no structured way to know which experiment forked from which, what code/config was used, or where artifacts live. The `Experiment` type already has `parent_name`/`config_diff` but it's metadata-only — no persistent record outside the alchemy DB.

**Idea (from Yuzhe):** Git is the natural primitive for experiment lineage. Branches = experiments, commits = config/code snapshots, manifest files = pointers to external artifacts (checkpoints, results). Git manages code + config + manifests. Weights stay on disk.

---

## Design

### 1. Experiment Repository Structure

Each project using alchemy has a git repo (already true for `jema`). We add a convention:

```
project/
  configs/           # yaml configs (already exists)
  experiments/       # NEW: one manifest per experiment
    _base.yaml       # default/baseline experiment manifest
    snorm_s42.yaml   # experiment manifest
    dual_ema_s42.yaml
  ...
```

### 2. Experiment Manifest (`experiments/*.yaml`)

```yaml
# experiments/snorm_s42.yaml
name: mixed_vicreg_rd128_ga_snorm_s42
parent: vicreg_rd128_ga    # which experiment this forks from
created_at: "2026-04-30T21:45:00Z"

# What changed from parent
config: configs/mixed_vicreg_rd128_ga_snorm.yaml
config_diff:
  state_norm: true          # added

# Seeds
seeds: [42]

# Artifacts (written by alchemy on task completion)
artifacts:
  train:
    status: completed       # running | completed | failed
    checkpoint: /vol/bitbucket/ys25/jema/runs/mixed_vicreg_rd128_ga_snorm_s42/final.pt
    run_dir: /vol/bitbucket/ys25/jema/runs/mixed_vicreg_rd128_ga_snorm_s42/
    task_id: "abc123"
    finished_at: "2026-05-01T03:22:00Z"
  eval:
    status: pending
    results_json: null
    results_png: null

# Results (written by alchemy after eval)
metrics:
  silhouette_all: null
  silhouette_visual: null
  silhouette_text: null
```

### 3. Server-side: Auto-commit on Task Completion

When a task completes (or fails), if it belongs to an experiment with `git_tracking: true`:

1. Server sends a `stub.exec` to the stub that ran the task:
   ```bash
   cd <project_cwd> && \
   git checkout -B exp/<experiment_name> && \
   # Update manifest artifacts section
   python -c "import yaml; ..." && \
   git add experiments/<name>.yaml && \
   git commit -m "alchemy: <task_name> completed (exit <code>)" && \
   git checkout main
   ```

2. Or (simpler, recommended): **Server writes the manifest update via stub.exec, commits on a dedicated alchemy branch**.

#### Simpler approach — single tracking branch

Instead of one branch per experiment (messy with 30+ experiments):

- All manifests live on `main` in `experiments/` directory
- Alchemy auto-commits manifest updates to `main` (or a dedicated `alchemy-track` branch)
- Git history provides the lineage: `git log -- experiments/snorm_s42.yaml`
- Parent-child relationships are in the manifest YAML, not branch structure

**This is the recommended approach.** Branch-per-experiment is conceptually clean but operationally painful.

### 4. New API Endpoints

#### `POST /api/experiments` — Enhanced

Add optional fields to experiment creation:

```typescript
// Additional fields in POST /api/experiments body
interface ExperimentCreateGit {
  // ... existing fields ...
  git_tracking?: boolean;        // Enable git manifest tracking (default: false)
  git_repo_path?: string;        // Absolute path to git repo on stub
  parent_experiment?: string;    // Name of parent experiment (for manifest)
  config_file?: string;          // Relative path to config yaml
}
```

#### `GET /api/experiments/:id/manifest` — Get Manifest

Returns the experiment manifest YAML content.

#### `POST /api/experiments/:id/sync-manifest` — Force Sync

Re-reads artifacts from disk and updates manifest.

### 5. Task Completion Hook

In `socket/stub-events.ts`, after `task.completed`:

```typescript
// After existing completion logic...
if (task.experiment_id) {
  const exp = store.getExperiment(task.experiment_id);
  if (exp?.git_tracking) {
    await updateExperimentManifest(exp, task, stub);
  }
}
```

New module: `src/git-tracking.ts`

```typescript
import { Experiment, Task, Stub } from "./types";
import { execOnStub } from "./api/exec";

export async function updateExperimentManifest(
  exp: Experiment,
  task: Task,
  stub: Stub
): Promise<void> {
  const manifestPath = `experiments/${exp.name}.yaml`;
  const repoPath = exp.git_repo_path || task.cwd;

  // Determine which artifact section to update based on task ref or name
  const phase = task.ref || (task.name?.startsWith("eval_") ? "eval" : "train");

  const updateScript = `
cd ${repoPath} && \\
python3 -c "
import yaml, sys
path = '${manifestPath}'
try:
    with open(path) as f:
        m = yaml.safe_load(f) or {}
except FileNotFoundError:
    m = {'name': '${exp.name}', 'artifacts': {}}

if 'artifacts' not in m:
    m['artifacts'] = {}

m['artifacts']['${phase}'] = {
    'status': '${task.status}',
    'task_id': '${task.id}',
    'exit_code': ${task.exit_code ?? 'null'},
    'finished_at': '${task.finished_at || ''}',
    'run_dir': '${task.run_dir || ''}',
}

# If eval completed, try to read metrics
if '${phase}' == 'eval' and ${task.exit_code ?? -1} == 0:
    import json, glob
    for jf in glob.glob('results/eval_${exp.name}*.json'):
        try:
            with open(jf) as f:
                metrics = json.load(f)
            m['metrics'] = {k: v for k, v in metrics.items() if k.startswith('silhouette')}
            m['artifacts']['eval']['results_json'] = jf
            break
        except: pass

with open(path, 'w') as f:
    yaml.dump(m, f, default_flow_style=False, sort_keys=False)
" && \\
git add ${manifestPath} && \\
git commit -m "alchemy: ${task.name} ${task.status} (exit ${task.exit_code ?? '?'})" --allow-empty 2>/dev/null || true
`;

  try {
    await execOnStub(stub.id, updateScript, 15000);
  } catch (e) {
    // Non-fatal — manifest update failure shouldn't block task lifecycle
    logger.warn("git-tracking.update-failed", {
      experiment: exp.name,
      task: task.id,
      error: String(e),
    });
  }
}
```

### 6. Manifest Init on Experiment Creation

When creating an experiment with `git_tracking: true`, generate the initial manifest:

```typescript
export async function initExperimentManifest(
  exp: Experiment,
  stubId: string
): Promise<void> {
  const manifest = {
    name: exp.name,
    parent: exp.parent_name || null,
    created_at: exp.created_at,
    config: null,  // Will be filled by SDK
    config_diff: exp.config_diff || null,
    artifacts: {},
    metrics: {},
  };

  const yaml = serializeYaml(manifest);
  const manifestPath = `experiments/${exp.name}.yaml`;
  const repoPath = /* from exp or first task cwd */;

  await execOnStub(stubId, `
    cd ${repoPath} && \\
    mkdir -p experiments && \\
    cat > ${manifestPath} << 'MANIFEST_EOF'
${yaml}
MANIFEST_EOF
    git add ${manifestPath} && \\
    git commit -m "alchemy: init experiment ${exp.name}" || true
  `, 10000);
}
```

### 7. CLI / Query Support

#### `GET /api/experiments/lineage?name=<name>`

Returns the experiment's ancestry chain by following `parent` links in manifests:

```json
{
  "chain": [
    { "name": "vicreg_rd128_ga", "metrics": { "sil_all": 0.154 } },
    { "name": "vicreg_rd128_ga_snorm", "metrics": { "sil_all": null }, "diff": { "state_norm": true } }
  ]
}
```

---

## Implementation Plan

### Phase 1: Manifest CRUD (no auto-commit)

1. Add `git_tracking`, `git_repo_path` fields to `Experiment` type in `types.ts`
2. Create `src/git-tracking.ts` with `updateExperimentManifest()` and `initExperimentManifest()`
3. On experiment creation with `git_tracking: true`, generate initial manifest via stub.exec
4. On task completion, update manifest via stub.exec (non-blocking, fire-and-forget)
5. Add `GET /api/experiments/:id/manifest` endpoint

### Phase 2: Auto-commit

6. After manifest update, auto-commit via stub.exec (`git add && git commit`)
7. Add `--no-git-commit` flag for cases where user wants manual control

### Phase 3: Lineage Query

8. Add `GET /api/experiments/lineage` that reads manifest chain
9. Frontend: experiment lineage tree visualization

---

## Files to Modify

| File | Change |
|------|--------|
| `server/src/types.ts` | Add `git_tracking`, `git_repo_path` to `Experiment` |
| `server/src/git-tracking.ts` | **NEW** — manifest CRUD + auto-commit logic |
| `server/src/api/experiments.ts` | Call `initExperimentManifest` on create, add `/manifest` endpoint |
| `server/src/socket/stub-events.ts` | Call `updateExperimentManifest` on task completion |

---

## Non-Goals

- Git LFS or any large file tracking — weights stay on disk, manifest just points to paths
- Branch-per-experiment — too many branches, use single branch + manifest files instead
- Replacing alchemy's task DB — git tracks lineage/config, alchemy tracks runtime state
- Automatic push to remote — commit locally, user pushes when ready

---

## Edge Cases

- **Stub that ran task goes offline before manifest commit:** Non-fatal. Manifest can be synced later via `/sync-manifest`.
- **Merge conflicts in manifest:** Unlikely since each experiment writes its own file. If it happens, `git commit` will fail silently (the `|| true`).
- **Multiple seeds:** One manifest per experiment name (not per seed). Seeds listed in manifest, artifacts keyed by seed.
- **Concurrent writes:** stub.exec is sequential per stub, so no race within a single node.
