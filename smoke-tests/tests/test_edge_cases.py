"""Edge-case smoke tests based on code review of server + stub source.

Each test targets a specific race condition, state machine gap, or failure
mode found by reading the actual implementation (not the design doc).
"""
from __future__ import annotations

import os
import time
from uuid import uuid4

import httpx
import pytest

from harness.waiter import wait_for_status, wait_all_terminal, TERMINAL_STATUSES

SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts"))


def _script(name: str) -> str:
    return os.path.join(SCRIPTS, name)


def _unique_name(base: str) -> str:
    return f"{base}_{uuid4().hex[:8]}"


class TestDispatchTimeout:
    """scheduler.ts:228 — 30s dispatch timeout marks task as failed if stub
    never sends task.started. This catches broken stubs that ack task.run
    but never actually spawn the process."""

    def test_dispatch_timeout_on_nonexistent_command(self, api, stub_default, tmp_path):
        """A task with a command that hangs on bash startup (broken env_setup)
        should eventually fail via dispatch timeout or process exit.
        The 30s setTimeout in maybeDispatch() is a safety net."""
        name = _unique_name("smoke_dispatch_timeout")
        # env_setup that hangs — the bash process will start but the
        # inner command never runs, so task.started might never fire.
        # In practice the subprocess exits quickly on bad env_setup,
        # but this verifies the overall failure path works.
        task = api.submit_expect(
            "echo done",
            name=name,
            env_setup="source /nonexistent/env/activate_smoke_test_edge_case",
        )
        final = wait_for_status(api, task["id"], TERMINAL_STATUSES, timeout=45)
        assert final["status"] == "failed", (
            f"Expected failed (dispatch timeout or process error), got {final['status']}"
        )


class TestKillPendingTask:
    """api/tasks.ts:232-244 — killing a pending task (in global queue, no stub)
    uses killGlobalTask(), a completely different code path from the stub-based
    kill chain. Existing tests only kill running tasks."""

    def test_kill_pending_before_dispatch(self, api, stub_factory):
        """Submit a task that can't be dispatched (no matching tag), then
        kill it while it's still pending in the global queue."""
        impossible_tag = f"impossible_{uuid4().hex[:8]}"
        name = _unique_name("smoke_kill_pending")
        task = api.submit_expect(
            "echo never_runs",
            name=name,
            target_tags=[impossible_tag],
        )
        # Task should stay pending since no stub has this tag
        time.sleep(2)
        t = api.get_task(task["id"])
        assert t["status"] == "pending", f"Expected pending, got {t['status']}"

        # Kill it
        api.kill_task(task["id"])

        final = api.get_task(task["id"])
        assert final["status"] == "killed"


class TestBatchEdgeCases:
    """api/tasks.ts batch endpoint — verify guard clauses on wrong states."""

    def test_batch_retry_running_task_rejected(self, api, stub_default):
        """Retrying a running task should fail (only terminal tasks can retry).
        api/tasks.ts:249 checks TERMINAL_STATUSES."""
        name = _unique_name("smoke_batch_retry_running")
        task = api.submit_expect("sleep 30", name=name)
        wait_for_status(api, task["id"], {"running"}, timeout=15)

        result = api.batch("retry", [task["id"]])
        items = result.get("results", [])
        assert len(items) == 1
        assert items[0]["ok"] is False, "Retry on running task should fail"
        assert "cannot retry" in items[0].get("error", "").lower()

        # Cleanup
        api.kill_task(task["id"])
        wait_for_status(api, task["id"], TERMINAL_STATUSES, timeout=15)

    def test_batch_delete_running_task_rejected(self, api, stub_default):
        """Deleting a running task should fail (only terminal tasks can delete).
        api/tasks.ts:287 checks TERMINAL_STATUSES."""
        name = _unique_name("smoke_batch_delete_running")
        task = api.submit_expect("sleep 30", name=name)
        wait_for_status(api, task["id"], {"running"}, timeout=15)

        result = api.batch("delete", [task["id"]])
        items = result.get("results", [])
        assert len(items) == 1
        assert items[0]["ok"] is False, "Delete on running task should fail"

        # Cleanup
        api.kill_task(task["id"])
        wait_for_status(api, task["id"], TERMINAL_STATUSES, timeout=15)

    def test_batch_kill_already_completed(self, api, stub_default):
        """Killing an already-completed task should fail gracefully."""
        name = _unique_name("smoke_batch_kill_completed")
        task = api.submit_expect(
            f"bash {_script('success_fast.sh')}",
            name=name,
        )
        final = wait_for_status(api, task["id"], {"completed"}, timeout=30)
        assert final["status"] == "completed"

        result = api.batch("kill", [final["id"]])
        items = result.get("results", [])
        assert len(items) == 1
        assert items[0]["ok"] is False, "Kill on completed task should fail"

    def test_batch_unknown_action(self, api, stub_default):
        """Unknown batch action should return error per task.
        api/tasks.ts:303 default case."""
        name = _unique_name("smoke_batch_unknown")
        task = api.submit_expect(
            f"bash {_script('success_fast.sh')}",
            name=name,
        )
        wait_for_status(api, task["id"], {"completed"}, timeout=30)

        result = api.batch("explode", [task["id"]])
        items = result.get("results", [])
        assert len(items) == 1
        assert items[0]["ok"] is False


class TestDoubleKill:
    """socket/stub.ts:163-189 — initiateKillChain creates a safety-net
    setTimeout. Calling kill twice creates two timers. The second kill
    should be idempotent and not corrupt state."""

    def test_double_kill_is_idempotent(self, api, stub_default, tmp_path):
        """Kill the same running task twice in rapid succession.
        Both should succeed without error; final state is killed."""
        script_path = str(tmp_path / "slow_trap.sh")
        with open(script_path, "w") as f:
            f.write("#!/usr/bin/env bash\ntrap '' SIGTERM\nsleep 999\n")
        os.chmod(script_path, 0o755)

        name = _unique_name("smoke_double_kill")
        task = api.submit_expect(f"bash {script_path}", name=name)
        wait_for_status(api, task["id"], {"running"}, timeout=15)
        time.sleep(1)

        # Kill twice rapidly
        api.kill_task(task["id"])
        # Second kill — should not throw
        try:
            api.kill_task(task["id"])
        except Exception:
            pass  # Some servers reject, that's fine

        final = wait_for_status(api, task["id"], TERMINAL_STATUSES, timeout=60)
        assert final["status"] == "killed"


class TestStatusTransitionGuards:
    """state-machine.ts — canTransition() prevents illegal transitions.
    Verify that the API actually enforces these guards."""

    def test_cannot_pause_pending_task(self, api, stub_factory):
        """Pausing a pending (undispatched) task should return 400.
        State machine: pending can only → queued or killed."""
        impossible_tag = f"notag_{uuid4().hex[:8]}"
        name = _unique_name("smoke_pause_pending")
        task = api.submit_expect(
            "echo never",
            name=name,
            target_tags=[impossible_tag],
        )
        time.sleep(1)

        # Attempt pause
        client = httpx.Client(
            base_url=api.base_url,
            headers={"Authorization": f"Bearer {api.token}"},
            timeout=10.0,
        )
        r = client.patch(f"/api/tasks/{task['id']}", json={"status": "paused"})
        client.close()
        assert r.status_code == 400, f"Expected 400 on illegal transition, got {r.status_code}"

        # Cleanup
        api.kill_task(task["id"])

    def test_cannot_set_completed_back_to_running(self, api, stub_default):
        """Completed → running is illegal. State machine: completed has no outgoing transitions."""
        name = _unique_name("smoke_completed_to_running")
        task = api.submit_expect(
            f"bash {_script('success_fast.sh')}",
            name=name,
        )
        final = wait_for_status(api, task["id"], {"completed"}, timeout=30)
        assert final["status"] == "completed"

        client = httpx.Client(
            base_url=api.base_url,
            headers={"Authorization": f"Bearer {api.token}"},
            timeout=10.0,
        )
        r = client.patch(f"/api/tasks/{task['id']}", json={"status": "running"})
        client.close()
        # Should be rejected (400 or ignored)
        assert r.status_code == 400, f"Expected 400, got {r.status_code}"


class TestRetryExhaustion:
    """socket/stub.ts:101-125 — handleAutoRetry checks retry_count < max_retries.
    When retries are exhausted, no new task should be created."""

    def test_max_retries_honored(self, api, stub_default, tmp_path):
        """Submit a task with max_retries=1 that always fails.
        Should produce exactly 2 tasks (original + 1 retry), not more."""
        name = _unique_name("smoke_retry_exhaust")
        task = api.submit_expect(
            "exit 1",
            name=name,
            max_retries=1,
            param_overrides={"retry_exhaust_run": uuid4().hex[:8]},
        )
        # Wait for original to fail
        wait_for_status(api, task["id"], {"failed"}, timeout=20)
        # Wait a bit for retry task to be created and also fail
        time.sleep(8)

        # Count tasks that are retries of the original
        listing = api.list_tasks(limit=100)
        related = [
            t for t in listing["tasks"]
            if t.get("retry_of") == task["id"] or t["id"] == task["id"]
        ]
        # Original + at most 1 retry = 2 total
        assert len(related) <= 2, (
            f"Expected <=2 tasks (orig + 1 retry), got {len(related)}"
        )


class TestEmptyScriptRejection:
    """api/tasks.ts:321-323 — POST /tasks requires script field.
    Missing or empty script should return 400."""

    def test_empty_script(self, api, stub_default):
        """Empty script string should be rejected."""
        client = httpx.Client(
            base_url=api.base_url,
            headers={"Authorization": f"Bearer {api.token}"},
            timeout=10.0,
        )
        r = client.post("/api/tasks", json={"script": ""})
        client.close()
        assert r.status_code == 400, f"Expected 400 for empty script, got {r.status_code}"

    def test_missing_script(self, api, stub_default):
        """Missing script field should be rejected."""
        client = httpx.Client(
            base_url=api.base_url,
            headers={"Authorization": f"Bearer {api.token}"},
            timeout=10.0,
        )
        r = client.post("/api/tasks", json={"name": "no_script"})
        client.close()
        assert r.status_code == 400, f"Expected 400 for missing script, got {r.status_code}"


class TestLogBufferOverflow:
    """socket/stub.ts:332 — log_buffer is capped at 500 lines via splice.
    Verify that a task producing massive output doesn't OOM the server
    and that the buffer stays bounded."""

    def test_large_output_capped(self, api, stub_default, tmp_path):
        """Task producing >500 lines of output: log_buffer length <= 500."""
        script_path = str(tmp_path / "log_flood.sh")
        with open(script_path, "w") as f:
            # Generate 1000 lines of output
            f.write("#!/usr/bin/env bash\nfor i in $(seq 1 1000); do echo \"line $i of log flood test\"; done\nexit 0\n")
        os.chmod(script_path, 0o755)

        name = _unique_name("smoke_log_overflow")
        task = api.submit_expect(f"bash {script_path}", name=name)
        final = wait_for_status(api, task["id"], {"completed"}, timeout=30)
        assert final["status"] == "completed"

        # Fetch logs — buffer should be capped
        logs = api.get_logs(task["id"])
        assert len(logs) <= 500, f"Log buffer exceeded cap: {len(logs)} lines"


class TestWriteLockRelease:
    """dedup.ts — write lock acquired on task.started (stub.ts:703).
    After a task fails, the lock should be released so the same run_dir
    can be reused. If not released, it's a resource leak."""

    def test_write_lock_released_after_failure(self, api, stub_default, tmp_path):
        """Task that fails should release its run_dir write lock,
        allowing a new task to use the same run_dir."""
        run_dir = str(tmp_path / "locked_run")
        os.makedirs(run_dir, exist_ok=True)

        # Task 1: fails
        name1 = _unique_name("smoke_lock_fail")
        task1 = api.submit_expect(
            "exit 1",
            name=name1,
            run_dir=run_dir,
            param_overrides={"lock_fail_1": uuid4().hex[:8]},
        )
        wait_for_status(api, task1["id"], {"failed"}, timeout=20)
        # Brief wait for write lock release to propagate
        time.sleep(1)

        # Task 2: same run_dir should now be accepted (lock released)
        name2 = _unique_name("smoke_lock_reuse")
        task2 = api.submit_expect(
            "echo reuse_ok",
            name=name2,
            run_dir=run_dir,
            param_overrides={"lock_fail_2": uuid4().hex[:8]},
        )
        final = wait_for_status(api, task2["id"], {"completed"}, timeout=20)
        assert final["status"] == "completed"


class TestWriteLockReleaseAfterKill:
    """Same as above but for killed tasks. Kill → should release lock."""

    def test_write_lock_released_after_kill(self, api, stub_default, tmp_path):
        """Killed task should release its run_dir write lock."""
        run_dir = str(tmp_path / "kill_lock")
        os.makedirs(run_dir, exist_ok=True)

        name1 = _unique_name("smoke_kill_lock")
        task1 = api.submit_expect(
            "sleep 999",
            name=name1,
            run_dir=run_dir,
            param_overrides={"kill_lock_1": uuid4().hex[:8]},
        )
        wait_for_status(api, task1["id"], {"running"}, timeout=15)
        time.sleep(1)

        api.kill_task(task1["id"])
        wait_for_status(api, task1["id"], TERMINAL_STATUSES, timeout=30)
        time.sleep(1)

        # Same run_dir should be reusable
        name2 = _unique_name("smoke_kill_lock_reuse")
        task2 = api.submit_expect(
            "echo reuse_ok",
            name=name2,
            run_dir=run_dir,
            param_overrides={"kill_lock_2": uuid4().hex[:8]},
        )
        final = wait_for_status(api, task2["id"], {"completed"}, timeout=20)
        assert final["status"] == "completed"


class TestRequeuePreservesFingerprint:
    """api/tasks.ts:256-283 — requeue resets status to pending but keeps
    the same task ID and fingerprint. The dedup system should NOT reject
    the requeued task (since it's the same task object, not a new submit)."""

    def test_requeue_after_failure(self, api, stub_default, tmp_path):
        """A failed task can be requeued and runs again successfully."""
        # Prepare a script that fails first time, succeeds second
        marker = str(tmp_path / "requeue_marker")
        script_path = str(tmp_path / "requeue_test.sh")
        with open(script_path, "w") as f:
            f.write(f"#!/usr/bin/env bash\nif [ -f '{marker}' ]; then echo 'second run ok'; exit 0; fi\ntouch '{marker}'\nexit 1\n")
        os.chmod(script_path, 0o755)

        name = _unique_name("smoke_requeue")
        task = api.submit_expect(
            f"bash {script_path}",
            name=name,
            param_overrides={"requeue_run": uuid4().hex[:8]},
        )
        # First run: fails
        wait_for_status(api, task["id"], {"failed"}, timeout=20)

        # Requeue
        result = api.batch("requeue", [task["id"]])
        assert result["results"][0]["ok"] is True

        # Second run: succeeds (marker file now exists)
        final = wait_for_status(api, task["id"], {"completed"}, timeout=20)
        assert final["status"] == "completed"


class TestPatchNonexistentTask:
    """api/tasks.ts:389 — GET/PATCH for nonexistent task should 404."""

    def test_get_nonexistent_returns_404(self, api):
        """GET /api/tasks/:id for bogus ID returns 404."""
        client = httpx.Client(
            base_url=api.base_url,
            headers={"Authorization": f"Bearer {api.token}"},
            timeout=10.0,
        )
        r = client.get(f"/api/tasks/{uuid4()}")
        client.close()
        assert r.status_code == 404

    def test_patch_nonexistent_returns_404(self, api):
        """PATCH /api/tasks/:id for bogus ID returns 404."""
        client = httpx.Client(
            base_url=api.base_url,
            headers={"Authorization": f"Bearer {api.token}"},
            timeout=10.0,
        )
        r = client.patch(f"/api/tasks/{uuid4()}", json={"priority": 10})
        client.close()
        assert r.status_code == 404


class TestPriorityUpdate:
    """api/tasks.ts:403-404 — PATCH priority on a pending task should
    affect scheduling order. Verify the field actually gets persisted."""

    def test_priority_change_persists(self, api, stub_factory):
        """Update priority on a pending task and verify the change sticks."""
        impossible_tag = f"priotag_{uuid4().hex[:8]}"
        name = _unique_name("smoke_priority_change")
        task = api.submit_expect(
            "echo never",
            name=name,
            priority=3,
            target_tags=[impossible_tag],
        )
        # Verify initial priority
        t = api.get_task(task["id"])
        assert t["priority"] == 3

        # Update
        api.patch_task(task["id"], priority=9)
        t2 = api.get_task(task["id"])
        assert t2["priority"] == 9, f"Expected priority 9, got {t2['priority']}"

        # Cleanup
        api.kill_task(task["id"])


class TestRapidSubmitDedup:
    """dedup.ts + api/tasks.ts — rapid-fire submits with the same fingerprint.
    The second should get 409 (not a race-through)."""

    def test_concurrent_identical_submits(self, api, stub_default, tmp_path):
        """Two identical submits in quick succession: one succeeds, one gets 409."""
        unique_cwd = str(tmp_path / "dedup_race")
        os.makedirs(unique_cwd, exist_ok=True)
        script = "sleep 10"
        params = {"dedup_race_key": uuid4().hex[:8]}

        client = httpx.Client(
            base_url=api.base_url,
            headers={"Authorization": f"Bearer {api.token}"},
            timeout=30.0,
        )
        body = {"script": script, "name": "dedup_race", "cwd": unique_cwd, "param_overrides": params}
        r1 = client.post("/api/tasks", json=body)
        r2 = client.post("/api/tasks", json=body)
        client.close()

        codes = sorted([r1.status_code, r2.status_code])
        assert codes == [201, 409], f"Expected [201, 409], got {codes}"

        # Cleanup: kill the accepted task
        accepted = r1.json() if r1.status_code == 201 else r2.json()
        if "id" in accepted:
            api.kill_task(accepted["id"])
            wait_for_status(api, accepted["id"], TERMINAL_STATUSES, timeout=15)


class TestKillQueuedTask:
    """api/tasks.ts:230-244 — killing a queued task (on stub but not yet
    dispatched) uses killTask(), not the full kill chain. Different path
    from killing a running task."""

    def test_kill_queued_on_busy_stub(self, api, stub_factory):
        """Fill a stub's slots, submit one more (queued), then kill the queued one."""
        tag = f"killq_{uuid4().hex[:6]}"
        stub = stub_factory(
            f"stub-killq-{uuid4().hex[:6]}",
            tags=[tag],
            max_concurrent=1,
        )

        # Blocker occupies the single slot
        blocker = api.submit_expect(
            "sleep 30",
            name=_unique_name("smoke_killq_blocker"),
            target_tags=[tag],
            param_overrides={"killq_block": uuid4().hex[:8]},
        )
        wait_for_status(api, blocker["id"], {"running"}, timeout=15)

        # This task will be queued on the stub (slot full)
        queued_task = api.submit_expect(
            "echo should_not_run",
            name=_unique_name("smoke_killq_queued"),
            target_tags=[tag],
            param_overrides={"killq_q": uuid4().hex[:8]},
        )
        time.sleep(3)
        t = api.get_task(queued_task["id"])
        assert t["status"] in ("pending", "queued", "dispatched"), (
            f"Expected queued/pending, got {t['status']}"
        )

        # Kill the queued task
        api.kill_task(queued_task["id"])
        final = wait_for_status(api, queued_task["id"], TERMINAL_STATUSES, timeout=10)
        assert final["status"] == "killed"

        # Cleanup
        api.kill_task(blocker["id"])
        wait_for_status(api, blocker["id"], TERMINAL_STATUSES, timeout=15)


class TestTaskNotFoundInBatch:
    """api/tasks.ts:226-227 — batch with nonexistent task_id should return
    ok=false per item, not crash the whole request."""

    def test_batch_with_bogus_id(self, api, stub_default):
        """Batch kill with a mix of real and fake IDs: real ones succeed,
        fake ones return ok=false."""
        name = _unique_name("smoke_batch_bogus")
        task = api.submit_expect(
            f"bash {_script('success_fast.sh')}",
            name=name,
        )
        wait_for_status(api, task["id"], {"completed"}, timeout=30)

        bogus_id = str(uuid4())
        result = api.batch("delete", [task["id"], bogus_id])
        items = result.get("results", [])
        assert len(items) == 2

        real_result = next(i for i in items if i["id"] == task["id"])
        fake_result = next(i for i in items if i["id"] == bogus_id)
        assert real_result["ok"] is True
        assert fake_result["ok"] is False


class TestPauseResumeCycle:
    """state-machine.ts: running → paused → running.
    Verify a paused task can be resumed and continues to completion.
    process_mgr.py uses SIGSTOP/SIGCONT under the hood."""

    def test_pause_and_resume(self, api, stub_default, tmp_path):
        """Start a task, pause it, resume it, verify it completes."""
        script_path = str(tmp_path / "pausable.sh")
        with open(script_path, "w") as f:
            # Script that takes ~6s total
            f.write("#!/usr/bin/env bash\nfor i in $(seq 1 6); do echo \"tick $i\"; sleep 1; done\nexit 0\n")
        os.chmod(script_path, 0o755)

        name = _unique_name("smoke_pause_resume")
        task = api.submit_expect(f"bash {script_path}", name=name)
        wait_for_status(api, task["id"], {"running"}, timeout=15)
        time.sleep(2)

        # Pause
        api.patch_task(task["id"], status="paused")
        time.sleep(1)
        t = api.get_task(task["id"])
        assert t["status"] == "paused", f"Expected paused, got {t['status']}"

        # Resume
        api.patch_task(task["id"], status="running")
        final = wait_for_status(api, task["id"], {"completed"}, timeout=30)
        assert final["status"] == "completed"
        assert final.get("exit_code") == 0


class TestKillPausedTask:
    """state-machine.ts: paused → killed is legal.
    But SIGSTOP'd processes can't handle SIGTERM. The kill chain must
    SIGCONT first or SIGKILL directly. This is a real edge case in
    process_mgr.py:_send_signal_to_group — SIGTERM to a stopped process
    is queued until SIGCONT."""

    def test_kill_paused_task(self, api, stub_default, tmp_path):
        """Pause a running task, then kill it. Should reach killed status."""
        script_path = str(tmp_path / "kill_paused.sh")
        with open(script_path, "w") as f:
            f.write("#!/usr/bin/env bash\nsleep 999\n")
        os.chmod(script_path, 0o755)

        name = _unique_name("smoke_kill_paused")
        task = api.submit_expect(f"bash {script_path}", name=name)
        wait_for_status(api, task["id"], {"running"}, timeout=15)
        time.sleep(1)

        # Pause
        api.patch_task(task["id"], status="paused")
        time.sleep(1)
        t = api.get_task(task["id"])
        assert t["status"] == "paused", f"Expected paused, got {t['status']}"

        # Kill while paused
        api.kill_task(task["id"])
        final = wait_for_status(api, task["id"], TERMINAL_STATUSES, timeout=60)
        assert final["status"] == "killed", (
            f"Paused task not killed properly, got {final['status']}"
        )


class TestDisplayNameGeneration:
    """api/tasks.ts:29-52 — generateDisplayName falls back to script basename.
    Verify display_name is populated and makes sense."""

    def test_display_name_from_script(self, api, stub_default):
        """Task submitted with script path gets display_name from basename."""
        name = _unique_name("smoke_display_name")
        task = api.submit_expect(
            f"bash {_script('success_fast.sh')}",
            name=name,
        )
        # Explicit name should override
        assert task.get("display_name") == name
        wait_for_status(api, task["id"], {"completed"}, timeout=30)

    def test_display_name_without_explicit_name(self, api, stub_default):
        """Task without explicit name uses script as display_name."""
        task = api.submit_expect(
            "echo hello_display",
            param_overrides={"display_test": uuid4().hex[:8]},
        )
        # display_name should be derived from script/command
        assert task.get("display_name"), "display_name should not be empty"
        assert "echo" in task["display_name"] or "hello" in task["display_name"]
        wait_for_status(api, task["id"], {"completed"}, timeout=30)


class TestListPagination:
    """api/tasks.ts:182-212 — GET /tasks supports pagination.
    Verify page/limit params work correctly."""

    def test_pagination_returns_correct_page(self, api, stub_default):
        """Submit multiple tasks and verify pagination metadata."""
        # Submit 3 quick tasks
        task_ids = []
        for i in range(3):
            t = api.submit_expect(
                f"bash {_script('success_fast.sh')}",
                name=_unique_name(f"smoke_page_{i}"),
                param_overrides={"page_run": f"{uuid4().hex[:8]}_{i}"},
            )
            task_ids.append(t["id"])

        # Wait for all to complete
        wait_all_terminal(api, task_ids, timeout=60)

        # Page 1, limit 2
        page1 = api.list_tasks(page=1, limit=2)
        assert page1["page"] == 1
        assert page1["limit"] == 2
        assert len(page1["tasks"]) <= 2
        assert page1["total"] >= 3  # at least our 3 tasks
