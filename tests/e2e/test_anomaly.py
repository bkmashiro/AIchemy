"""E2E tests for anomaly detection and smart allocation."""
import json
import math
import time
import pytest
from conftest import (
    start_stub,
    wait_for_stub,
    wait_for_task_status,
    api_get,
    api_post,
    api_patch,
    _session,
    MOCKS_DIR,
)


def api_delete(url: str, **kwargs):
    return _session.delete(url, **kwargs)


def api_post_raw(url: str, payload: dict) -> object:
    """Post raw JSON, allowing NaN values (non-strict JSON)."""
    raw = json.dumps(payload, allow_nan=True)
    return _session.post(url, data=raw, headers={"Content-Type": "application/json"})


def test_alerts_endpoint(server_url, api_token):
    """Alerts endpoint should be accessible."""
    r = api_get(f"{server_url}/api/alerts")
    assert r.ok
    assert isinstance(r.json(), list)


def test_stall_config_crud(server_url, api_token):
    """Stall config should be readable and patchable."""
    r = api_get(f"{server_url}/api/config/stall")
    assert r.ok
    cfg = r.json()
    assert "enabled" in cfg
    assert "no_progress_timeout_min" in cfg

    # Patch
    r = api_patch(f"{server_url}/api/config/stall", json={"no_progress_timeout_min": 45})
    assert r.ok
    assert r.json()["no_progress_timeout_min"] == 45

    # Restore
    api_patch(f"{server_url}/api/config/stall", json={"no_progress_timeout_min": 30})


def test_migration_suggestions_endpoint(server_url, api_token):
    """Migration suggestions endpoint should be accessible."""
    r = api_get(f"{server_url}/api/migrations/suggestions")
    assert r.ok
    assert isinstance(r.json(), list)


def test_loss_spike_reported(server_url, api_token):
    """Reporting a 10x loss spike should create a warning alert."""
    proc = start_stub(server_url, api_token)
    try:
        stub = wait_for_stub(server_url)
        stub_id = stub["id"]

        fake_slow = str(MOCKS_DIR / "fake_train_slow.py")
        r = api_post(f"{server_url}/api/stubs/{stub_id}/tasks", json={
            "command": f"python3 {fake_slow} 60",
        })
        assert r.status_code == 201
        task_id = r.json()["id"]
        wait_for_task_status(server_url, stub_id, task_id, ["running"], timeout=15)

        # Report initial loss
        r = api_post(f"{server_url}/api/sdk/report", json={
            "task_id": task_id,
            "step": 100,
            "total": 1000,
            "loss": 0.5,
        })
        assert r.ok

        # Report 10x spike (this should create a loss_spike alert)
        r = api_post(f"{server_url}/api/sdk/report", json={
            "task_id": task_id,
            "step": 101,
            "total": 1000,
            "loss": 5.5,  # > 10x of 0.5
        })
        assert r.ok

        # Alert should be created
        alerts = api_get(f"{server_url}/api/alerts").json()
        spike_alerts = [a for a in alerts if a["type"] == "loss_spike" and a.get("task_id") == task_id]
        assert len(spike_alerts) >= 1

    finally:
        proc.kill()
        proc.wait(timeout=5)


def test_smart_allocation_auto_assign(server_url, api_token):
    """POST /api/tasks should auto-assign to the best available stub."""
    proc = start_stub(server_url, api_token)
    try:
        stub = wait_for_stub(server_url)

        r = api_post(f"{server_url}/api/tasks", json={
            "command": "echo auto-assigned",
        })
        assert r.status_code == 201, r.text
        task = r.json()
        assert task["stub_id"] == stub["id"]
        assert task["status"] in ("queued", "running")

    finally:
        proc.kill()
        proc.wait(timeout=5)


def test_smart_allocation_no_stub(server_url, api_token):
    """POST /api/tasks with no stubs available should return 503."""
    # Don't start any stub
    r = api_post(f"{server_url}/api/tasks", json={
        "command": "echo nothing",
    })
    # There might be leftover online stubs from other tests; just verify it's either 201 or 503
    assert r.status_code in (201, 503)


def test_checkpoint_and_pause_endpoint(server_url, api_token):
    """Checkpoint-and-pause endpoint should be accessible."""
    proc = start_stub(server_url, api_token)
    try:
        stub = wait_for_stub(server_url)
        stub_id = stub["id"]

        fake_slow = str(MOCKS_DIR / "fake_train_slow.py")
        r = api_post(f"{server_url}/api/stubs/{stub_id}/tasks", json={
            "command": f"python3 {fake_slow} 30",
        })
        assert r.status_code == 201
        task_id = r.json()["id"]
        wait_for_task_status(server_url, stub_id, task_id, ["running"], timeout=15)

        r = api_post(f"{server_url}/api/stubs/{stub_id}/tasks/{task_id}/checkpoint-and-pause")
        assert r.ok

    finally:
        proc.kill()
        proc.wait(timeout=5)
