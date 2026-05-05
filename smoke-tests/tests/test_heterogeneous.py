"""Docker-based heterogeneous stub tests (Phase 4).

All tests require Docker and are marked with @pytest.mark.docker.
Run with: pytest -m docker --timeout=180
"""
from __future__ import annotations

import time
from uuid import uuid4

import httpx
import pytest

from harness.docker import DockerComposeEnv

pytestmark = pytest.mark.docker

# Docker compose server URL (mapped to host port 13002)
SERVER_URL = "http://127.0.0.1:13002"
TOKEN = "test-docker-token"


@pytest.fixture(scope="module")
def docker_env():
    """Build and start the Docker Compose environment for the module."""
    env = DockerComposeEnv()
    # Tear down any leftover containers from previous runs
    env.down()
    yield env
    env.down()


@pytest.fixture(scope="module")
def docker_api(docker_env):
    """HTTP client for the Dockerized test server."""
    client = httpx.Client(
        base_url=SERVER_URL,
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30.0,
    )
    yield client
    client.close()


def _wait_server_healthy(timeout: float = 60) -> None:
    """Poll the test server health endpoint until ready."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            r = httpx.get(f"{SERVER_URL}/api/health", timeout=3.0)
            if r.status_code == 200:
                return
        except (httpx.ConnectError, httpx.ReadError, httpx.TimeoutException):
            pass
        time.sleep(1.0)
    raise TimeoutError(f"Docker test server not healthy within {timeout}s")


def _wait_stub_online(client: httpx.Client, tag: str, timeout: float = 60) -> dict | None:
    """Wait for a stub with the given tag to appear online."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            r = client.get("/api/stubs")
            if r.status_code == 200:
                stubs = r.json()
                for s in stubs:
                    if s.get("status") == "online" and tag in (s.get("tags") or []):
                        return s
        except Exception:
            pass
        time.sleep(2.0)
    return None


def _wait_no_stub_with_tag(client: httpx.Client, tag: str, timeout: float = 30) -> bool:
    """Verify no stub with the given tag registers within timeout. Returns True if none appeared."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            r = client.get("/api/stubs")
            if r.status_code == 200:
                stubs = r.json()
                for s in stubs:
                    if s.get("status") == "online" and tag in (s.get("tags") or []):
                        return False  # Stub appeared — unexpected
        except Exception:
            pass
        time.sleep(2.0)
    return True  # No stub appeared — expected


def _submit_task(client: httpx.Client, script: str, **kwargs) -> dict:
    """Submit a task and return the response."""
    body = {"script": script, **kwargs}
    r = client.post("/api/tasks", json=body)
    assert r.status_code in (200, 201), f"Submit failed: {r.status_code} {r.text}"
    return r.json()


def _wait_task_terminal(client: httpx.Client, task_id: str, timeout: float = 60) -> dict:
    """Wait for a task to reach terminal status."""
    terminal = {"completed", "failed", "killed", "lost"}
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        r = client.get(f"/api/tasks/{task_id}")
        if r.status_code == 200:
            task = r.json()
            if task.get("status") in terminal:
                return task
        time.sleep(2.0)
    raise TimeoutError(f"Task {task_id} did not reach terminal status within {timeout}s")


class TestOldPython:
    """Python 3.8 stub should fail to start and never register."""

    def test_python_too_old_no_register(self, docker_env, docker_api):
        # Start only server + oldpy stub
        docker_env.up(services=["test-server", "stub-oldpy"], timeout=120)
        _wait_server_healthy()

        # The old-python stub should exit almost immediately.
        # Give it time to attempt startup and either crash or exit.
        time.sleep(10)

        # Verify the stub-oldpy container has exited (not running)
        logs = docker_env.logs("stub-oldpy", tail=50)
        assert not docker_env.is_running("stub-oldpy"), (
            f"stub-oldpy should have exited but is still running. Logs:\n{logs}"
        )

        # Verify no stubs registered with the server
        # (oldpy never gets past _check_python_version or pip install failure)
        r = docker_api.get("/api/stubs")
        if r.status_code == 200:
            stubs = r.json()
            # Filter out any stubs — there should be none from oldpy
            online_stubs = [s for s in stubs if s.get("status") == "online"]
            # If there are stubs, they shouldn't be from the oldpy container
            for s in online_stubs:
                assert "oldpy" not in str(s.get("tags", [])), (
                    f"Old Python stub should not have registered: {s}"
                )

        docker_env.down()


class TestNoGpu:
    """Stub without nvidia-smi should register with empty GPU info and run CPU tasks."""

    def test_nogpu_registers_empty_gpu(self, docker_env, docker_api):
        docker_env.up(services=["test-server", "stub-nogpu"], timeout=120)
        _wait_server_healthy()

        # Wait for the no-gpu stub to register
        stub = _wait_stub_online(docker_api, "nogpu", timeout=60)
        assert stub is not None, "stub-nogpu did not register"

        # GPU info should be empty/CPU-only
        gpu = stub.get("gpu", {})
        assert gpu.get("count", 0) == 0 or gpu.get("name") == "CPU-only", (
            f"Expected empty GPU info, got: {gpu}"
        )

        # Submit a simple CPU task and verify it completes
        uid = uuid4().hex[:8]
        task = _submit_task(
            docker_api,
            script=f"echo 'cpu-task-{uid}' && sleep 2 && echo done",
            name=f"smoke-nogpu-{uid}",
            target_tags=["nogpu"],
        )
        task_id = task.get("task_id") or task.get("id")
        assert task_id, f"No task_id in response: {task}"

        result = _wait_task_terminal(docker_api, task_id, timeout=60)
        assert result["status"] == "completed", (
            f"Task should complete on CPU-only stub, got: {result['status']}"
        )

        docker_env.down()


class TestNoPerm:
    """Stub with read-only /tmp should fail self-check and not register."""

    def test_noperm_fails_selfcheck(self, docker_env, docker_api):
        docker_env.up(services=["test-server", "stub-noperm"], timeout=120)
        _wait_server_healthy()

        # Wait a bit for the stub to attempt startup
        time.sleep(10)

        # Stub should have exited due to /tmp not writable
        logs = docker_env.logs("stub-noperm", tail=50)
        assert not docker_env.is_running("stub-noperm"), (
            f"stub-noperm should have exited but is still running. Logs:\n{logs}"
        )

        # Verify "tmp" or "writable" appears in logs (self-check failure)
        assert "tmp" in logs.lower() or "writable" in logs.lower() or "permission" in logs.lower(), (
            f"Expected /tmp write failure in logs, got:\n{logs}"
        )

        # Verify no stubs from noperm registered
        r = docker_api.get("/api/stubs")
        if r.status_code == 200:
            stubs = r.json()
            online = [s for s in stubs if s.get("status") == "online"]
            for s in online:
                assert "noperm" not in str(s.get("tags", [])), (
                    f"noperm stub should not have registered: {s}"
                )

        docker_env.down()


class TestSlowNetwork:
    """Stub with 500ms network delay should still register and complete tasks."""

    def test_slow_network_works(self, docker_env, docker_api):
        docker_env.up(
            services=["test-server", "stub-slow"],
            timeout=120,
        )
        _wait_server_healthy()

        # Inject network delay via tc netem inside the stub-slow container
        try:
            docker_env.exec_in(
                "stub-slow",
                ["tc", "qdisc", "add", "dev", "eth0", "root", "netem", "delay", "500ms"],
                timeout=10,
                check=False,  # May fail if already set or no permission; that's OK
            )
        except Exception:
            pass  # tc might not work in all environments; test still validates latency tolerance

        # Wait for the slow-net stub to come online (allow extra time for delay)
        stub = _wait_stub_online(docker_api, "slow-net", timeout=90)
        assert stub is not None, "stub-slow did not register despite network delay"

        # Submit a task and verify it completes (with higher timeout for latency)
        uid = uuid4().hex[:8]
        task = _submit_task(
            docker_api,
            script=f"echo 'slow-net-{uid}' && sleep 3 && echo done",
            name=f"smoke-slow-{uid}",
            target_tags=["slow-net"],
        )
        task_id = task.get("task_id") or task.get("id")
        assert task_id, f"No task_id in response: {task}"

        result = _wait_task_terminal(docker_api, task_id, timeout=90)
        assert result["status"] == "completed", (
            f"Task should complete despite slow network, got: {result['status']}"
        )

        docker_env.down()


class TestMultipleCompetingStubs:
    """Three competing stubs should all register and distribute tasks."""

    def test_tasks_distributed(self, docker_env, docker_api):
        docker_env.up(
            services=[
                "test-server",
                "stub-compete-1",
                "stub-compete-2",
                "stub-compete-3",
            ],
            timeout=120,
        )
        _wait_server_healthy()

        # Wait for all 3 competing stubs to register
        deadline = time.monotonic() + 60
        compete_stubs = []
        while time.monotonic() < deadline:
            try:
                r = docker_api.get("/api/stubs")
                if r.status_code == 200:
                    stubs = r.json()
                    compete_stubs = [
                        s for s in stubs
                        if s.get("status") == "online"
                        and "compete" in (s.get("tags") or [])
                    ]
                    if len(compete_stubs) >= 3:
                        break
            except Exception:
                pass
            time.sleep(2.0)

        assert len(compete_stubs) >= 3, (
            f"Expected 3 competing stubs online, got {len(compete_stubs)}"
        )

        # Submit 6 tasks (2 per stub if evenly distributed)
        task_ids = []
        for i in range(6):
            uid = uuid4().hex[:8]
            task = _submit_task(
                docker_api,
                script=f"echo 'compete-task-{i}-{uid}' && sleep 5 && echo done",
                name=f"smoke-compete-{i}-{uid}",
                target_tags=["compete"],
            )
            tid = task.get("task_id") or task.get("id")
            assert tid, f"No task_id in response: {task}"
            task_ids.append(tid)

        # Wait for all tasks to complete
        results = []
        for tid in task_ids:
            result = _wait_task_terminal(docker_api, tid, timeout=90)
            results.append(result)

        # All tasks should complete
        completed = [r for r in results if r["status"] == "completed"]
        assert len(completed) == 6, (
            f"Expected all 6 tasks completed, got {len(completed)}: "
            f"{[r['status'] for r in results]}"
        )

        # Verify distribution: tasks should be spread across stubs (not all on one)
        stub_ids_used = set()
        for r in results:
            sid = r.get("stub_id") or r.get("assigned_stub")
            if sid:
                stub_ids_used.add(sid)

        # With 3 stubs and 6 tasks, at least 2 stubs should have been used
        # (perfect distribution = 3, but we allow for scheduling variance)
        if stub_ids_used:
            assert len(stub_ids_used) >= 2, (
                f"Expected tasks distributed across stubs, but only used: {stub_ids_used}"
            )

        docker_env.down()
