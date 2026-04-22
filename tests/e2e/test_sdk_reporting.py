"""Test SDK progress reporting."""
import time
import pytest
from conftest import start_stub, wait_for_stub, wait_for_task_status, api_get, api_post, MOCKS_DIR, SDK_DIR


def test_sdk_progress_reporting(server_url, api_token):
    """Task using SDK should update progress field."""
    proc = start_stub(server_url, api_token)
    try:
        stub = wait_for_stub(server_url)
        stub_id = stub["id"]

        fake_sdk = str(MOCKS_DIR / "fake_train_sdk.py")
        r = api_post(
            f"{server_url}/api/stubs/{stub_id}/tasks",
            json={
                "command": f"python3 {fake_sdk} 20",
                "env": {
                    "ALCHEMY_SERVER": server_url,
                    "PYTHONPATH": str(SDK_DIR),
                },
            },
        )
        assert r.status_code == 201
        task_id = r.json()["id"]

        # Wait for task to complete
        completed = wait_for_task_status(server_url, stub_id, task_id, ["completed", "failed"], timeout=30)
        assert completed["status"] == "completed", f"Task failed: {completed}"
    finally:
        proc.kill()
        proc.wait(timeout=5)


def test_sdk_direct_report(server_url, api_token):
    """Test SDK /api/sdk/report endpoint directly."""
    proc = start_stub(server_url, api_token)
    try:
        stub = wait_for_stub(server_url)
        stub_id = stub["id"]

        fake_slow = str(MOCKS_DIR / "fake_train_slow.py")
        r = api_post(
            f"{server_url}/api/stubs/{stub_id}/tasks",
            json={"command": f"python3 {fake_slow} 30"},
        )
        task_id = r.json()["id"]
        wait_for_task_status(server_url, stub_id, task_id, ["running"], timeout=15)

        # Send SDK report
        from conftest import _session
        r = _session.post(
            f"{server_url}/api/sdk/report",
            json={
                "task_id": task_id,
                "step": 100,
                "total": 1000,
                "loss": 0.5,
                "metrics": {"accuracy": 0.85},
            },
        )
        assert r.ok, f"SDK report failed: {r.text}"
        resp = r.json()
        assert resp.get("ok") is True

        # Verify progress updated
        time.sleep(0.5)
        r = api_get(f"{server_url}/api/stubs/{stub_id}/tasks/{task_id}")
        task = r.json()
        assert task.get("progress") is not None
        assert task["progress"]["step"] == 100
        assert task["progress"]["total"] == 1000
        assert abs(task["progress"]["loss"] - 0.5) < 1e-6

        # Kill the slow task
        from conftest import api_patch
        api_patch(
            f"{server_url}/api/stubs/{stub_id}/tasks/{task_id}",
            json={"action": "kill"},
        )
    finally:
        proc.kill()
        proc.wait(timeout=5)
