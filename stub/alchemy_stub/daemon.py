"""Main stub daemon — socket.io event loop, heartbeat, lifecycle.

Unified resume flow (spec §4):
  Every connect (first / reconnect / hot-restart) → send `resume` event.
  Server responds with `resume_response`.
  No separate register + sync_state events.

Reliable messaging:
  Uses socket.io native ack callbacks. Each emit includes an ack callback;
  server acks on receipt. Retry on timeout. No custom seq/ack/nack layer.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import ssl
import time
from datetime import datetime, timezone
from typing import Any

import socketio

from .config import Config
from .env_discover import discover_python_envs
from .gpu_monitor import GpuMonitor
from .log_setup import jlog
from .preflight import run_preflight
from .process_mgr import ProcessManager
from .system_monitor import SystemMonitor
from .task_socket import TaskSocketRegistry
from .walltime import CHECK_INTERVAL_S, DRAIN_THRESHOLD_S, get_remaining_walltime

log = logging.getLogger(__name__)


def _extract_dict(args: tuple) -> dict | None:
    """Extract a dict payload from socket.io handler args.
    python-socketio 5.16+ may pass extra positional args or JSON strings."""
    for a in args:
        if isinstance(a, dict):
            return a
        if isinstance(a, str):
            try:
                parsed = json.loads(a)
                if isinstance(parsed, dict):
                    return parsed
            except (ValueError, TypeError):
                pass
    return None


def _find_ack(args: tuple):
    """Find ack callback in socket.io handler args (last arg if callable)."""
    if args and callable(args[-1]):
        return args[-1]
    return None


class StubDaemon:
    """Core daemon. Instantiated fresh on each restart loop iteration."""

    @staticmethod
    def _build_ssl_context() -> ssl.SSLContext | bool:
        """Build SSL context that respects SSL_CERT_FILE for A30 nodes."""
        cert_file = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
        if not cert_file:
            return True  # default verification
        ctx = ssl.create_default_context()
        ctx.load_verify_locations(cert_file)
        return ctx

    def __init__(self, config: Config) -> None:
        self.config = config

        self.gpu_monitor = GpuMonitor()
        self.system_monitor = SystemMonitor(gpu_monitor=self.gpu_monitor)
        self.task_socket_registry = TaskSocketRegistry()

        identity = config.identity_hash
        # Use /tmp for PID file and log dir to avoid home-dir permission issues
        # (e.g. hw2025's home may not be writable from SLURM jobs)
        os.environ.setdefault("ALCHEMY_LOG_DIR", f"/tmp/alchemy_stub_{identity}_logs")
        self.process_mgr = ProcessManager(
            max_concurrent=config.max_concurrent,
            env_setup=config.env_setup,
            default_cwd=config.default_cwd,
            default_env=config.default_env,
            pid_file=f"/tmp/alchemy_stub_{identity}_tasks.json",
            on_started=self._on_task_started,
            on_log=self._on_task_log,
            on_completed=self._on_task_completed,
            on_failed=self._on_task_failed,
            on_zombie=self._on_task_zombie,
        )

        self.stub_id: str | None = None
        self.stub_name: str | None = None
        self.accepting_tasks: bool = True
        self.last_task_time: float = time.time()
        self._zombie_reported: set[str] = set()
        self._walltime_draining: bool = False
        self._task_start_times: dict[str, float] = {}
        self._killing: set[str] = set()

        self.sio = socketio.AsyncClient(
            reconnection=False,  # outer while-loop handles reconnection; prevent double-socket
            logger=False,
            engineio_logger=False,
            ssl_verify=self._build_ssl_context(),
        )

        self._connected = False
        self._setup_handlers()

    # ------------------------------------------------------------------ #
    # Raw socket.io helpers                                                #
    # ------------------------------------------------------------------ #

    async def _emit(self, event: str, payload: Any) -> None:
        """Emit event directly via socket.io."""
        if self._connected:
            try:
                await self.sio.emit(event, payload, namespace="/stubs")
            except Exception as e:
                log.warning("emit failed for %s: %s", event, e)

    # ------------------------------------------------------------------ #
    # socket.io handler registration                                       #
    # ------------------------------------------------------------------ #

    def _setup_handlers(self) -> None:
        sio = self.sio

        @sio.event(namespace="/stubs")
        async def connect():
            jlog("info", "sio.connect", server=self.config.server)
            log.info("Connected to server %s", self.config.server)
            self._connected = True
            await self._send_resume()

        @sio.event(namespace="/stubs")
        async def disconnect():
            jlog("info", "sio.disconnect")
            log.info("Disconnected from server")
            self._connected = False

        # ─── Server → Stub events (direct, with native ack) ─────────────
        @sio.on("resume_response", namespace="/stubs")
        async def on_resume_response(*args):
            data = _extract_dict(args)
            ack = _find_ack(args)
            if data:
                if ack: ack({"ok": True})
                await self._handle_resume_response(data)

        @sio.on("task.run", namespace="/stubs")
        async def on_task_run(*args):
            data = _extract_dict(args)
            ack = _find_ack(args)
            if data:
                if ack: ack({"ok": True})
                await self._handle_task_run(data)

        @sio.on("task.kill", namespace="/stubs")
        async def on_task_kill(*args):
            data = _extract_dict(args)
            ack = _find_ack(args)
            if data:
                if ack: ack({"ok": True})
                await self._handle_task_kill(data)

        @sio.on("task.signal", namespace="/stubs")
        async def on_task_signal(*args):
            data = _extract_dict(args)
            ack = _find_ack(args)
            if data:
                if ack: ack({"ok": True})
                await self._handle_task_signal(data)

        @sio.on("config.update", namespace="/stubs")
        async def on_config_update(*args):
            data = _extract_dict(args)
            ack = _find_ack(args)
            if data:
                if ack: ack({"ok": True})
                await self._handle_config_update(data)

        @sio.on("shell.exec", namespace="/stubs")
        async def on_shell_exec(*args):
            data = _extract_dict(args)
            ack = _find_ack(args)
            if data:
                if ack: ack({"ok": True})
                await self._handle_shell_exec(data)

        @sio.on("request_sync", namespace="/stubs")
        async def on_request_sync(*args):
            log.debug("request_sync received — re-sending resume")
            await self._send_resume()

        @sio.on("status.sync", namespace="/stubs")
        async def on_status_sync(*args):
            ack = _find_ack(args)
            running_tasks = [
                {"task_id": tid, "pid": info.pid, "alive": info.poll() is None}
                for tid, info in self.process_mgr._procs.items()
            ]
            status = {"running_tasks": running_tasks}
            if ack:
                ack(status)
            else:
                await self._emit("status.sync_response", status)

        @sio.on("stub.restart", namespace="/stubs")
        async def on_stub_restart(*args):
            ack = _find_ack(args)
            if ack:
                ack({"ok": True})
            jlog("info", "stub.restart_requested")
            # Brief delay to allow ack to send before exiting
            await asyncio.sleep(0.5)
            os._exit(0)

    # ------------------------------------------------------------------ #
    # Resume                                                               #
    # ------------------------------------------------------------------ #

    async def _send_resume(self) -> None:
        """Send unified resume event (spec §4)."""
        gpu_info = self.gpu_monitor.get_gpu_info()

        # Compute server-compatible stub_id using actual GPU info
        computed_stub_id = self.config.compute_stub_id(
            gpu_name=gpu_info.get("name", "CPU-only"),
            gpu_count=gpu_info.get("count", 0),
        )

        running_tasks = []
        for task_id, pid in self.process_mgr.get_task_pids().items():
            running_tasks.append({"task_id": task_id, "pid": pid, "status": "running"})

        # Tasks that died while stub was offline — report with exit code (-1 = unknown)
        dead_tasks = [
            {"task_id": tid, "exit_code": -1}
            for tid, _pid in self.process_mgr._dead_on_reattach
        ]

        payload: dict[str, Any] = {
            "stub_id": computed_stub_id,
            "hostname": self.config.hostname,
            "gpu": gpu_info,
            "max_concurrent": self.config.max_concurrent,
            "token": self.config.token,
            "running_tasks": running_tasks,
            "local_queue": [],
            "dead_tasks": dead_tasks,
            "env_setup": self.config.env_setup or None,
            "default_cwd": self.config.default_cwd or None,
            "user": os.environ.get("USER", "unknown"),
        }

        if self.config.slurm_job_id:
            payload["slurm_job_id"] = self.config.slurm_job_id
            payload["type"] = "slurm"
        else:
            payload["type"] = "workstation"

        if self.config.idle_timeout > 0:
            payload["idle_timeout_s"] = self.config.idle_timeout

        if self.config.tags:
            payload["tags"] = self.config.tags

        # B3: Report SLURM resource constraints
        slurm_constraints = self._read_slurm_constraints()
        if slurm_constraints:
            payload["slurm_constraints"] = slurm_constraints

        # Discover available Python environments (conda/mamba/venv)
        try:
            payload["available_envs"] = discover_python_envs()
        except Exception:
            payload["available_envs"] = []

        await self._emit("resume", payload)
        jlog(
            "info", "resume.sent",
            running_tasks=len(running_tasks),
            tags=self.config.tags,
        )

    # ------------------------------------------------------------------ #
    # SLURM resource discovery (B3)                                        #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _read_slurm_constraints() -> dict[str, Any] | None:
        """Read SLURM allocation constraints from environment variables."""
        mem_str = os.environ.get("SLURM_MEM_PER_NODE")
        nodes_str = os.environ.get("SLURM_JOB_NUM_NODES")
        cpus_str = os.environ.get("SLURM_CPUS_ON_NODE")
        gpus_str = os.environ.get("SLURM_GPUS_ON_NODE")
        time_str = os.environ.get("SLURM_JOB_TIME_LIMIT")  # minutes or HH:MM:SS

        if not any([mem_str, nodes_str, cpus_str]):
            return None

        constraints: dict[str, Any] = {}
        if mem_str:
            # SLURM_MEM_PER_NODE is in MB
            try:
                constraints["mem_mb"] = int(mem_str)
            except ValueError:
                pass
        if cpus_str:
            try:
                constraints["cpus"] = int(cpus_str)
            except ValueError:
                pass
        if gpus_str:
            try:
                constraints["gpus"] = int(gpus_str)
            except ValueError:
                pass
        if time_str:
            # May be minutes (int) or HH:MM:SS
            try:
                constraints["time_min"] = int(time_str)
            except ValueError:
                # Try HH:MM:SS format
                parts = time_str.split(":")
                if len(parts) == 3:
                    try:
                        h, m, s = int(parts[0]), int(parts[1]), int(parts[2])
                        constraints["time_min"] = h * 60 + m + (1 if s > 0 else 0)
                    except ValueError:
                        pass

        return constraints if constraints else None

    # ------------------------------------------------------------------ #
    # Event handlers: server → stub                                        #
    # ------------------------------------------------------------------ #

    async def _handle_resume_response(self, data: dict) -> None:
        self.stub_id = data.get("stub_id")
        self.stub_name = data.get("name")
        config_update = data.get("config") or {}

        jlog("info", "resume_response", stub_id=self.stub_id, name=self.stub_name)
        log.info("Registered as stub_id=%s name=%s", self.stub_id, self.stub_name)
        if data.get("kill_tasks"):
            log.info("Server requested kill of %d orphan task(s)", len(data["kill_tasks"]))
        if data.get("adopt_tasks"):
            log.info("Server assigned %d task(s) to adopt", len(data["adopt_tasks"]))

        # Apply server-authoritative config
        if "max_concurrent" in config_update:
            self.process_mgr.max_concurrent = config_update["max_concurrent"]
            self.config.max_concurrent = config_update["max_concurrent"]

        # Kill orphaned tasks the server doesn't know about
        for task_id in data.get("kill_tasks", []):
            log.info("resume_response: killing orphan task %s", task_id)
            await self._kill_task(task_id, grace_period_s=0)

        # Dead-on-reattach tasks were already reported in the resume payload — clear the list
        self.process_mgr._dead_on_reattach.clear()

        # Adopt tasks server wants us to run
        for task in data.get("adopt_tasks", []):
            await self._handle_task_run(task)

    def _resolve_command(self, command: str, cwd: str) -> str:
        """Resolve relative paths in command to absolute using cwd.

        Shell operators (&&, ||, ;, |) are preserved verbatim — shlex.split
        treats them as regular tokens and shlex.join would quote them, breaking
        the shell semantics.  We split around these operators first, resolve
        each segment independently, and stitch back together.
        """
        import shlex
        import re

        # Shell operators that must stay unquoted
        _SHELL_OPS = {'&&', '||', ';', '|', '>', '>>', '<', '2>', '2>>'}

        try:
            parts = shlex.split(command)
        except ValueError:
            parts = command.split()

        resolved: list[str] = []
        for part in parts:
            # Preserve shell operators literally
            if part in _SHELL_OPS:
                resolved.append(part)
                continue
            # Skip flags and absolute paths
            if part.startswith('-') or part.startswith('/'):
                # Handle --flag=relative/path
                if '=' in part and not part.split('=', 1)[1].startswith('/'):
                    flag, val = part.split('=', 1)
                    if '/' in val:
                        abs_val = os.path.join(cwd, val)
                        if os.path.exists(abs_val):
                            resolved.append(f"{flag}={abs_val}")
                            continue
                resolved.append(part)
                continue
            # Check if this looks like a relative file path
            if '/' in part:
                abs_path = os.path.join(cwd, part)
                if os.path.exists(abs_path):
                    resolved.append(abs_path)
                    continue
            resolved.append(part)

        # Rebuild: quote each token EXCEPT shell operators
        out_parts: list[str] = []
        for tok in resolved:
            if tok in _SHELL_OPS:
                out_parts.append(tok)
            else:
                out_parts.append(shlex.quote(tok))
        return ' '.join(out_parts)

    async def _handle_task_run(self, data: dict) -> None:
        task_id: str = data.get("task_id", "unknown")
        try:
            await self._handle_task_run_inner(data)
        except Exception as e:
            log.error("[%s] Unhandled error in task.run: %s", task_id, e)
            await self._emit(
                "task.failed",
                {"task_id": task_id, "exit_code": -2, "error": f"Unhandled dispatch error: {str(e)[:500]}"},
            )

    async def _handle_task_run_inner(self, data: dict) -> None:
        task_id: str = data["task_id"]
        command: str = data["command"]

        log.info("Task %s received: command=%s", task_id, command[:200])

        if not self.accepting_tasks:
            log.info("Not accepting new tasks (draining), ignoring task.run %s", task_id)
            return

        if self.process_mgr.is_running(task_id):
            log.info("Task %s already running, ignoring duplicate task.run", task_id)
            return

        # Preflight
        result = await run_preflight(
            task=data,
            stub_id=self.stub_id or self.config.identity_hash,
            stub_default_cwd=self.config.default_cwd,
            server_url=self.config.server,
            token=self.config.token,
        )
        if not result.ok:
            error_detail = "; ".join(result.errors)
            jlog("error", "preflight.fail", task_id=task_id, errors=result.errors)
            log.error("Preflight failed for task %s: %s", task_id, error_detail)
            # Send error to task log buffer so web UI shows what went wrong
            await self._emit(
                "task.log",
                {"task_id": task_id, "lines": [
                    f"[alchemy-stub] PREFLIGHT FAILED: {err}" for err in result.errors
                ]},
            )
            await self._emit(
                "preflight.fail",
                {"task_id": task_id, "errors": result.errors},
            )
            # Also report as task.failed so server marks it done
            await self._emit(
                "task.failed",
                {"task_id": task_id, "exit_code": -1, "error": f"Preflight failed: {error_detail}"},
            )
            return

        jlog("info", "preflight.pass", task_id=task_id)

        cwd = data.get("cwd") or self.config.default_cwd or None
        env: dict[str, str] = data.get("env") or {}
        task_env_setup: str = data.get("env_setup") or ""
        params: dict[str, Any] | None = data.get("params")
        run_dir: str | None = data.get("run_dir")
        env_overrides: dict[str, str] | None = data.get("env_overrides")

        # Resolve relative paths in command using cwd
        if cwd:
            command = self._resolve_command(command, cwd)

        jlog("info", "task.run", task_id=task_id, command=command[:120], cwd=cwd, run_dir=run_dir)
        self.last_task_time = time.time()

        try:
            pid = await self.process_mgr.start(
                task_id=task_id,
                command=command,
                cwd=cwd,
                env=env,
                task_env_setup=task_env_setup,
                params=params,
                run_dir=run_dir,
                env_overrides=env_overrides,
            )
        except Exception as e:
            error_msg = f"Failed to start process: {e}"
            log.error("Failed to start task %s: %s", task_id, e)
            # Send error to task log buffer
            await self._emit(
                "task.log",
                {"task_id": task_id, "lines": [f"[alchemy-stub] {error_msg}"]},
            )
            await self._emit(
                "task.failed",
                {"task_id": task_id, "exit_code": -1, "error": error_msg},
            )
            return

        # Start Unix socket (non-fatal if it fails)
        try:
            await self.task_socket_registry.create(
                task_id=task_id,
                pid=pid,
                on_progress=self._on_sdk_progress,
                on_eval=self._on_sdk_eval,
                on_checkpoint=self._on_sdk_checkpoint,
                on_config=self._on_sdk_config,
                on_done=self._on_sdk_done,
                on_notify=self._on_sdk_notify,
                on_phase=self._on_sdk_phase,
                on_zombie=self._on_task_zombie,
            )
        except Exception as e:
            log.warning("Failed to create task socket for %s: %s", task_id, e)

    async def _handle_task_kill(self, data: dict) -> None:
        task_id: str = data["task_id"]
        grace_period_s: float = float(data.get("grace_period_s", 5))
        jlog("info", "task.kill_chain", task_id=task_id, grace_period_s=grace_period_s)
        await self._kill_task(task_id, grace_period_s=grace_period_s)

    async def _kill_task(self, task_id: str, grace_period_s: float = 5.0) -> None:
        if not self.process_mgr.is_running(task_id):
            return
        if task_id in self._killing:
            return
        self._killing.add(task_id)
        try:
            await self.process_mgr.kill_graceful(
                task_id,
                grace_period_s=grace_period_s,
            )
        finally:
            self._killing.discard(task_id)

    async def _handle_task_signal(self, data: dict) -> None:
        # Legacy handler kept for backward compatibility — currently a no-op.
        task_id: str = data.get("task_id", "")
        sig: str = data.get("signal", "")
        log.debug("task.signal (ignored, deprecated): task=%s signal=%s", task_id, sig)

    async def _handle_config_update(self, data: dict) -> None:
        if "max_concurrent" in data:
            new_val = int(data["max_concurrent"])
            self.process_mgr.max_concurrent = new_val
            self.config.max_concurrent = new_val
            log.info("config.update: max_concurrent=%d", new_val)

    # ------------------------------------------------------------------ #
    # Shell exec                                                           #
    # ------------------------------------------------------------------ #

    # Basic blocklist — not exhaustive, just guards against obvious destruction
    _SHELL_BLOCKLIST = [
        "rm -rf /",
        "mkfs",
        "dd if=",
        ":(){ :|:& };:",
        "> /dev/sda",
        "chmod -R 777 /",
        "chown -R",
        "rm -rf /*",
    ]

    def _is_blocked_command(self, command: str) -> bool:
        cmd_lower = command.lower()
        for pattern in self._SHELL_BLOCKLIST:
            if pattern.lower() in cmd_lower:
                return True
        return False

    async def _handle_shell_exec(self, data: dict) -> None:
        request_id: str = data.get("request_id", "")
        command: str = data.get("command", "")
        timeout: int = min(int(data.get("timeout", 30)), 120)

        if self._is_blocked_command(command):
            log.warning("shell.exec: blocked command request_id=%s", request_id)
            await self.sio.emit(
                "shell.output",
                {"request_id": request_id, "chunk": "Error: command blocked by security policy\n", "stream": "stdout"},
                namespace="/stubs",
            )
            await self.sio.emit(
                "shell.done",
                {"request_id": request_id, "exit_code": 1},
                namespace="/stubs",
            )
            return

        # Build full command with env_setup prefix if configured
        full_command = command
        if self.config.env_setup:
            full_command = f"{self.config.env_setup} && {command}"

        cwd = self.config.default_cwd or "/tmp"
        log.info("shell.exec: request_id=%s command=%s", request_id, command[:120])

        try:
            proc = await asyncio.create_subprocess_shell(
                full_command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=cwd,
            )
        except Exception as e:
            log.error("shell.exec: failed to start process: %s", e)
            await self.sio.emit(
                "shell.output",
                {"request_id": request_id, "chunk": f"Error: {e}\n", "stream": "stdout"},
                namespace="/stubs",
            )
            await self.sio.emit(
                "shell.done",
                {"request_id": request_id, "exit_code": -1},
                namespace="/stubs",
            )
            return

        async def _stream_output() -> int:
            assert proc.stdout is not None
            while True:
                chunk = await proc.stdout.read(4096)
                if not chunk:
                    break
                if self.sio.connected:
                    await self.sio.emit(
                        "shell.output",
                        {"request_id": request_id, "chunk": chunk.decode("utf-8", errors="replace"), "stream": "stdout"},
                        namespace="/stubs",
                    )
            await proc.wait()
            return proc.returncode if proc.returncode is not None else -1

        try:
            exit_code = await asyncio.wait_for(_stream_output(), timeout=timeout)
        except asyncio.TimeoutError:
            log.warning("shell.exec: timeout request_id=%s", request_id)
            try:
                proc.kill()
                await proc.wait()  # reap zombie process
            except Exception:
                pass
            await self.sio.emit(
                "shell.output",
                {"request_id": request_id, "chunk": f"\nError: command timed out after {timeout}s\n", "stream": "stdout"},
                namespace="/stubs",
            )
            exit_code = -1
        except Exception as e:
            log.error("shell.exec: streaming error: %s", e)
            exit_code = -1

        await self.sio.emit(
            "shell.done",
            {"request_id": request_id, "exit_code": exit_code},
            namespace="/stubs",
        )

    # ------------------------------------------------------------------ #
    # ProcessManager callbacks                                             #
    # ------------------------------------------------------------------ #

    async def _on_task_started(self, task_id: str, pid: int) -> None:
        self._task_start_times[task_id] = time.time()
        jlog("info", "task.started", task_id=task_id, pid=pid)
        log.info("Task %s started with pid=%d", task_id, pid)
        await self._emit("task.started", {"task_id": task_id, "pid": pid})

    async def _on_task_log(self, task_id: str, lines: list[str]) -> None:
        if lines:
            await self._emit("task.log", {"task_id": task_id, "lines": lines})

    async def _on_task_completed(self, task_id: str, exit_code: int, death_cause: str = "success", has_checkpoint: bool = False) -> None:
        self.last_task_time = time.time()
        duration_s = round(time.time() - self._task_start_times.pop(task_id, time.time()))
        jlog("info", "task.completed", task_id=task_id, exit_code=exit_code, duration_s=duration_s)
        log.info("Task %s completed: exit_code=%d duration=%ds", task_id, exit_code, duration_s)
        await self.task_socket_registry.remove(task_id)
        await self._emit("task.completed", {
            "task_id": task_id,
            "exit_code": exit_code,
            "death_cause": death_cause,
            "has_checkpoint": has_checkpoint,
        })

    async def _on_task_failed(self, task_id: str, exit_code: int, error: str, death_cause: str = "code_error", has_checkpoint: bool = False) -> None:
        self.last_task_time = time.time()
        duration_s = round(time.time() - self._task_start_times.pop(task_id, time.time()))
        jlog("warn", "task.failed", task_id=task_id, exit_code=exit_code, error=error, death_cause=death_cause, duration_s=duration_s)
        log.error("Task %s failed: exit_code=%d death_cause=%s duration=%ds error=%s", task_id, exit_code, death_cause, duration_s, error)
        await self.task_socket_registry.remove(task_id)
        # Send error to task log buffer so web UI shows the failure reason
        await self._emit(
            "task.log",
            {"task_id": task_id, "lines": [f"[alchemy-stub] Task failed: exit_code={exit_code} death_cause={death_cause} {error}"]},
        )
        await self._emit(
            "task.failed",
            {"task_id": task_id, "exit_code": exit_code, "error": error, "death_cause": death_cause, "has_checkpoint": has_checkpoint},
        )

    async def _on_task_zombie(self, task_id: str) -> None:
        if task_id in self._zombie_reported:
            return  # Don't spam reliable channel with repeated zombie reports
        self._zombie_reported.add(task_id)
        jlog("warn", "task.zombie", task_id=task_id)
        await self._emit("task.zombie", {"task_id": task_id})

    # ------------------------------------------------------------------ #
    # SDK socket callbacks                                                 #
    # ------------------------------------------------------------------ #

    async def _on_sdk_progress(
        self,
        task_id: str,
        step: int,
        total: int,
        loss: float | None,
        metrics: dict,
    ) -> None:
        payload: dict[str, Any] = {
            "task_id": task_id,
            "step": step,
            "total": total,
        }
        if loss is not None:
            payload["loss"] = loss
        if metrics:
            payload["metrics"] = metrics
        await self._emit("task.progress", payload)

        # Also emit structured metrics via task.metrics for the metrics buffer
        structured: dict[str, float] = {}
        if loss is not None:
            structured["loss"] = loss
        if metrics:
            structured.update(metrics)
        if structured:
            await self.emit_task_metrics(task_id, structured, step)

    async def emit_task_metrics(self, task_id: str, metrics: dict, step: int) -> None:
        """Emit structured metrics for a task (non-reliable, high-frequency).

        Args:
            task_id: The task UUID.
            metrics: Dict of metric_key → float value (e.g. {"loss": 0.42, "reward": 1.5}).
            step: Current training step.
        """
        await self._emit("task.metrics", {
            "task_id": task_id,
            "metrics": metrics,
            "step": step,
        })

    async def _on_sdk_eval(self, task_id: str, metrics: dict) -> None:
        await self._emit("task.eval", {"task_id": task_id, "metrics": metrics})

    async def _on_sdk_checkpoint(self, task_id: str, path: str) -> None:
        await self._emit("task.checkpoint", {"task_id": task_id, "path": path})

    async def _on_sdk_config(self, task_id: str, config: dict) -> None:
        await self._emit("task.config", {"task_id": task_id, "config": config})

    async def _on_sdk_done(self, task_id: str, metrics: dict) -> None:
        log.info("SDK done for task %s", task_id)

    async def _on_sdk_notify(self, task_id: str, message: str, level: str) -> None:
        """Forward SDK notify message to server."""
        jlog("info", "task.notify", task_id=task_id, level=level, message=message[:200])
        await self._emit("task.notify", {
            "task_id": task_id,
            "message": message,
            "level": level,
        })

    async def _on_sdk_phase(self, task_id: str, phase: str) -> None:
        """Forward SDK phase report to server."""
        await self._emit("task.phase", {
            "task_id": task_id,
            "phase": phase,
        })

    # ------------------------------------------------------------------ #
    # Background loops                                                     #
    # ------------------------------------------------------------------ #

    async def _heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(30)
            if not self._connected:
                continue
            try:
                # Include walltime_remaining_s if in SLURM mode
                heartbeat_payload: dict[str, Any] = {
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
                if self.config.slurm_job_id:
                    remaining = get_remaining_walltime()
                    if remaining is not None:
                        heartbeat_payload["walltime_remaining_s"] = remaining

                # Send heartbeat FIRST — before any blocking monitoring calls
                await self._emit("heartbeat", heartbeat_payload)

                # GPU/system stats with timeout — don't let nvidia-smi block heartbeat
                async def _collect_and_emit_stats() -> None:
                    # GPU stats (non-reliable)
                    try:
                        loop = asyncio.get_running_loop()
                        gpu_stats = await loop.run_in_executor(None, self.gpu_monitor.query)
                        await self._emit("gpu_stats", gpu_stats)
                    except Exception as e:
                        log.debug("gpu_stats error (skipping round): %s", e)

                    # System stats (non-reliable)
                    try:
                        loop = asyncio.get_running_loop()
                        pids = self.process_mgr.get_task_pids()
                        sys_stats = await loop.run_in_executor(None, self.system_monitor.collect, pids)
                        if sys_stats.get("mem_total_mb", 0) == 0:
                            log.warning(
                                "system_stats: mem_total_mb=0 — host RAM "
                                "not reported this cycle (psutil may be "
                                "unavailable or returned zero on this node)"
                            )
                        await self._emit("system_stats", sys_stats)
                    except Exception as e:
                        log.warning("system_stats error (skipping round): %s", e)

                    # Per-task resource emit
                    try:
                        for task_id, pid in self.process_mgr.get_task_pids().items():
                            gpu_mem = self.gpu_monitor.get_gpu_mem_for_pid(pid)
                            per = self.system_monitor.collect({task_id: pid})
                            task_per = per.get("per_task", {}).get(task_id, {})
                            await self._emit(
                                "task.resource",
                                {
                                    "task_id": task_id,
                                    "gpu_mem_mb": gpu_mem,
                                    "cpu_mem_mb": task_per.get("mem_mb", 0),
                                    "gpu_util_pct": 0,
                                },
                            )
                    except Exception as e:
                        log.debug("task.resource error: %s", e)

                try:
                    await asyncio.wait_for(_collect_and_emit_stats(), timeout=20)
                except asyncio.TimeoutError:
                    log.warning("heartbeat_loop: stats collection timed out (20s)")

            except Exception as e:
                log.warning("heartbeat_loop error: %s", e)

    async def _walltime_check_loop(self) -> None:
        """SLURM walltime sensing loop (spec §9).

        Checks every 60s. When remaining < 10min, triggers drain:
          1. Stop accepting new tasks.
          2. Send should_checkpoint to all running tasks.
          3. Wait 60s.
          4. Send should_stop to all running tasks.
          5. Wait for tasks to exit (up to walltime - 2min).
          6. Emit draining:walltime status.
        """
        if not self.config.slurm_job_id:
            return  # Not SLURM — skip

        while True:
            await asyncio.sleep(CHECK_INTERVAL_S)
            if self._walltime_draining:
                continue

            remaining = get_remaining_walltime()
            if remaining is None:
                continue

            if remaining < DRAIN_THRESHOLD_S:
                jlog("warn", "stub.walltime_drain",
                     remaining_s=remaining,
                     threshold_s=DRAIN_THRESHOLD_S)
                self._walltime_draining = True
                self.accepting_tasks = False

                # Step 2: SIGTERM all running tasks (triggers SDK stop flag)
                # Give tasks 60s to checkpoint and exit cleanly after SIGTERM
                for task_id in list(self.process_mgr.get_task_pids()):
                    asyncio.create_task(
                        self.process_mgr.kill_graceful(task_id, grace_period_s=60)
                    )

                # Step 3: wait 60s for checkpoint + clean exit
                await asyncio.sleep(60)

                # Step 4: wait up to (remaining - 120s) for remaining tasks
                grace = max(0, remaining - 120)
                jlog("info", "stub.walltime_drain",
                     detail="waiting_for_tasks",
                     grace_s=grace,
                     running=self.process_mgr.running_count())
                deadline = time.monotonic() + grace
                while self.process_mgr.running_count() > 0:
                    if time.monotonic() >= deadline:
                        break
                    await asyncio.sleep(2)

                # Step 6: notify server
                jlog("info", "stub.walltime_drain",
                     detail="drain_complete",
                     remaining_running=self.process_mgr.running_count())
                # Emit a system_stats update so server can see we're draining
                if self._connected:
                    await self._emit("system_stats", {"draining": "walltime"})

    async def _idle_check_loop(self) -> None:
        if self.config.idle_timeout <= 0:
            return
        while True:
            await asyncio.sleep(30)
            if self.process_mgr.running_count() == 0:
                idle_s = time.time() - self.last_task_time
                if idle_s >= self.config.idle_timeout:
                    jlog("info", "stub.stop",
                         reason="idle_timeout",
                         idle_s=round(idle_s),
                         timeout_s=self.config.idle_timeout)
                    os._exit(0)

    async def _log_cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(3600)
            try:
                self.process_mgr.cleanup_old_logs(max_age_hours=24)
            except Exception as e:
                log.debug("log cleanup error: %s", e)

    # ------------------------------------------------------------------ #
    # Main run                                                             #
    # ------------------------------------------------------------------ #

    async def run(self) -> None:
        jlog("info", "daemon.start",
             server=self.config.server,
             default_cwd=self.config.default_cwd,
             max_concurrent=self.config.max_concurrent,
             tags=self.config.tags,
             env_setup=self.config.env_setup[:80] if self.config.env_setup else "")
        log.info(
            "Daemon starting: server=%s cwd=%s max_concurrent=%d tags=%s",
            self.config.server, self.config.default_cwd,
            self.config.max_concurrent, self.config.tags,
        )

        # Re-attach surviving task processes from previous run
        reattached = self.process_mgr.load_and_reattach()
        if reattached:
            log.info("Re-attached %d task(s) from previous run: %s",
                     len(reattached), list(reattached.keys()))
        dead_count = len(self.process_mgr._dead_on_reattach)
        if dead_count:
            log.info("Found %d dead task(s) from previous run", dead_count)

        # Start process monitoring
        self.process_mgr.start_monitoring()

        # Start background tasks
        asyncio.create_task(self._heartbeat_loop())
        asyncio.create_task(self._idle_check_loop())
        asyncio.create_task(self._log_cleanup_loop())
        asyncio.create_task(self._walltime_check_loop())

        # Connect and run forever (socket.io handles reconnection)
        server = self.config.server
        log.info("Connecting to %s", server)
        while True:
            try:
                # Ensure clean state before connecting — prevent double-socket loops
                if self.sio.connected:
                    await self.sio.disconnect()
                await self.sio.connect(server, namespaces=["/stubs"])
                await self.sio.wait()
            except socketio.exceptions.ConnectionError as e:
                jlog("warn", "sio.reconnect", error=str(e))
                log.warning("Connection failed, retrying in 5s: %s", e)
                await asyncio.sleep(5)
            except Exception as e:
                jlog("error", "sio.reconnect", error=str(e))
                log.error("Unexpected connection error, retrying in 5s: %s", e)
                await asyncio.sleep(5)

    async def graceful_drain(self, timeout: float = 300.0) -> None:
        """Stop accepting tasks; wait for running tasks to finish (max timeout s)."""
        self.accepting_tasks = False
        log.info("Draining: waiting for %d task(s) to finish", self.process_mgr.running_count())
        deadline = time.monotonic() + timeout
        while self.process_mgr.running_count() > 0:
            if time.monotonic() >= deadline:
                log.warning("Drain timeout — %d tasks still running", self.process_mgr.running_count())
                break
            await asyncio.sleep(1)
        await self.task_socket_registry.stop_all()
        log.info("Drain complete")
