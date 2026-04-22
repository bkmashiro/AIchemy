"""E2E tests for Grid Tasks."""
import time
import pytest
from conftest import (
    start_stub,
    wait_for_stub,
    wait_for_task_status,
    api_get,
    api_post,
    _session,
    MOCKS_DIR,
)


def api_delete(url: str, **kwargs):
    return _session.delete(url, **kwargs)


def test_grid_create_and_list(server_url, api_token):
    """Create a grid and verify cells are generated correctly."""
    r = api_post(f"{server_url}/api/grids", json={
        "name": "test_grid",
        "command_template": "echo ctx={context_len} seed={seed}",
        "parameters": {
            "context_len": [1, 2, 4],
            "seed": [42, 123],
        },
    })
    assert r.status_code == 201, r.text
    grid = r.json()
    assert grid["name"] == "test_grid"
    # 3 * 2 = 6 cells
    assert len(grid["cells"]) == 6
    # Verify all combinations present
    combos = {(c["params"]["context_len"], c["params"]["seed"]) for c in grid["cells"]}
    assert combos == {(1, 42), (1, 123), (2, 42), (2, 123), (4, 42), (4, 123)}

    grid_id = grid["id"]

    # GET /api/grids
    r = api_get(f"{server_url}/api/grids")
    assert r.ok
    grids = r.json()
    assert any(g["id"] == grid_id for g in grids)

    # GET /api/grids/:id
    r = api_get(f"{server_url}/api/grids/{grid_id}")
    assert r.ok
    grid_detail = r.json()
    assert grid_detail["id"] == grid_id
    assert len(grid_detail["cells"]) == 6


def test_grid_tasks_execute(server_url, api_token):
    """Grid tasks should execute and complete."""
    proc = start_stub(server_url, api_token)
    try:
        stub = wait_for_stub(server_url)
        stub_id = stub["id"]

        r = api_post(f"{server_url}/api/grids", json={
            "name": "exec_grid",
            "command_template": "echo ctx={context_len}",
            "parameters": {
                "context_len": [1, 2],
            },
            "stub_id": stub_id,
        })
        assert r.status_code == 201, r.text
        grid = r.json()
        grid_id = grid["id"]
        assert len(grid["cells"]) == 2

        # Wait for all cell tasks to complete
        deadline = time.time() + 30
        while time.time() < deadline:
            r = api_get(f"{server_url}/api/grids/{grid_id}")
            if r.ok:
                g = r.json()
                cell_statuses = {c["status"] for c in g["cells"]}
                if cell_statuses <= {"completed", "failed"}:
                    break
            time.sleep(0.5)

        r = api_get(f"{server_url}/api/grids/{grid_id}")
        grid_detail = r.json()
        # At least some cells completed
        completed = [c for c in grid_detail["cells"] if c["status"] == "completed"]
        assert len(completed) > 0, f"No cells completed: {grid_detail['cells']}"

    finally:
        proc.kill()
        proc.wait(timeout=5)


def test_grid_retry_failed(server_url, api_token):
    """Retry-failed endpoint should be reachable."""
    r = api_post(f"{server_url}/api/grids", json={
        "name": "retry_grid",
        "command_template": "false",
        "parameters": {
            "x": [1],
        },
    })
    assert r.status_code == 201
    grid_id = r.json()["id"]

    r = api_post(f"{server_url}/api/grids/{grid_id}/retry-failed")
    assert r.ok
    assert r.json()["ok"] is True


def test_grid_delete(server_url, api_token):
    """Delete grid should remove it."""
    r = api_post(f"{server_url}/api/grids", json={
        "name": "del_grid",
        "command_template": "echo {x}",
        "parameters": {"x": [1, 2]},
    })
    assert r.status_code == 201
    grid_id = r.json()["id"]

    r_del = api_delete(f"{server_url}/api/grids/{grid_id}")
    assert r_del.ok

    r_get = api_get(f"{server_url}/api/grids/{grid_id}")
    assert r_get.status_code == 404
