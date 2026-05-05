"""Phase 2 — Lifecycle tests: success, slow, multi-tag, API listing."""
from __future__ import annotations

import os
import time
from uuid import uuid4

import pytest

from harness.waiter import wait_for_status


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts"))


def _script(name: str) -> str:
    return os.path.join(SCRIPTS, name)


def _unique_name(base: str) -> str:
    return f"{base}_{uuid4().hex[:8]}"


class TestLifecycle:
    """Basic submit → dispatch → complete lifecycle."""

    def test_success_fast(self, api, stub_default):
        """success_fast.sh completes with exit_code=0 in <15s."""
        name = _unique_name("smoke_success_fast")
        task = api.submit_expect(
            f"bash {_script('success_fast.sh')}",
            name=name,
        )
        t0 = time.monotonic()
        final = wait_for_status(api, task["id"], {"completed"}, timeout=30)
        elapsed = time.monotonic() - t0

        assert final["status"] == "completed"
        assert final.get("exit_code") == 0
        assert elapsed < 15, f"Took {elapsed:.1f}s, expected <15s"

    def test_success_slow(self, api, stub_default):
        """success_slow.sh completes with exit_code=0, ~30s duration."""
        name = _unique_name("smoke_success_slow")
        task = api.submit_expect(
            f"bash {_script('success_slow.sh')}",
            name=name,
        )
        t0 = time.monotonic()
        final = wait_for_status(api, task["id"], {"completed"}, timeout=60)
        elapsed = time.monotonic() - t0

        assert final["status"] == "completed"
        assert final.get("exit_code") == 0
        assert 20 < elapsed < 50, f"Took {elapsed:.1f}s, expected 20-50s"

    def test_multi_tag(self, api, stub_default):
        """multi_tag.sh dispatched and completes."""
        name = _unique_name("smoke_multi_tag")
        task = api.submit_expect(
            f"bash {_script('multi_tag.sh')}",
            name=name,
        )
        final = wait_for_status(api, task["id"], {"completed"}, timeout=30)
        assert final["status"] == "completed"
        assert final.get("exit_code") == 0

    def test_task_visible_in_listing(self, api, stub_default):
        """Submitted task appears in GET /api/tasks listing."""
        name = _unique_name("smoke_listing_test")
        task = api.submit_expect(
            f"bash {_script('success_fast.sh')}",
            name=name,
        )
        # Check listing immediately (task should be pending or queued or running)
        listing = api.list_tasks()
        task_ids = [t["id"] for t in listing["tasks"]]
        assert task["id"] in task_ids, "Submitted task not found in listing"

        # Wait for completion
        wait_for_status(api, task["id"], {"completed"}, timeout=30)

    def test_completion_moves_to_terminal(self, api, stub_default):
        """After completion, task no longer shows as running."""
        name = _unique_name("smoke_terminal_check")
        task = api.submit_expect(
            f"bash {_script('success_fast.sh')}",
            name=name,
        )
        final = wait_for_status(api, task["id"], {"completed"}, timeout=30)
        assert final["status"] == "completed"

        # Verify it's not in running tasks
        running = api.list_tasks(status="running")
        running_ids = [t["id"] for t in running["tasks"]]
        assert task["id"] not in running_ids
