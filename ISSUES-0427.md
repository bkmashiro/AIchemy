# Alchemy v2 Issues — 2026-04-27

## P0-1: Stub reconnect overwrites API-set tags

**Symptom:** PATCH `/api/stubs/:id` with `{"tags":["a30"]}` works, but tags reset to `[]` after stub reconnects.

**Suspected cause:** `socket/stub.ts` resume handler uses `tags ?? existingStub.tags`. Empty array `[]` is not nullish, so it overwrites API-set tags.

**Fix:** Change to `(tags && tags.length > 0) ? tags : existingStub.tags`

---

## P0-2: Kill + resubmit blocked by fingerprint dedup

**Symptom:** After batch-kill a running task, immediately resubmitting same script gets `"Task with same fingerprint is already active"` because kill is async — status hasn't transitioned yet.

**Suspected cause:** Dedup check in task creation doesn't exclude tasks in kill-pending state, or kill signal takes seconds to propagate.

**Fix options:**
- a) Dedup should exclude `killed` / `killing` status tasks
- b) Task creation should wait briefly or allow `force` flag to bypass dedup
- c) Kill endpoint should be synchronous (wait for stub ack before returning)

---

## P1-1: No task reschedule/migrate operation

**Symptom:** Moving a task from one GPU type to another requires: kill → wait → resubmit with new name (fingerprint dedup) → new target_tags. Too many manual steps.

**Desired:** Single `reschedule` action: kill current execution, requeue with new target_tags, preserve name/config.

---

## P1-2: Kill API inconsistency

**Symptom:** `PATCH /api/tasks/:id {"status":"killed"}` silently does nothing for running tasks. Only `POST /api/tasks/batch {"action":"kill"}` works.

**Suspected cause:** PATCH handler may not trigger the kill chain for running tasks, or requires stub_id logic that isn't reached.

**Fix:** PATCH with `status=killed` should trigger the same kill chain as batch kill.

---

## ~~P2-1: No stub GPU utilization metrics~~ — NOT AN ISSUE

Already implemented: stub reports `gpu_stats` (utilization_pct, memory_used_mb), scheduler uses `availableVram()` for VRAM-aware dispatch, dashboard receives via WS.

---

## P2-2: Task log_buffer lost after completion/kill

**Symptom:** Once a task terminates, log_buffer is eventually cleared. No way to review logs of past tasks without SSH.

**Scope:** Persist last N lines of log to disk on task completion.
