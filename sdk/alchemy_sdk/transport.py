"""Transport layer: Unix socket → HTTP fallback → Noop."""
from __future__ import annotations

import json
import os
import socket
import threading
import time
from typing import Any, Optional


# ---------------------------------------------------------------------------
# Base / Noop
# ---------------------------------------------------------------------------

class NoopTransport:
    """Silent no-op. Used when no stub and no server are available."""

    def send(self, msg: dict) -> None:
        pass

    def should_stop(self) -> bool:
        return False

    def should_checkpoint(self) -> bool:
        return False

    def should_eval(self) -> bool:
        return False

    def close(self) -> None:
        pass


# ---------------------------------------------------------------------------
# HTTP fallback
# ---------------------------------------------------------------------------

class HttpTransport:
    """POST to /api/sdk/report. Signals always False (no back-channel)."""

    def __init__(self, server: str, task_id: str) -> None:
        self._server = server.rstrip("/")
        self._task_id = task_id
        self._url = f"{self._server}/api/sdk/report"

    def send(self, msg: dict) -> None:
        payload = {"task_id": self._task_id, **msg}
        try:
            self._post(payload)
        except Exception:
            pass  # never crash training

    def _post(self, payload: dict) -> None:
        body = json.dumps(payload).encode()
        headers = {"Content-Type": "application/json"}
        try:
            import requests  # type: ignore
            requests.post(self._url, data=body, headers=headers, timeout=5)
        except Exception:
            # Fallback to urllib (works when requests CA certs broken on A30)
            import ssl
            import urllib.request
            ctx = ssl.create_default_context()
            req = urllib.request.Request(self._url, data=body, headers=headers, method="POST")
            urllib.request.urlopen(req, timeout=5, context=ctx)

    def should_stop(self) -> bool:
        return False

    def should_checkpoint(self) -> bool:
        return False

    def should_eval(self) -> bool:
        return False

    def close(self) -> None:
        pass


# ---------------------------------------------------------------------------
# Unix socket
# ---------------------------------------------------------------------------

class UnixSocketTransport:
    """
    Connect to /tmp/alchemy_task_{task_id}.sock.
    Sends JSON-line messages to stub; receives signal messages in background thread.
    Sends heartbeat every 10s.
    """

    HEARTBEAT_INTERVAL = 10  # seconds
    RECONNECT_DELAY = 2       # seconds between reconnect attempts

    def __init__(self, sock_path: str, task_id: str) -> None:
        self._sock_path = sock_path
        self._task_id = task_id

        # Signal state — written by recv thread, read by main thread
        self._signals: dict[str, bool] = {
            "should_stop": False,
            "should_eval": False,
        }
        self._checkpoint_requests: dict[str, bool] = {}
        self._last_checkpoint_id: str | None = None
        self._saved_checkpoint_paths: dict[str, str] = {}
        self._signals_lock = threading.Lock()

        # Socket state
        self._sock: Optional[socket.socket] = None
        self._sock_lock = threading.Lock()
        self._closed = False

        # Try initial connection
        self._connect()

        # Background threads
        self._recv_thread = threading.Thread(target=self._recv_loop, daemon=True, name="alchemy-recv")
        self._heartbeat_thread = threading.Thread(target=self._heartbeat_loop, daemon=True, name="alchemy-hb")
        self._recv_thread.start()
        self._heartbeat_thread.start()

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    def _connect(self) -> bool:
        """Try to (re)connect. Returns True on success."""
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(5)
            s.connect(self._sock_path)
            s.settimeout(None)
            with self._sock_lock:
                if self._sock is not None:
                    try:
                        self._sock.close()
                    except Exception:
                        pass
                self._sock = s
            return True
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Send
    # ------------------------------------------------------------------

    def send(self, msg: dict) -> None:
        """Send a JSON-line message. Silently drops if not connected."""
        line = (json.dumps(msg) + "\n").encode()
        with self._sock_lock:
            sock = self._sock
        if sock is None:
            return
        try:
            sock.sendall(line)
        except Exception:
            # Connection broken; clear socket so recv_loop can reconnect
            with self._sock_lock:
                self._sock = None

    # ------------------------------------------------------------------
    # Receive loop
    # ------------------------------------------------------------------

    def _recv_loop(self) -> None:
        buf = ""
        while not self._closed:
            with self._sock_lock:
                sock = self._sock
            if sock is None:
                time.sleep(self.RECONNECT_DELAY)
                self._connect()
                buf = ""
                continue
            try:
                chunk = sock.recv(4096)
                if not chunk:
                    # Server closed connection
                    with self._sock_lock:
                        self._sock = None
                    buf = ""
                    continue
                buf += chunk.decode(errors="replace")
                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    line = line.strip()
                    if line:
                        self._handle_message(line)
            except Exception:
                with self._sock_lock:
                    self._sock = None
                buf = ""

    def _handle_message(self, line: str) -> None:
        try:
            msg = json.loads(line)
        except Exception:
            return
        if msg.get("type") == "signal":
            sig = msg.get("signal", "")
            request_id = msg.get("request_id")
            acknowledge = False
            with self._signals_lock:
                if sig == "should_checkpoint" and request_id:
                    self._checkpoint_requests.setdefault(str(request_id), False)
                    acknowledge = True
                elif sig == "should_stop" and request_id:
                    self._stop_request_id = str(request_id)
                    self._signals["should_stop"] = True
                    acknowledge = True
                elif sig in self._signals:
                    self._signals[sig] = True
            if acknowledge:
                # Receipt is distinct from checkpoint completion. Repeated delivery
                # re-acks the same ID without re-triggering the one-shot request.
                self.send({"type": "control.received", "request_id": str(request_id)})
                with self._signals_lock:
                    saved_path = self._saved_checkpoint_paths.get(str(request_id)) if sig == "should_checkpoint" else None
                if saved_path:
                    self.send({"type": "checkpoint", "path": saved_path, "request_id": str(request_id)})

    # ------------------------------------------------------------------
    # Heartbeat loop
    # ------------------------------------------------------------------

    def _heartbeat_loop(self) -> None:
        while not self._closed:
            time.sleep(self.HEARTBEAT_INTERVAL)
            if not self._closed:
                self.send({"type": "heartbeat"})

    # ------------------------------------------------------------------
    # Signal queries (pure — no IO)
    # ------------------------------------------------------------------

    def should_stop(self) -> bool:
        with self._signals_lock:
            return self._signals["should_stop"]

    def should_checkpoint(self) -> bool:
        with self._signals_lock:
            pending = next((rid for rid, consumed in self._checkpoint_requests.items() if not consumed), None)
            if pending is None:
                return False
            self._checkpoint_requests[pending] = True
            self._last_checkpoint_id = pending
        return True

    def checkpoint_request_id(self) -> str | None:
        with self._signals_lock:
            return self._last_checkpoint_id

    def remember_checkpoint(self, request_id: str, path: str) -> None:
        with self._signals_lock:
            self._saved_checkpoint_paths[request_id] = path
            if self._last_checkpoint_id == request_id:
                self._last_checkpoint_id = None

    def should_eval(self) -> bool:
        with self._signals_lock:
            return self._signals["should_eval"]

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    def close(self) -> None:
        self._closed = True
        with self._sock_lock:
            if self._sock is not None:
                try:
                    self._sock.close()
                except Exception:
                    pass
                self._sock = None


# ---------------------------------------------------------------------------
# Auto-select transport
# ---------------------------------------------------------------------------

def make_transport(
    task_id: Optional[str],
    stub_socket: Optional[str],
    server: Optional[str],
) -> "NoopTransport | HttpTransport | UnixSocketTransport":
    """
    Auto-select transport:
      1. Unix socket if ALCHEMY_STUB_SOCKET is set and connectable
      2. HTTP if ALCHEMY_SERVER is set
      3. Noop otherwise
    """
    if not task_id:
        return NoopTransport()

    # Try Unix socket first — probe before constructing to allow fallback
    if stub_socket:
        if _probe_unix_socket(stub_socket):
            return UnixSocketTransport(stub_socket, task_id)
        # Socket path set but not reachable — fall through to HTTP

    # Try HTTP fallback
    if server:
        return HttpTransport(server, task_id)

    return NoopTransport()


def _probe_unix_socket(path: str) -> bool:
    """Return True if the Unix socket at path is connectable right now."""
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(2)
        s.connect(path)
        s.close()
        return True
    except Exception:
        return False
