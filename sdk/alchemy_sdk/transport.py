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

    def close(self) -> None:
        pass


# ---------------------------------------------------------------------------
# HTTP fallback
# ---------------------------------------------------------------------------

class HttpTransport:
    """POST to /api/sdk/report. No back-channel."""

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

    def close(self) -> None:
        pass


# ---------------------------------------------------------------------------
# Unix socket
# ---------------------------------------------------------------------------

class UnixSocketTransport:
    """
    Connect to /tmp/alchemy_task_{task_id}.sock.
    Sends JSON-line messages to stub.
    Sends heartbeat every 10s.
    """

    HEARTBEAT_INTERVAL = 10  # seconds
    RECONNECT_DELAY = 2       # seconds between reconnect attempts

    def __init__(self, sock_path: str, task_id: str) -> None:
        self._sock_path = sock_path
        self._task_id = task_id

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
    # Receive loop (kept for future server→SDK messages)
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
                    time.sleep(self.RECONNECT_DELAY)
                    continue
                buf += chunk.decode(errors="replace")
                # Drain any complete lines (currently no messages to handle)
                while "\n" in buf:
                    _line, buf = buf.split("\n", 1)
            except Exception:
                with self._sock_lock:
                    self._sock = None
                buf = ""

    # ------------------------------------------------------------------
    # Heartbeat loop
    # ------------------------------------------------------------------

    def _heartbeat_loop(self) -> None:
        while not self._closed:
            time.sleep(self.HEARTBEAT_INTERVAL)
            if not self._closed:
                self.send({"type": "heartbeat"})

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

    # Try Unix socket first — check path exists before constructing
    if stub_socket:
        if os.path.exists(stub_socket):
            transport = UnixSocketTransport(stub_socket, task_id)
            if transport._sock is not None:
                return transport
            transport.close()
        # Socket not reachable — fall through to HTTP

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
