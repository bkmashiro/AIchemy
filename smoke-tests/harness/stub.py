"""TestStub — manages a real alchemy_stub process pointed at the test server."""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import tempfile
import time
from uuid import uuid4


class TestStub:
    """Start/stop a real alchemy_stub pointed at a test server."""

    def __init__(
        self,
        server_url: str,
        token: str,
        name: str,
        tags: list[str] | None = None,
        max_concurrent: int = 3,
        default_cwd: str | None = None,
    ):
        self.server_url = server_url
        self.token = token
        self.name = name
        self.tags = tags or []
        self.max_concurrent = max_concurrent
        self.proc: subprocess.Popen | None = None
        self._log_dir = tempfile.mkdtemp(prefix=f"alchemy_stub_{name}_")
        self._log_path = os.path.join(self._log_dir, "stub.log")
        self.default_cwd = default_cwd or self._log_dir
        self._stub_dir = os.environ.get(
            "ALCHEMY_TEST_STUB_DIR",
            os.path.join(os.path.dirname(__file__), "..", "..", "stub"),
        )
        self._stub_dir = os.path.abspath(self._stub_dir)

    def start(self) -> None:
        cmd = [
            sys.executable, "-m", "alchemy_stub",
            "--server", self.server_url,
            "--token", self.token,
            "--max-concurrent", str(self.max_concurrent),
            "--default-cwd", self.default_cwd,
            "--idle-timeout", "0",
        ]
        if self.tags:
            cmd.extend(["--tags", ",".join(self.tags)])

        env = {
            **os.environ,
            "PYTHONPATH": self._stub_dir,
            "ALCHEMY_LOG_DIR": self._log_dir,
            # Unique GPU indices per stub to avoid singleton lock collision
            "CUDA_VISIBLE_DEVICES": uuid4().hex[:8],
        }
        # Remove SLURM vars that would affect stub behavior
        for k in list(env):
            if k.startswith("SLURM_"):
                del env[k]

        log_fd = open(self._log_path, "w")
        self.proc = subprocess.Popen(
            cmd,
            cwd=self._stub_dir,
            env=env,
            stdout=log_fd,
            stderr=subprocess.STDOUT,
        )

    def stop(self) -> None:
        if self.proc is None or self.proc.poll() is not None:
            return
        self.proc.send_signal(signal.SIGTERM)
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)

    def wait_online(self, api_client, timeout: float = 30.0) -> None:
        """Poll GET /api/stubs until this stub appears with status=online."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                stubs = api_client.list_stubs()
                for s in stubs:
                    if s.get("status") == "online":
                        # Match by hostname or tags — our stubs use unique CUDA_VISIBLE_DEVICES
                        # Best match: check if default_cwd matches
                        if s.get("default_cwd") == self.default_cwd:
                            self.stub_id = s["id"]
                            return
            except Exception:
                pass
            # Check process hasn't died
            if self.proc and self.proc.poll() is not None:
                raise RuntimeError(
                    f"Stub '{self.name}' exited with code {self.proc.returncode}. "
                    f"Check logs: {self._log_path}"
                )
            time.sleep(1.0)
        raise TimeoutError(
            f"Stub '{self.name}' did not come online within {timeout}s. "
            f"Check logs: {self._log_path}"
        )

    @property
    def log_path(self) -> str:
        return self._log_path
