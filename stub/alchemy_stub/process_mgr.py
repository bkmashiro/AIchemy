"""Subprocess management for tasks."""
import asyncio
import os
import shlex
import signal
import subprocess
import json
import threading
import time
from collections import deque
from typing import Callable, Awaitable, Any

from .error_classifier import classify_failure


class ProcessManager:
    """Manages concurrent subprocesses for tasks."""

    def __init__(
        self,
        max_concurrent: int = 3,
        env_setup: str = "",
        pid_file: str = "/tmp/alchemy_stub_tasks.json",
        on_started: Callable[[str, int], Awaitable[None]] | None = None,
        on_log: Callable[[str, list[str]], Awaitable[None]] | None = None,
        on_completed: Callable[[str, int], Awaitable[None]] | None = None,
        on_failed: Callable[[str, int, str], Awaitable[None]] | None = None,
    ):
        self.max_concurrent = max_concurrent
        self.env_setup = env_setup
        self.pid_file = pid_file
        self.on_started = on_started
        self.on_log = on_log
        self.on_completed = on_completed
        self.on_failed = on_failed

        self.processes: dict[str, subprocess.Popen] = {}
        self.log_buffers: dict[str, deque[str]] = {}
        self.log_pending: dict[str, list[str]] = {}  # lines accumulated since last send
        self._log_offsets: dict[str, int] = {}  # file read offsets for tail
        self._monitor_task: asyncio.Task | None = None
        self._pid_lock = threading.Lock()

    def start_monitoring(self):
        loop = asyncio.get_event_loop()
        self._monitor_task = loop.create_task(self._monitor_loop())

    async def _monitor_loop(self):
        """Tail logs every 0.5s, flush to server and check completions every 2s."""
        tick = 0
        while True:
            await asyncio.sleep(0.5)
            tick += 1
            try:
                self._tail_logs()
                if tick % 4 == 0:  # every 2s
                    await self._flush_logs()
                    await self._check_completions()
            except Exception as e:
                print(f"[process_mgr] Monitor loop error: {e}")

    async def _flush_logs(self):
        for task_id, lines in list(self.log_pending.items()):
            if lines and self.on_log:
                await self.on_log(task_id, lines)
                self.log_pending[task_id] = []

    async def _check_completions(self):
        done = []
        for task_id, proc in list(self.processes.items()):
            ret = proc.poll() if hasattr(proc, '_child_created') else self._check_pid(proc.pid)
            if ret is not None:
                done.append((task_id, ret))

        for task_id, exit_code in done:
            # Flush remaining logs
            if task_id in self.log_pending and self.log_pending[task_id]:
                if self.on_log:
                    await self.on_log(task_id, self.log_pending[task_id])
                self.log_pending[task_id] = []

            del self.processes[task_id]
            if task_id in self.log_pending:
                del self.log_pending[task_id]
            self._log_offsets.pop(task_id, None)
            self._remove_pid(task_id)

            if exit_code == 0:
                if self.on_completed:
                    await self.on_completed(task_id, exit_code)
            else:
                if self.on_failed:
                    # Read last 50 lines from log file for classification
                    last_lines: list[str] = []
                    log_path = self._log_path(task_id)
                    try:
                        with open(log_path, "r") as f:
                            last_lines = f.read().splitlines()[-50:]
                    except Exception:
                        pass
                    failure_reason = classify_failure(exit_code, last_lines)
                    await self.on_failed(task_id, exit_code, f"Exit code {exit_code}", failure_reason)

    def _build_script(self, task_env_setup: str, env: dict[str, str], command: str) -> str:
        parts = ["set -e"]
        if self.env_setup:
            parts.append(self.env_setup)
        if task_env_setup:
            parts.append(task_env_setup)
        for k, v in env.items():
            parts.append(f"export {k}={shlex.quote(v)}")
        parts.append(command)
        return "\n".join(parts)

    def _log_dir(self) -> str:
        d = os.path.join(os.environ.get("ALCHEMY_LOG_DIR", "/tmp"), "alchemy_task_logs")
        os.makedirs(d, exist_ok=True)
        return d

    def _log_path(self, task_id: str) -> str:
        return os.path.join(self._log_dir(), f"{task_id}.log")

    def start(
        self,
        task_id: str,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        env_setup: str = "",
    ) -> int:
        """Start task subprocess. Returns PID."""
        if task_id in self.processes:
            return self.processes[task_id].pid

        script = self._build_script(env_setup, env or {}, command)

        proc_env = os.environ.copy()
        proc_env["ALCHEMY_TASK_ID"] = task_id
        if env:
            proc_env.update(env)

        # Write stdout to file instead of pipe — survives daemon restart
        log_path = self._log_path(task_id)
        log_file = open(log_path, "w")

        proc = subprocess.Popen(
            ["bash", "-c", script],
            cwd=cwd,
            env=proc_env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,  # survive stub restart
        )

        log_file.close()  # daemon doesn't need the write fd

        self.processes[task_id] = proc
        self.log_buffers[task_id] = deque(maxlen=500)
        self.log_pending[task_id] = []
        self._log_offsets[task_id] = 0
        self._save_pid(task_id, proc.pid)

        return proc.pid

    def _tail_logs(self):
        """Read new lines from all task log files."""
        for task_id in list(self.processes.keys()):
            log_path = self._log_path(task_id)
            try:
                with open(log_path, "r") as f:
                    f.seek(self._log_offsets.get(task_id, 0))
                    new_data = f.read()
                    if new_data:
                        self._log_offsets[task_id] = f.tell()
                        for line in new_data.splitlines():
                            if task_id in self.log_buffers:
                                self.log_buffers[task_id].append(line)
                            if task_id in self.log_pending:
                                self.log_pending[task_id].append(line)
            except FileNotFoundError:
                pass

    @staticmethod
    def _check_pid(pid: int) -> int | None:
        """Check if a re-attached process (not a real Popen) is still alive."""
        try:
            os.kill(pid, 0)
            return None  # still running
        except ProcessLookupError:
            return -1  # dead, unknown exit code

    def kill(self, task_id: str, sig: str = "SIGTERM"):
        proc = self.processes.get(task_id)
        if not proc:
            return
        try:
            pgid = os.getpgid(proc.pid)
            sig_num = signal.SIGTERM if sig == "SIGTERM" else signal.SIGKILL
            os.killpg(pgid, sig_num)
            if sig == "SIGTERM":
                # Give it 10s then SIGKILL
                def force_kill():
                    time.sleep(10)
                    try:
                        os.killpg(pgid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                threading.Thread(target=force_kill, daemon=True).start()
        except ProcessLookupError:
            pass

    def pause(self, task_id: str):
        proc = self.processes.get(task_id)
        if not proc:
            return
        try:
            pgid = os.getpgid(proc.pid)
            os.killpg(pgid, signal.SIGSTOP)
        except ProcessLookupError:
            pass

    def resume(self, task_id: str):
        proc = self.processes.get(task_id)
        if not proc:
            return
        try:
            pgid = os.getpgid(proc.pid)
            os.killpg(pgid, signal.SIGCONT)
        except ProcessLookupError:
            pass

    def get_logs(self, task_id: str) -> list[str]:
        buf = self.log_buffers.get(task_id)
        if buf is None:
            return []
        return list(buf)

    def is_running(self, task_id: str) -> bool:
        return task_id in self.processes

    def running_count(self) -> int:
        return len(self.processes)

    def _save_pid(self, task_id: str, pid: int):
        with self._pid_lock:
            try:
                data: dict = {}
                if os.path.exists(self.pid_file):
                    with open(self.pid_file) as f:
                        data = json.load(f)
                data[task_id] = pid
                with open(self.pid_file, "w") as f:
                    json.dump(data, f)
            except Exception:
                pass

    def _remove_pid(self, task_id: str):
        with self._pid_lock:
            try:
                if not os.path.exists(self.pid_file):
                    return
                with open(self.pid_file) as f:
                    data = json.load(f)
                data.pop(task_id, None)
                with open(self.pid_file, "w") as f:
                    json.dump(data, f)
            except Exception:
                pass

    def cleanup_old_logs(self, max_age_hours: int = 24):
        """Delete log files for tasks no longer tracked and older than max_age_hours."""
        log_dir = self._log_dir()
        now = time.time()
        cutoff = now - max_age_hours * 3600
        try:
            for f in os.listdir(log_dir):
                if not f.endswith(".log"):
                    continue
                task_id = f[:-4]
                if task_id in self.processes:
                    continue  # still running
                path = os.path.join(log_dir, f)
                try:
                    if os.path.getmtime(path) < cutoff:
                        os.remove(path)
                except Exception:
                    pass
        except Exception:
            pass

    def validate_before_start(
        self, command: str, cwd: str | None, env: dict
    ) -> tuple[bool, str]:
        """Validate task can run. Returns (ok, error_message)."""
        from .disk_monitor import check_low_disk

        # Check disk space
        warnings = check_low_disk(threshold_gb=2.0)
        if warnings:
            w = warnings[0]
            return False, f"Low disk space: {w['path']} has {w['free_gb']}GB free"

        # Check cwd exists
        if cwd and not os.path.isdir(cwd):
            return False, f"Working directory does not exist: {cwd}"

        # Check concurrent limit
        if self.running_count() >= self.max_concurrent:
            return False, f"At max concurrent tasks ({self.max_concurrent})"

        return True, ""

    def load_and_reattach(self) -> dict[str, int]:
        """Try to re-attach surviving processes from previous stub run.
        Returns dict of {task_id: pid} for alive processes.
        Dead processes are reported via self._dead_on_reattach for the daemon to handle.
        """
        result = {}
        self._dead_on_reattach: list[tuple[str, int]] = []
        try:
            if not os.path.exists(self.pid_file):
                return result
            with open(self.pid_file) as f:
                data = json.load(f)
            for task_id, pid in data.items():
                try:
                    os.kill(pid, 0)  # check if alive
                    # Create a fake Popen to track the process
                    proc = subprocess.Popen.__new__(subprocess.Popen)
                    proc.pid = pid
                    proc.returncode = None
                    self.processes[task_id] = proc
                    self.log_buffers[task_id] = deque(maxlen=500)
                    self.log_pending[task_id] = []
                    # Seek to end of existing log — only stream new output
                    log_path = self._log_path(task_id)
                    if os.path.exists(log_path):
                        self._log_offsets[task_id] = os.path.getsize(log_path)
                    else:
                        self._log_offsets[task_id] = 0
                    result[task_id] = pid
                    print(f"[process_mgr] Re-attached task {task_id} (pid {pid})")
                except ProcessLookupError:
                    print(f"[process_mgr] Task {task_id} (pid {pid}) no longer alive, will report")
                    self._dead_on_reattach.append((task_id, pid))
                    self._remove_pid(task_id)
        except Exception as e:
            print(f"[process_mgr] Failed to load PID file: {e}")
        return result
