"""TestServer — manages an isolated alchemy-v2 server process."""
from __future__ import annotations

import os
import signal
import subprocess
import tempfile
import time
from uuid import uuid4

import httpx


class TestServer:
    """Start/stop a real alchemy-v2 server on a dedicated port with isolated state."""

    def __init__(
        self,
        port: int | None = None,
        server_dir: str | None = None,
    ):
        self.port = port or int(os.environ.get("ALCHEMY_TEST_PORT", "13002"))
        self.server_dir = server_dir or os.environ.get(
            "ALCHEMY_TEST_SERVER_DIR",
            os.path.join(os.path.dirname(__file__), "..", "..", "server"),
        )
        self.server_dir = os.path.abspath(self.server_dir)
        self.state_dir = tempfile.mkdtemp(prefix="alchemy_test_")
        self.state_file = os.path.join(self.state_dir, "state.json")
        self.token = f"test-token-{uuid4().hex[:8]}"
        self.proc: subprocess.Popen | None = None
        self._log_path = os.path.join(self.state_dir, "server.log")

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self, timeout: float = 30.0) -> None:
        env = {
            **os.environ,
            "PORT": str(self.port),
            "STATE_FILE": self.state_file,
            "ALCHEMY_TOKEN": self.token,
            "NODE_ENV": "test",
            # Disable Discord notifications in test
            "DISCORD_WEBHOOK_URL": "",
        }
        log_fd = open(self._log_path, "w")
        self.proc = subprocess.Popen(
            ["npx", "tsx", "src/index.ts"],
            cwd=self.server_dir,
            env=env,
            stdout=log_fd,
            stderr=subprocess.STDOUT,
        )
        self._wait_healthy(timeout)

    def _wait_healthy(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        url = f"{self.url}/api/health"
        while time.monotonic() < deadline:
            try:
                r = httpx.get(url, timeout=2.0)
                if r.status_code == 200:
                    return
            except (httpx.ConnectError, httpx.ReadError, httpx.TimeoutException):
                pass
            # Check process hasn't died
            if self.proc and self.proc.poll() is not None:
                raise RuntimeError(
                    f"Server exited with code {self.proc.returncode}. "
                    f"Check logs: {self._log_path}"
                )
            time.sleep(0.5)
        raise TimeoutError(
            f"Server did not become healthy within {timeout}s. "
            f"Check logs: {self._log_path}"
        )

    def stop(self) -> None:
        if self.proc is None or self.proc.poll() is not None:
            return
        self.proc.send_signal(signal.SIGTERM)
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)

    @property
    def log_path(self) -> str:
        return self._log_path
