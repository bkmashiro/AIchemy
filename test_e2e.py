"""Quick E2E test: connect stub, submit task, verify completion."""
import asyncio
import json
import os
import socketio
import httpx

SERVER = "http://127.0.0.1:3002"
TOKEN = "default-dev-token"

async def main():
    print("=== AIchemy v2 E2E Test ===\n")

    # 1. Check server health
    async with httpx.AsyncClient() as http:
        r = await http.get(f"{SERVER}/health")
        print(f"[1] Server health: {r.json()}")

        # Get token
        r = await http.get(f"{SERVER}/api/tokens")
        tokens = r.json()
        token = tokens[0]["token"] if tokens else TOKEN
        print(f"[1] Using token: {token}")

    # 2. Connect stub
    sio = socketio.AsyncClient(reconnection=False)
    stub_id = None
    task_started = asyncio.Event()
    task_completed = asyncio.Event()
    task_result = {}

    @sio.on("registered", namespace="/stubs")
    async def on_registered(data):
        nonlocal stub_id
        stub_id = data["stub_id"]
        print(f"[2] Stub registered: {stub_id}")

    @sio.on("task.run", namespace="/stubs")
    async def on_task_run(data):
        print(f"[3] Received task.run: {data['task_id']}")
        print(f"    Command: {data['command']}")
        print(f"    Env: {data.get('env', {})}")
        print(f"    Param overrides: {data.get('param_overrides')}")
        print(f"    Base config: {data.get('base_config')}")
        task_started.set()

        # Simulate: report started
        await sio.emit("task.started", {
            "task_id": data["task_id"],
            "pid": 99999,
        }, namespace="/stubs")

        # Simulate: report progress
        await sio.emit("task.progress", {
            "task_id": data["task_id"],
            "step": 50,
            "total": 100,
            "loss": 0.42,
        }, namespace="/stubs")

        await asyncio.sleep(0.5)

        # Simulate: report completion
        await sio.emit("task.completed", {
            "task_id": data["task_id"],
            "exit_code": 0,
            "metrics": {"accuracy": 0.95},
        }, namespace="/stubs")
        task_result["task_id"] = data["task_id"]
        task_completed.set()

    @sio.on("pong", namespace="/stubs")
    async def on_pong(data):
        pass  # heartbeat response

    await sio.connect(SERVER, namespaces=["/stubs"], transports=["websocket"])

    # Register
    await sio.emit("register", {
        "hostname": "test-local",
        "gpu": {"name": "FakeGPU", "vram_total_mb": 11264, "count": 1},
        "max_concurrent": 3,
        "token": token,
    }, namespace="/stubs")

    await asyncio.sleep(1)
    print(f"[2] Stub ID: {stub_id}")

    # 3. Submit a simple task via REST
    async with httpx.AsyncClient() as http:
        r = await http.post(f"{SERVER}/api/stubs/{stub_id}/tasks", json={
            "command": "echo 'Hello from AIchemy v2!'",
            "env": {"TEST_VAR": "42"},
        })
        task = r.json()
        print(f"[3] Task created: {task['id']} status={task['status']}")

    # Wait for task to complete
    await asyncio.wait_for(task_completed.wait(), timeout=10)
    print(f"[4] Task completed!")

    # 4. Verify via REST
    async with httpx.AsyncClient() as http:
        r = await http.get(f"{SERVER}/api/stubs/{stub_id}/tasks")
        tasks = r.json()
        t = next(x for x in tasks if x["id"] == task_result["task_id"])
        print(f"[4] Task status: {t['status']}, metrics: {t.get('metrics')}")
        assert t["status"] == "completed", f"Expected completed, got {t['status']}"
        assert t["metrics"]["accuracy"] == 0.95

    # 5. Test grid task with params
    print(f"\n--- Grid Task Test ---")
    async with httpx.AsyncClient() as http:
        r = await http.post(f"{SERVER}/api/grids", json={
            "name": "test_grid",
            "command_template": "python train.py --ctx {context_len} --seed {seed}",
            "parameters": {
                "context_len": [8, 16],
                "seed": [42],
            },
            "stub_id": stub_id,
        })
        grid = r.json()
        print(f"[5] Grid created: {grid['id']}, {len(grid['cells'])} cells")
        for cell in grid["cells"]:
            print(f"    Cell {cell['id'][:8]}: params={cell['params']}")

    # Wait for grid tasks to be dispatched
    await asyncio.sleep(2)

    # 6. Check grid status
    async with httpx.AsyncClient() as http:
        r = await http.get(f"{SERVER}/api/grids/{grid['id']}")
        g = r.json()
        print(f"[6] Grid status: {g['status']}")
        for cell in g["cells"]:
            print(f"    Cell {cell['id'][:8]}: status={cell['status']}")

    # 7. Test conflict detection
    print(f"\n--- Conflict Detection Test ---")
    async with httpx.AsyncClient() as http:
        r = await http.post(f"{SERVER}/api/stubs/{stub_id}/tasks", json={
            "command": "echo test",
            "run_dir": "/runs/exp1",
        })
        print(f"[7] First task with run_dir: {r.status_code}")

        # Mark it completed
        tid = r.json()["id"]
        await sio.emit("task.started", {"task_id": tid, "pid": 11111}, namespace="/stubs")
        await sio.emit("task.completed", {"task_id": tid, "exit_code": 0}, namespace="/stubs")
        await asyncio.sleep(0.5)

        # Try duplicate
        r = await http.post(f"{SERVER}/api/stubs/{stub_id}/tasks", json={
            "command": "echo test2",
            "run_dir": "/runs/exp1",
        })
        print(f"[7] Duplicate run_dir: {r.status_code} -> {r.json().get('error', 'ok')}")
        assert r.status_code == 409

        # Force override
        r = await http.post(f"{SERVER}/api/stubs/{stub_id}/tasks", json={
            "command": "echo test3",
            "run_dir": "/runs/exp1",
            "force": True,
        })
        print(f"[7] Force override: {r.status_code}")
        assert r.status_code == 201

    print(f"\n=== All E2E tests passed! ===")

    await sio.disconnect()

if __name__ == "__main__":
    asyncio.run(main())
