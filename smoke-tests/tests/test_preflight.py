"""Phase 2 — Preflight tests: cwd missing, script not found."""
from __future__ import annotations

import os
from uuid import uuid4

import httpx

from harness.waiter import wait_for_status, TERMINAL_STATUSES


def _unique_name(base: str) -> str:
    return f"{base}_{uuid4().hex[:8]}"


class TestPreflight:

    def test_cwd_does_not_exist(self, api, stub_default):
        """Task with nonexistent cwd fails."""
        name = _unique_name("smoke_preflight_cwd")
        bad_cwd = f"/tmp/alchemy_test_nonexistent_{uuid4().hex[:8]}"
        task = api.submit_expect(
            "echo hello",
            name=name,
            cwd=bad_cwd,
        )
        final = wait_for_status(api, task["id"], TERMINAL_STATUSES, timeout=30)
        assert final["status"] == "failed"

    def test_script_not_found(self, api, stub_default):
        """Nonexistent script path fails."""
        name = _unique_name("smoke_preflight_script")
        task = api.submit_expect(
            f"python3 /tmp/alchemy_no_such_script_{uuid4().hex[:8]}.py",
            name=name,
        )
        final = wait_for_status(api, task["id"], TERMINAL_STATUSES, timeout=30)
        assert final["status"] == "failed"

    def test_run_dir_write_lock(self, api, stub_default, tmp_path):
        """Two tasks with same run_dir: second gets rejected (409)."""
        run_dir = str(tmp_path / "locked_run_dir")
        os.makedirs(run_dir, exist_ok=True)

        # Submit first task (slow so it stays active)
        name1 = _unique_name("smoke_lock_first")
        task1 = api.submit_expect(
            "sleep 30",
            name=name1,
            run_dir=run_dir,
            # Unique fingerprint
            param_overrides={"lock_run": uuid4().hex[:8]},
        )

        # Submit second task with same run_dir
        body = {
            "script": "echo hi",
            "name": _unique_name("smoke_lock_second"),
            "run_dir": run_dir,
            "param_overrides": {"lock_run2": uuid4().hex[:8]},
        }
        client = httpx.Client(
            base_url=api.base_url,
            headers={"Authorization": f"Bearer {api.token}"},
            timeout=30.0,
        )
        r = client.post("/api/tasks", json=body)
        client.close()

        assert r.status_code == 409, f"Expected 409, got {r.status_code}: {r.text}"
        data = r.json()
        assert "locked" in data.get("error", "").lower()

        # Cleanup: kill first task
        api.kill_task(task1["id"])
        wait_for_status(api, task1["id"], TERMINAL_STATUSES, timeout=30)
