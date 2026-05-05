# Implement: Experiment Feature (假说驱动的实验管理)

## Context

Alchemy v2 is a distributed ML task scheduler (Node.js server, Python stubs on GPU nodes, Python SDK in training scripts, React web dashboard). See `DESIGN.md` §11 for the full design spec.

Currently, `Grid` groups tasks by Cartesian product of params, but has no success criteria validation. Users manually check eval metrics after completion. This is the #1 pain point.

## What to Build

An `Experiment` entity that wraps a Grid, adds success criteria, and auto-validates task results.

## Architecture Overview

```
SDK: al.experiment() → POST /api/experiments
Server: Experiment CRUD + criteria validation on task.eval events  
Web: ExperimentsPage + experiment detail view with matrix heatmap
```

## Detailed Implementation Plan

### 1. Server: Types (`server/src/types.ts`)

Add after the `Grid` interface:

```typescript
export interface CriterionResult {
  value: number;
  threshold: string;    // e.g. "> 0.3"
  ok: boolean;
}

export interface TaskValidation {
  passed: boolean;
  checked_at: string;
  details: Record<string, CriterionResult>;
}

export interface Experiment {
  id: string;
  name: string;
  description?: string;
  criteria: Record<string, string>;    // "metric_name": "op value"
  grid_id: string;
  status: "running" | "passed" | "partial" | "failed";
  results: Record<string, TaskValidation>;  // taskId → validation
  created_at: string;
}
```

Add `experiments` to `ServerState`:
```typescript
export interface ServerState {
  // ... existing fields ...
  experiments: Experiment[];
}
```

### 2. Server: Store (`server/src/store/index.ts`)

Add to the Store class:

```typescript
private experiments: Map<string, Experiment> = new Map();

// CRUD
getExperiment(id: string): Experiment | undefined
getAllExperiments(): Experiment[]
setExperiment(exp: Experiment): void
deleteExperiment(id: string): void
getExperimentByGridId(gridId: string): Experiment | undefined
```

Add experiments to `serialize()` / `deserialize()` for state persistence.

### 3. Server: Criteria Engine (`server/src/criteria.ts`) — NEW FILE

```typescript
/**
 * Parse and evaluate criteria expressions.
 * 
 * Supported formats:
 *   "> 0.3"           → value > 0.3
 *   "< 0.5"           → value < 0.5
 *   ">= 0.3"          → value >= 0.3
 *   "<= 0.5"          → value <= 0.5
 *   ">= 0.3 && < 0.8" → 0.3 <= value < 0.8
 */

export function parseCriterion(expr: string): (value: number) => boolean;
export function evaluateCriteria(
  criteria: Record<string, string>,
  metrics: Record<string, number>
): { passed: boolean; details: Record<string, CriterionResult> };
```

Implementation notes:
- Use simple regex parsing, NOT eval(). Security matters.
- `parseCriterion` returns a predicate function.
- `evaluateCriteria` checks all criteria against provided metrics. A criterion is skipped (not failed) if its metric key is absent from the metrics dict — the task might report that metric in a later eval call.
- Overall `passed` = all present criteria pass. If some metrics haven't been reported yet, `passed` stays false but individual missing criteria are marked as `pending`, not `failed`.

### 4. Server: Eval Event Handler (`server/src/socket/stub.ts`)

**IMPORTANT**: The server currently does NOT handle `task.eval` events from stubs. The stub emits `task.eval` (see `daemon.py:638`) but the server has no listener. You must add one.

Add a handler in `registerStubEvents()`, near the existing `task.metrics` handler (~line 338):

```typescript
socket.on("task.eval", (payload: { task_id: string; metrics: Record<string, number> }, ack?: Function) => {
  const stubId = socketToStub.get(socket.id);
  if (!stubId) { if (ack) ack({ ok: false }); return; }
  
  const task = store.getTask(stubId, payload.task_id);
  if (!task) { if (ack) ack({ ok: false }); return; }
  
  // Store eval metrics on the task
  store.updateTask(stubId, payload.task_id, {
    eval_metrics: payload.metrics,
  });
  
  // Check experiment criteria
  if (task.grid_id) {
    const exp = store.getExperimentByGridId(task.grid_id);
    if (exp) {
      const result = evaluateCriteria(exp.criteria, payload.metrics);
      exp.results[payload.task_id] = {
        passed: result.passed,
        checked_at: new Date().toISOString(),
        details: result.details,
      };
      exp.status = deriveExperimentStatus(exp);
      store.setExperiment(exp);
      webNs.emit("experiment.update", exp);
      
      // Discord notification on status change
      if (exp.status === "passed") {
        notifyExperimentPassed(exp);
      }
    }
  }
  
  // Also forward to web
  webNs.emit("task.eval", { stub_id: stubId, task_id: payload.task_id, metrics: payload.metrics });
  if (ack) ack({ ok: true });
});
```

Also add `eval_metrics?: Record<string, number>` to the `Task` interface in types.ts.

### 5. Server: Experiment Status Derivation

```typescript
function deriveExperimentStatus(exp: Experiment): Experiment["status"] {
  const grid = store.getGrid(exp.grid_id);
  if (!grid) return "running";
  
  const totalTasks = grid.task_ids.length;
  const validated = Object.values(exp.results);
  const passed = validated.filter(v => v.passed).length;
  const failed = validated.filter(v => !v.passed).length;
  
  // Check if all tasks in grid are terminal
  const tasks = store.getGridTasks(exp.grid_id);
  const allDone = tasks.every(t => ["completed", "failed", "killed", "lost"].includes(t.status));
  
  if (passed === totalTasks) return "passed";
  if (allDone && failed > 0) return passed > 0 ? "partial" : "failed";
  return "running";
}
```

### 6. Server: API Routes (`server/src/api/experiments.ts`) — NEW FILE

```
POST   /experiments          — create experiment (creates grid internally)
GET    /experiments          — list all experiments with derived status
GET    /experiments/:id      — experiment detail + task validations
DELETE /experiments/:id      — delete experiment (does NOT delete tasks)
POST   /experiments/:id/retry-failed — retry tasks that failed criteria
```

**POST /experiments** request body:
```json
{
  "name": "ctx_scaling_atari",
  "description": "context length impact on z_rule quality",
  "criteria": {
    "silhouette_l2": "> 0.3",
    "nmi": "> 0.1"
  },
  "script": "train.py",
  "matrix": {
    "ctx_len": [16, 32, 64, 128],
    "seed": [42, 123, 789]
  },
  "requirements": { "gpu_mem_mb": 20000 },
  "target_tags": ["a40"]
}
```

Implementation: internally call the grid creation logic (extract `cartesianProduct` and task creation from `grids.ts` into a shared function, or just POST to the grids endpoint internally). Then create the Experiment entity linking to the grid.

Register router in `server/src/index.ts` at `/api/experiments`.

### 7. Server: Discord Notification (`server/src/discord.ts`)

Add `notifyExperimentPassed(exp)` and `notifyExperimentPartial(exp)` functions. Format:

```
✅ Experiment "ctx_scaling_atari" PASSED (18/18)
⚠️ Experiment "ctx_scaling_atari" PARTIAL (12/18 passed)
   Failed: ctx16/s789 (sil=0.18 < 0.3)
```

### 8. Web: ExperimentsPage (`web/src/pages/ExperimentsPage.tsx`) — NEW FILE

List view showing all experiments:
- Name, status badge (passed=green, partial=yellow, running=blue, failed=red)
- Progress bar: `12/18 passed ██████████░░░░ 67%`
- Created date
- Click → detail view

### 9. Web: Experiment Detail View

Matrix heatmap showing param combinations × seeds:

```
              s42    s123    s789
ctx_len=16    ✓      ✓       ✗
ctx_len=32    ✓      ✓       ✓  
ctx_len=64    🔄     🔄      🔄
ctx_len=128   ⏳     ⏳      ⏳
```

- ✓ green = all criteria passed
- ✗ red = at least one criterion failed (show tooltip with details)
- 🔄 running
- ⏳ pending/queued

Click a cell → expand to show per-criterion results:
```
silhouette_l2: 0.42 > 0.3 ✓
nmi: 0.08 > 0.1 ✗
```

Reuse existing task table components from GridView.tsx where possible.

### 10. Web: Navigation

Add "Experiments" to the sidebar navigation, between "Grids" and existing items.

### 11. SDK Changes (`sdk/alchemy_sdk/client.py`)

**Minimal changes** — the experiment is created via API, not SDK. The SDK's existing `log_eval()` already sends eval metrics through the pipeline. No SDK changes needed for v1.

In a future iteration, add `al.experiment()` as a convenience wrapper that POSTs to the API. But for v1, experiments are created via the web UI or direct API call.

## File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `server/src/types.ts` | EDIT | Add Experiment, CriterionResult, TaskValidation interfaces; add eval_metrics to Task |
| `server/src/store/index.ts` | EDIT | Add experiments Map + CRUD methods + serialize/deserialize |
| `server/src/criteria.ts` | NEW | Criteria expression parser + evaluator |
| `server/src/socket/stub.ts` | EDIT | Add task.eval handler with criteria check hook |
| `server/src/api/experiments.ts` | NEW | Experiment CRUD routes |
| `server/src/api/grids.ts` | EDIT | Extract cartesianProduct + task creation into shared util (or keep and import) |
| `server/src/index.ts` | EDIT | Register /api/experiments router |
| `server/src/discord.ts` | EDIT | Add experiment notification functions |
| `web/src/pages/ExperimentsPage.tsx` | NEW | List + detail view |
| `web/src/App.tsx` (or router config) | EDIT | Add route + sidebar nav |

## Implementation Order

1. `types.ts` — interfaces first
2. `criteria.ts` — pure logic, easy to test
3. `store/index.ts` — persistence
4. `api/experiments.ts` — CRUD
5. `socket/stub.ts` — eval handler + criteria hook
6. `discord.ts` — notifications
7. `index.ts` — wire up router
8. Web pages — last, after API is solid

## Testing

After implementation:
1. `cd server && npm run build` — must compile cleanly
2. Create an experiment via curl:
```bash
curl -X POST http://localhost:3002/api/experiments \
  -H "Authorization: Bearer alchemy-v2-token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test_exp",
    "criteria": {"loss": "< 1.0"},
    "script": "echo hello",
    "matrix": {"seed": [1, 2]}
  }'
```
3. Verify GET /api/experiments returns the experiment
4. `cd web && npm run build` — must compile cleanly

## Non-Goals (do NOT implement)

- `top_k()` criteria — defer to v2
- SDK-side `al.experiment()` convenience — defer to v2
- Experiment templates / cloning
- Cross-experiment comparison views
