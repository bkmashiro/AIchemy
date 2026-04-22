"""Test task pause/resume/kill lifecycle."""
import time
import pytest
from conftest import start_stub, wait_for_stub, wait_for_task_status, api_get, api_post, api_patch, MOCKS_DIR


def test_pause_resume_kill(server_url, api_token):
    """Submit slow task, pause, resume, then kill."""
    proc = start_stub(server_url, api_token)
    try:
        stub = wait_for_stub(server_url)
        stub_id = stub["id"]

        fake_slow = str(MOCKS_DIR / "fake_train_slow.py")
        r = api_post(
            f"{server_url}/api/stubs/{stub_id}/tasks",
            json={"command": f"python3 {fake_slow} 60"},
        )
        assert r.status_code == 201
        task_id = r.json()["id"]

        # Wait for it to start running
        wait_for_task_status(server_url, stub_id, task_id, ["running"], timeout=15)

        # Pause it
        r = api_patch(
            f"{server_url}/api/stubs/{stub_id}/tasks/{task_id}",
            json={"action": "pause"},
        )
        assert r.ok, f"Pause failed: {r.text}"

        time.sleep(1)
        r = api_get(f"{server_url}/api/stubs/{stub_id}/tasks/{task_id}")
        assert r.json()["status"] == "paused", f"Expected paused, got {r.json()['status']}"

        # Resume it
        r = api_patch(
            f"{server_url}/api/stubs/{stub_id}/tasks/{task_id}",
            json={"action": "resume"},
        )
        assert r.ok

        time.sleep(1)
        r = api_get(f"{server_url}/api/stubs/{stub_id}/tasks/{task_id}")
        assert r.json()["status"] == "running", f"Expected running, got {r.json()['status']}"

        # Kill it
        r = api_patch(
            f"{server_url}/api/stubs/{stub_id}/tasks/{task_id}",
            json={"action": "kill"},
        )
        assert r.ok

        time.sleep(2)
        r = api_get(f"{server_url}/api/stubs/{stub_id}/tasks/{task_id}")
        # After kill, task could be killed/failed (non-zero exit), or completed
        # (if process caught SIGTERM and exited 0). All are valid end states.
        assert r.json()["status"] in ("killed", "failed", "completed"), \
            f"Unexpected status: {r.json()['status']}"

    finally:
        proc.kill()
        proc.wait(timeout=5)


def test_kill_queued_task(server_url, api_token):
    """Kill a queued task (never started)."""
    proc = start_stub(server_url, api_token, max_concurrent=1)
    try:
        stub = wait_for_stub(server_url)
        stub_id = stub["id"]

        fake_slow = str(MOCKS_DIR / "fake_train_slow.py")
        fake_train = str(MOCKS_DIR / "fake_train.py")

        # Block the slot with a slow task
        r = api_post(
            f"{server_url}/api/stubs/{stub_id}/tasks",
            json={"command": f"python3 {fake_slow} 30"},
        )
        blocker_id = r.json()["id"]
        time.sleep(2)

        # Submit a task that will queue
        r = api_post(
            f"{server_url}/api/stubs/{stub_id}/tasks",
            json={"command": f"python3 {fake_train}"},
        )
        task_id = r.json()["id"]
        time.sleep(0.5)

        # Verify it's queued
        r = api_get(f"{server_url}/api/stubs/{stub_id}/tasks/{task_id}")
        assert r.json()["status"] == "queued", f"Expected queued, got {r.json()['status']}"

        # Kill the queued task
        r = api_patch(
            f"{server_url}/api/stubs/{stub_id}/tasks/{task_id}",
            json={"action": "kill"},
        )
        assert r.ok

        r = api_get(f"{server_url}/api/stubs/{stub_id}/tasks/{task_id}")
        assert r.json()["status"] == "killed"

        # Kill the blocker
        api_patch(
            f"{server_url}/api/stubs/{stub_id}/tasks/{blocker_id}",
            json={"action": "kill"},
        )
    finally:
        proc.kill()
        proc.wait(timeout=5)
