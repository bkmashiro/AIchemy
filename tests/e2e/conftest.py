"""Pytest fixtures for E2E tests."""
import os
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Generator

import pytest
import requests

# Paths
PROJECT_ROOT = Path(__file__).parent.parent.parent
SERVER_DIR = PROJECT_ROOT / "server"
STUB_DIR = PROJECT_ROOT / "stub"
SDK_DIR = PROJECT_ROOT / "sdk"
MOCKS_DIR = PROJECT_ROOT / "tests" / "mocks"


def get_free_port() -> int:
    with socket.socket() as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def no_proxy_session():
    """Create a requests session that bypasses proxy."""
    s = requests.Session()
    s.trust_env = False
    return s


_session = no_proxy_session()


def wait_for_server(url: str, timeout: float = 15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = _session.get(f"{url}/health", timeout=1)
            if r.ok:
                return
        except Exception:
            pass
        time.sleep(0.2)
    raise RuntimeError(f"Server at {url} did not start in {timeout}s")


@pytest.fixture(scope="session")
def server_process():
    """Start the Alchemy server on a random port."""
    port = get_free_port()
    state_file = f"/tmp/alchemy_test_state_{port}.json"

    env = os.environ.copy()
    env["PORT"] = str(port)
    env["STATE_FILE"] = state_file
    env["NO_PROXY"] = "*"
    env["no_proxy"] = "*"

    # Use tsx to run TS directly
    proc = subprocess.Popen(
        ["node_modules/.bin/tsx", "src/index.ts"],
        cwd=str(SERVER_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    url = f"http://localhost:{port}"
    try:
        wait_for_server(url)
    except RuntimeError:
        out = proc.stdout.read() if proc.stdout else ""
        proc.kill()
        raise RuntimeError(f"Server failed to start. Output:\n{out}")

    yield {"url": url, "port": port, "process": proc}

    proc.kill()
    proc.wait()
    try:
        os.unlink(state_file)
    except FileNotFoundError:
        pass


@pytest.fixture(scope="session")
def server_url(server_process):
    return server_process["url"]


@pytest.fixture(scope="function")
def api_token(server_url):
    """Create a unique token per test function to ensure stub isolation."""
    r = _session.post(f"{server_url}/api/tokens", json={"label": "test"})
    assert r.status_code == 201
    return r.json()["token"]


def api_get(url: str, **kwargs):
    return _session.get(url, **kwargs)


def api_post(url: str, **kwargs):
    return _session.post(url, **kwargs)


def api_patch(url: str, **kwargs):
    return _session.patch(url, **kwargs)


def start_stub(server_url: str, token: str, max_concurrent: int = 3, idle_timeout: int = 0, extra_args: list[str] | None = None) -> subprocess.Popen:
    """Start a stub daemon process."""
    env = os.environ.copy()
    env["PYTHONPATH"] = str(STUB_DIR) + ":" + str(SDK_DIR) + ":" + env.get("PYTHONPATH", "")
    env["ALCHEMY_SERVER"] = server_url
    env["ALCHEMY_SDK_PATH"] = str(SDK_DIR)

    cmd = [
        sys.executable, "-m", "alchemy_stub",
        "--server", server_url,
        "--token", token,
        "--max-concurrent", str(max_concurrent),
        "--idle-timeout", str(idle_timeout),
        "--pid-file", f"/tmp/alchemy_stub_test_{uuid.uuid4().hex[:8]}.json",
    ]
    if extra_args:
        cmd.extend(extra_args)

    proc = subprocess.Popen(
        cmd,
        cwd=str(STUB_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    return proc


def wait_for_stub(server_url: str, timeout: float = 15.0) -> dict:
    """Wait for a stub to appear as online in the API."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = _session.get(f"{server_url}/api/stubs", timeout=2)
            if r.ok:
                stubs = r.json()
                online = [s for s in stubs if s["status"] == "online"]
                if online:
                    return online[-1]
        except Exception:
            pass
        time.sleep(0.3)
    raise RuntimeError(f"No stub came online in {timeout}s")


def wait_for_task_status(server_url: str, stub_id: str, task_id: str, statuses: list[str], timeout: float = 30.0) -> dict:
    """Wait for a task to reach one of the given statuses."""
    deadline = time.time() + timeout
    last_task: dict = {}
    while time.time() < deadline:
        try:
            r = _session.get(f"{server_url}/api/stubs/{stub_id}/tasks/{task_id}", timeout=2)
            if r.ok:
                last_task = r.json()
                if last_task["status"] in statuses:
                    return last_task
        except Exception:
            pass
        time.sleep(0.3)
    raise RuntimeError(f"Task {task_id} did not reach status {statuses} in {timeout}s. Last status: {last_task.get('status', 'unknown')}")


@pytest.fixture
def stub_proc(server_url, api_token):
    """Start a stub daemon, yield its process, kill on teardown."""
    proc = start_stub(server_url, api_token)
    stub = wait_for_stub(server_url)
    yield {"process": proc, "stub": stub}
    proc.kill()
    proc.wait(timeout=5)
