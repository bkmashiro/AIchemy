"""Entry point: python -m alchemy_stub

Startup sequence:
  1. Parse args → Config
  2. Setup structured JSON logging to stderr
  3. os.umask(0o002)
  4. Acquire singleton flock
  5. Self-check (Python version, /tmp writable, GPU access, server reachable)
  6. Run daemon with top-level restart loop
  7. SIGUSR1 → graceful drain, then exit (outer loop restarts)
"""
from __future__ import annotations

import asyncio
import fcntl
import logging
import os
import signal
import subprocess
import sys
import time

import aiohttp

from .config import parse_args
from .daemon import StubDaemon
from .log_setup import jlog, setup_logging

# ------------------------------------------------------------------ #
# Singleton lock                                                       #
# ------------------------------------------------------------------ #

_lock_fd = None  # kept open for process lifetime


def _acquire_singleton_lock(identity_hash: str) -> None:
    global _lock_fd
    lock_path = f"/tmp/alchemy_stub_{identity_hash}.lock"
    try:
        _lock_fd = open(lock_path, "w")
        fcntl.flock(_lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _lock_fd.write(f"{os.getpid()}\n")
        _lock_fd.flush()
        jlog("info", "stub.flock", lock_path=lock_path, pid=os.getpid())
    except BlockingIOError:
        jlog("error", "stub.flock", error="already_running", identity_hash=identity_hash)
        sys.exit(
            f"Another stub is already running with this identity (hash={identity_hash}). "
            f"Lock file: {lock_path}"
        )


# ------------------------------------------------------------------ #
# Self-check                                                           #
# ------------------------------------------------------------------ #

def _check_python_version() -> None:
    vi = sys.version_info
    if vi < (3, 10):
        jlog("error", "stub.self_check", check="python_version",
             got=f"{vi.major}.{vi.minor}", required=">=3.10")
        sys.exit(f"Python >= 3.10 required, got {vi.major}.{vi.minor}")


def _check_tmp_writable() -> None:
    test_path = f"/tmp/alchemy_write_test_{os.getpid()}"
    try:
        with open(test_path, "w") as f:
            f.write("ok")
        os.unlink(test_path)
    except OSError as e:
        jlog("error", "stub.self_check", check="tmp_writable", error=str(e))
        sys.exit(f"Self-check failed: /tmp not writable: {e}")


def _check_gpu_access() -> None:
    """Run nvidia-smi to verify GPU access. Non-fatal if not available (CPU-only mode)."""
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            gpus = [l.strip() for l in result.stdout.strip().splitlines() if l.strip()]
            jlog("info", "stub.self_check", check="gpu_access", gpus=gpus)
        else:
            jlog("warn", "stub.self_check", check="gpu_access",
                 detail="nvidia-smi returned non-zero; continuing in CPU-only mode")
    except FileNotFoundError:
        jlog("warn", "stub.self_check", check="gpu_access",
             detail="nvidia-smi not found; continuing in CPU-only mode")
    except subprocess.TimeoutExpired:
        jlog("warn", "stub.self_check", check="gpu_access", detail="nvidia-smi timed out")


async def _check_server_reachable(server_url: str) -> None:
    http_url = server_url.replace("wss://", "https://").replace("ws://", "http://")
    health_url = http_url.rstrip("/") + "/api/health"
    try:
        timeout = aiohttp.ClientTimeout(total=10)
        headers = {"Accept-Encoding": "identity"}  # Avoid brotli from CF tunnel
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(health_url, headers=headers) as resp:
                # 200/204 = healthy; 404 = server up but no /health endpoint
                if resp.status in (200, 204, 404):
                    jlog("info", "stub.self_check", check="server_reachable",
                         url=health_url, status=resp.status)
                else:
                    jlog("warn", "stub.self_check", check="server_reachable",
                         url=health_url, status=resp.status)
    except Exception as e:
        jlog("error", "stub.self_check", check="server_reachable",
             url=health_url, error=str(e))
        sys.exit(f"Self-check failed: Cannot reach server at {health_url}: {e}")


async def _run_self_check(server_url: str) -> None:
    _check_python_version()
    _check_tmp_writable()
    _check_gpu_access()
    await _check_server_reachable(server_url)
    jlog("info", "stub.self_check", result="passed")


# ------------------------------------------------------------------ #
# SIGUSR1 handling                                                     #
# ------------------------------------------------------------------ #

class _GracefulDrain(Exception):
    """Raised by SIGUSR1 to trigger graceful drain."""


_daemon_instance: StubDaemon | None = None


def _sigusr1_handler(signum, frame):
    jlog("info", "stub.stop", reason="SIGUSR1")
    raise _GracefulDrain()


# ------------------------------------------------------------------ #
# Main                                                                 #
# ------------------------------------------------------------------ #

log = logging.getLogger("alchemy_stub")


def main() -> None:
    config = parse_args()

    # Structured JSON logging to stderr
    setup_logging()

    # Group-writable output files
    os.umask(0o002)

    # Singleton lock
    _acquire_singleton_lock(config.identity_hash)

    # Self-check (async)
    asyncio.run(_run_self_check(config.server))

    jlog(
        "info", "stub.start",
        server=config.server,
        hostname=config.hostname,
        identity=config.identity_hash,
        stub_type=config.stub_type,
        tags=config.tags,
        max_concurrent=config.max_concurrent,
        idle_timeout=config.idle_timeout,
        slurm_job_id=config.slurm_job_id,
    )

    signal.signal(signal.SIGUSR1, _sigusr1_handler)

    while True:
        global _daemon_instance
        _daemon_instance = StubDaemon(config)
        try:
            asyncio.run(_daemon_instance.run())
        except KeyboardInterrupt:
            jlog("info", "stub.stop", reason="keyboard_interrupt")
            sys.exit(0)
        except _GracefulDrain:
            jlog("info", "stub.stop", reason="SIGUSR1_drain")
            try:
                asyncio.run(_daemon_instance.graceful_drain(timeout=300))
            except Exception as e:
                log.warning("Drain error: %s", e)
            sys.exit(0)
        except SystemExit:
            raise
        except Exception as e:
            jlog("error", "stub.crash", error=str(e), restart_in_s=5)
            time.sleep(5)


if __name__ == "__main__":
    main()
