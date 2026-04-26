"""Phase 2 — Signal tests: graceful SIGTERM, kill timeout."""
from __future__ import annotations

import os
import time
from uuid import uuid4

from harness.waiter import wait_for_status, TERMINAL_STATUSES

SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts"))


def _unique_name(base: str) -> str:
    return f"{base}_{uuid4().hex[:8]}"


class TestSignal:

    def test_graceful_sigterm(self, api, stub_default):
        """signal_handler.sh receives SIGTERM, cleans up, exits gracefully."""
        name = _unique_name("smoke_signal_graceful")
        task = api.submit_expect(
            f"bash {os.path.join(SCRIPTS, 'signal_handler.sh')}",
            name=name,
        )
        # Wait for running
        wait_for_status(api, task["id"], {"running"}, timeout=30)
        # Give it a moment to start
        time.sleep(2)

        # Kill via API
        api.kill_task(task["id"])

        final = wait_for_status(api, task["id"], TERMINAL_STATUSES, timeout=30)
        # Script traps SIGTERM and exits 0: stub may report "completed" or server may mark "killed"
        assert final["status"] in ("killed", "completed"), f"Got {final['status']}"
        if final["status"] == "completed":
            assert final.get("exit_code") == 0

    def test_kill_timeout(self, api, stub_default, tmp_path):
        """Task ignoring SIGTERM gets force-killed."""
        # Create a script that ignores SIGTERM
        script_path = str(tmp_path / "ignore_sigterm.sh")
        with open(script_path, "w") as f:
            f.write("#!/usr/bin/env bash\ntrap '' SIGTERM\necho 'ignoring SIGTERM'\nsleep 999\n")
        os.chmod(script_path, 0o755)

        name = _unique_name("smoke_kill_timeout")
        task = api.submit_expect(
            f"bash {script_path}",
            name=name,
        )
        wait_for_status(api, task["id"], {"running"}, timeout=30)
        time.sleep(1)

        # Kill via API
        api.kill_task(task["id"])

        final = wait_for_status(api, task["id"], TERMINAL_STATUSES, timeout=60)
        assert final["status"] == "killed"
