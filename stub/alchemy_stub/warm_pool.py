"""Warm worker pool manager.

Manages a set of pre-started WarmWorker processes that accept tasks via Unix
sockets, avoiding the per-task cost of Python interpreter startup + import.

Usage:
    pool = WarmPool(size=3, env_setup="conda activate myenv")
    await pool.start()
    pid = await pool.submit(task_id, script, cwd, env, params, run_dir, config_path, stub_socket)
    await pool.kill_task(task_id)
    await pool.shutdown()
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import socket
import struct
import subprocess
import sys
import time
from typing import Any

log = logging.getLogger(__name__)

_HDR_FMT = ">I"
_HDR_SIZE = 4
_PING_TIMEOUT = 5.0       # seconds to wait for ping response
_TASK_CONNECT_TIMEOUT = 5.0  # seconds to connect to worker socket
_RESPAWN_DELAY = 1.0      # seconds between respawn attempts


def worker_socket_path(worker_id: str) -> str:
    return f"/tmp/alchemy_warm_{worker_id}.sock"


# --------------------------------------------------------------------------- #
# Low-level socket helpers (sync, run in executor for async callers)          #
# --------------------------------------------------------------------------- #

def _send_msg_sync(sock: socket.socket, payload: dict) -> None:
    data = json.dumps(payload).encode("utf-8")
    header = struct.pack(_HDR_FMT, len(data))
    sock.sendall(header + data)


def _recv_msg_sync(sock: socket.socket, timeout: float = 30.0) -> dict | None:
    sock.settimeout(timeout)
    try:
        header = _recv_exactly_sync(sock, _HDR_SIZE)
        if header is None:
            return None
        length = struct.unpack(_HDR_FMT, header)[0]
        if length == 0:
            return {}
        body = _recv_exactly_sync(sock, length)
        if body is None:
            return None
        return json.loads(body.decode("utf-8"))
    except (OSError, json.JSONDecodeError, struct.error):
        return None


def _recv_exactly_sync(sock: socket.socket, n: int) -> bytes | None:
    buf = b""
    while len(buf) < n:
        try:
            chunk = sock.recv(n - len(buf))
        except OSError:
            return None
        if not chunk:
            return None
        buf += chunk
    return buf


def _ping_worker_sync(sock_path: str) -> bool:
    """Connect and ping a worker. Returns True if alive."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(_PING_TIMEOUT)
            s.connect(sock_path)
            _send_msg_sync(s, {"type": "ping"})
            resp = _recv_msg_sync(s, timeout=_PING_TIMEOUT)
            return resp is not None and resp.get("type") == "pong"
    except Exception:
        return False


def _send_task_sync(sock_path: str, payload: dict, timeout: float) -> dict | None:
    """Send task to worker and wait for result. Returns result dict or None on error."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(_TASK_CONNECT_TIMEOUT)
            s.connect(sock_path)
            _send_msg_sync(s, payload)
            # Task execution can take arbitrarily long — use the caller-provided timeout
            # (0 = no timeout; we set a large value to avoid hanging forever)
            result = _recv_msg_sync(s, timeout=max(timeout, 3600 * 24))
            return result
    except Exception as e:
        log.warning("_send_task_sync error for %s: %s", sock_path, e)
        return None


# --------------------------------------------------------------------------- #
# Worker state                                                                  #
# --------------------------------------------------------------------------- #

class _WorkerState:
    """Tracks one worker subprocess."""

    def __init__(self, worker_id: str) -> None:
        self.worker_id = worker_id
        self.sock_path = worker_socket_path(worker_id)
        self.proc: subprocess.Popen | None = None
        self.pid: int | None = None
        self.current_task_id: str | None = None
        self.busy: bool = False

    def is_alive(self) -> bool:
        if self.proc is None or self.pid is None:
            return False
        return self.proc.poll() is None

    def kill(self, grace: float = 5.0) -> None:
        if self.proc is None:
            return
        try:
            self.proc.terminate()
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                return
            time.sleep(0.1)
        try:
            self.proc.kill()
            self.proc.wait(timeout=5)
        except Exception:
            pass

    def cleanup_socket(self) -> None:
        try:
            os.unlink(self.sock_path)
        except FileNotFoundError:
            pass


# --------------------------------------------------------------------------- #
# WarmPool                                                                      #
# --------------------------------------------------------------------------- #

class WarmPool:
    """Pool of warm worker processes."""

    def __init__(
        self,
        size: int,
        python_path: str | None = None,
        env_setup: str = "",
        preload: list[str] | None = None,
    ) -> None:
        self.size = size
        self.python_path = python_path or sys.executable
        self.env_setup = env_setup
        self.preload = preload if preload is not None else ["torch", "numpy"]

        # worker_id → _WorkerState
        self._workers: dict[str, _WorkerState] = {}
        # task_id → worker_id (for kill lookup)
        self._task_worker: dict[str, str] = {}
        # task_id → exit_code (populated when task finishes)
        self._task_results: dict[str, int] = {}
        # Semaphore to limit concurrency to pool size
        self._sem: asyncio.Semaphore | None = None
        # Lock around worker state mutations
        self._lock = asyncio.Lock()
        self._started = False
        self._shutting_down = False

    # ---------------------------------------------------------------------- #
    # Public API                                                               #
    # ---------------------------------------------------------------------- #

    async def start(self) -> None:
        """Spawn all workers and wait until they're ready."""
        if self._started:
            return
        self._started = True
        self._sem = asyncio.Semaphore(self.size)

        spawn_tasks = []
        for i in range(self.size):
            worker_id = f"w{i}"
            state = _WorkerState(worker_id)
            self._workers[worker_id] = state
            spawn_tasks.append(asyncio.create_task(self._spawn_worker(state)))

        # Wait for all workers to be ready (or fail — they'll be respawned on demand)
        results = await asyncio.gather(*spawn_tasks, return_exceptions=True)
        alive = sum(1 for r in results if r is not True and not isinstance(r, Exception))
        ready = sum(1 for w in self._workers.values() if w.is_alive())
        log.info("WarmPool: started %d/%d workers", ready, self.size)

    async def submit(
        self,
        task_id: str,
        script: str,
        cwd: str | None,
        env: dict[str, str],
        params: dict | None,
        run_dir: str | None,
        config_path: str | None,
        stub_socket: str,
    ) -> int:
        """Submit a task. Blocks until a worker is free. Returns worker PID."""
        assert self._sem is not None, "call start() first"

        payload = {
            "type": "task",
            "task_id": task_id,
            "script": script,
            "cwd": cwd,
            "env": env,
            "params": params,
            "run_dir": run_dir,
            "config_path": config_path,
            "stub_socket": stub_socket,
        }

        await self._sem.acquire()
        # Find a free, alive worker (or spawn one if needed)
        worker = await self._acquire_worker(task_id)
        pid = worker.pid or 0

        # Run task in background — release semaphore and mark worker free when done
        asyncio.create_task(self._run_task_on_worker(worker, task_id, payload))
        return pid

    async def kill_task(self, task_id: str, grace_period: float = 5.0) -> None:
        """Kill the worker running this task, then respawn it."""
        async with self._lock:
            worker_id = self._task_worker.pop(task_id, None)
            if worker_id is None:
                return
            state = self._workers.get(worker_id)
            if state is None:
                return
            state.busy = False
            state.current_task_id = None

        if state is not None:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, state.kill, grace_period)
            state.proc = None
            state.pid = None
            state.cleanup_socket()
            # Respawn the slot
            if not self._shutting_down:
                asyncio.create_task(self._spawn_worker(state))
            # Release semaphore so another task can be submitted
            if self._sem:
                self._sem.release()

    async def shutdown(self) -> None:
        """Gracefully stop all workers."""
        self._shutting_down = True
        async with self._lock:
            states = list(self._workers.values())

        loop = asyncio.get_running_loop()
        for state in states:
            if state.is_alive():
                await loop.run_in_executor(None, state.kill, 5.0)
            state.cleanup_socket()
        log.info("WarmPool: all workers stopped")

    def get_worker_for_task(self, task_id: str) -> int | None:
        """Get PID of worker running a task."""
        worker_id = self._task_worker.get(task_id)
        if worker_id is None:
            return None
        state = self._workers.get(worker_id)
        return state.pid if state else None

    def pop_task_result(self, task_id: str) -> int | None:
        """Return and remove the exit code for a completed task. None if still running."""
        return self._task_results.pop(task_id, None)

    # ---------------------------------------------------------------------- #
    # Internal                                                                 #
    # ---------------------------------------------------------------------- #

    async def _spawn_worker(self, state: _WorkerState, attempt: int = 0) -> bool:
        """Spawn (or respawn) a worker process. Returns True on success."""
        state.cleanup_socket()
        preload_str = ",".join(self.preload) if self.preload else ""
        cmd_parts = [
            self.python_path, "-m", "alchemy_stub.warm_worker",
            "--id", state.worker_id,
            "--preload", preload_str,
        ]
        if self.env_setup:
            shell_cmd = f"{self.env_setup} && {' '.join(cmd_parts)}"
            cmd = ["bash", "-c", shell_cmd]
        else:
            cmd = cmd_parts

        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            state.proc = proc
            state.pid = proc.pid
            state.busy = False
            state.current_task_id = None
        except Exception as e:
            log.error("WarmPool: failed to spawn worker %s: %s", state.worker_id, e)
            return False

        # Wait for socket to appear (worker ready)
        loop = asyncio.get_running_loop()
        ready = await loop.run_in_executor(None, self._wait_for_socket, state)
        if ready:
            log.info("WarmPool: worker %s ready (pid=%d)", state.worker_id, state.pid)
        else:
            log.warning("WarmPool: worker %s did not become ready", state.worker_id)
        return ready

    @staticmethod
    def _wait_for_socket(state: _WorkerState, timeout: float = 30.0) -> bool:
        """Poll until worker socket appears and responds to ping."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not state.is_alive():
                return False
            if os.path.exists(state.sock_path):
                if _ping_worker_sync(state.sock_path):
                    return True
            time.sleep(0.2)
        return False

    async def _acquire_worker(self, task_id: str) -> _WorkerState:
        """Find a free worker. Respawns dead workers as needed."""
        while True:
            async with self._lock:
                # Find a free, alive worker
                for state in self._workers.values():
                    if not state.busy and state.is_alive():
                        state.busy = True
                        state.current_task_id = task_id
                        self._task_worker[task_id] = state.worker_id
                        return state
                # All workers busy or dead — check for dead ones to respawn
                dead = [s for s in self._workers.values() if not state.is_alive() and not state.busy]

            if dead:
                # Respawn first dead worker
                s = dead[0]
                await self._spawn_worker(s)
            else:
                # All busy — wait briefly and retry
                await asyncio.sleep(0.1)

    async def _run_task_on_worker(
        self,
        worker: _WorkerState,
        task_id: str,
        payload: dict,
    ) -> None:
        """Run task on worker, handle result, release resources."""
        sock_path = worker.sock_path
        loop = asyncio.get_running_loop()

        try:
            result = await loop.run_in_executor(
                None,
                _send_task_sync,
                sock_path,
                payload,
                0.0,  # no timeout — let task run as long as needed
            )
        except Exception as e:
            log.error("WarmPool: task %s execution error: %s", task_id, e)
            result = None

        async with self._lock:
            self._task_worker.pop(task_id, None)
            worker.busy = False
            worker.current_task_id = None
            # Store exit code for ProcessManager monitor to read
            exit_code_for_monitor = result.get("exit_code", -1) if result else -1
            self._task_results[task_id] = exit_code_for_monitor

        if result is None:
            # Worker likely died — respawn
            log.warning("WarmPool: worker %s died during task %s, respawning", worker.worker_id, task_id)
            if not self._shutting_down:
                if not worker.is_alive():
                    worker.cleanup_socket()
                    asyncio.create_task(self._spawn_worker(worker))

        # Release semaphore (whether success or failure)
        if self._sem:
            self._sem.release()

        exit_code = result.get("exit_code", -1) if result else -1
        error = result.get("error") if result else "Worker died unexpectedly"
        log.info(
            "WarmPool: task %s finished (exit_code=%d, worker=%s)",
            task_id, exit_code, worker.worker_id,
        )
