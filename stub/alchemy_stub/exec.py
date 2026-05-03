"""exec.py — Stub-side handler for exec.request (Spec 3).

Server sends exec.request with { request_id, command, timeout_s }.
Stub spawns a subprocess, captures stdout/stderr (truncated to 4KB each),
and returns the result via the socket.io ack callback.

Security: only active when Config.allow_exec is True (--allow-exec flag).
"""
from __future__ import annotations

import asyncio
import logging
import os
import shlex
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .config import Config

log = logging.getLogger(__name__)

_MAX_OUTPUT_BYTES = 4 * 1024  # 4KB per stream


async def handle_exec_request(
    data: dict,
    config: "Config",
    emit_fn,
) -> dict:
    """Handle an exec.request payload.

    Args:
        data: Payload from server: { request_id, command, timeout_s }
        config: Stub config (used for default_cwd, default_env, allow_exec)
        emit_fn: Async callable for emitting WS events (unused here — result via ack).

    Returns:
        Dict matching ExecResponsePayload to be sent as the ack response.
    """
    request_id: str = data.get("request_id", "")
    command: str = data.get("command", "")
    timeout_s: float = float(data.get("timeout_s", 30))

    # Security gate
    if not config.allow_exec:
        log.warning("exec.request rejected: --allow-exec not set, request_id=%s", request_id)
        return {
            "request_id": request_id,
            "stdout": "",
            "stderr": "",
            "exit_code": -1,
            "truncated": False,
            "error": "exec_disabled",
        }

    log.info("exec.request: request_id=%s command=%s timeout_s=%s", request_id, command[:200], timeout_s)

    cwd = config.default_cwd or os.getcwd()

    # Build env: start from os.environ, overlay default_env
    env = dict(os.environ)
    env.update(config.default_env)

    # Determine whether to use shell=True.
    # Use shell=True for commands containing shell operators; otherwise shlex.split.
    _SHELL_OPERATORS = ("&&", "||", ";", "|", ">", ">>", "<", "2>", "2>>", "`", "$(")
    needs_shell = any(op in command for op in _SHELL_OPERATORS)

    try:
        if needs_shell:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=env,
            )
        else:
            try:
                args = shlex.split(command)
            except ValueError as e:
                return {
                    "request_id": request_id,
                    "stdout": "",
                    "stderr": f"Failed to parse command: {e}\n",
                    "exit_code": -1,
                    "truncated": False,
                }
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=env,
            )
    except Exception as e:
        log.error("exec.request: failed to spawn subprocess: %s", e)
        return {
            "request_id": request_id,
            "stdout": "",
            "stderr": f"Failed to start process: {e}\n",
            "exit_code": -1,
            "truncated": False,
        }

    async def _read_limited(stream: asyncio.StreamReader | None) -> tuple[bytes, bool]:
        """Read up to _MAX_OUTPUT_BYTES from stream, discard the rest."""
        if stream is None:
            return b"", False
        chunks: list[bytes] = []
        total = 0
        was_truncated = False
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                break
            remaining = _MAX_OUTPUT_BYTES - total
            if remaining <= 0:
                was_truncated = True
                continue  # drain remaining output without storing
            if len(chunk) > remaining:
                chunks.append(chunk[:remaining])
                total += remaining
                was_truncated = True
            else:
                chunks.append(chunk)
                total += len(chunk)
        return b"".join(chunks), was_truncated

    timed_out = False
    truncated = False
    try:
        stdout_task = asyncio.create_task(_read_limited(proc.stdout))
        stderr_task = asyncio.create_task(_read_limited(proc.stderr))

        async def _wait_all():
            out, out_trunc = await stdout_task
            err, err_trunc = await stderr_task
            await proc.wait()
            return out, out_trunc, err, err_trunc

        stdout_bytes, stdout_trunc, stderr_bytes, stderr_trunc = await asyncio.wait_for(
            _wait_all(), timeout=timeout_s
        )
        truncated = stdout_trunc or stderr_trunc
    except asyncio.TimeoutError:
        timed_out = True
        log.warning("exec.request: timeout request_id=%s", request_id)
        try:
            proc.kill()
            await proc.wait()  # reap zombie
        except Exception:
            pass
        stdout_bytes = b""
        stderr_bytes = b""

    exit_code = proc.returncode if proc.returncode is not None else -1
    if timed_out:
        exit_code = -1
        stderr_bytes = f"Command timed out after {timeout_s:.0f}s\n".encode()
        truncated = False

    stdout = stdout_bytes.decode("utf-8", errors="replace")
    stderr = stderr_bytes.decode("utf-8", errors="replace")

    log.info(
        "exec.response: request_id=%s exit_code=%d truncated=%s stdout_len=%d stderr_len=%d",
        request_id, exit_code, truncated, len(stdout), len(stderr),
    )

    return {
        "request_id": request_id,
        "stdout": stdout,
        "stderr": stderr,
        "exit_code": exit_code,
        "truncated": truncated,
    }
