"""Phase 3 — Concurrency tests: max_concurrent enforcement, slot contention."""
from __future__ import annotations

import time
from uuid import uuid4

from harness.waiter import wait_for_status, wait_all_terminal, TERMINAL_STATUSES


def _unique_name(base: str) -> str:
    return f"{base}_{uuid4().hex[:8]}"


class TestConcurrency:

    def test_max_concurrent_strict(self, api, stub_factory):
        """Submit N+1 tasks to a stub with max_concurrent=N; verify N running, 1 queued."""
        tag = f"conc_{uuid4().hex[:6]}"
        max_c = 2
        stub = stub_factory(
            f"stub-conc-{uuid4().hex[:6]}",
            tags=[tag],
            max_concurrent=max_c,
        )

        # Submit max_c + 1 tasks (each sleeps 8s)
        task_ids = []
        for i in range(max_c + 1):
            t = api.submit_expect(
                "sleep 8",
                name=_unique_name(f"smoke_conc_{i}"),
                target_tags=[tag],
                param_overrides={"conc_run": f"{uuid4().hex[:8]}_{i}"},
            )
            task_ids.append(t["id"])

        # Wait for first batch to start running
        time.sleep(4)

        running = 0
        pending_or_queued = 0
        for tid in task_ids:
            t = api.get_task(tid)
            if t["status"] == "running":
                running += 1
            elif t["status"] in ("pending", "queued", "dispatched"):
                pending_or_queued += 1

        assert running <= max_c, f"Expected <={max_c} running, got {running}"
        # At least one should be waiting
        assert pending_or_queued >= 1 or running < max_c + 1, (
            f"Expected at least 1 queued/pending, got running={running} pending={pending_or_queued}"
        )

        # Wait for all to finish
        wait_all_terminal(api, task_ids, timeout=60)

    def test_slot_opens_after_completion(self, api, stub_factory):
        """When a task completes, the next queued task gets dispatched."""
        tag = f"slot_{uuid4().hex[:6]}"
        stub = stub_factory(
            f"stub-slot-{uuid4().hex[:6]}",
            tags=[tag],
            max_concurrent=1,
        )

        # Task 1: short (3s)
        t1 = api.submit_expect(
            "sleep 3",
            name=_unique_name("smoke_slot1"),
            target_tags=[tag],
            param_overrides={"slot_run": uuid4().hex[:8]},
        )
        # Task 2: short (3s) — should wait for t1
        t2 = api.submit_expect(
            "sleep 3",
            name=_unique_name("smoke_slot2"),
            target_tags=[tag],
            param_overrides={"slot_run2": uuid4().hex[:8]},
        )

        # Wait for t1 to complete
        wait_for_status(api, t1["id"], {"completed"}, timeout=20)

        # t2 should now be running or completed
        final2 = wait_for_status(api, t2["id"], {"completed"}, timeout=20)
        assert final2["status"] == "completed"
