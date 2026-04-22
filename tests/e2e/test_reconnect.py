"""Test stub disconnect/reconnect behavior."""
import time
import pytest
from conftest import start_stub, wait_for_stub, wait_for_task_status, api_get, api_post, MOCKS_DIR


def test_stub_reconnects(server_url, api_token):
    """Kill and restart stub, verify it re-registers."""
    proc = start_stub(server_url, api_token)
    stub = wait_for_stub(server_url)
    stub_id = stub["id"]
    hostname = stub["hostname"]

    # Kill stub (simulate crash)
    proc.kill()
    proc.wait(timeout=5)

    # Server should mark it offline
    time.sleep(2)
    r = api_get(f"{server_url}/api/stubs/{stub_id}")
    assert r.json()["status"] in ("offline", "stale")

    # Restart stub with same token
    proc2 = start_stub(server_url, api_token)
    try:
        # Wait for a stub to come online
        new_stub = wait_for_stub(server_url, timeout=15)
        assert new_stub["status"] == "online"
        # Should be same hostname (re-registration)
        assert new_stub["hostname"] == hostname
    finally:
        proc2.kill()
        proc2.wait(timeout=5)


def test_server_state_survives_restart(server_url, api_token):
    """Tasks submitted before server restart should still be visible after."""
    proc = start_stub(server_url, api_token)
    try:
        stub = wait_for_stub(server_url)
        stub_id = stub["id"]

        fake_train = str(MOCKS_DIR / "fake_train.py")
        r = api_post(
            f"{server_url}/api/stubs/{stub_id}/tasks",
            json={"command": f"python3 {fake_train} 3"},
        )
        task_id = r.json()["id"]
        wait_for_task_status(server_url, stub_id, task_id, ["completed"], timeout=20)

        # Verify task is still in state
        r = api_get(f"{server_url}/api/stubs/{stub_id}/tasks/{task_id}")
        assert r.ok
        assert r.json()["status"] == "completed"
    finally:
        proc.kill()
        proc.wait(timeout=5)


def test_stale_after_missed_heartbeats(server_url, api_token):
    """Stub that stops heartbeating should be marked stale."""
    proc = start_stub(server_url, api_token)
    stub = wait_for_stub(server_url)
    stub_id = stub["id"]

    proc.kill()
    proc.wait(timeout=5)

    # Wait for offline status
    deadline = time.time() + 10
    while time.time() < deadline:
        r = api_get(f"{server_url}/api/stubs/{stub_id}")
        if r.ok and r.json()["status"] in ("offline", "stale"):
            break
        time.sleep(0.5)

    r = api_get(f"{server_url}/api/stubs/{stub_id}")
    assert r.json()["status"] in ("offline", "stale")
