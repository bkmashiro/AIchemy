# Alchemy v2 — GPU Task Queue

## Project Shape

- **Server**: Node.js/TypeScript, Socket.IO + REST API, SQLite WAL persistence.
- **Stub**: Python daemon on GPU nodes. Connects to server over WebSocket and runs tasks as subprocesses.
- **Web**: Vite + React dashboard.
- **Deploy config**: `deploy-config.yaml` can start Cloudflare tunnel and remote stubs. Treat deploy/restart commands as production-affecting.

## Important Safety Rule

Do **not** deploy, restart the server, restart tunnels, or redeploy stubs unless the user explicitly asks. There may be long-running GPU tasks in flight.

Avoid these unless explicitly requested:

```bash
bash deploy.sh
npm run deploy
curl -X POST */deploy/*
```

## Key Directories

```text
server/src/
  index.ts              HTTP + Socket.IO setup
  socket/stub.ts        Stub namespace: resume, heartbeat, disconnect, task events
  store/index.ts        In-memory + SQLite store, archive, prune logic
  task-actions.ts       State transition helpers
  scheduler.ts          Task dispatch/scoring
  dag.ts                Dependency handling
  api/*.ts              REST API routers
  reliable.ts           Ack/retry emit path for server-to-stub messages
  version.ts            Server version
  __tests__/            Vitest unit tests

server/tests/           Vitest integration-style server/socket tests
stub/alchemy_stub/      Python stub package
sdk/alchemy_sdk/        Python SDK
web/src/                React dashboard
```

## Build and Test Commands

```bash
# Server
cd server && npm run build
cd server && npm test -- --run
cd server && npm test -- --run tests/socket-stub.test.ts

# Stub / SDK
cd stub && uv run pytest tests/test_cgroup_memory.py
cd sdk && uv run pytest tests/test_client.py
```

Notes:
- `npm test -- --run` may start local test servers and Cloudflare tunnel subprocesses from config. It is test-only, but noisy.
- If the full Vitest suite fails with `EADDRINUSE`, rerun the failing suite alone before treating it as a product failure.
- `uv` may generate `uv.lock`; repo policy currently ignores `/sdk/uv.lock` and `/stub/uv.lock`.

## Current Runtime Semantics

- Task lifecycle is based on active states like `pending`, `assigned`, `running`, `paused`, plus terminal states `completed`, `failed`, `cancelled`, and DAG `blocked`.
- `disconnected_at` is a flag on a task, not a separate task state.
- On stub disconnect, running tasks should stay running with `disconnected_at` set.
- Disconnected running tasks must not be archived just because a stub dropped.
- Disconnect failure timeout is intentionally long (`DISCONNECT_FAIL_MS`, currently 6 hours) to protect jobs from tunnel blips.

## Stub Resume / Rolling Upgrade Rules

These are production-sensitive. Be conservative.

- `stub_version` mismatch is a warning by default. Only enforce rejection when `ALCHEMY_ENFORCE_VERSION=1` or `true`.
- Old stubs may not send `stub_id`. Server must preserve compatibility with the legacy identity formula when a matching persisted stub row exists.
- Do not change the stub identity formula without a migration/alias strategy and tests.
- Zombie/stale stub cleanup is dangerous during rolling upgrades. It is disabled by default and gated behind `ALCHEMY_ENABLE_ZOMBIE_CLEANUP=1`.
- Zombie cleanup must never fail or archive running/paused tasks. Disconnect reconciliation owns running task failure.

## Code Quality Rules

- No broad `git add .`; stage explicit files.
- Do not commit runtime state: `state.db*`, generated lock files, build output, cache dirs, local backups.
- Keep tests close to behavior changes. Socket/stub changes need tests in `server/tests/socket-stub.test.ts` or related integration tests.
- Prefer explicit structured logs over silent behavior changes.
- Do not hide data loss. If metrics or fields are dropped, warn or document why.

## Useful Review Focus

When reviewing server/stub changes, check:

1. Rolling upgrade compatibility between old stubs and new server.
2. Whether reconnect/resume can misclassify live work as zombie/stale.
3. Whether running tasks can be failed, archived, or requeued too aggressively.
4. Whether API endpoints expose internal task/stub/deploy metadata without auth.
5. Whether tests cover both old-client and new-client paths.
