"""Unit tests for alchemy_sdk/transport.py."""
from __future__ import annotations

import json
import os
import socket
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch, call

import pytest

from alchemy_sdk.transport import (
    NoopTransport,
    HttpTransport,
    UnixSocketTransport,
    make_transport,
    _probe_unix_socket,
)


# ---------------------------------------------------------------------------
# NoopTransport
# ---------------------------------------------------------------------------

class TestNoopTransport:
    def test_send_does_not_raise(self):
        t = NoopTransport()
        t.send({"type": "progress", "step": 1, "total": 100})

    def test_close_does_not_raise(self):
        t = NoopTransport()
        t.close()

    def test_send_any_payload(self):
        t = NoopTransport()
        t.send({})
        t.send({"nested": {"a": [1, 2, 3]}})


# ---------------------------------------------------------------------------
# HttpTransport
# ---------------------------------------------------------------------------

class TestHttpTransport:
    def _make(self, server="http://alchemy.local", task_id="task-123"):
        return HttpTransport(server=server, task_id=task_id)

    def test_url_construction_strips_trailing_slash(self):
        t = HttpTransport(server="http://example.com/", task_id="t1")
        assert t._url == "http://example.com/api/sdk/report"

    def test_url_construction_no_slash(self):
        t = HttpTransport(server="http://example.com", task_id="t1")
        assert t._url == "http://example.com/api/sdk/report"

    def test_send_includes_task_id_in_payload(self):
        t = self._make(task_id="abc-123")
        captured = []

        def fake_post(self_inner, payload):
            captured.append(payload)

        with patch.object(HttpTransport, "_post", fake_post):
            t.send({"type": "progress"})

        assert captured[0]["task_id"] == "abc-123"
        assert captured[0]["type"] == "progress"

    def test_send_does_not_raise_on_network_error(self):
        t = self._make()
        with patch.object(HttpTransport, "_post", side_effect=Exception("timeout")):
            t.send({"type": "progress"})  # must not raise

    def test_post_uses_requests_first(self):
        t = self._make()
        mock_requests = MagicMock()
        with patch.dict("sys.modules", {"requests": mock_requests}):
            t._post({"key": "val"})
        mock_requests.post.assert_called_once()
        call_kwargs = mock_requests.post.call_args
        assert call_kwargs[1]["timeout"] == 5

    def test_post_falls_back_to_urllib_when_requests_raises(self):
        t = self._make()
        mock_requests = MagicMock()
        mock_requests.post.side_effect = Exception("cert error")

        with patch.dict("sys.modules", {"requests": mock_requests}):
            with patch("urllib.request.urlopen") as mock_urlopen:
                mock_urlopen.return_value.__enter__ = lambda s: s
                mock_urlopen.return_value.__exit__ = MagicMock(return_value=False)
                t._post({"key": "val"})
                mock_urlopen.assert_called_once()

    def test_close_does_not_raise(self):
        t = self._make()
        t.close()

    def test_send_merges_extra_fields(self):
        t = self._make(task_id="x")
        captured = []
        with patch.object(HttpTransport, "_post", lambda self_inner, p: captured.append(p)):
            t.send({"type": "eval", "metrics": {"reward": 1.0}})
        assert captured[0]["metrics"] == {"reward": 1.0}
        assert captured[0]["task_id"] == "x"


# ---------------------------------------------------------------------------
# UnixSocketTransport helpers — inject a fake connected socket
# ---------------------------------------------------------------------------

def _make_unix_transport_with_mock_sock(sock_path="/tmp/fake.sock", task_id="task-1"):
    """
    Construct a UnixSocketTransport without a real Unix socket by patching
    socket.socket so the initial _connect() succeeds immediately.
    recv() blocks (returns b"data") so recv_loop doesn't immediately clear the socket.
    """
    mock_sock = MagicMock(spec=socket.socket)
    # Block recv_loop: return a non-empty chunk that keeps the loop busy,
    # then block on the second call so the thread doesn't spin.
    # Use an Event to make recv block after the first call.
    _block = threading.Event()

    def _recv(n):
        if not _block.is_set():
            _block.set()
            return b"ping\n"
        # Block until transport is closed (daemon thread, will be killed)
        time.sleep(100)
        return b""

    mock_sock.recv.side_effect = _recv

    with patch("alchemy_sdk.transport.socket.socket", return_value=mock_sock):
        transport = UnixSocketTransport(sock_path=sock_path, task_id=task_id)

    # Wait until recv_loop has consumed the first chunk and is blocking
    _block.wait(timeout=1)

    return transport, mock_sock


class TestUnixSocketTransport:
    def test_initial_connect_sets_sock(self):
        transport, mock_sock = _make_unix_transport_with_mock_sock()
        try:
            assert transport._sock is not None
        finally:
            transport.close()

    def test_send_encodes_json_line(self):
        transport, mock_sock = _make_unix_transport_with_mock_sock()
        try:
            transport.send({"type": "heartbeat"})
            expected = (json.dumps({"type": "heartbeat"}) + "\n").encode()
            mock_sock.sendall.assert_called_with(expected)
        finally:
            transport.close()

    def test_send_drops_message_when_not_connected(self):
        transport, mock_sock = _make_unix_transport_with_mock_sock()
        try:
            with transport._sock_lock:
                transport._sock = None
            transport.send({"type": "progress"})  # must not raise
            mock_sock.sendall.assert_not_called()
        finally:
            transport.close()

    def test_send_clears_sock_on_sendall_error(self):
        transport, mock_sock = _make_unix_transport_with_mock_sock()
        try:
            mock_sock.sendall.side_effect = OSError("broken pipe")
            transport.send({"type": "progress"})
            with transport._sock_lock:
                assert transport._sock is None
        finally:
            transport.close()

    def test_close_sets_closed_flag(self):
        transport, mock_sock = _make_unix_transport_with_mock_sock()
        transport.close()
        assert transport._closed is True

    def test_close_clears_sock(self):
        transport, mock_sock = _make_unix_transport_with_mock_sock()
        transport.close()
        assert transport._sock is None

    def test_close_calls_sock_close(self):
        transport, mock_sock = _make_unix_transport_with_mock_sock()
        transport.close()
        mock_sock.close.assert_called()

    def test_close_twice_does_not_raise(self):
        transport, mock_sock = _make_unix_transport_with_mock_sock()
        transport.close()
        transport.close()  # idempotent

    def test_send_after_close_is_silent(self):
        transport, mock_sock = _make_unix_transport_with_mock_sock()
        transport.close()
        transport.send({"type": "heartbeat"})  # must not raise

    def test_heartbeat_thread_is_daemon(self):
        transport, _ = _make_unix_transport_with_mock_sock()
        try:
            assert transport._heartbeat_thread.daemon is True
        finally:
            transport.close()

    def test_recv_thread_is_daemon(self):
        transport, _ = _make_unix_transport_with_mock_sock()
        try:
            assert transport._recv_thread.daemon is True
        finally:
            transport.close()

    def test_recv_loop_reconnects_when_sock_none(self):
        """recv_loop detects None socket and calls _connect().

        We test this by running _recv_loop in a fresh thread with sock=None
        from the start and a very short RECONNECT_DELAY so we don't wait long.
        """
        reconnect_calls = []
        mock_sock = MagicMock(spec=socket.socket)
        # blocking recv — won't be reached while sock is None
        mock_sock.recv.side_effect = lambda n: time.sleep(100) or b""

        with patch("alchemy_sdk.transport.socket.socket", return_value=mock_sock):
            transport = UnixSocketTransport.__new__(UnixSocketTransport)
            transport._sock_path = "/tmp/fake.sock"
            transport._task_id = "t"
            transport._sock = None          # start with no socket
            transport._sock_lock = threading.Lock()
            transport._closed = False
            # Use very short reconnect delay
            transport.RECONNECT_DELAY = 0.05
            transport.HEARTBEAT_INTERVAL = UnixSocketTransport.HEARTBEAT_INTERVAL

        def tracked_connect():
            reconnect_calls.append(1)
            return False  # don't actually connect

        transport._connect = tracked_connect

        # Start only recv_loop thread (no heartbeat needed)
        recv_thread = threading.Thread(target=transport._recv_loop, daemon=True)
        recv_thread.start()

        try:
            time.sleep(0.3)  # 6+ reconnect cycles at 0.05s
            assert len(reconnect_calls) >= 1
        finally:
            transport._closed = True

    def test_recv_loop_clears_sock_on_empty_recv(self):
        """recv()==b'' means server closed — should clear sock."""
        mock_sock = MagicMock(spec=socket.socket)
        # First call returns data, second returns b"" (server closed)
        mock_sock.recv.side_effect = [b"hello\n", b""]

        with patch("alchemy_sdk.transport.socket.socket", return_value=mock_sock):
            transport = UnixSocketTransport(sock_path="/tmp/fake.sock", task_id="t")

        try:
            # Give recv_loop time to process both calls and clear sock
            time.sleep(0.3)
            with transport._sock_lock:
                assert transport._sock is None
        finally:
            transport.close()

    def test_recv_loop_handles_exception_gracefully(self):
        """recv() raising must clear sock but not crash the thread."""
        mock_sock = MagicMock(spec=socket.socket)
        # First recv raises, then block to keep the thread alive
        _called = threading.Event()

        def _recv(n):
            if not _called.is_set():
                _called.set()
                raise OSError("connection reset")
            time.sleep(100)
            return b""

        mock_sock.recv.side_effect = _recv

        with patch("alchemy_sdk.transport.socket.socket", return_value=mock_sock):
            transport = UnixSocketTransport(sock_path="/tmp/fake.sock", task_id="t")

        try:
            _called.wait(timeout=1)
            time.sleep(0.1)
            assert transport._recv_thread.is_alive()
        finally:
            transport.close()

    def test_heartbeat_sends_heartbeat_type(self):
        """Heartbeat loop sends {"type": "heartbeat"} messages."""
        # Build transport with short heartbeat interval from the start
        mock_sock = MagicMock(spec=socket.socket)
        _block = threading.Event()

        def _recv(n):
            if not _block.is_set():
                _block.set()
                return b"ping\n"
            time.sleep(100)
            return b""

        mock_sock.recv.side_effect = _recv

        with patch("alchemy_sdk.transport.socket.socket", return_value=mock_sock):
            transport = UnixSocketTransport.__new__(UnixSocketTransport)
            transport._sock_path = "/tmp/fake.sock"
            transport._task_id = "t"
            transport._sock = None
            transport._sock_lock = threading.Lock()
            transport._closed = False
            transport.HEARTBEAT_INTERVAL = 0.05  # override before threads start
            transport.RECONNECT_DELAY = UnixSocketTransport.RECONNECT_DELAY
            transport._connect()

        sent = []
        transport.send = lambda msg: sent.append(msg)

        transport._recv_thread = threading.Thread(target=transport._recv_loop, daemon=True, name="alchemy-recv")
        transport._heartbeat_thread = threading.Thread(target=transport._heartbeat_loop, daemon=True, name="alchemy-hb")
        transport._recv_thread.start()
        transport._heartbeat_thread.start()

        _block.wait(timeout=1)
        time.sleep(0.3)  # ~6 heartbeats at 0.05s interval

        try:
            hb_msgs = [m for m in sent if m.get("type") == "heartbeat"]
            assert len(hb_msgs) >= 2
        finally:
            transport.close()

    def test_connect_closes_old_socket_on_reconnect(self):
        """_connect() must close the existing socket before replacing it."""
        transport, old_sock = _make_unix_transport_with_mock_sock()

        new_sock = MagicMock(spec=socket.socket)
        new_sock.recv.side_effect = lambda n: time.sleep(100) or b""

        try:
            with patch("alchemy_sdk.transport.socket.socket", return_value=new_sock):
                transport._connect()

            old_sock.close.assert_called()
        finally:
            transport.close()


# ---------------------------------------------------------------------------
# make_transport — transport selection logic
# ---------------------------------------------------------------------------

class TestMakeTransport:
    def test_no_task_id_returns_noop(self):
        t = make_transport(task_id=None, stub_socket=None, server=None)
        assert isinstance(t, NoopTransport)

    def test_task_id_only_returns_noop(self):
        t = make_transport(task_id="task-1", stub_socket=None, server=None)
        assert isinstance(t, NoopTransport)

    def test_unix_socket_preferred_over_http(self, tmp_path):
        sock_path = str(tmp_path / "fake.sock")
        mock_sock = MagicMock(spec=socket.socket)
        mock_sock.recv.side_effect = lambda n: time.sleep(100) or b""

        with patch("alchemy_sdk.transport.os.path.exists", return_value=True):
            with patch("alchemy_sdk.transport.socket.socket", return_value=mock_sock):
                t = make_transport(task_id="t1", stub_socket=sock_path, server="http://s")
        try:
            assert isinstance(t, UnixSocketTransport)
        finally:
            t.close()

    def test_falls_back_to_http_when_socket_unreachable(self):
        with patch("alchemy_sdk.transport.os.path.exists", return_value=False):
            t = make_transport(task_id="t1", stub_socket="/nonexistent.sock", server="http://srv")
        assert isinstance(t, HttpTransport)

    def test_falls_back_to_http_when_socket_connect_fails(self, tmp_path):
        sock_path = str(tmp_path / "bad.sock")
        mock_sock = MagicMock(spec=socket.socket)
        mock_sock.connect.side_effect = ConnectionRefusedError("refused")
        mock_sock.recv.side_effect = lambda n: time.sleep(100) or b""

        with patch("alchemy_sdk.transport.os.path.exists", return_value=True):
            with patch("alchemy_sdk.transport.socket.socket", return_value=mock_sock):
                t = make_transport(task_id="t1", stub_socket=sock_path, server="http://s")
        assert isinstance(t, HttpTransport)

    def test_returns_noop_when_only_bad_socket_no_server(self):
        with patch("alchemy_sdk.transport.os.path.exists", return_value=False):
            t = make_transport(task_id="t1", stub_socket="/bad.sock", server=None)
        assert isinstance(t, NoopTransport)

    def test_http_transport_when_no_socket_but_server_present(self):
        t = make_transport(task_id="t1", stub_socket=None, server="http://srv")
        assert isinstance(t, HttpTransport)


# ---------------------------------------------------------------------------
# _probe_unix_socket
# ---------------------------------------------------------------------------

class TestProbeUnixSocket:
    def test_returns_false_when_not_connectable(self, tmp_path):
        result = _probe_unix_socket(str(tmp_path / "nonexistent.sock"))
        assert result is False

    def test_returns_true_when_connectable(self, tmp_path):
        """Spin up a real Unix domain server to test probe."""
        sock_path = str(tmp_path / "test.sock")
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(sock_path)
        srv.listen(1)

        def accept_once():
            try:
                conn, _ = srv.accept()
                conn.close()
            except Exception:
                pass

        t = threading.Thread(target=accept_once, daemon=True)
        t.start()

        try:
            result = _probe_unix_socket(sock_path)
            assert result is True
        finally:
            srv.close()
            t.join(timeout=2)
