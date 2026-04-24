"""
Smoke test: multi-stub chaos testing with fault injection.

Spawns N stubs, submits random tasks, injects faults (server restart,
stub crash/reconnect), and asserts all tasks reach terminal state
without zombies.

Regression targets:
- Server restart → stub reconnect → reliable messaging works
- Lost tasks auto-archive (don't block capacity)
- Stub reconnect preserves max_concurrent
"""
import os
import random
import subprocess
import time

import pytest
from conftest import (
    SERVER_DIR,
    STUB_DIR,
    SDK_DIR,
    MOCKS_DIR,
    get_free_port,
    wait_for_server,
    no_proxy_session,
)

SMOKE_TOKEN = "smoke-test-token"

TERMINAL_STATUSES = {"completed", "failed", "killed", "lost"}
ACTIVE_STATUSES = {"pending", "queued", "dispatched", "running", "paused"}


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _api_session():
    s = no_proxy_session()
    s.headers.update({"Authorization": f"Bearer {SMOKE_TOKEN}"})
    return s


_session = _api_session()


_stub_counter = 0


def start_stub(server_url: str, token: str, max_concurrent: int = 3, stub_id: str | None = None) -> subprocess.Popen:
    """Start a stub daemon with unique identity (via --default-cwd).
    Pass stub_id to reuse a previous stub's identity (for reconnect tests).
    """
    global _stub_counter
    if stub_id is None:
        _stub_counter += 1
        stub_id = f"{os.getpid()}_{_stub_counter}"
    # Each stub gets a unique default-cwd to produce a unique identity_hash.
    # Also ensures runs/ subdirectory is writable for preflight checks.
    unique_cwd = f"/tmp/smoke_stub_{stub_id}"
    os.makedirs(os.path.join(unique_cwd, "runs"), exist_ok=True)

    env = os.environ.copy()
    env["PYTHONPATH"] = str(STUB_DIR) + ":" + str(SDK_DIR) + ":" + env.get("PYTHONPATH", "")
    env["ALCHEMY_SERVER"] = server_url
    env["ALCHEMY_SDK_PATH"] = str(SDK_DIR)
    env["NO_PROXY"] = "*"
    env["no_proxy"] = "*"

    cmd = [
        "python3", "-m", "alchemy_stub",
        "--server", server_url,
        "--token", token,
        "--max-concurrent", str(max_concurrent),
        "--default-cwd", unique_cwd,
    ]
    return subprocess.Popen(
        cmd,
        cwd=str(STUB_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )


def start_server(port: int, state_file: str) -> subprocess.Popen:
    env = os.environ.copy()
    env["PORT"] = str(port)
    env["STATE_FILE"] = state_file
    env["ALCHEMY_TOKEN"] = SMOKE_TOKEN
    env["NO_PROXY"] = "*"
    env["no_proxy"] = "*"
    proc = subprocess.Popen(
        ["node_modules/.bin/tsx", "src/index.ts"],
        cwd=str(SERVER_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    return proc


def wait_for_n_stubs(server_url: str, n: int, timeout: float = 30.0) -> list[dict]:
    deadline = time.time() + timeout
    online = []
    while time.time() < deadline:
        try:
            r = _session.get(f"{server_url}/api/stubs", timeout=2)
            if r.ok:
                online = [s for s in r.json() if s["status"] == "online"]
                if len(online) >= n:
                    return online
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError(f"Only got {len(online)}/{n} stubs online in {timeout}s")


def get_all_tasks(server_url: str) -> list[dict]:
    tasks = []
    try:
        r = _session.get(f"{server_url}/api/tasks", timeout=5)
        if r.ok:
            tasks.extend(r.json())
    except Exception:
        pass
    return tasks


def find_task(server_url: str, task_id: str) -> dict | None:
    try:
        r = _session.get(f"{server_url}/api/tasks/{task_id}", timeout=5)
        if r.ok:
            return r.json()
    except (ConnectionError, Exception):
        pass
    return None


def wait_all_terminal(server_url: str, task_ids: list[str], timeout: float = 120.0) -> list[dict]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        results = []
        all_done = True
        for tid in task_ids:
            t = find_task(server_url, tid)
            if t is None:
                all_done = False
                continue
            results.append(t)
            if t["status"] not in TERMINAL_STATUSES:
                all_done = False
        if all_done and len(results) == len(task_ids):
            return results
        time.sleep(1.0)
    still_active = []
    for tid in task_ids:
        t = find_task(server_url, tid)
        if t and t["status"] not in TERMINAL_STATUSES:
            still_active.append(f"{tid[:8]}={t['status']}")
    raise RuntimeError(f"Tasks not terminal after {timeout}s: {still_active}")


_task_counter = 0


def submit_task(server_url: str, command: str, stub_id: str | None = None, retries: int = 5) -> dict:
    global _task_counter
    _task_counter += 1
    payload = {"script": command, "raw_args": f"smoke_uid_{os.getpid()}_{_task_counter}"}
    url = f"{server_url}/api/stubs/{stub_id}/tasks" if stub_id else f"{server_url}/api/tasks"
    last_err = None
    for attempt in range(retries):
        try:
            r = _session.post(url, json=payload, timeout=5)
            assert r.status_code == 201, f"Submit failed: {r.status_code} {r.text}"
            return r.json()
        except Exception as e:
            last_err = e
            time.sleep(2)
    raise last_err  # type: ignore


# ─── Shared fixture setup ────────────────────────────────────────────────────

class SmokeBase:
    """Base class with server lifecycle management."""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.port = get_free_port()
        self.state_file = f"/tmp/alchemy_smoke_{self.port}.json"
        self.server_url = f"http://localhost:{self.port}"
        self.procs: list[subprocess.Popen] = []

        self.server_proc = start_server(self.port, self.state_file)
        self.procs.append(self.server_proc)
        wait_for_server(self.server_url)

        # Use the default token created by ALCHEMY_TOKEN env var
        self.token = SMOKE_TOKEN

        yield

        for p in self.procs:
            try:
                p.kill()
                p.wait(timeout=5)
            except Exception:
                pass
        try:
            os.unlink(self.state_file)
        except FileNotFoundError:
            pass

    def _start_stubs(self, n: int, max_concurrent: int = 2) -> list[dict]:
        for _ in range(n):
            proc = start_stub(self.server_url, self.token, max_concurrent=max_concurrent)
            self.procs.append(proc)
        return wait_for_n_stubs(self.server_url, n)

    def _restart_server(self):
        """Kill and restart the server, preserving state file."""
        # Force save state before killing
        try:
            _session.post(f"{self.server_url}/api/admin/backup", timeout=3)
        except Exception:
            pass
        self.server_proc.terminate()
        try:
            self.server_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.server_proc.kill()
            self.server_proc.wait(timeout=5)
        self.procs.remove(self.server_proc)
        # Wait for port to be released
        time.sleep(3)
        self.server_proc = start_server(self.port, self.state_file)
        self.procs.append(self.server_proc)
        wait_for_server(self.server_url, timeout=20)


# ─── Tests ────────────────────────────────────────────────────────────────────

class TestSmokeMultiStub(SmokeBase):
    """Multi-stub random task submission — no faults."""

    def test_multi_stub_random_tasks(self):
        """3 stubs, 10 random tasks, all should complete."""
        self._start_stubs(3, max_concurrent=2)
        fake_train = str(MOCKS_DIR / "fake_train.py")

        task_ids = []
        for _ in range(10):
            steps = random.randint(2, 8)
            task = submit_task(self.server_url, f"python3 {fake_train} {steps}")
            task_ids.append(task["id"])

        results = wait_all_terminal(self.server_url, task_ids, timeout=60)
        completed = [t for t in results if t["status"] == "completed"]
        assert len(completed) == 10, f"Expected 10 completed, got {len(completed)}. Statuses: {[t['status'] for t in results]}"

    def test_no_zombie_tasks(self):
        """After all tasks finish, no tasks should remain in active status."""
        self._start_stubs(2, max_concurrent=3)
        fake_train = str(MOCKS_DIR / "fake_train.py")

        task_ids = []
        for _ in range(6):
            steps = random.randint(2, 5)
            task = submit_task(self.server_url, f"python3 {fake_train} {steps}")
            task_ids.append(task["id"])

        wait_all_terminal(self.server_url, task_ids, timeout=60)

        all_tasks = get_all_tasks(self.server_url)
        active = [t for t in all_tasks if t["status"] in ACTIVE_STATUSES]
        assert len(active) == 0, f"Zombie tasks: {[(t['id'][:8], t['status']) for t in active]}"


class TestSmokeFaultInjection(SmokeBase):
    """Fault injection: stub crash, server restart."""

    def test_stub_crash_and_reconnect(self):
        """Crash a stub mid-task, restart it, new tasks should complete."""
        fake_slow = str(MOCKS_DIR / "fake_train_slow.py")
        fake_train = str(MOCKS_DIR / "fake_train.py")

        proc = start_stub(self.server_url, self.token, max_concurrent=2)
        self.procs.append(proc)
        stubs = wait_for_n_stubs(self.server_url, 1)
        stub_id = stubs[0]["id"]

        t1 = submit_task(self.server_url, f"python3 {fake_slow} 10", stub_id)
        time.sleep(2)

        proc.kill()
        proc.wait(timeout=5)
        self.procs.remove(proc)
        time.sleep(5)

        proc2 = start_stub(self.server_url, self.token, max_concurrent=2)
        self.procs.append(proc2)
        wait_for_n_stubs(self.server_url, 1, timeout=15)

        t2 = submit_task(self.server_url, f"python3 {fake_train} 3")
        results = wait_all_terminal(self.server_url, [t2["id"]], timeout=30)
        assert results[0]["status"] == "completed"

        t1_final = find_task(self.server_url, t1["id"])
        assert t1_final is not None
        assert t1_final["status"] in TERMINAL_STATUSES

    def test_server_restart_tasks_complete(self):
        """
        Regression: server restart → stubs reconnect → reliable messaging works.
        Exact scenario from the 4/24 incident.
        """
        fake_train = str(MOCKS_DIR / "fake_train.py")

        for _ in range(2):
            proc = start_stub(self.server_url, self.token, max_concurrent=2)
            self.procs.append(proc)
        wait_for_n_stubs(self.server_url, 2)

        pre_tasks = []
        for _ in range(3):
            t = submit_task(self.server_url, f"python3 {fake_train} 3")
            pre_tasks.append(t["id"])
        wait_all_terminal(self.server_url, pre_tasks, timeout=30)

        time.sleep(2)

        # --- RESTART SERVER ---
        self._restart_server()

        wait_for_n_stubs(self.server_url, 2, timeout=30)
        # Wait for reliable messaging to re-establish after reconnect
        time.sleep(5)

        post_tasks = []
        for _ in range(4):
            steps = random.randint(2, 5)
            t = submit_task(self.server_url, f"python3 {fake_train} {steps}")
            post_tasks.append(t["id"])
            time.sleep(0.5)  # stagger submissions

        results = wait_all_terminal(self.server_url, post_tasks, timeout=90)
        completed = [t for t in results if t["status"] == "completed"]
        assert len(completed) == 4, f"Post-restart tasks failed: {[(t['id'][:8], t['status']) for t in results]}"

    def test_lost_tasks_dont_block_capacity(self):
        """
        Regression: lost tasks must not count against stub capacity.
        Previously lost was in _activeStatuses, blocking new dispatches.
        """
        fake_slow = str(MOCKS_DIR / "fake_train_slow.py")
        fake_train = str(MOCKS_DIR / "fake_train.py")

        proc = start_stub(self.server_url, self.token, max_concurrent=2)
        self.procs.append(proc)
        stubs = wait_for_n_stubs(self.server_url, 1)
        stub_id = stubs[0]["id"]

        t1 = submit_task(self.server_url, f"python3 {fake_slow} 30", stub_id)
        t2 = submit_task(self.server_url, f"python3 {fake_slow} 30", stub_id)
        time.sleep(2)

        proc.kill()
        proc.wait(timeout=5)
        self.procs.remove(proc)
        time.sleep(8)

        proc2 = start_stub(self.server_url, self.token, max_concurrent=2)
        self.procs.append(proc2)
        wait_for_n_stubs(self.server_url, 1, timeout=15)

        t3 = submit_task(self.server_url, f"python3 {fake_train} 3")
        t4 = submit_task(self.server_url, f"python3 {fake_train} 3")

        results = wait_all_terminal(self.server_url, [t3["id"], t4["id"]], timeout=30)
        completed = [t for t in results if t["status"] == "completed"]
        assert len(completed) == 2, f"Lost tasks blocked capacity: {[(t['id'][:8], t['status']) for t in results]}"

    def test_max_concurrent_preserved_after_reconnect(self):
        """
        Regression: stub's max_concurrent should be preserved after reconnect.
        Previously server locked it to the first-seen value.
        """
        # Use a fixed stub_id so reconnect uses the same identity
        fixed_id = f"mc_test_{os.getpid()}"
        proc = start_stub(self.server_url, self.token, max_concurrent=5, stub_id=fixed_id)
        self.procs.append(proc)
        stubs = wait_for_n_stubs(self.server_url, 1)
        stub_id = stubs[0]["id"]

        r = _session.get(f"{self.server_url}/api/stubs/{stub_id}", timeout=5)
        assert r.json()["max_concurrent"] == 5

        proc.kill()
        proc.wait(timeout=5)
        self.procs.remove(proc)
        time.sleep(2)

        proc2 = start_stub(self.server_url, self.token, max_concurrent=3, stub_id=fixed_id)
        self.procs.append(proc2)
        wait_for_n_stubs(self.server_url, 1, timeout=15)

        r = _session.get(f"{self.server_url}/api/stubs/{stub_id}", timeout=5)
        assert r.json()["max_concurrent"] == 3, f"max_concurrent not updated: {r.json()['max_concurrent']}"
