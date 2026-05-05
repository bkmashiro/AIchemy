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

**Problem:** SLURM walltime/OOM/preempt kills require manual resume. Resource data is wrong (reads host totals, not cgroup/SLURM allocation).

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

### B3. Resource data from SLURM params
- Server already generates sbatch scripts → knows `--mem`, `--time`, `--gres`
- Store these as `slurm_constraints` on stub record
- Stub on startup: read `SLURM_MEM_PER_NODE`, `SLURM_JOB_NUM_NODES`, `SLURM_CPUS_ON_NODE` from env
- Report actual SLURM allocation alongside hardware totals
- Dashboard shows allocated resources, not host totals

**Tests:** Add smoke test for death classification. Unit test auto-resume decision logic.

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
