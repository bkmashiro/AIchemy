"""Tests for Spec 3: Stub Remote Exec via WebSocket.

Covers:
- handle_exec_request: exec disabled without --allow-exec
- handle_exec_request: runs command and captures stdout/stderr
- handle_exec_request: stdout/stderr truncated to 4KB
- handle_exec_request: separates stdout and stderr correctly
- handle_exec_request: returns non-zero exit code
- handle_exec_request: shell=True used for commands with pipes
- handle_exec_request: timeout returns exit_code=-1 and error message
- Config: --allow-exec flag defaults to False, can be set to True
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
from dataclasses import dataclass, field
from unittest.mock import AsyncMock

import pytest

from alchemy_stub.exec import handle_exec_request


# ─── Minimal Config stub ─────────────────────────────────────────────────────

@dataclass
class _FakeConfig:
    allow_exec: bool = False
    default_cwd: str = "/tmp"
    default_env: dict = field(default_factory=dict)
    env_setup: str = ""


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _payload(command: str, timeout_s: float = 10, request_id: str = "req-1") -> dict:
    return {"request_id": request_id, "command": command, "timeout_s": timeout_s}


def _run(command: str, allow_exec: bool = True, timeout_s: float = 10, **cfg_kwargs) -> dict:
    config = _FakeConfig(allow_exec=allow_exec, **cfg_kwargs)
    emit_fn = AsyncMock()
    return asyncio.run(handle_exec_request(_payload(command, timeout_s), config, emit_fn))


# ─── Tests: security gate ────────────────────────────────────────────────────

def test_exec_disabled_by_default():
    """Without --allow-exec, requests are rejected with error='exec_disabled'."""
    result = _run("ls", allow_exec=False)
    assert result["error"] == "exec_disabled"
    assert result["exit_code"] == -1
    assert result["stdout"] == ""


def test_exec_enabled_with_flag():
    """With allow_exec=True, commands run normally."""
    result = _run("echo hello")
    assert result["exit_code"] == 0
    assert "hello" in result["stdout"]
    assert result.get("error") is None


# ─── Tests: basic execution ──────────────────────────────────────────────────

def test_stdout_captured():
    result = _run("echo hello")
    assert result["exit_code"] == 0
    assert "hello" in result["stdout"]
    assert result["truncated"] is False


def test_stderr_captured():
    result = _run('python3 -c "import sys; sys.stderr.write(\'err\\n\')"')
    assert result["exit_code"] == 0
    assert "err" in result["stderr"]


def test_nonzero_exit_code():
    result = _run("python3 -c \"import sys; sys.exit(42)\"")
    assert result["exit_code"] == 42


def test_stdout_and_stderr_separate():
    """Stdout and stderr are captured separately (not interleaved)."""
    cmd = 'python3 -c "import sys; print(\'out\'); sys.stderr.write(\'err\\n\')"'
    result = _run(cmd)
    assert "out" in result["stdout"]
    assert "err" in result["stderr"]


def test_request_id_preserved():
    config = _FakeConfig(allow_exec=True)
    emit_fn = AsyncMock()
    data = {"request_id": "my-req-42", "command": "echo hi", "timeout_s": 5}
    result = asyncio.run(handle_exec_request(data, config, emit_fn))
    assert result["request_id"] == "my-req-42"


# ─── Tests: truncation ───────────────────────────────────────────────────────

def test_stdout_truncated_to_4kb():
    """Output > 4KB is truncated and truncated=True."""
    cmd = "python3 -c \"print('x' * 5000)\""
    result = _run(cmd)
    assert result["truncated"] is True
    assert len(result["stdout"]) <= 4096


def test_short_output_not_truncated():
    result = _run("echo hello")
    assert result["truncated"] is False
    assert len(result["stdout"]) < 4096


# ─── Tests: shell operators ──────────────────────────────────────────────────

def test_pipe_works():
    """Commands with pipes use shell=True."""
    result = _run("echo hello | tr a-z A-Z")
    assert result["exit_code"] == 0
    assert "HELLO" in result["stdout"]


def test_shell_redirection():
    """Commands with shell redirects work."""
    result = _run("echo hello 2>/dev/null")
    assert result["exit_code"] == 0
    assert "hello" in result["stdout"]


# ─── Tests: timeout ──────────────────────────────────────────────────────────

def test_timeout_kills_process():
    """Commands that exceed timeout_s return exit_code=-1 with error in stderr."""
    result = _run("sleep 10", timeout_s=0.2)
    assert result["exit_code"] == -1
    assert "timed out" in result["stderr"].lower()


# ─── Tests: cwd and env ──────────────────────────────────────────────────────

def test_runs_in_default_cwd():
    """Command runs in default_cwd."""
    with tempfile.TemporaryDirectory() as tmp:
        result = _run("pwd", default_cwd=tmp)
        assert tmp in result["stdout"]


def test_default_env_vars_available():
    """default_env vars are available to the subprocess (via shell=True for $VAR expansion)."""
    # Use a pipe to force shell=True, which enables $VAR expansion
    result = _run("echo $MY_CUSTOM_VAR | cat", default_env={"MY_CUSTOM_VAR": "alchemy_test"})
    assert "alchemy_test" in result["stdout"]


# ─── Tests: config --allow-exec flag ─────────────────────────────────────────

def test_config_allow_exec_default_false():
    """Config.allow_exec defaults to False (security default)."""
    from alchemy_stub.config import Config
    cfg = Config(
        server="ws://localhost:3002",
        token="tk_test",
        max_concurrent=1,
        env_setup="",
        default_cwd="/tmp",
        idle_timeout=0,
    )
    assert cfg.allow_exec is False


def test_parse_args_allow_exec_flag(monkeypatch):
    """--allow-exec CLI flag sets allow_exec=True on Config."""
    from alchemy_stub.config import parse_args
    monkeypatch.setattr(
        sys, "argv",
        ["stub", "--server", "ws://localhost:3002", "--token", "tk_test", "--allow-exec"],
    )
    cfg = parse_args()
    assert cfg.allow_exec is True


def test_parse_args_allow_exec_default(monkeypatch):
    """Without --allow-exec, allow_exec is False."""
    from alchemy_stub.config import parse_args
    monkeypatch.setattr(
        sys, "argv",
        ["stub", "--server", "ws://localhost:3002", "--token", "tk_test"],
    )
    cfg = parse_args()
    assert cfg.allow_exec is False
