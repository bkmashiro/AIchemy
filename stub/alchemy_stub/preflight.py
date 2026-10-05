"""Pre-execution checks before spawning a task subprocess."""
from __future__ import annotations

import json
import os
import tempfile
from typing import Any

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
    """Publish a complete owner marker with an atomic, no-replace hard link."""
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
            f.flush()
        try:
            # POSIX link creation is atomic and fails if dst already exists.
            os.link(tmp, dst)
            return
        except FileExistsError:
            owner = _read_flag(run_dir)
            if (
                owner
                and "fingerprint" in owner
                and owner.get("task_id") == task_id
                and owner.get("stub_id") == stub_id
                and owner.get("fingerprint") == fingerprint
            ):
                return
            owner_id = owner.get("task_id") if owner else None
            if owner_id:
                raise FileExistsError(f"run_dir already claimed by task {owner_id}")
            raise FileExistsError("run_dir already has an unreadable or legacy owner claim")
    finally:
        # This is our uniquely-created staging file, never the shared claim.
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


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

    # 2b. Python binary exists (if command uses absolute python path)
    if command:
        import shlex as _shlex
        try:
            _cmd_parts = _shlex.split(command.strip())
        except ValueError:
            _cmd_parts = command.strip().split()
        if _cmd_parts and os.path.isabs(_cmd_parts[0]) and os.path.basename(_cmd_parts[0]).startswith("python"):
            _py_bin = _cmd_parts[0]
            if not os.access(_py_bin, os.X_OK):
                errors.append(f"Python binary not found: {_py_bin}")

    # 3. run_dir parent writable/creatable (if declared)
    if run_dir:
        parent = os.path.dirname(run_dir.rstrip("/")) or run_dir
        if not os.path.isdir(parent):
            try:
                os.makedirs(parent, exist_ok=True)
            except Exception:
                errors.append(f"run_dir parent not writable: {parent}")
        if not errors and not os.access(parent, os.W_OK):
            errors.append(f"run_dir parent not writable: {parent}")

    # 3b. Declared outputs: validate the nearest existing ancestor without
    # creating the output parent. Producers may use parent non-existence as
    # their freshness guard; pre-creating it changes task semantics.
    outputs: list[str] = task.get("outputs") or []
    for out_path in outputs:
        out_parent = os.path.dirname(out_path) or "."
        ancestor = os.path.abspath(out_parent)
        while not os.path.exists(ancestor):
            next_ancestor = os.path.dirname(ancestor)
            if next_ancestor == ancestor:
                break
            ancestor = next_ancestor
        if not os.path.isdir(ancestor) or not os.access(ancestor, os.W_OK):
            errors.append(f"Output path ancestor not writable: {ancestor}")

    # Early exit on basic errors
    if errors:
        return PreflightResult.fail(*errors)

    # 4. Atomically claim the output directory before any subprocess can start.
    if run_dir:
        try:
            # Empty fingerprints are still recorded: task/stub identity protects
            # the directory even for older payloads without a fingerprint.
            _write_flag_atomic(run_dir, stub_id, task_id, fingerprint)
        except FileExistsError as e:
            return PreflightResult.fail(str(e))
        except Exception as e:
            return PreflightResult.fail(f"Failed to claim run_dir: {e}")

    return PreflightResult.success()
