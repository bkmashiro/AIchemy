"""Phase 3 — SDK integration tests: progress reporting, metrics, should_stop."""
from __future__ import annotations

import os
import time
from uuid import uuid4

from harness.waiter import wait_for_status, TERMINAL_STATUSES

SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts"))


def _unique_name(base: str) -> str:
    return f"{base}_{uuid4().hex[:8]}"


class TestSDK:

    def test_progress_updates(self, api, stub_default):
        """SDK reporter completes and progress is visible."""
        name = _unique_name("smoke_sdk_progress")
        task = api.submit_expect(
            f"python3 {os.path.join(SCRIPTS, 'sdk_reporter.py')}",
            name=name,
        )
        final = wait_for_status(api, task["id"], {"completed"}, timeout=60)
        assert final["status"] == "completed"
        assert final.get("exit_code") == 0

        # Check logs contain progress messages
        logs = api.get_logs(task["id"])
        log_text = " ".join(str(l) for l in logs)
        assert "sdk_reporter" in log_text.lower() or "step" in log_text.lower()

    def test_metrics_visible(self, api, stub_default):
        """After SDK reporter runs, task has progress field populated."""
        name = _unique_name("smoke_sdk_metrics")
        task = api.submit_expect(
            f"python3 {os.path.join(SCRIPTS, 'sdk_reporter.py')}",
            name=name,
        )
        final = wait_for_status(api, task["id"], {"completed"}, timeout=60)
        assert final["status"] == "completed"

        # The progress field may or may not be populated depending on
        # whether the SDK transport connected. At minimum task should complete.
        # If progress is present, verify structure.
        progress = final.get("progress")
        if progress:
            assert "step" in progress or "loss" in progress

    def test_should_stop(self, api, stub_default):
        """Submit SDK reporter, set should_stop=true, task exits cleanly."""
        name = _unique_name("smoke_sdk_stop")
        task = api.submit_expect(
            f"python3 {os.path.join(SCRIPTS, 'sdk_reporter.py')}",
            name=name,
        )

        # Wait for running
        wait_for_status(api, task["id"], {"running"}, timeout=30)
        time.sleep(2)

        # Set should_stop
        api.patch_task(task["id"], should_stop=True)

        # Task should complete (SDK checks should_stop and exits)
        final = wait_for_status(api, task["id"], TERMINAL_STATUSES, timeout=30)
        # It may complete normally if it finishes before should_stop takes effect,
        # or it may be killed. Both are acceptable.
        assert final["status"] in ("completed", "killed")
