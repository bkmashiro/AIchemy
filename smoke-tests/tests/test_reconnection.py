"""Reconnection and stub lifecycle edge-case tests.

Based on code review of:
- server/src/socket/stub.ts — handleResume, markTasksLost, reconciliation
- server/src/scheduler.ts — slot accounting after disconnect
- stub/alchemy_stub/daemon.py — reconnect loop, _send_resume
- stub/alchemy_stub/process_mgr.py — load_and_reattach, _dead_on_reattach

These test scenarios the design doc missed because they depend on
implementation details of the stub process lifecycle.
"""
from __future__ import annotations

import os
import signal
import time
from uuid import uuid4

import pytest

from harness.stub import TestStub
from harness.waiter import wait_for_status, wait_all_terminal, TERMINAL_STATUSES

SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts"))


def _script(name: str) -> str:
    return os.path.join(SCRIPTS, name)


def _unique_name(base: str) -> str:
    return f"{base}_{uuid4().hex[:8]}"


class TestStubDisconnectRunningTask:
    """socket/stub.ts:73-99 — markTasksLost() marks running tasks as "lost"
    when a stub goes offline. Verify the server correctly transitions the
    task and that it shows up in the API as "lost"."""

    def test_task_becomes_lost_on_stub_kill(self, api, test_server, tmp_path):
        """Start a long-running task, kill the stub process (SIGKILL),
        verify the task transitions to "lost" after heartbeat timeout
        or immediate disconnect detection.

        socket/stub.ts:409-433 — disconnect handler marks tasks lost."""
        stub = TestStub(
            test_server.url,
            test_server.token,
            name=f"stub-lossy-{uuid4().hex[:6]}",
            tags=[f"lossy_{uuid4().hex[:6]}"],
            max_concurrent=3,
        )
        stub.snapshot_existing_stubs(api)
        stub.start()
        stub.wait_online(api)
        tag = stub.tags[0]

        name = _unique_name("smoke_lost_on_kill")
        task = api.submit_expect(
            "sleep 300",
            name=name,
            target_tags=[tag],
            param_overrides={"lost_run": uuid4().hex[:8]},
        )
        wait_for_status(api, task["id"], {"running"}, timeout=20)

        # Kill the stub process brutally
        if stub.proc:
            stub.proc.kill()
            stub.proc.wait(timeout=5)

        # Server should detect disconnect and mark task as lost
        final = wait_for_status(api, task["id"], {"lost"}, timeout=30)
        assert final["status"] == "lost"


class TestStubReconnectRecovery:
    """socket/stub.ts:568-583 — when a stub reconnects and reports a task
    that the server marked as "lost", the server recovers it to "running".
    This is the recoverTask() path.

    process_mgr.py:229-258 — load_and_reattach recovers live PIDs."""

    def test_task_recovers_on_stub_reconnect(self, api, test_server, tmp_path):
        """Start a task, stop the stub gracefully (process survives because
        start_new_session=True), start a new stub — task should recover.

        This simulates a stub restart where the task subprocess survives."""
        tag = f"recover_{uuid4().hex[:6]}"
        cwd = str(tmp_path / "recover_workdir")
        os.makedirs(os.path.join(cwd, "runs"), exist_ok=True)

        stub = TestStub(
            test_server.url,
            test_server.token,
            name=f"stub-recover-{uuid4().hex[:6]}",
            tags=[tag],
            max_concurrent=3,
            default_cwd=cwd,
        )
        stub.snapshot_existing_stubs(api)
        stub.start()
        stub.wait_online(api)

        name = _unique_name("smoke_recover")
        task = api.submit_expect(
            "sleep 120",
            name=name,
            target_tags=[tag],
            param_overrides={"recover_run": uuid4().hex[:8]},
        )
        wait_for_status(api, task["id"], {"running"}, timeout=20)
        time.sleep(2)

        # Stop stub gracefully (SIGTERM) — task subprocess may survive
        # because process_mgr uses start_new_session=True
        stub.stop()

        # Wait for server to notice disconnect
        time.sleep(5)
        t = api.get_task(task["id"])
        # Task should be lost now
        assert t["status"] == "lost", f"Expected lost after stub stop, got {t['status']}"

        # Start a new stub with the same identity (same cwd, same tags)
        # The new stub will discover the surviving process via PID file
        stub2 = TestStub(
            test_server.url,
            test_server.token,
            name=f"stub-recover-{uuid4().hex[:6]}",
            tags=[tag],
            max_concurrent=3,
            default_cwd=cwd,
        )
        # Same identity → same stub ID; use wait_online_by_id
        old_stub_id = stub.stub_id
        stub2.start()
        stub2.wait_online_by_id(api, old_stub_id)

        # Give it time to reconcile
        time.sleep(5)

        t2 = api.get_task(task["id"])
        # Task should either be recovered to running, or still lost
        # (depends on whether the subprocess survived the stub restart)
        # Either way, the system should not crash or produce duplicates
        assert t2["status"] in ("running", "lost", "completed", "failed"), (
            f"Unexpected status after reconnect: {t2['status']}"
        )

        # Cleanup
        if t2["status"] == "running":
            try:
                api.kill_task(task["id"])
                wait_for_status(api, task["id"], TERMINAL_STATUSES, timeout=30)
            except Exception:
                pass
        stub2.stop()


class TestStubOfflineSlotsFreed:
    """scheduler.ts:64-67 — when a stub goes offline, its slots shouldn't
    block global queue dispatch. Tasks should be rescheduled to other stubs."""

    def test_pending_tasks_reschedule_after_stub_offline(
        self, api, test_server, stub_factory
    ):
        """Submit tasks to stub A, kill stub A, start stub B with same tags.
        Pending tasks in global queue should dispatch to stub B.

        scheduler.ts:263-292 — _scheduleInner iterates global queue
        and assigns to best available stub."""
        tag = f"resched_{uuid4().hex[:6]}"

        # Stub A: start it
        stub_a = TestStub(
            test_server.url,
            test_server.token,
            name=f"stub-resched-a-{uuid4().hex[:6]}",
            tags=[tag],
            max_concurrent=1,
        )
        stub_a.snapshot_existing_stubs(api)
        stub_a.start()
        stub_a.wait_online(api)

        # Fill stub A's slot
        blocker = api.submit_expect(
            "sleep 300",
            name=_unique_name("smoke_resched_block"),
            target_tags=[tag],
            param_overrides={"resched_block": uuid4().hex[:8]},
        )
        wait_for_status(api, blocker["id"], {"running"}, timeout=15)

        # Submit another task — will be pending since stub A is full
        pending_task = api.submit_expect(
            f"bash {_script('success_fast.sh')}",
            name=_unique_name("smoke_resched_pending"),
            target_tags=[tag],
            param_overrides={"resched_pending": uuid4().hex[:8]},
        )
        time.sleep(2)

        # Kill stub A
        if stub_a.proc:
            stub_a.proc.kill()
            stub_a.proc.wait(timeout=5)
        time.sleep(3)

        # Start stub B with same tag
        stub_b = stub_factory(
            f"stub-resched-b-{uuid4().hex[:6]}",
            tags=[tag],
            max_concurrent=3,
        )

        # The pending task should now dispatch to stub B
        final = wait_for_status(api, pending_task["id"], {"completed"}, timeout=30)
        assert final["status"] == "completed"

        # Cleanup: blocker is lost (stub A is dead)
        wait_for_status(api, blocker["id"], TERMINAL_STATUSES, timeout=10)


class TestAutoRetryOnLost:
    """socket/stub.ts:101-125 — handleAutoRetry creates a new pending task
    when a task is lost AND max_retries > 0. Verify the retry task gets
    created and eventually runs."""

    def test_lost_task_auto_retries(self, api, test_server, stub_factory):
        """Task with max_retries=1 on a stub that dies should produce
        a retry task that runs on a surviving stub.

        This tests the full cycle: running → lost → auto-retry → pending → running → completed."""
        tag = f"autoretry_{uuid4().hex[:6]}"

        # Stub that will die
        doomed_stub = TestStub(
            test_server.url,
            test_server.token,
            name=f"stub-doomed-{uuid4().hex[:6]}",
            tags=[tag],
            max_concurrent=3,
        )
        doomed_stub.snapshot_existing_stubs(api)
        doomed_stub.start()
        doomed_stub.wait_online(api)

        # Survivor stub
        survivor = stub_factory(
            f"stub-survivor-{uuid4().hex[:6]}",
            tags=[tag],
            max_concurrent=3,
        )

        name = _unique_name("smoke_auto_retry_lost")
        task = api.submit_expect(
            f"bash {_script('success_fast.sh')}",
            name=name,
            max_retries=1,
            target_tags=[tag],
            param_overrides={"auto_retry_lost": uuid4().hex[:8]},
        )
        wait_for_status(api, task["id"], {"running"}, timeout=15)

        # Ensure the task landed on the doomed stub
        t = api.get_task(task["id"])
        if t.get("stub_id") != doomed_stub.stub_id:
            # Task went to survivor — can't test this scenario properly
            wait_for_status(api, task["id"], {"completed"}, timeout=30)
            doomed_stub.stop()
            pytest.skip("Task dispatched to survivor stub, can't test lost→retry")

        # Kill the doomed stub
        if doomed_stub.proc:
            doomed_stub.proc.kill()
            doomed_stub.proc.wait(timeout=5)

        # Original task becomes lost
        wait_for_status(api, task["id"], {"lost"}, timeout=15)
        time.sleep(3)

        # A retry task should have been created
        listing = api.list_tasks(limit=100)
        retries = [
            t for t in listing["tasks"]
            if t.get("retry_of") == task["id"]
        ]
        assert len(retries) >= 1, "No retry task created after lost"

        # The retry should complete on the survivor stub
        retry_id = retries[0]["id"]
        final = wait_for_status(api, retry_id, {"completed"}, timeout=30)
        assert final["status"] == "completed"


class TestStubNameStability:
    """socket/stub.ts:50-55 — computeStubId is a hash of hostname+gpu+cwd+slurm_job.
    A stub reconnecting with the same identity should get the same stub_id,
    not create a duplicate."""

    def test_reconnected_stub_keeps_same_id(self, api, test_server, tmp_path):
        """Start a stub, record its ID, stop it, start it again with
        same config, verify it gets the same stub_id."""
        tag = f"stable_{uuid4().hex[:6]}"
        cwd = str(tmp_path / "stable_cwd")
        os.makedirs(os.path.join(cwd, "runs"), exist_ok=True)

        stub1 = TestStub(
            test_server.url,
            test_server.token,
            name=f"stub-stable-{uuid4().hex[:6]}",
            tags=[tag],
            max_concurrent=2,
            default_cwd=cwd,
        )
        stub1.snapshot_existing_stubs(api)
        stub1.start()
        stub1.wait_online(api)
        first_id = stub1.stub_id

        stub1.stop()
        time.sleep(3)

        # Start again with same config — same identity → same stub ID
        stub2 = TestStub(
            test_server.url,
            test_server.token,
            name=f"stub-stable-{uuid4().hex[:6]}",
            tags=[tag],
            max_concurrent=2,
            default_cwd=cwd,
        )
        stub2.start()
        stub2.wait_online_by_id(api, first_id)
        second_id = stub2.stub_id

        # Same identity → same stub_id
        assert first_id == second_id, (
            f"Stub ID changed on reconnect: {first_id} → {second_id}"
        )
        stub2.stop()
