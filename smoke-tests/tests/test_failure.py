"""Phase 2 — Failure tests: exit code 1, OOM, nonexistent script, missing cwd."""
from __future__ import annotations

import os
from uuid import uuid4

from harness.waiter import wait_for_status, TERMINAL_STATUSES

SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts"))


def _script(name: str) -> str:
    return os.path.join(SCRIPTS, name)


def _unique_name(base: str) -> str:
    return f"{base}_{uuid4().hex[:8]}"


class TestFailure:

    def test_exit_code_1(self, api, stub_default):
        """fail_exit1.sh results in status=failed, exit_code=1."""
        name = _unique_name("smoke_fail_exit1")
        task = api.submit_expect(
            f"bash {_script('fail_exit1.sh')}",
            name=name,
        )
        final = wait_for_status(api, task["id"], {"failed"}, timeout=30)
        assert final["status"] == "failed"
        assert final.get("exit_code") == 1

    def test_oom_simulation(self, api, stub_default):
        """fail_oom.py results in status=failed, exit_code != 0."""
        name = _unique_name("smoke_fail_oom")
        task = api.submit_expect(
            f"python3 {_script('fail_oom.py')}",
            name=name,
        )
        final = wait_for_status(api, task["id"], TERMINAL_STATUSES, timeout=60)
        assert final["status"] == "failed"
        assert final.get("exit_code") is not None
        assert final["exit_code"] != 0

    def test_nonexistent_script(self, api, stub_default):
        """Nonexistent script results in failed status."""
        name = _unique_name("smoke_no_script")
        task = api.submit_expect(
            "python3 /does/not/exist_smoke_test.py",
            name=name,
        )
        final = wait_for_status(api, task["id"], TERMINAL_STATUSES, timeout=30)
        assert final["status"] == "failed"

    def test_missing_cwd(self, api, stub_default):
        """Task with nonexistent cwd results in failed status."""
        name = _unique_name("smoke_missing_cwd")
        task = api.submit_expect(
            "echo hello",
            name=name,
            cwd="/tmp/alchemy_test_nonexistent_cwd_" + uuid4().hex[:8],
        )
        final = wait_for_status(api, task["id"], TERMINAL_STATUSES, timeout=30)
        assert final["status"] == "failed"
