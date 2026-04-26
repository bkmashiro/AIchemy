"""Pre-execution checks before spawning a task subprocess.

Implements spec §2 disk flag decision tree and §9 stub preflight checks.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
from typing import Any

import aiohttp

log = logging.getLogger(__name__)

_OWNER_FILENAME = ".alchemy_owner"


# ------------------------------------------------------------------ #
# Result type                                                          #
# ------------------------------------------------------------------ #

class PreflightResult:
    """Encapsulates preflight outcome."""

    def __init__(self, ok: bool, errors: list[str] | None = None) -> None:
        self.ok = ok
        self.errors: list[str] = errors or []

    @classmethod
    def success(cls) -> "PreflightResult":
        return cls(ok=True)

    @classmethod
    def fail(cls, *reasons: str) -> "PreflightResult":
        return cls(ok=False, errors=list(reasons))


# ------------------------------------------------------------------ #
# Flag helpers                                                         #
# ------------------------------------------------------------------ #

def _flag_path(run_dir: str) -> str:
    return os.path.join(run_dir, _OWNER_FILENAME)


def _read_flag(run_dir: str) -> dict[str, Any] | None:
    try:
        with open(_flag_path(run_dir)) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _write_flag_atomic(run_dir: str, stub_id: str, task_id: str, fingerprint: str) -> None:
    """Write .alchemy_owner atomically (tmp + rename)."""
    os.makedirs(run_dir, exist_ok=True)
    payload = {
        "stub_id": stub_id,
        "task_id": task_id,
        "fingerprint": fingerprint,
        "ts": int(__import__("time").time()),
    }
    dst = _flag_path(run_dir)
    fd, tmp = tempfile.mkstemp(dir=run_dir, prefix=".alchemy_owner_tmp_")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f)
        os.replace(tmp, dst)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ------------------------------------------------------------------ #
# Server verification helper                                           #
# ------------------------------------------------------------------ #

async def _verify_task_alive_with_server(
    server_url: str,
    token: str,
    task_id: str,
) -> bool | None:
    """Ask server whether task_id is still alive (running/dispatched/queued).

    Returns:
        True  → task is alive (server confirms)
        False → task is dead  (server confirms)
        None  → server unreachable
    """
    url = f"{server_url}/api/tasks/{task_id}"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        timeout = aiohttp.ClientTimeout(total=5)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=headers) as resp:
                if resp.status == 404:
                    return False
                if resp.status == 200:
                    data = await resp.json()
                    alive_statuses = {"pending", "queued", "dispatched", "running", "paused"}
                    return data.get("status") in alive_statuses
    except Exception as e:
        log.warning("server verification failed for task %s: %s", task_id, e)
    return None


# ------------------------------------------------------------------ #
# Main preflight entry point                                           #
# ------------------------------------------------------------------ #

async def run_preflight(
    task: dict[str, Any],
    stub_id: str,
    stub_default_cwd: str,
    server_url: str,
    token: str,
) -> PreflightResult:
    """Run all preflight checks for a task before spawning subprocess.

    Args:
        task:            task.run payload from server
        stub_id:         this stub's identity string
        stub_default_cwd: default cwd from stub config
        server_url:      server base URL (for flag verification)
        token:           auth token

    Returns:
        PreflightResult
    """
    errors: list[str] = []

    task_id: str = task["task_id"]
    cwd: str = task.get("cwd") or stub_default_cwd
    run_dir: str | None = task.get("run_dir")
    command: str = task.get("command", "")
    fingerprint: str = task.get("fingerprint", "")

    # 1. cwd must exist
    if cwd and not os.path.isdir(cwd):
        errors.append(f"Working directory does not exist: {cwd}")

    # 2. If command looks like "python <script>", verify script exists
    #    Check both the explicit "script" field and the actual "command" field.
    _PYTHON_BINS = ("python", "python3", "python3.10", "python3.11", "python3.12")

    def _check_script_exists(raw: str) -> str | None:
        """Return error string if script file not found, else None."""
        import shlex
        try:
            parts = shlex.split(raw.strip())
        except ValueError:
            parts = raw.strip().split()
        if len(parts) < 2 or parts[0] not in _PYTHON_BINS:
            return None
        candidate = parts[1]
        # Skip flags like -u, -m, etc.
        if candidate.startswith("-"):
            return None
        if not os.path.isabs(candidate):
            candidate = os.path.join(cwd or ".", candidate)
        if not os.path.exists(candidate):
            return f"Script not found: {candidate} (cwd: {cwd or '.'})"
        if not os.access(candidate, os.R_OK):
            return f"Script not readable: {candidate}"
        return None

    for source in (task.get("script", ""), command):
        if source:
            err = _check_script_exists(source)
            if err:
                errors.append(err)
                break  # one error is enough

    # 3. run_dir parent writable (if declared)
    if run_dir:
        parent = os.path.dirname(run_dir.rstrip("/")) or run_dir
        if not os.access(parent, os.W_OK):
            errors.append(f"run_dir parent not writable: {parent}")

    # Early exit on basic errors
    if errors:
        return PreflightResult.fail(*errors)

    # 4. .alchemy_owner disk flag check
    if run_dir and fingerprint:
        flag_result = await _check_disk_flag(
            run_dir=run_dir,
            fingerprint=fingerprint,
            stub_id=stub_id,
            task_id=task_id,
            server_url=server_url,
            token=token,
        )
        if not flag_result.ok:
            return flag_result

        # Write / overwrite flag
        try:
            _write_flag_atomic(run_dir, stub_id, task_id, fingerprint)
        except Exception as e:
            return PreflightResult.fail(f"Failed to write .alchemy_owner: {e}")

    elif run_dir:
        # No fingerprint available — just ensure run_dir is accessible
        try:
            os.makedirs(run_dir, exist_ok=True)
        except Exception as e:
            return PreflightResult.fail(f"Cannot create run_dir: {e}")

    return PreflightResult.success()


async def _check_disk_flag(
    run_dir: str,
    fingerprint: str,
    stub_id: str,
    task_id: str,
    server_url: str,
    token: str,
) -> PreflightResult:
    """Implement the .alchemy_owner decision tree from spec §2."""
    flag = _read_flag(run_dir)

    if flag is None:
        # No flag → safe to proceed (flag written by caller)
        return PreflightResult.success()

    flag_fp = flag.get("fingerprint", "")
    flag_stub = flag.get("stub_id", "")
    flag_task = flag.get("task_id", "")

    if flag_fp == fingerprint:
        if flag_stub == stub_id:
            # Same fingerprint + own stub → own restart, resume
            log.info("preflight: own restart detected for task %s, resuming", task_id)
            return PreflightResult.success()
        else:
            # Same fingerprint + other stub → verify with server
            alive = await _verify_task_alive_with_server(server_url, token, flag_task)
            if alive is None:
                return PreflightResult.fail(
                    f"Cannot verify ownership of run_dir {run_dir}: server unreachable"
                )
            if alive:
                return PreflightResult.fail(
                    f"Directory {run_dir} occupied by alive task {flag_task} on stub {flag_stub}"
                )
            # Other stub's task is dead → overwrite flag
            log.info(
                "preflight: other stub task %s confirmed dead, overwriting flag", flag_task
            )
            return PreflightResult.success()
    else:
        return PreflightResult.fail(
            f"Directory {run_dir} belongs to different task "
            f"(flag fingerprint {flag_fp!r} != {fingerprint!r})"
        )
