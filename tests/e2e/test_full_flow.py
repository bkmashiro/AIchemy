"""Full E2E test: server + stub + task lifecycle."""
import time
import pytest
from conftest import (
    start_stub,
    wait_for_stub,
    wait_for_task_status,
    api_get,
    api_post,
    api_patch,
    MOCKS_DIR,
)


def test_stub_registers(server_url, api_token):
    """Start stub and verify it appears as online."""
    proc = start_stub(server_url, api_token)
    try:
        stub = wait_for_stub(server_url)
        assert stub["status"] == "online"
        assert "hostname" in stub
        assert stub["max_concurrent"] >= 1
    finally:
        proc.kill()
        proc.wait(timeout=5)


def test_full_task_flow(server_url, api_token):
    """Submit task, assert queued → running → completed."""
    proc = start_stub(server_url, api_token)
    try:
        stub = wait_for_stub(server_url)
        stub_id = stub["id"]

        # Submit task
        fake_train = str(MOCKS_DIR / "fake_train.py")
        r = api_post(
            f"{server_url}/api/stubs/{stub_id}/tasks",
            json={"command": f"python3 {fake_train} 5"},
        )
        assert r.status_code == 201
        task = r.json()
        task_id = task["id"]

        # Task starts as queued or running
        assert task["status"] in ("queued", "running")

        # Wait for completion
        completed = wait_for_task_status(server_url, stub_id, task_id, ["completed", "failed"], timeout=30)
        assert completed["status"] == "completed", f"Task failed: {completed}"
        assert completed["exit_code"] == 0

        # Check log buffer has output
        r = api_get(f"{server_url}/api/stubs/{stub_id}/tasks/{task_id}/logs")
        assert r.ok
        logs = r.json()
        assert len(logs["lines"]) > 0
        log_content = "\n".join(logs["lines"])
        assert "Training" in log_content or "Done" in log_content

    finally:
        proc.kill()
        proc.wait(timeout=5)


def test_stub_offline_on_disconnect(server_url, api_token):
    """Kill stub process and verify it goes offline."""
    proc = start_stub(server_url, api_token)
    stub = wait_for_stub(server_url)
    stub_id = stub["id"]

    # Kill the stub
    proc.kill()
    proc.wait(timeout=5)

    # Wait for offline
    deadline = time.time() + 10
    while time.time() < deadline:
        r = api_get(f"{server_url}/api/stubs/{stub_id}")
        if r.ok and r.json()["status"] in ("offline", "stale"):
            break
        time.sleep(0.5)

    r = api_get(f"{server_url}/api/stubs/{stub_id}")
    assert r.ok
    assert r.json()["status"] in ("offline", "stale")


def test_task_crash(server_url, api_token):
    """Task that crashes should be marked failed."""
    proc = start_stub(server_url, api_token)
    try:
        stub = wait_for_stub(server_url)
        stub_id = stub["id"]

        fake_crash = str(MOCKS_DIR / "fake_train_crash.py")
        r = api_post(
            f"{server_url}/api/stubs/{stub_id}/tasks",
            json={"command": f"python3 {fake_crash}"},
        )
        assert r.status_code == 201
        task_id = r.json()["id"]

        task = wait_for_task_status(server_url, stub_id, task_id, ["failed", "completed"], timeout=30)
        assert task["status"] == "failed"
        assert task["exit_code"] != 0
    finally:
        proc.kill()
        proc.wait(timeout=5)
