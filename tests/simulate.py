#!/usr/bin/env python3
"""
Alchemy v2 仿真环境 — 本地全功能测试。

启动 server + N 个 mock stub，提交各种任务，验证全流程。
用法:
  cd /workspace/extra/projects/alchemy-v2
  python3 tests/simulate.py [--stubs N] [--tasks N] [--port PORT]
"""
import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Optional

# Paths
ROOT = Path(__file__).parent.parent
SERVER_DIR = ROOT / "server"
STUB_DIR = ROOT / "stub"
SDK_DIR = ROOT / "sdk"
MOCKS_DIR = ROOT / "tests" / "mocks"

# Color output
class C:
    GREEN = "\033[92m"
    RED = "\033[91m"
    YELLOW = "\033[93m"
    CYAN = "\033[96m"
    BOLD = "\033[1m"
    END = "\033[0m"

def log(msg: str, color: str = ""):
    print(f"{color}[sim] {msg}{C.END}", flush=True)

def ok(msg: str):
    log(f"✓ {msg}", C.GREEN)

def fail(msg: str):
    log(f"✗ {msg}", C.RED)

def info(msg: str):
    log(msg, C.CYAN)

def warn(msg: str):
    log(msg, C.YELLOW)


# --- HTTP helpers (bypass proxy) ---
import requests as _req

_session = _req.Session()
_session.trust_env = False


def api(method: str, url: str, **kwargs) -> _req.Response:
    kwargs.setdefault("timeout", 10)
    return getattr(_session, method)(url, **kwargs)


# --- Port finder ---
def free_port() -> int:
    with socket.socket() as s:
        s.bind(("", 0))
        return s.getsockname()[1]


# --- Process management ---
_procs: list[subprocess.Popen] = []

def cleanup():
    for p in _procs:
        try:
            p.kill()
            p.wait(timeout=5)
        except Exception:
            pass

signal.signal(signal.SIGINT, lambda s, f: (cleanup(), sys.exit(0)))
signal.signal(signal.SIGTERM, lambda s, f: (cleanup(), sys.exit(0)))


def start_server(port: int) -> subprocess.Popen:
    state_file = f"/tmp/alchemy_sim_state_{port}.json"
    env = os.environ.copy()
    env.update({
        "PORT": str(port),
        "STATE_FILE": state_file,
        "NO_PROXY": "*",
        "no_proxy": "*",
    })
    proc = subprocess.Popen(
        ["node_modules/.bin/tsx", "src/index.ts"],
        cwd=str(SERVER_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    _procs.append(proc)
    return proc


def start_stub(server_url: str, token: str, name: str = "", max_concurrent: int = 3) -> subprocess.Popen:
    env = os.environ.copy()
    env["PYTHONPATH"] = f"{STUB_DIR}:{SDK_DIR}:" + env.get("PYTHONPATH", "")
    env["ALCHEMY_SERVER"] = server_url
    env["ALCHEMY_SDK_PATH"] = str(SDK_DIR)
    env["NO_PROXY"] = "*"
    env["no_proxy"] = "*"

    cmd = [
        sys.executable, "-m", "alchemy_stub",
        "--server", server_url,
        "--token", token,
        "--max-concurrent", str(max_concurrent),
        "--idle-timeout", "0",
        "--pid-file", f"/tmp/alchemy_sim_stub_{uuid.uuid4().hex[:8]}.json",
    ]
    if name:
        env["HOSTNAME"] = name

    proc = subprocess.Popen(
        cmd,
        cwd=str(STUB_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    _procs.append(proc)
    return proc


def wait_server(url: str, timeout: float = 20.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = api("get", f"{url}/health")
            if r.ok:
                return
        except Exception:
            pass
        time.sleep(0.3)
    raise RuntimeError(f"Server didn't start in {timeout}s")


def wait_stubs_online(url: str, token: str, count: int, timeout: float = 20.0) -> list[dict]:
    headers = {"Authorization": f"Bearer {token}"}
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = api("get", f"{url}/api/stubs", headers=headers)
            if r.ok:
                stubs = [s for s in r.json() if s["status"] == "online"]
                if len(stubs) >= count:
                    return stubs
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError(f"Only {len(stubs) if 'stubs' in dir() else 0}/{count} stubs online after {timeout}s")


def wait_task(url: str, token: str, task_id: str, statuses: list[str], timeout: float = 30.0) -> dict:
    headers = {"Authorization": f"Bearer {token}"}
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        try:
            r = api("get", f"{url}/api/tasks/{task_id}", headers=headers)
            if r.ok:
                last = r.json()
                if last.get("status") in statuses:
                    return last
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError(f"Task {task_id} didn't reach {statuses} in {timeout}s (last: {last.get('status', '?')})")


# --- Test scenarios ---

class SimResults:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.errors: list[str] = []

    def check(self, name: str, condition: bool, detail: str = ""):
        if condition:
            ok(name)
            self.passed += 1
        else:
            fail(f"{name}: {detail}")
            self.failed += 1
            self.errors.append(f"{name}: {detail}")

    def summary(self):
        total = self.passed + self.failed
        color = C.GREEN if self.failed == 0 else C.RED
        log(f"\n{'='*50}", C.BOLD)
        log(f"Results: {self.passed}/{total} passed", color)
        if self.errors:
            for e in self.errors:
                log(f"  - {e}", C.RED)
        return self.failed == 0


def run_simulation(num_stubs: int = 3, num_tasks: int = 10, port: int = 0):
    results = SimResults()
    port = port or free_port()
    url = f"http://localhost:{port}"
    headers = {}

    try:
        # --- Phase 1: Start server ---
        info(f"Starting server on port {port}...")
        server_proc = start_server(port)
        wait_server(url)
        ok("Server started")

        # Use default token (server creates one on startup if none exist)
        token = os.environ.get("ALCHEMY_TOKEN", "alchemy-v2-token")
        headers = {"Authorization": f"Bearer {token}"}

        # Verify token works
        r = api("get", f"{url}/api/stubs", headers=headers)
        results.check("Default token works", r.status_code == 200, f"got {r.status_code}")

        # --- Phase 2: Start mock stubs ---
        info(f"Starting {num_stubs} mock stubs...")
        stub_procs = []
        for i in range(num_stubs):
            p = start_stub(url, token, name=f"sim-gpu{i:02d}", max_concurrent=3)
            stub_procs.append(p)

        try:
            stubs = wait_stubs_online(url, token, num_stubs)
        except RuntimeError:
            # Debug: print stub stdout
            for i, p in enumerate(stub_procs):
                p.kill()
                out, _ = p.communicate(timeout=5)
                warn(f"Stub {i} output:\n{out[:2000]}")
            raise
        results.check(f"{num_stubs} stubs online", len(stubs) >= num_stubs, f"got {len(stubs)}")

        # --- Phase 3: Overview endpoint ---
        info("Testing overview endpoint...")
        r = api("get", f"{url}/api/overview")
        results.check("Overview returns data", r.ok and r.json()["stubs"]["online"] >= num_stubs)

        # --- Phase 4: Submit tasks (global queue) ---
        info(f"Submitting {num_tasks} tasks to global queue...")
        task_ids = []
        for i in range(num_tasks):
            fake_train = str(MOCKS_DIR / "fake_train.py")
            r = api("post", f"{url}/api/tasks", json={
                "command": f"python3 {fake_train} 5",
                "priority": i % 3 + 4,  # priority 4-6
            }, headers=headers)
            results.check(f"Submit task {i}", r.status_code == 201, str(r.status_code))
            if r.ok:
                task_ids.append(r.json()["id"])

        # Wait for all tasks to complete
        info("Waiting for tasks to complete...")
        completed = 0
        failed_tasks = 0
        for tid in task_ids:
            try:
                t = wait_task(url, token, tid, ["completed", "failed"], timeout=60)
                if t["status"] == "completed":
                    completed += 1
                else:
                    failed_tasks += 1
            except RuntimeError as e:
                warn(str(e))
                failed_tasks += 1

        results.check(f"Tasks completed: {completed}/{len(task_ids)}", completed == len(task_ids),
                      f"{failed_tasks} failed")

        # --- Phase 5: SDK reporting task ---
        info("Testing SDK-integrated task...")
        stub_id = stubs[0]["id"]
        fake_sdk = str(MOCKS_DIR / "fake_train_sdk.py")
        r = api("post", f"{url}/api/stubs/{stub_id}/tasks", json={
            "command": f"python3 {fake_sdk} 20",
            "env": {"ALCHEMY_SERVER": url, "ALCHEMY_SDK_PATH": str(SDK_DIR)},
        }, headers=headers)
        if r.ok:
            sdk_task_id = r.json()["id"]
            sdk_task = wait_task(url, token, sdk_task_id, ["completed", "failed"], timeout=30)
            results.check("SDK task completed", sdk_task["status"] == "completed")
            has_progress = sdk_task.get("progress") and sdk_task["progress"].get("step", 0) > 0
            results.check("SDK task has progress data", has_progress,
                         f"progress: {sdk_task.get('progress')}")

        # --- Phase 6: Task failure + error classification ---
        info("Testing task failure handling...")
        fake_oom = str(MOCKS_DIR / "fake_train_oom.py")
        r = api("post", f"{url}/api/stubs/{stub_id}/tasks", json={
            "command": f"python3 {fake_oom}",
        }, headers=headers)
        if r.ok:
            oom_id = r.json()["id"]
            oom_task = wait_task(url, token, oom_id, ["failed"], timeout=20)
            results.check("OOM task marked failed", oom_task["status"] == "failed")
            # Check logs contain OOM message
            r = api("get", f"{url}/api/stubs/{stub_id}/tasks/{oom_id}/logs", headers=headers)
            if r.ok:
                log_text = "\n".join(r.json().get("lines", []))
                results.check("OOM log captured", "OutOfMemoryError" in log_text or "out of memory" in log_text.lower(),
                             f"log: {log_text[:200]}")

        # --- Phase 7: Task kill ---
        info("Testing task kill...")
        fake_slow = str(MOCKS_DIR / "fake_train_slow.py")
        r = api("post", f"{url}/api/stubs/{stub_id}/tasks", json={
            "command": f"python3 {fake_slow} 120",
        }, headers=headers)
        if r.ok:
            slow_id = r.json()["id"]
            time.sleep(2)  # let it start
            r = api("patch", f"{url}/api/stubs/{stub_id}/tasks/{slow_id}",
                    json={"action": "kill"}, headers=headers)
            results.check("Kill request accepted", r.ok)
            killed = wait_task(url, token, slow_id, ["killed", "failed"], timeout=20)
            results.check("Task killed", killed["status"] in ("killed", "failed"))

        # --- Phase 8: should_stop API ---
        info("Testing should_stop...")
        r = api("post", f"{url}/api/stubs/{stub_id}/tasks", json={
            "command": f"python3 {fake_slow} 120",
        }, headers=headers)
        if r.ok:
            stop_id = r.json()["id"]
            time.sleep(1)
            r = api("post", f"{url}/api/stubs/{stub_id}/tasks/{stop_id}/stop", headers=headers)
            results.check("Stop request accepted", r.ok)
            # Verify the flag is set
            r = api("get", f"{url}/api/stubs/{stub_id}/tasks/{stop_id}", headers=headers)
            if r.ok:
                results.check("should_stop flag set", r.json().get("should_stop") == True)
            # Clean up
            api("patch", f"{url}/api/stubs/{stub_id}/tasks/{stop_id}",
                json={"action": "kill"}, headers=headers)

        # --- Phase 9: Grid search ---
        info("Testing grid search...")
        fake_train = str(MOCKS_DIR / "fake_train.py")
        r = api("post", f"{url}/api/grids", json={
            "name": "sim-grid-test",
            "command_template": f"python3 {fake_train} 3",
            "parameters": {"lr": [0.1, 0.01], "batch": [16, 32]},
        }, headers=headers)
        if r.ok:
            grid = r.json()
            grid_id = grid["id"]
            results.check("Grid created", True)
            results.check("Grid has 4 cells", len(grid.get("cells", [])) == 4,
                         f"got {len(grid.get('cells', []))}")
            # Wait for grid tasks
            time.sleep(15)
            r = api("get", f"{url}/api/grids/{grid_id}", headers=headers)
            if r.ok:
                grid = r.json()
                done = sum(1 for c in grid["cells"] if c.get("status") in ("completed", "failed"))
                results.check(f"Grid cells done: {done}/4", done >= 2, f"only {done} done")

        # --- Phase 10: Metrics ---
        info("Testing metrics endpoints...")
        r = api("get", f"{url}/api/stubs/{stub_id}/metrics?hours=1", headers=headers)
        results.check("Stub metrics endpoint works", r.ok)

        r = api("get", f"{url}/api/metrics/summary", headers=headers)
        results.check("Metrics summary endpoint works", r.ok)

        # --- Phase 11: Audit log ---
        info("Testing audit log...")
        r = api("get", f"{url}/api/audit?limit=50", headers=headers)
        results.check("Audit endpoint works", r.ok)
        if r.ok:
            entries = r.json()
            results.check("Audit has entries", len(entries) > 0, f"got {len(entries)}")

        # --- Phase 12: Alerts ---
        info("Testing alerts endpoint...")
        r = api("get", f"{url}/api/alerts", headers=headers)
        results.check("Alerts endpoint works", r.ok)

        # --- Phase 13: Purge offline ---
        info("Testing purge offline...")
        # Kill one stub
        stub_procs[0].kill()
        stub_procs[0].wait(timeout=5)
        time.sleep(5)  # wait for server to detect offline

        r = api("delete", f"{url}/api/stubs/offline", headers=headers)
        results.check("Purge offline works", r.ok)

        # --- Phase 14: Backup ---
        info("Testing backup...")
        r = api("post", f"{url}/api/admin/backup", headers=headers)
        results.check("Manual backup works", r.ok)
        if r.ok:
            r = api("get", f"{url}/api/admin/backups", headers=headers)
            results.check("List backups works", r.ok and len(r.json()) > 0)

        # --- Phase 15: Stall config ---
        info("Testing stall config...")
        r = api("get", f"{url}/api/config/stall", headers=headers)
        results.check("Get stall config", r.ok)

    except Exception as e:
        fail(f"Simulation error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        info("Cleaning up...")
        cleanup()

    return results.summary()


def main():
    parser = argparse.ArgumentParser(description="Alchemy v2 仿真环境")
    parser.add_argument("--stubs", type=int, default=3, help="Number of mock stubs")
    parser.add_argument("--tasks", type=int, default=10, help="Number of tasks to submit")
    parser.add_argument("--port", type=int, default=0, help="Server port (0=random)")
    args = parser.parse_args()

    log(f"Alchemy v2 Simulation — {args.stubs} stubs, {args.tasks} tasks", C.BOLD)
    log("="*50, C.BOLD)

    success = run_simulation(
        num_stubs=args.stubs,
        num_tasks=args.tasks,
        port=args.port,
    )

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
