"""Subprocess management for tasks.

Handles:
 - spawning subprocesses with correct env (ALCHEMY_TASK_ID, ALCHEMY_STUB_SOCKET, ALCHEMY_PARAMS)
 - log tailing (log file per task, survives stub restart)
 - process monitoring (detect exit, report completed/failed)
 - graceful kill chain: should_stop signal → wait grace → SIGTERM → 5s → SIGKILL
 - re-attach surviving processes on hot restart
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
import signal
import subprocess
import threading
import time
from collections import deque
from typing import Any, Callable, Awaitable

from .config import _parse_env_value
from .error_classifier import classify_death, has_checkpoint
from .task_socket import task_socket_path

log = logging.getLogger(__name__)


def merge_env(
    base: dict[str, str],
    default_env: dict[str, str],
    task_overrides: dict[str, str],
    alchemy_vars: dict[str, str],
) -> dict[str, str]:
    """Merge environment layers for task execution.

    Order (later wins): base → default_env → task_overrides → alchemy_vars.

    PATH-like expansion: if a value in default_env or task_overrides starts with
    ``$KEY:`` or ends with ``:$KEY`` (where KEY matches the variable being set),
    the reference is expanded from the *current merged state* so far, allowing
    append/prepend semantics (e.g. PATH=/my/bin:$PATH).

    Other $VAR references are expanded against the merged state at that layer.
    """
    result = dict(base)

    for layer in (default_env, task_overrides):
        for key, value in layer.items():
            # Expand $VAR references against current merged result
            expanded = _parse_env_value(value, result)
            result[key] = expanded

    # ALCHEMY_* vars always win — no expansion needed
    result.update(alchemy_vars)
    return result

_LOG_DIR_ENV = "ALCHEMY_LOG_DIR"
_PID_FILE_DEFAULT = os.path.join(os.path.expanduser("~"), ".alchemy", "stub_tasks.json")
_LOG_DIR_DEFAULT = os.path.join(os.path.expanduser("~"), ".alchemy", "task_logs")


def _log_dir() -> str:
    d = os.environ.get(_LOG_DIR_ENV, _LOG_DIR_DEFAULT)
    os.makedirs(d, exist_ok=True)
    return d


def _log_path(task_id: str) -> str:
    return os.path.join(_log_dir(), f"{task_id}.log")


class ProcessInfo:
    """Tracks a single running subprocess."""

    def __init__(self, task_id: str, pid: int, proc: subprocess.Popen | None = None, run_dir: str | None = None) -> None:
        self.task_id = task_id
        self.pid = pid
        self.proc = proc  # None for re-attached processes
        self.run_dir = run_dir  # For checkpoint detection on death
        self.log_offset = 0
        self.log_buffer: deque[str] = deque(maxlen=500)
        self.log_pending: list[str] = []

    def poll(self) -> int | None:
        """Return exit code if done, None if still running."""
        if self.proc is not None:
            return self.proc.poll()
        # Re-attached process — check via os.kill
        try:
            os.kill(self.pid, 0)
            return None  # alive
        except ProcessLookupError:
            return -1
        except PermissionError:
            return None  # alive but different user


class ProcessManager:
    """Manages concurrent task subprocesses."""

    def __init__(
        self,
        max_concurrent: int = 3,
        env_setup: str = "",
        default_cwd: str = "",
        default_env: dict[str, str] | None = None,
        pid_file: str = _PID_FILE_DEFAULT,
        on_started: Callable[[str, int], Awaitable[None]] | None = None,
        on_log: Callable[[str, list[str]], Awaitable[None]] | None = None,
        on_completed: Callable[[str, int], Awaitable[None]] | None = None,
        on_failed: Callable[[str, int, str], Awaitable[None]] | None = None,
        on_zombie: Callable[[str], Awaitable[None]] | None = None,
    ) -> None:
        self.max_concurrent = max_concurrent
        self.env_setup = env_setup
        self.default_cwd = default_cwd
        self.default_env = default_env or {}
        self.pid_file = pid_file

        self.on_started = on_started
        self.on_log = on_log
        self.on_completed = on_completed
        self.on_failed = on_failed
        self.on_zombie = on_zombie

        # SLURM job ID for death classification (walltime detection)
        self._slurm_job_id: str | None = os.environ.get("SLURM_JOB_ID")

        self._procs: dict[str, ProcessInfo] = {}
        self._pid_lock = threading.Lock()
        self._monitor_task: asyncio.Task | None = None
        # Tasks that died while stub was offline — report on reconnect
        self._dead_on_reattach: list[tuple[str, int]] = []
        self._stub_killed: set[str] = set()

    # ------------------------------------------------------------------ #
    # Public API                                                           #
    # ------------------------------------------------------------------ #

    def start_monitoring(self) -> None:
        self._monitor_task = asyncio.get_running_loop().create_task(self._monitor_loop())

    async def start(
        self,
        task_id: str,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        task_env_setup: str = "",
        params: dict[str, Any] | None = None,
        run_dir: str | None = None,
        env_overrides: dict[str, str] | None = None,
    ) -> int:
        """Spawn subprocess. Returns PID."""
        if task_id in self._procs:
            return self._procs[task_id].pid

        effective_cwd = cwd or self.default_cwd or None

        # Build wrapper shell script
        script = self._build_script(task_id, task_env_setup, env or {}, command)

        # Build ALCHEMY_* vars
        alchemy_vars: dict[str, str] = {"ALCHEMY_TASK_ID": task_id}
        alchemy_vars["ALCHEMY_STUB_SOCKET"] = task_socket_path(task_id)
        if params:
            alchemy_vars["ALCHEMY_PARAMS"] = json.dumps(params)
        if run_dir:
            alchemy_vars["ALCHEMY_RUN_DIR"] = run_dir

        # Merge env layers: process env → default_env → task env + env_overrides → ALCHEMY_*
        # Combine task env and env_overrides into one layer (overrides win)
        combined_task_env = dict(env or {})
        combined_task_env.update(env_overrides or {})
        proc_env = merge_env(
            base=dict(os.environ),
            default_env=self.default_env,
            task_overrides=combined_task_env,
            alchemy_vars=alchemy_vars,
        )

        # Open log file — use context manager to avoid fd leak if Popen raises
        log_path = _log_path(task_id)
        log_file = open(log_path, "w")
        try:
            proc = subprocess.Popen(
                ["bash", "-c", script],
                cwd=effective_cwd,
                env=proc_env,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,  # detach from stub's process group
            )
        except Exception:
            log_file.close()
            raise
        log_file.close()  # stub only reads

        try:
            info = ProcessInfo(task_id=task_id, pid=proc.pid, proc=proc, run_dir=run_dir)
            info.log_offset = 0
            self._procs[task_id] = info
            self._save_pid(task_id, proc.pid)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
            raise

        log.info("Task %s started (pid=%d)", task_id, proc.pid)

        if self.on_started:
            await self.on_started(task_id, proc.pid)

        return proc.pid

    async def kill_graceful(
        self,
        task_id: str,
        grace_period_s: float = 5.0,
    ) -> None:
        """Graceful kill chain:
        1. SIGTERM to process group (triggers SIGTERM handler in SDK → sets stop flag).
        2. Wait grace_period_s.
        3. SIGKILL if still alive.
        """
        info = self._procs.get(task_id)
        if not info:
            return

        self._stub_killed.add(task_id)
        # Step 1: SIGTERM — SDK's SIGTERM handler sets should_stop() = True
        self._send_signal_to_group(info.pid, signal.SIGTERM)

        # Step 2: wait grace period
        deadline = time.monotonic() + grace_period_s
        while time.monotonic() < deadline:
            if info.poll() is not None:
                return  # exited cleanly after SIGTERM
            await asyncio.sleep(0.5)

        # Step 3: SIGKILL
        self._send_signal_to_group(info.pid, signal.SIGKILL)

    def kill_immediate(self, task_id: str) -> None:
        """Immediately SIGKILL the task process group."""
        info = self._procs.get(task_id)
        if info:
            self._send_signal_to_group(info.pid, signal.SIGKILL)

    def pause(self, task_id: str) -> None:
        info = self._procs.get(task_id)
        if info:
            self._send_signal_to_group(info.pid, signal.SIGSTOP)

    def resume_task(self, task_id: str) -> None:
        info = self._procs.get(task_id)
        if info:
            self._send_signal_to_group(info.pid, signal.SIGCONT)

    def is_running(self, task_id: str) -> bool:
        info = self._procs.get(task_id)
        if info is None:
            return False
        if info.proc is not None and info.proc.poll() is not None:
            return False
        return True

    def running_count(self) -> int:
        return len(self._procs)

    def get_task_pids(self) -> dict[str, int]:
        return {tid: info.pid for tid, info in self._procs.items()}

    def get_logs(self, task_id: str) -> list[str]:
        info = self._procs.get(task_id)
        return list(info.log_buffer) if info else []

    # ------------------------------------------------------------------ #
    # Re-attach on hot restart                                             #
    # ------------------------------------------------------------------ #

    def load_and_reattach(self) -> dict[str, int]:
        """Try to re-attach surviving processes from a previous stub run.

        Returns {task_id: pid} for alive processes.
        Dead processes are stored in self._dead_on_reattach.
        """
        result: dict[str, int] = {}
        self._dead_on_reattach = []
        try:
            if not os.path.exists(self.pid_file):
                return {}
            with open(self.pid_file) as f:
                data: dict[str, int] = json.load(f)
            for task_id, pid in data.items():
                try:
                    os.kill(pid, 0)
                    # Alive — create ProcessInfo without a Popen handle
                    info = ProcessInfo(task_id=task_id, pid=pid, proc=None)
                    lp = _log_path(task_id)
                    info.log_offset = os.path.getsize(lp) if os.path.exists(lp) else 0
                    self._procs[task_id] = info
                    result[task_id] = pid
                    log.info("Re-attached task %s (pid=%d)", task_id, pid)
                except ProcessLookupError:
                    log.info("Task %s (pid=%d) died while stub was offline", task_id, pid)
                    self._dead_on_reattach.append((task_id, pid))
                    self._remove_pid(task_id)
        except Exception as e:
            log.warning("load_and_reattach failed: %s", e)
        return result

    # ------------------------------------------------------------------ #
    # Monitor loop                                                         #
    # ------------------------------------------------------------------ #

    async def _monitor_loop(self) -> None:
        tick = 0
        while True:
            await asyncio.sleep(0.5)
            tick += 1
            try:
                self._tail_logs()
                if tick % 4 == 0:  # every 2 seconds
                    await self._flush_logs()
                    await self._check_completions()
            except Exception as e:
                log.error("monitor_loop error: %s", e)

    def _tail_logs(self) -> None:
        for task_id, info in list(self._procs.items()):
            lp = _log_path(task_id)
            try:
                with open(lp, "r", errors="replace") as f:
                    f.seek(info.log_offset)
                    new = f.read()
                    if new:
                        info.log_offset = f.tell()
                        for line in new.splitlines():
                            info.log_buffer.append(line)
                            info.log_pending.append(line)
            except FileNotFoundError:
                pass

    async def _flush_logs(self) -> None:
        for task_id, info in list(self._procs.items()):
            if info.log_pending and self.on_log:
                lines = info.log_pending
                info.log_pending = []
                try:
                    await self.on_log(task_id, lines)
                except Exception as e:
                    log.debug("on_log error: %s", e)

    async def _check_completions(self) -> None:
        done: list[tuple[str, int, ProcessInfo]] = []
        for task_id, info in list(self._procs.items()):
            rc = info.poll()
            if rc is not None:
                done.append((task_id, rc, info))

        for task_id, exit_code, info in done:
            self._procs.pop(task_id, None)

            # Final read of log file to capture lines written after last _tail_logs
            lp = _log_path(task_id)
            try:
                with open(lp, "r", errors="replace") as f:
                    f.seek(info.log_offset)
                    new = f.read()
                    if new:
                        info.log_offset = f.tell()
                        for line in new.splitlines():
                            info.log_buffer.append(line)
                            info.log_pending.append(line)
            except FileNotFoundError:
                pass

            # Flush remaining logs
            if info.log_pending and self.on_log:
                try:
                    await self.on_log(task_id, info.log_pending)
                except Exception:
                    pass

            self._remove_pid(task_id)

            # Classify death cause and check for checkpoints
            killed_by_stub = task_id in self._stub_killed
            self._stub_killed.discard(task_id)
            death_cause = classify_death(
                exit_code=exit_code,
                slurm_job_id=self._slurm_job_id,
                killed_by_stub=killed_by_stub,
            )
            ckpt = has_checkpoint(info.run_dir)
            log.info(
                "Task %s exited (exit_code=%d, death_cause=%s, has_checkpoint=%s)",
                task_id, exit_code, death_cause, ckpt,
            )

            if exit_code == 0:
                if self.on_completed:
                    await self.on_completed(task_id, exit_code, death_cause, ckpt)
            else:
                error_msg = f"Process exited with code {exit_code}"
                if self.on_failed:
                    await self.on_failed(task_id, exit_code, error_msg, death_cause, ckpt)

    # ------------------------------------------------------------------ #
    # Internal helpers                                                     #
    # ------------------------------------------------------------------ #

    def _build_script(
        self,
        task_id: str,
        task_env_setup: str,
        env: dict[str, str],
        command: str,
    ) -> str:
        """Assemble the shell script that wraps the task command.

        NOTE: env vars are NOT exported here — they are set via proc_env
        (through merge_env). This method only handles env_setup commands
        and the actual command.
        """
        parts: list[str] = ["set -e"]
        if self.env_setup:
            parts.append(self.env_setup)
        if task_env_setup:
            parts.append(task_env_setup)
        parts.append(command)
        return "\n".join(parts)

    @staticmethod
    def _send_signal_to_group(pid: int, sig: signal.Signals) -> None:
        try:
            pgid = os.getpgid(pid)
            os.killpg(pgid, sig)
        except ProcessLookupError:
            pass
        except Exception as e:
            log.debug("send_signal_to_group pid=%d sig=%s: %s", pid, sig, e)

    def _save_pid(self, task_id: str, pid: int) -> None:
        with self._pid_lock:
            try:
                data: dict = {}
                if os.path.exists(self.pid_file):
                    with open(self.pid_file) as f:
                        data = json.load(f)
                data[task_id] = pid
                tmp = self.pid_file + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(data, f)
                os.replace(tmp, self.pid_file)
            except Exception as e:
                log.debug("_save_pid error: %s", e)

    def _remove_pid(self, task_id: str) -> None:
        with self._pid_lock:
            try:
                if not os.path.exists(self.pid_file):
                    return
                with open(self.pid_file) as f:
                    data = json.load(f)
                data.pop(task_id, None)
                tmp = self.pid_file + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(data, f)
                os.replace(tmp, self.pid_file)
            except Exception as e:
                log.debug("_remove_pid error: %s", e)

    def cleanup_old_logs(self, max_age_hours: int = 24) -> None:
        ld = _log_dir()
        cutoff = time.time() - max_age_hours * 3600
        try:
            for fname in os.listdir(ld):
                if not fname.endswith(".log"):
                    continue
                tid = fname[:-4]
                if tid in self._procs:
                    continue
                fpath = os.path.join(ld, fname)
                try:
                    if os.path.getmtime(fpath) < cutoff:
                        os.remove(fpath)
                except Exception:
                    pass
        except Exception:
            pass
