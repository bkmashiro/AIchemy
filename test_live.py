"""Live E2E tests against real gpu30 stub via tunnel."""
import asyncio
import json
import httpx
import traceback

SERVER = "http://127.0.0.1:3002"
STUB_ID = None  # auto-detect


async def get_stub_id(http: httpx.AsyncClient) -> str:
    r = await http.get(f"{SERVER}/api/stubs")
    stubs = r.json()
    online = [s for s in stubs if s["status"] == "online"]
    assert online, "No online stubs!"
    print(f"  Found {len(online)} online stub(s): {[s['hostname'] for s in online]}")
    return online[0]["id"]


async def wait_task(http: httpx.AsyncClient, stub_id: str, task_id: str, timeout: float = 30) -> dict:
    """Poll until task completes or fails."""
    for _ in range(int(timeout * 2)):
        await asyncio.sleep(0.5)
        r = await http.get(f"{SERVER}/api/stubs/{stub_id}/tasks")
        tasks = r.json()
        t = next((x for x in tasks if x["id"] == task_id), None)
        if t and t["status"] in ("completed", "failed", "interrupted"):
            return t
    raise TimeoutError(f"Task {task_id} did not complete in {timeout}s")


async def test_basic_task(http: httpx.AsyncClient, stub_id: str):
    """Test 1: Basic task execution with env vars."""
    print("\n[Test 1] Basic task with env vars")
    r = await http.post(f"{SERVER}/api/stubs/{stub_id}/tasks", json={
        "command": "echo HELLO=$HELLO && echo WORLD=$WORLD",
        "env": {"HELLO": "alchemy", "WORLD": "v2"},
    })
    assert r.status_code == 201, f"Expected 201, got {r.status_code}: {r.text}"
    task = r.json()
    print(f"  Created task {task['id'][:8]}, waiting...")

    result = await wait_task(http, stub_id, task["id"])
    print(f"  Status: {result['status']}, exit_code: {result.get('exit_code')}")
    print(f"  Logs: {result.get('log_buffer', [])}")
    assert result["status"] == "completed"
    assert result["exit_code"] == 0
    logs = result.get("log_buffer", [])
    assert any("HELLO=alchemy" in l for l in logs), f"Expected HELLO=alchemy in logs: {logs}"
    print("  PASS ✓")


async def test_concurrent_tasks(http: httpx.AsyncClient, stub_id: str):
    """Test 2: Multiple concurrent tasks (max_concurrent=2)."""
    print("\n[Test 2] Concurrent tasks")
    tasks = []
    for i in range(3):
        r = await http.post(f"{SERVER}/api/stubs/{stub_id}/tasks", json={
            "command": f"echo 'task_{i} start' && sleep 2 && echo 'task_{i} done'",
        })
        assert r.status_code == 201
        tasks.append(r.json())
        print(f"  Created task_{i}: {tasks[-1]['id'][:8]}")

    # Wait for all to complete
    for i, t in enumerate(tasks):
        result = await wait_task(http, stub_id, t["id"], timeout=20)
        print(f"  task_{i}: {result['status']} (exit={result.get('exit_code')})")
        assert result["status"] == "completed"
    print("  PASS ✓")


async def test_failing_task(http: httpx.AsyncClient, stub_id: str):
    """Test 3: Task that exits with non-zero."""
    print("\n[Test 3] Failing task")
    r = await http.post(f"{SERVER}/api/stubs/{stub_id}/tasks", json={
        "command": "echo 'about to fail' && exit 42",
    })
    assert r.status_code == 201
    task = r.json()

    result = await wait_task(http, stub_id, task["id"])
    print(f"  Status: {result['status']}, exit_code: {result.get('exit_code')}")
    assert result["status"] == "failed"
    assert result["exit_code"] == 42
    print("  PASS ✓")


async def test_conflict_detection(http: httpx.AsyncClient, stub_id: str):
    """Test 4: run_dir conflict detection."""
    print("\n[Test 4] Conflict detection (run_dir)")

    # Submit task with run_dir
    r = await http.post(f"{SERVER}/api/stubs/{stub_id}/tasks", json={
        "command": "echo 'first run'",
        "run_dir": "/tmp/test_conflict_exp1",
    })
    assert r.status_code == 201
    task = r.json()
    result = await wait_task(http, stub_id, task["id"])
    assert result["status"] == "completed"
    print(f"  First task completed: {task['id'][:8]}")

    # Try duplicate - should get 409
    r = await http.post(f"{SERVER}/api/stubs/{stub_id}/tasks", json={
        "command": "echo 'duplicate'",
        "run_dir": "/tmp/test_conflict_exp1",
    })
    print(f"  Duplicate attempt: {r.status_code} -> {r.json().get('error', 'ok')}")
    assert r.status_code == 409, f"Expected 409, got {r.status_code}"

    # Force override - should work
    r = await http.post(f"{SERVER}/api/stubs/{stub_id}/tasks", json={
        "command": "echo 'forced override'",
        "run_dir": "/tmp/test_conflict_exp1",
        "force": True,
    })
    print(f"  Force override: {r.status_code}")
    assert r.status_code == 201
    result = await wait_task(http, stub_id, r.json()["id"])
    assert result["status"] == "completed"
    print("  PASS ✓")


async def test_grid_tasks(http: httpx.AsyncClient, stub_id: str):
    """Test 5: Grid task creation and execution."""
    print("\n[Test 5] Grid tasks with param expansion")

    r = await http.post(f"{SERVER}/api/grids", json={
        "name": "live_test_grid",
        "command_template": "echo 'lr={lr} seed={seed}' && echo $ALCHEMY_PARAMS",
        "parameters": {
            "lr": [0.01, 0.001],
            "seed": [42],
        },
        "stub_id": stub_id,
    })
    assert r.status_code == 201, f"Expected 201, got {r.status_code}: {r.text}"
    grid = r.json()
    print(f"  Grid created: {grid['id'][:8]}, {len(grid['cells'])} cells")
    for cell in grid["cells"]:
        print(f"    Cell {cell['id'][:8]}: params={cell['params']}")

    # Wait for grid completion
    for _ in range(30):
        await asyncio.sleep(1)
        r = await http.get(f"{SERVER}/api/grids/{grid['id']}")
        g = r.json()
        if g["status"] in ("completed", "failed"):
            break

    print(f"  Grid status: {g['status']}")
    for cell in g["cells"]:
        print(f"    Cell {cell['id'][:8]}: status={cell['status']}")
    assert g["status"] == "completed", f"Expected completed, got {g['status']}"
    print("  PASS ✓")


async def test_grid_conflict(http: httpx.AsyncClient, stub_id: str):
    """Test 6: Grid name conflict detection."""
    print("\n[Test 6] Grid name conflict")

    # Try to create grid with same name (has completed cells from test 5)
    r = await http.post(f"{SERVER}/api/grids", json={
        "name": "live_test_grid",
        "command_template": "echo test",
        "parameters": {"x": [1]},
    })
    print(f"  Duplicate grid: {r.status_code} -> {r.json().get('error', 'ok')}")
    assert r.status_code == 409, f"Expected 409, got {r.status_code}"

    # Force override
    r = await http.post(f"{SERVER}/api/grids", json={
        "name": "live_test_grid",
        "command_template": "echo 'forced grid'",
        "parameters": {"x": [1]},
        "force": True,
    })
    print(f"  Force override: {r.status_code}")
    assert r.status_code == 201
    print("  PASS ✓")


async def test_task_kill(http: httpx.AsyncClient, stub_id: str):
    """Test 7: Kill a running task."""
    print("\n[Test 7] Kill running task")

    r = await http.post(f"{SERVER}/api/stubs/{stub_id}/tasks", json={
        "command": "echo 'will be killed' && sleep 60",
    })
    assert r.status_code == 201
    task = r.json()
    print(f"  Created long task: {task['id'][:8]}")

    # Wait for it to start
    await asyncio.sleep(2)

    # Kill it
    r = await http.post(f"{SERVER}/api/stubs/{stub_id}/tasks/{task['id']}/kill")
    print(f"  Kill response: {r.status_code}")

    # Wait for it to show as failed
    result = await wait_task(http, stub_id, task["id"], timeout=15)
    print(f"  Status: {result['status']}, exit_code: {result.get('exit_code')}")
    assert result["status"] == "failed"
    print("  PASS ✓")


async def test_alchemy_params(http: httpx.AsyncClient, stub_id: str):
    """Test 8: ALCHEMY_PARAMS env var injection."""
    print("\n[Test 8] ALCHEMY_PARAMS injection")

    r = await http.post(f"{SERVER}/api/grids", json={
        "name": "params_test_grid",
        "command_template": "python3 -c \"import os,json; p=json.loads(os.environ['ALCHEMY_PARAMS']); print(f'ctx={{p[\\\"ctx\\\"]}} bs={{p[\\\"bs\\\"]}}')\"\n",
        "parameters": {"ctx": [8], "bs": [32]},
        "stub_id": stub_id,
    })
    assert r.status_code == 201
    grid = r.json()
    print(f"  Grid: {grid['id'][:8]}")

    # Wait for completion
    for _ in range(20):
        await asyncio.sleep(1)
        r = await http.get(f"{SERVER}/api/grids/{grid['id']}")
        g = r.json()
        if g["status"] in ("completed", "failed"):
            break

    # Check logs of the task
    r = await http.get(f"{SERVER}/api/stubs/{stub_id}/tasks")
    tasks = r.json()
    grid_task = next((t for t in tasks if t.get("grid_id") == grid["id"]), None)
    if grid_task:
        print(f"  Task logs: {grid_task.get('log_buffer', [])}")
    assert g["status"] == "completed", f"Grid status: {g['status']}"
    print("  PASS ✓")


async def test_slurm_accounts_api(http: httpx.AsyncClient):
    """Test 9: SLURM accounts CRUD (API only, no real SLURM)."""
    print("\n[Test 9] SLURM accounts API")

    # Create
    r = await http.post(f"{SERVER}/api/slurm/accounts", json={
        "name": "test_account",
        "ssh_target": "user@cluster",
        "qos_limit": 3,
        "partitions": ["a40", "a100"],
    })
    assert r.status_code == 201, f"Expected 201, got {r.status_code}: {r.text}"
    account = r.json()
    print(f"  Created account: {account['id'][:8]} name={account['name']}")

    # List
    r = await http.get(f"{SERVER}/api/slurm/accounts")
    accounts = r.json()
    assert len(accounts) >= 1
    print(f"  Listed {len(accounts)} account(s)")

    # Update
    r = await http.patch(f"{SERVER}/api/slurm/accounts/{account['id']}", json={
        "qos_limit": 5,
    })
    assert r.status_code == 200
    assert r.json()["qos_limit"] == 5
    print(f"  Updated qos_limit to 5")

    # Utilization
    r = await http.get(f"{SERVER}/api/slurm/accounts/{account['id']}/utilization")
    assert r.status_code == 200
    util = r.json()
    print(f"  Utilization: online={util['online_stubs']}, total={util['total_stubs']}")

    # Auto-queue config
    r = await http.post(f"{SERVER}/api/slurm/accounts/{account['id']}/autoqueue", json={
        "max_running": 3,
        "max_pending": 3,
        "qos_running_limit": 3,
        "qos_pending_limit": 3,
        "idle_timeout_min": 30,
    })
    assert r.status_code == 201
    aq = r.json()
    print(f"  AutoQueue config: max_running={aq['max_running']}, max_pending={aq['max_pending']}")

    # Delete
    r = await http.delete(f"{SERVER}/api/slurm/accounts/{account['id']}")
    assert r.status_code == 200
    print(f"  Deleted account")

    print("  PASS ✓")


async def main():
    print("=== AIchemy v2 Live Tests ===")
    bugs = []

    async with httpx.AsyncClient(timeout=30) as http:
        # Health check
        r = await http.get(f"{SERVER}/health")
        print(f"Server: {r.json()}")

        stub_id = await get_stub_id(http)
        print(f"Using stub: {stub_id[:8]}")

        tests = [
            ("Basic task", test_basic_task, (http, stub_id)),
            ("Concurrent tasks", test_concurrent_tasks, (http, stub_id)),
            ("Failing task", test_failing_task, (http, stub_id)),
            ("Conflict detection", test_conflict_detection, (http, stub_id)),
            ("Grid tasks", test_grid_tasks, (http, stub_id)),
            ("Grid conflict", test_grid_conflict, (http, stub_id)),
            ("Task kill", test_task_kill, (http, stub_id)),
            ("ALCHEMY_PARAMS", test_alchemy_params, (http, stub_id)),
            ("SLURM accounts API", test_slurm_accounts_api, (http,)),
        ]

        passed = 0
        failed = 0
        for name, test_fn, args in tests:
            try:
                await test_fn(*args)
                passed += 1
            except Exception as e:
                failed += 1
                tb = traceback.format_exc()
                bugs.append({"test": name, "error": str(e), "traceback": tb})
                print(f"  FAIL ✗: {e}")

    print(f"\n{'='*40}")
    print(f"Results: {passed} passed, {failed} failed")
    if bugs:
        print(f"\n--- Bugs Found ---")
        for b in bugs:
            print(f"\n[{b['test']}] {b['error']}")
            print(b["traceback"])


if __name__ == "__main__":
    asyncio.run(main())
