"""Unix socket server per running task.

Socket path: /tmp/alchemy_task_{task_id}.sock
Protocol: newline-delimited JSON

SDK → Stub messages:
  { "type": "progress", "step": N, "total": N, "loss": F, "metrics": {} }
  { "type": "eval",     "metrics": {} }
  { "type": "checkpoint", "path": "..." }
  { "type": "config",   "config": {} }
  { "type": "done",     "metrics": {} }
  { "type": "notify",   "message": "...", "level": "info" }
  { "type": "heartbeat" }

Zombie detection: 60s no heartbeat but PID alive → zombie callback.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, Callable, Awaitable

log = logging.getLogger(__name__)

SOCKET_DIR = "/tmp"
HEARTBEAT_TIMEOUT = 60.0  # seconds — no heartbeat → zombie


def task_socket_path(task_id: str) -> str:
    return os.path.join(SOCKET_DIR, f"alchemy_task_{task_id}.sock")


class TaskSocket:
    """Manages one Unix socket server for a single task.

    Callbacks (all async):
        on_progress(task_id, step, total, loss, metrics)
        on_eval(task_id, metrics)
        on_checkpoint(task_id, path)
        on_config(task_id, config)
        on_done(task_id, metrics)
        on_notify(task_id, message, level)
        on_zombie(task_id)
    """

    def __init__(
        self,
        task_id: str,
        pid: int,
        on_progress: Callable[..., Awaitable[None]] | None = None,
        on_eval: Callable[..., Awaitable[None]] | None = None,
        on_checkpoint: Callable[..., Awaitable[None]] | None = None,
        on_config: Callable[..., Awaitable[None]] | None = None,
        on_done: Callable[..., Awaitable[None]] | None = None,
        on_notify: Callable[..., Awaitable[None]] | None = None,
        on_zombie: Callable[..., Awaitable[None]] | None = None,
    ) -> None:
        self.task_id = task_id
        self.pid = pid
        self._on_progress = on_progress
        self._on_eval = on_eval
        self._on_checkpoint = on_checkpoint
        self._on_config = on_config
        self._on_done = on_done
        self._on_notify = on_notify
        self._on_zombie = on_zombie

        self._sock_path = task_socket_path(task_id)
        self._server: asyncio.AbstractServer | None = None
        self._last_heartbeat = time.monotonic()
        self._writers: list[asyncio.StreamWriter] = []
        self._zombie_task: asyncio.Task | None = None
        self._running = False

    # ------------------------------------------------------------------ #
    # Lifecycle                                                            #
    # ------------------------------------------------------------------ #

    async def start(self) -> None:
        """Create Unix socket, start accepting connections."""
        # Remove stale socket
        try:
            os.unlink(self._sock_path)
        except FileNotFoundError:
            pass

        self._server = await asyncio.start_unix_server(
            self._handle_client, path=self._sock_path
        )
        os.chmod(self._sock_path, 0o666)  # allow different users
        self._running = True
        self._zombie_task = asyncio.create_task(self._zombie_watcher())
        log.debug("TaskSocket started: %s", self._sock_path)

    async def stop(self) -> None:
        """Stop socket server and clean up."""
        self._running = False
        if self._zombie_task:
            self._zombie_task.cancel()
            try:
                await self._zombie_task
            except asyncio.CancelledError:
                pass
        if self._server:
            self._server.close()
            await self._server.wait_closed()
        for w in self._writers:
            try:
                w.close()
                await w.wait_closed()
            except Exception:
                pass
        try:
            os.unlink(self._sock_path)
        except FileNotFoundError:
            pass
        log.debug("TaskSocket stopped: %s", self._sock_path)

    # ------------------------------------------------------------------ #
    # Client handling                                                      #
    # ------------------------------------------------------------------ #

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        self._writers.append(writer)
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                await self._handle_message(line.decode().strip())
        except (asyncio.IncompleteReadError, ConnectionResetError):
            pass
        except Exception as e:
            log.debug("task socket client error: %s", e)
        finally:
            try:
                self._writers.remove(writer)
            except ValueError:
                pass
            try:
                writer.close()
            except Exception:
                pass

    async def _handle_message(self, raw: str) -> None:
        if not raw:
            return
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            log.debug("invalid JSON from SDK: %r", raw)
            return

        mtype = msg.get("type")
        if mtype == "heartbeat":
            self._last_heartbeat = time.monotonic()
        elif mtype == "progress":
            self._last_heartbeat = time.monotonic()
            if self._on_progress:
                await self._on_progress(
                    self.task_id,
                    msg.get("step", 0),
                    msg.get("total", 0),
                    msg.get("loss"),
                    msg.get("metrics") or {},
                )
        elif mtype == "eval":
            if self._on_eval:
                await self._on_eval(self.task_id, msg.get("metrics") or {})
        elif mtype == "checkpoint":
            if self._on_checkpoint:
                await self._on_checkpoint(self.task_id, msg.get("path", ""))
        elif mtype == "config":
            if self._on_config:
                await self._on_config(self.task_id, msg.get("config") or {})
        elif mtype == "done":
            if self._on_done:
                await self._on_done(self.task_id, msg.get("metrics") or {})
        elif mtype == "notify":
            if self._on_notify:
                await self._on_notify(
                    self.task_id,
                    msg.get("message", ""),
                    msg.get("level", "info"),
                )
        else:
            log.debug("unknown SDK message type: %s", mtype)

    # ------------------------------------------------------------------ #
    # Zombie detection                                                     #
    # ------------------------------------------------------------------ #

    async def _zombie_watcher(self) -> None:
        """Detect if SDK heartbeat is absent but PID still alive (zombie)."""
        while self._running:
            await asyncio.sleep(10)
            elapsed = time.monotonic() - self._last_heartbeat
            if elapsed >= HEARTBEAT_TIMEOUT:
                if self._pid_alive():
                    log.warning(
                        "Task %s zombie: no heartbeat for %.0fs but PID %d alive",
                        self.task_id,
                        elapsed,
                        self.pid,
                    )
                    if self._on_zombie:
                        await self._on_zombie(self.task_id)
                    # Reset so we don't spam
                    self._last_heartbeat = time.monotonic()

    def _pid_alive(self) -> bool:
        try:
            os.kill(self.pid, 0)
            return True
        except (ProcessLookupError, PermissionError):
            return False


# ------------------------------------------------------------------ #
# Registry: one TaskSocket per running task                           #
# ------------------------------------------------------------------ #

class TaskSocketRegistry:
    """Manages creation/teardown of TaskSocket instances."""

    def __init__(self) -> None:
        self._sockets: dict[str, TaskSocket] = {}

    async def create(self, task_id: str, pid: int, **callbacks) -> TaskSocket:
        """Create and start a TaskSocket for task_id."""
        ts = TaskSocket(task_id=task_id, pid=pid, **callbacks)
        await ts.start()
        self._sockets[task_id] = ts
        return ts

    async def remove(self, task_id: str) -> None:
        """Stop and remove TaskSocket for task_id."""
        ts = self._sockets.pop(task_id, None)
        if ts:
            await ts.stop()

    def get(self, task_id: str) -> TaskSocket | None:
        return self._sockets.get(task_id)

    async def stop_all(self) -> None:
        for ts in list(self._sockets.values()):
            await ts.stop()
        self._sockets.clear()
