# Alchemy v2 — Next Development Specs

## Spec 1: Stub umask + env_config (P0)

### Problem
Training jobs create files with `rw-------` permissions. When a different user's stub runs eval, it gets PermissionError.

### Requirements
1. **Stub-side umask**: Stub sets `umask 022` before spawning any task subprocess, ensuring all output files are world-readable (`rw-r--r--`).
2. **Structured env config**: Stub accepts a `default_env` config (via CLI `--default-env-file env.yaml` or inline `--default-env KEY=VAL`):
   ```yaml
   default_cwd: /vol/bitbucket/ys25/jema
   default_env:
     PATH: /vol/bitbucket/ys25/conda-envs/jema/bin:${PATH}
     PYTHONPATH: /vol/bitbucket/ys25/jema:${PYTHONPATH}
     NUMBA_CACHE_DIR: /tmp/numba_cache
   umask: "022"
   ```
3. Task `env` field merges on top of `default_env` (task wins on conflict).
4. Task `cwd` falls back to `default_cwd` if not specified.
5. Existing `--env-setup` CLI arg continues to work (applied before default_env).

### Files to modify
- `stub/alchemy_stub/__main__.py` — add `--default-env-file`, `--umask` CLI args
- `stub/alchemy_stub/runner.py` (or equivalent task spawn logic) — apply umask + env merge before subprocess.Popen
- Add test

---

## Spec 2: Artifact Rollback on Failure (P1)

### Problem
Failed eval tasks leave 0-byte output files. Retry tasks can't overwrite them (EPERM from different user). Must manually rm.

### Requirements
1. New optional task field: `outputs: string[]` — list of file paths the task will produce.
2. Server stores `outputs` on the task object, passes to stub with dispatch.
3. Stub behavior on task **failure** (non-zero exit):
   - Delete all files listed in `outputs` that were created/modified after task start time.
   - Log cleanup actions.
4. Stub behavior on task **success**:
   - Verify declared outputs exist (warning if missing, don't fail).
   - If task has `exports` field, register output file paths as export values.
5. API: `POST /api/tasks` accepts `outputs` array.

### Files to modify
- `server/src/types.ts` — add `outputs?: string[]` to Task/TaskSpec
- `server/src/socket/stub.ts` — pass outputs in dispatch, handle cleanup report
- `stub/alchemy_stub/runner.py` — implement cleanup logic on failure
- Add test

---

## Spec 3: Stub Remote Exec via WebSocket (P1)

### Problem
SSH to cluster takes 5-15s per command (two jump hosts). Stubs already have persistent WS connections.

### Requirements
1. **Server endpoint**: `POST /api/stubs/:id/exec`
   - Body: `{ "command": "ls -la runs/", "timeout": 10000 }`
   - Auth: same alchemy token
   - Response: `{ "stdout": "...", "stderr": "...", "exit_code": 0, "truncated": false }`
2. **Server→Stub WS**: Server emits `exec.request` to target stub, waits for `exec.response`.
   - Timeout: configurable, default 30s.
   - If stub offline → 503.
3. **Stub-side**: 
   - Listen for `exec.request`, spawn subprocess with 30s timeout.
   - Stdout/stderr truncated to 4KB each. Set `truncated: true` if exceeded.
   - Command runs in stub's `default_cwd` with `default_env`.
   - **No shell=True** — use shlex.split. Or if command contains pipes/redirects, use shell=True with timeout.
4. **Security**: Optional `--allow-exec` flag on stub (default: disabled). Without it, stub rejects exec requests.

### Files to modify
- `server/src/api/stubs.ts` (or new file `server/src/api/exec.ts`) — HTTP endpoint
- `server/src/socket/stub.ts` — WS relay logic
- `stub/alchemy_stub/__main__.py` — `--allow-exec` flag
- `stub/alchemy_stub/exec.py` (new) — exec handler
- Add test

---

## Spec 4: Results Directory Permissions (P0, quick fix)

### Problem
`results/` directory and existing files have mixed ownership. Need sticky bit and group write.

### Requirements
1. **sbatch template**: Add `umask 022` at top of `sbatch_alchemy_a30.sh` and `sbatch_alchemy_a40.sh`.
2. This is a one-liner fix in each sbatch file. Just add `umask 022` after the shebang/SBATCH directives.
