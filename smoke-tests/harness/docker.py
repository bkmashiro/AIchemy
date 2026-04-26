"""Docker container helpers for heterogeneous stub tests.

Uses subprocess calls to `docker compose` — no docker SDK dependency.
"""
from __future__ import annotations

import logging
import os
import subprocess
import time
from typing import Any

log = logging.getLogger(__name__)

# Path to docker-compose.test.yml relative to this file
_COMPOSE_FILE = os.path.join(
    os.path.dirname(__file__), "..", "docker", "docker-compose.test.yml"
)
_COMPOSE_FILE = os.path.abspath(_COMPOSE_FILE)

# Build context is alchemy-v2 root
_PROJECT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _run(
    args: list[str],
    timeout: float = 120,
    check: bool = True,
    capture: bool = True,
) -> subprocess.CompletedProcess:
    """Run a docker compose command."""
    cmd = [
        "docker", "compose",
        "-f", _COMPOSE_FILE,
        "-p", "alchemy-smoke-test",
    ] + args
    log.debug("docker cmd: %s", " ".join(cmd))
    return subprocess.run(
        cmd,
        cwd=_PROJECT_DIR,
        capture_output=capture,
        text=True,
        timeout=timeout,
        check=check,
    )


class DockerComposeEnv:
    """Manage Docker Compose services for heterogeneous tests."""

    def __init__(self) -> None:
        self._up = False

    def build(self, services: list[str] | None = None, timeout: float = 300) -> None:
        """Build Docker images."""
        args = ["build"]
        if services:
            args.extend(services)
        _run(args, timeout=timeout)

    def up(
        self,
        services: list[str] | None = None,
        timeout: float = 120,
        wait: bool = True,
    ) -> None:
        """Start services in detached mode."""
        args = ["up", "-d"]
        if wait:
            args.append("--wait")
        if services:
            args.extend(services)
        _run(args, timeout=timeout)
        self._up = True

    def down(self, timeout: float = 30) -> None:
        """Stop and remove all services."""
        if not self._up:
            return
        try:
            _run(["down", "--volumes", "--remove-orphans", "-t", "5"], timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            log.warning("docker compose down timed out")
        self._up = False

    def stop_service(self, service: str, timeout: float = 15) -> None:
        """Stop a single service."""
        _run(["stop", "-t", "3", service], timeout=timeout, check=False)

    def start_service(self, service: str, timeout: float = 30) -> None:
        """Start a single service."""
        _run(["start", service], timeout=timeout)

    def restart_service(self, service: str, timeout: float = 30) -> None:
        """Restart a single service."""
        _run(["restart", "-t", "3", service], timeout=timeout)

    def logs(self, service: str, tail: int = 100) -> str:
        """Get logs from a service."""
        r = _run(["logs", "--tail", str(tail), service], check=False)
        return r.stdout or ""

    def exec_in(
        self,
        service: str,
        command: list[str],
        timeout: float = 30,
        check: bool = True,
    ) -> subprocess.CompletedProcess:
        """Execute a command in a running container."""
        args = ["exec", "-T", service] + command
        return _run(args, timeout=timeout, check=check)

    def is_running(self, service: str) -> bool:
        """Check if a service container is running."""
        r = _run(
            ["ps", "--filter", f"name={service}", "--format", "json"],
            check=False,
        )
        return "running" in (r.stdout or "").lower()

    def wait_service_exit(self, service: str, timeout: float = 30) -> int | None:
        """Wait for a service to exit and return its exit code."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            r = _run(
                ["ps", "-a", "--filter", f"name={service}", "--format", "{{.State}} {{.ExitCode}}"],
                check=False,
            )
            output = (r.stdout or "").strip()
            if "exited" in output.lower():
                # Parse exit code from output
                parts = output.split()
                for p in parts:
                    if p.isdigit():
                        return int(p)
                return None
            time.sleep(1.0)
        return None

    def wait_healthy(self, service: str, timeout: float = 60) -> bool:
        """Wait for a service to become healthy."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            r = _run(
                ["ps", "--filter", f"name={service}", "--format", "{{.Status}}"],
                check=False,
            )
            status = (r.stdout or "").strip().lower()
            if "healthy" in status:
                return True
            time.sleep(2.0)
        return False

    def container_count(self, filter_name: str = "") -> int:
        """Count running containers, optionally filtered by name substring."""
        r = _run(["ps", "--format", "{{.Name}}"], check=False)
        if not r.stdout:
            return 0
        names = [n.strip() for n in r.stdout.strip().splitlines() if n.strip()]
        if filter_name:
            names = [n for n in names if filter_name in n]
        return len(names)
