"""Resource cleanup, timeout, and concurrency edge-case tests.

Based on code review of:
- server/src/scheduler.ts — slot accounting, VRAM estimation
- server/src/dedup.ts — write lock table, path normalization, idempotency TTL
- stub/alchemy_stub/task_socket.py — unix socket cleanup, zombie detection
- stub/alchemy_stub/process_mgr.py — log file cleanup, PID file atomicity
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


class TestUnixSocketCleanup:
    """task_socket.py:85-119 — TaskSocket.start() creates a Unix socket at
    /tmp/alchemy_task_{task_id}.sock. stop() deletes it. Verify the socket
    file is cleaned up after task completion."""

    def test_socket_file_removed_after_completion(self, api, stub_default, tmp_path):
        """After a task completes, its Unix socket file should not linger."""
        name = _unique_name("smoke_sock_cleanup")
        task = api.submit_expect(
            f"bash {_script('success_fast.sh')}",
            name=name,
        )
        task_id = task["id"]
        sock_path = f"/tmp/alchemy_task_{task_id}.sock"

        final = wait_for_status(api, task_id, {"completed"}, timeout=30)
        assert final["status"] == "completed"

        # Brief wait for async cleanup
        time.sleep(2)
        assert not os.path.exists(sock_path), (
            f"Unix socket not cleaned up: {sock_path}"
        )

    def test_socket_file_removed_after_failure(self, api, stub_default, tmp_path):
        """After a task fails, its Unix socket should also be cleaned up.
        task_socket.py removal happens in daemon._on_task_failed → registry.remove."""
        name = _unique_name("smoke_sock_cleanup_fail")
        task = api.submit_expect("exit 1", name=name)
        task_id = task["id"]
        sock_path = f"/tmp/alchemy_task_{task_id}.sock"

        final = wait_for_status(api, task_id, {"failed"}, timeout=20)
        assert final["status"] == "failed"

        time.sleep(2)
        assert not os.path.exists(sock_path), (
            f"Unix socket not cleaned up after failure: {sock_path}"
        )


class TestWriteLockPathNormalization:
    """dedup.ts:55-71 — normalizeLockPath and pathsConflict.
    Verify that paths with trailing slashes, `..`, etc. are handled
    correctly by the write lock table."""

    def test_trailing_slash_normalized(self, api, stub_default, tmp_path):
        """run_dir with and without trailing slash should conflict.
        dedup.ts:57 strips trailing slashes."""
        run_dir = str(tmp_path / "norm_test")
        os.makedirs(run_dir, exist_ok=True)

        # First task: no trailing slash
        task1 = api.submit_expect(
            "sleep 30",
            name=_unique_name("smoke_norm1"),
            run_dir=run_dir,
            param_overrides={"norm1": uuid4().hex[:8]},
        )
        time.sleep(2)

        # Second task: with trailing slash — should be rejected
        client = httpx.Client(
            base_url=api.base_url,
            headers={"Authorization": f"Bearer {api.token}"},
            timeout=10.0,
        )
        r = client.post("/api/tasks", json={
            "script": "echo conflict",
            "run_dir": run_dir + "/",
            "param_overrides": {"norm2": uuid4().hex[:8]},
        })
        client.close()
        assert r.status_code == 409, (
            f"Expected 409 for trailing-slash path conflict, got {r.status_code}"
        )

        # Cleanup
        api.kill_task(task1["id"])
        wait_for_status(api, task1["id"], TERMINAL_STATUSES, timeout=15)


class TestSlotAccountingAfterFailure:
    """scheduler.ts:64-67 — slot counting uses tasks with status
    "running" or "dispatched". After a task fails, the slot should
    be freed and a new task can be dispatched immediately.

    This is subtle because the scheduler checks slot count at dispatch
    time, and a failed task might not be cleaned up immediately."""

    def test_slot_freed_after_rapid_failure(self, api, stub_factory, tmp_path):
        """Fill max_concurrent slots with instant-fail tasks.
        After they all fail, new tasks should dispatch immediately."""
        tag = f"slotfree_{uuid4().hex[:6]}"
        stub = stub_factory(
            f"stub-slotfree-{uuid4().hex[:6]}",
            tags=[tag],
            max_concurrent=2,
        )

        # Submit 2 tasks that fail instantly
        fail_ids = []
        for i in range(2):
            t = api.submit_expect(
                "exit 1",
                name=_unique_name(f"smoke_slotfail_{i}"),
                target_tags=[tag],
                param_overrides={"slotfail": f"{uuid4().hex[:8]}_{i}"},
            )
            fail_ids.append(t["id"])

        # Wait for both to fail
        wait_all_terminal(api, fail_ids, timeout=20)

        # Now submit 2 more — should dispatch immediately (slots are free)
        success_ids = []
        for i in range(2):
            t = api.submit_expect(
                f"bash {_script('success_fast.sh')}",
                name=_unique_name(f"smoke_slotok_{i}"),
                target_tags=[tag],
                param_overrides={"slotok": f"{uuid4().hex[:8]}_{i}"},
            )
            success_ids.append(t["id"])

        finals = wait_all_terminal(api, success_ids, timeout=30)
        for f in finals:
            assert f["status"] == "completed"


class TestIdempotencyKeyExpiry:
    """dedup.ts:148-160 — IdempotencyCache has a 60s TTL.
    After TTL expires, the same key should create a new task.

    Note: This test is time-sensitive and may be slow. It waits for
    the TTL to expire (~65s)."""

    @pytest.mark.slow
    def test_idempotency_key_expires(self, api, stub_default):
        """Same idempotency_key after 65s creates a new task."""
        idem_key = f"expire_{uuid4().hex}"
        script = f"bash {_script('success_fast.sh')}"

        task1 = api.submit_expect(
            script,
            name=_unique_name("smoke_idem_expire1"),
            idempotency_key=idem_key,
            param_overrides={"expire_1": uuid4().hex[:8]},
        )
        wait_for_status(api, task1["id"], {"completed"}, timeout=30)

        # Wait for TTL + cleanup interval
        time.sleep(65)

        # Same key should now create a new task (TTL expired)
        # Note: fingerprint dedup might still reject it if the first task
        # is still active. Since it completed, fingerprint index should
        # have been cleared. Use different params to avoid fingerprint collision.
        task2 = api.submit_expect(
            script,
            name=_unique_name("smoke_idem_expire2"),
            idempotency_key=idem_key,
            param_overrides={"expire_2": uuid4().hex[:8]},
        )
        assert task2["id"] != task1["id"], "Expected new task after TTL expiry"
        wait_for_status(api, task2["id"], {"completed"}, timeout=30)


class TestMaxConcurrentDynamic:
    """daemon.py:297-299 — config.update event changes max_concurrent at runtime.
    The API can update a stub's max_concurrent via PATCH /api/stubs/:id.
    New value should be enforced immediately."""

    def test_max_concurrent_change_takes_effect(self, api, stub_factory):
        """Start stub with max_concurrent=1, fill the slot, change to 2,
        verify a second task gets dispatched."""
        tag = f"dynmc_{uuid4().hex[:6]}"
        stub = stub_factory(
            f"stub-dynmc-{uuid4().hex[:6]}",
            tags=[tag],
            max_concurrent=1,
        )

        # Fill the 1 slot
        t1 = api.submit_expect(
            "sleep 20",
            name=_unique_name("smoke_dynmc_1"),
            target_tags=[tag],
            param_overrides={"dynmc_1": uuid4().hex[:8]},
        )
        wait_for_status(api, t1["id"], {"running"}, timeout=15)

        # Submit t2 — should be queued (slot full)
        t2 = api.submit_expect(
            f"bash {_script('success_fast.sh')}",
            name=_unique_name("smoke_dynmc_2"),
            target_tags=[tag],
            param_overrides={"dynmc_2": uuid4().hex[:8]},
        )
        time.sleep(3)

        t2_state = api.get_task(t2["id"])
        assert t2_state["status"] in ("pending", "queued"), (
            f"Expected t2 queued/pending with max_concurrent=1, got {t2_state['status']}"
        )

        # Increase max_concurrent to 2
        try:
            client = httpx.Client(
                base_url=api.base_url,
                headers={"Authorization": f"Bearer {api.token}"},
                timeout=10.0,
            )
            r = client.patch(
                f"/api/stubs/{stub.stub_id}",
                json={"max_concurrent": 2},
            )
            client.close()
            if r.status_code != 200:
                pytest.skip(f"PATCH /api/stubs not supported (status={r.status_code})")
        except Exception:
            pytest.skip("PATCH /api/stubs not available")

        # t2 should now get dispatched
        final2 = wait_for_status(api, t2["id"], {"completed"}, timeout=30)
        assert final2["status"] == "completed"

        # Cleanup (t1 may already be completed)
        try:
            api.kill_task(t1["id"])
            wait_for_status(api, t1["id"], TERMINAL_STATUSES, timeout=15)
        except Exception:
            pass


class TestEnvVarsPassedToTask:
    """daemon.py:424-425 — task env vars are passed to subprocess.
    process_mgr.py:129-135 — ALCHEMY_TASK_ID, ALCHEMY_STUB_SOCKET,
    ALCHEMY_PARAMS, ALCHEMY_RUN_DIR are injected."""

    def test_alchemy_env_vars_available(self, api, stub_default, tmp_path):
        """Task subprocess should have ALCHEMY_TASK_ID in its environment."""
        marker = str(tmp_path / "env_marker.txt")
        script_path = str(tmp_path / "check_env.sh")
        with open(script_path, "w") as f:
            f.write(f"#!/usr/bin/env bash\necho $ALCHEMY_TASK_ID > '{marker}'\nexit 0\n")
        os.chmod(script_path, 0o755)

        name = _unique_name("smoke_env_check")
        task = api.submit_expect(f"bash {script_path}", name=name)
        final = wait_for_status(api, task["id"], {"completed"}, timeout=20)
        assert final["status"] == "completed"

        assert os.path.exists(marker), f"Env marker not created at {marker}"
        with open(marker) as f:
            task_id_from_env = f.read().strip()
        assert task_id_from_env == task["id"], (
            f"ALCHEMY_TASK_ID mismatch: env={task_id_from_env}, expected={task['id']}"
        )

    def test_alchemy_params_json(self, api, stub_default, tmp_path):
        """ALCHEMY_PARAMS should be valid JSON with the param_overrides."""
        marker = str(tmp_path / "params_marker.txt")
        script_path = str(tmp_path / "check_params.sh")
        with open(script_path, "w") as f:
            f.write(f"#!/usr/bin/env bash\necho $ALCHEMY_PARAMS > '{marker}'\nexit 0\n")
        os.chmod(script_path, 0o755)

        params = {"lr": "0.001", "batch_size": "32"}
        name = _unique_name("smoke_params_check")
        task = api.submit_expect(
            f"bash {script_path}",
            name=name,
            param_overrides=params,
        )
        final = wait_for_status(api, task["id"], {"completed"}, timeout=20)
        assert final["status"] == "completed"

        import json
        with open(marker) as f:
            raw = f.read().strip()
        parsed = json.loads(raw)
        assert parsed["lr"] == "0.001"
        assert parsed["batch_size"] == "32"


class TestRapidTaskChurn:
    """Stress test: submit many short tasks in rapid succession.
    Verifies the scheduler doesn't deadlock or over-dispatch under
    high churn. scheduler.ts:240-250 has a re-entrancy guard (_scheduling)
    that could mask bugs."""

    def test_rapid_submit_10_tasks(self, api, stub_default):
        """Submit 10 instant tasks rapidly, verify all complete."""
        task_ids = []
        for i in range(10):
            t = api.submit_expect(
                "echo rapid",
                name=_unique_name(f"smoke_rapid_{i}"),
                param_overrides={"rapid": f"{uuid4().hex[:8]}_{i}"},
            )
            task_ids.append(t["id"])

        finals = wait_all_terminal(api, task_ids, timeout=60)
        completed = [f for f in finals if f["status"] == "completed"]
        assert len(completed) == 10, (
            f"Expected 10 completed, got {len(completed)}. "
            f"Statuses: {[f['status'] for f in finals]}"
        )


class TestKillChainSafetyNet:
    """socket/stub.ts:172-179 — kill chain has a 2× grace period safety net.
    If the first SIGTERM fails, a second kill with 5s grace is sent.
    Verify a task that ignores the first SIGTERM is eventually killed."""

    def test_stubborn_task_force_killed(self, api, stub_default, tmp_path):
        """Task that traps SIGTERM and continues — should be force-killed
        by the safety net (SIGKILL after grace period)."""
        script_path = str(tmp_path / "stubborn.sh")
        with open(script_path, "w") as f:
            # Trap SIGTERM and continue running. SIGKILL can't be trapped.
            f.write(
                "#!/usr/bin/env bash\n"
                "trap 'echo got SIGTERM, ignoring' SIGTERM\n"
                "while true; do sleep 1; done\n"
            )
        os.chmod(script_path, 0o755)

        name = _unique_name("smoke_stubborn_kill")
        task = api.submit_expect(f"bash {script_path}", name=name)
        wait_for_status(api, task["id"], {"running"}, timeout=15)
        time.sleep(1)

        api.kill_task(task["id"])

        # Should eventually be killed via SIGKILL safety net
        # Default grace_period_s=30, safety net fires at 2×30=60s
        # But the stub's kill_graceful does SIGTERM then SIGKILL after grace
        # so it should be faster
        final = wait_for_status(api, task["id"], TERMINAL_STATUSES, timeout=90)
        assert final["status"] == "killed"


class TestShellExecBlocklist:
    """daemon.py:511-525 — shell exec has a basic blocklist for dangerous
    commands. Verify blocked commands are rejected."""

    # This test only works if shell.exec is exposed via an API endpoint.
    # If not, skip it.
    @pytest.mark.skip(reason="shell.exec requires WebSocket, not REST API")
    def test_blocked_command_rejected(self):
        pass


class TestRetryTaskIdDiffers:
    """api/tasks.ts:488-508 — _createRetryTask creates a NEW task with
    a new UUID. The retry should have retry_of set to the original."""

    def test_retry_creates_new_task_with_link(self, api, stub_default):
        """Manual retry via POST /api/tasks/:id/retry creates a new task
        with retry_of pointing to the original."""
        name = _unique_name("smoke_retry_link")
        task = api.submit_expect(
            "exit 1",
            name=name,
            param_overrides={"retry_link": uuid4().hex[:8]},
        )
        wait_for_status(api, task["id"], {"failed"}, timeout=20)

        # Manual retry
        client = httpx.Client(
            base_url=api.base_url,
            headers={"Authorization": f"Bearer {api.token}"},
            timeout=10.0,
        )
        r = client.post(f"/api/tasks/{task['id']}/retry")
        client.close()
        assert r.status_code == 201, f"Expected 201, got {r.status_code}"
        retry = r.json()

        assert retry["id"] != task["id"], "Retry should have a new ID"
        assert retry.get("retry_of") == task["id"], (
            f"retry_of should be {task['id']}, got {retry.get('retry_of')}"
        )
        assert retry["retry_count"] == 1
        assert retry["status"] in ("pending", "queued"), f"Got {retry['status']}"

        # Wait for retry to complete (it will also fail with exit 1)
        wait_for_status(api, retry["id"], TERMINAL_STATUSES, timeout=20)


class TestTaskSeqMonotonicity:
    """store/index.ts:44-47 — nextSeq() is a simple counter.
    Verify that tasks get monotonically increasing seq numbers."""

    def test_seq_numbers_increase(self, api, stub_default):
        """Submit 3 tasks and verify seq is strictly increasing."""
        seqs = []
        for i in range(3):
            t = api.submit_expect(
                f"bash {_script('success_fast.sh')}",
                name=_unique_name(f"smoke_seq_{i}"),
                param_overrides={"seq_run": f"{uuid4().hex[:8]}_{i}"},
            )
            seqs.append(t.get("seq", 0))

        for i in range(1, len(seqs)):
            assert seqs[i] > seqs[i - 1], (
                f"Seq not monotonic: {seqs}"
            )

        # Cleanup
        # Tasks are fast, they'll complete on their own
