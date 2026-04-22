"""Subprocess management for tasks."""
import asyncio
import os
import signal
import subprocess
import json
import time
from collections import deque
from typing import Callable, Awaitable, Any


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
        self._monitor_task: asyncio.Task | None = None

    def start_monitoring(self):
        loop = asyncio.get_event_loop()
        self._monitor_task = loop.create_task(self._monitor_loop())

    async def _monitor_loop(self):
        """Poll processes and send log batches every 2s."""
        while True:
            await asyncio.sleep(2)
            try:
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
            ret = proc.poll()
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
            self._remove_pid(task_id)

            if exit_code == 0:
                if self.on_completed:
                    await self.on_completed(task_id, exit_code)
            else:
                if self.on_failed:
                    await self.on_failed(task_id, exit_code, f"Exit code {exit_code}")

    def _build_script(self, task_env_setup: str, env: dict[str, str], command: str) -> str:
        parts = ["set -e"]
        if self.env_setup:
            parts.append(self.env_setup)
        if task_env_setup:
            parts.append(task_env_setup)
        for k, v in env.items():
            parts.append(f"export {k}={v!r}")
        parts.append(f"exec {command}")
        return "\n".join(parts)

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

        proc = subprocess.Popen(
            ["bash", "-c", script],
            cwd=cwd,
            env=proc_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,  # survive stub restart
            text=True,
            bufsize=1,
        )

        self.processes[task_id] = proc
        self.log_buffers[task_id] = deque(maxlen=500)
        self.log_pending[task_id] = []
        self._save_pid(task_id, proc.pid)

        # Start reading stdout in thread
        import threading
        t = threading.Thread(target=self._read_output, args=(task_id, proc), daemon=True)
        t.start()

        return proc.pid

    def _read_output(self, task_id: str, proc: subprocess.Popen):
        try:
            for line in proc.stdout:  # type: ignore
                line = line.rstrip("\n")
                if task_id in self.log_buffers:
                    self.log_buffers[task_id].append(line)
                if task_id in self.log_pending:
                    self.log_pending[task_id].append(line)
        except Exception:
            pass

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
                import threading
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

    def load_and_reattach(self) -> dict[str, int]:
        """Try to re-attach surviving processes from previous stub run."""
        result = {}
        try:
            if not os.path.exists(self.pid_file):
                return result
            with open(self.pid_file) as f:
                data = json.load(f)
            for task_id, pid in data.items():
                try:
                    os.kill(pid, 0)  # check if alive
                    result[task_id] = pid
                    print(f"[process_mgr] Re-attached task {task_id} (pid {pid})")
                except ProcessLookupError:
                    print(f"[process_mgr] Task {task_id} (pid {pid}) no longer alive")
        except Exception as e:
            print(f"[process_mgr] Failed to load PID file: {e}")
        return result
