"""Test max_concurrent enforcement and queuing."""
import time
import pytest
from conftest import start_stub, wait_for_stub, wait_for_task_status, api_get, api_post, MOCKS_DIR


def test_max_concurrent_enforcement(server_url, api_token):
    """Submit 3 tasks with max_concurrent=2; assert 2 running + 1 queued."""
    proc = start_stub(server_url, api_token, max_concurrent=2)
    try:
        stub = wait_for_stub(server_url)
        stub_id = stub["id"]

        fake_slow = str(MOCKS_DIR / "fake_train_slow.py")
        task_ids = []
        for _ in range(3):
            r = api_post(
                f"{server_url}/api/stubs/{stub_id}/tasks",
                json={"command": f"python3 {fake_slow} 10"},
            )
            assert r.status_code == 201
            task_ids.append(r.json()["id"])

        # Give some time for tasks to start
        time.sleep(3)

        # Check status
        statuses = []
        for tid in task_ids:
            r = api_get(f"{server_url}/api/stubs/{stub_id}/tasks/{tid}")
            statuses.append(r.json()["status"])

        running = statuses.count("running")
        queued = statuses.count("queued")

        assert running == 2, f"Expected 2 running, got {running}. Statuses: {statuses}"
        assert queued == 1, f"Expected 1 queued, got {queued}. Statuses: {statuses}"

        # Wait for all to complete
        for tid in task_ids:
            wait_for_task_status(server_url, stub_id, tid, ["completed", "failed", "killed"], timeout=45)

        # All should be completed
        final_statuses = []
        for tid in task_ids:
            r = api_get(f"{server_url}/api/stubs/{stub_id}/tasks/{tid}")
            final_statuses.append(r.json()["status"])

        assert all(s == "completed" for s in final_statuses), f"Not all completed: {final_statuses}"
    finally:
        proc.kill()
        proc.wait(timeout=5)


def test_queued_starts_when_slot_opens(server_url, api_token):
    """When a running task completes, queued task should start."""
    proc = start_stub(server_url, api_token, max_concurrent=1)
    try:
        stub = wait_for_stub(server_url)
        stub_id = stub["id"]

        fake_train = str(MOCKS_DIR / "fake_train.py")
        fake_slow = str(MOCKS_DIR / "fake_train_slow.py")

        # Submit slow task first to block the slot
        r1 = api_post(
            f"{server_url}/api/stubs/{stub_id}/tasks",
            json={"command": f"python3 {fake_slow} 5"},
        )
        assert r1.status_code == 201
        t1_id = r1.json()["id"]

        r2 = api_post(
            f"{server_url}/api/stubs/{stub_id}/tasks",
            json={"command": f"python3 {fake_train} 3"},
        )
        assert r2.status_code == 201
        t2_id = r2.json()["id"]

        time.sleep(1)

        # t2 should be queued
        r = api_get(f"{server_url}/api/stubs/{stub_id}/tasks/{t2_id}")
        assert r.json()["status"] == "queued"

        # Wait for t1 to finish
        wait_for_task_status(server_url, stub_id, t1_id, ["completed"], timeout=20)

        # t2 should now run and complete
        wait_for_task_status(server_url, stub_id, t2_id, ["completed", "running"], timeout=15)
    finally:
        proc.kill()
        proc.wait(timeout=5)
