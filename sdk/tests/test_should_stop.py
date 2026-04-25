"""Tests for should_stop (SIGTERM-based) and deprecated should_checkpoint/should_eval."""
import os
import signal
import warnings
from unittest.mock import MagicMock, patch

import pytest

from alchemy_sdk.transport import NoopTransport, HttpTransport, UnixSocketTransport, make_transport
from alchemy_sdk.client import Alchemy


class TestNoopTransport:
    def test_send_noop(self):
        t = NoopTransport()
        t.send({"type": "progress", "step": 1, "total": 100})  # must not raise

    def test_close_noop(self):
        t = NoopTransport()
        t.close()  # must not raise


class TestHttpTransport:
    def test_send_silently_fails(self):
        t = HttpTransport("http://localhost:19999", "task-123")
        t.send({"type": "progress", "step": 1, "total": 100})  # must not raise


class TestUnixSocketTransport:
    def test_connects_and_sends(self):
        with patch.object(UnixSocketTransport, "_connect", return_value=False), \
             patch.object(UnixSocketTransport, "_recv_loop"), \
             patch.object(UnixSocketTransport, "_heartbeat_loop"):
            t = UnixSocketTransport("/tmp/nonexistent.sock", "task-abc")
            t.send({"type": "heartbeat"})  # must not raise even when not connected


class TestMakeTransport:
    def test_noop_when_no_task_id(self):
        t = make_transport(None, None, None)
        assert isinstance(t, NoopTransport)

    def test_noop_when_task_id_only(self):
        t = make_transport("task-123", None, None)
        assert isinstance(t, NoopTransport)

    def test_http_when_server_set(self):
        t = make_transport("task-123", None, "http://localhost:3001")
        assert isinstance(t, HttpTransport)

    def test_unix_socket_when_socket_connectable(self):
        with patch("alchemy_sdk.transport._probe_unix_socket", return_value=True), \
             patch.object(UnixSocketTransport, "__init__", return_value=None):
            t = make_transport("task-123", "/tmp/test.sock", None)
            assert isinstance(t, UnixSocketTransport)

    def test_http_fallback_when_socket_not_connectable(self):
        with patch("alchemy_sdk.transport._probe_unix_socket", return_value=False):
            t = make_transport("task-123", "/tmp/test.sock", "http://localhost:3001")
        assert isinstance(t, HttpTransport)

    def test_noop_fallback_when_socket_unreachable_and_no_server(self):
        with patch("alchemy_sdk.transport._probe_unix_socket", return_value=False):
            t = make_transport("task-123", "/tmp/test.sock", None)
        assert isinstance(t, NoopTransport)


class TestAlchemyShouldStop:
    def setup_method(self):
        for k in ["ALCHEMY_TASK_ID", "ALCHEMY_STUB_SOCKET", "ALCHEMY_SERVER", "ALCHEMY_PARAMS"]:
            os.environ.pop(k, None)

    def test_should_stop_false_initially(self):
        al = Alchemy()
        assert al.should_stop() is False

    def test_should_stop_true_after_sigterm(self):
        al = Alchemy()
        assert al.should_stop() is False
        # Simulate SIGTERM
        al._stop_flag = True
        assert al.should_stop() is True

    def test_should_stop_set_by_signal_handler(self):
        al = Alchemy()
        # Trigger the installed SIGTERM handler
        os.kill(os.getpid(), signal.SIGTERM)
        assert al.should_stop() is True
        # Restore
        al._stop_flag = False

    def test_should_checkpoint_deprecated_returns_false(self):
        al = Alchemy()
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            result = al.should_checkpoint()
            assert result is False
            assert len(w) == 1
            assert issubclass(w[0].category, DeprecationWarning)
            assert "should_checkpoint" in str(w[0].message)

    def test_should_eval_deprecated_returns_false(self):
        al = Alchemy()
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            result = al.should_eval()
            assert result is False
            assert len(w) == 1
            assert issubclass(w[0].category, DeprecationWarning)
            assert "should_eval" in str(w[0].message)

    def test_context_manager_calls_done(self):
        al = Alchemy()
        with patch.object(al, "done") as mock_done:
            with al:
                pass
            mock_done.assert_called_once()


class TestAlchemyNotify:
    def setup_method(self):
        for k in ["ALCHEMY_TASK_ID", "ALCHEMY_STUB_SOCKET", "ALCHEMY_SERVER", "ALCHEMY_PARAMS"]:
            os.environ.pop(k, None)

    def test_notify_sends_via_transport(self):
        al = Alchemy()
        al._transport = MagicMock()
        al.notify("training diverged", level="warning")
        al._transport.send.assert_called_once_with({
            "type": "notify",
            "message": "training diverged",
            "level": "warning",
        })

    def test_notify_default_level_is_info(self):
        al = Alchemy()
        al._transport = MagicMock()
        al.notify("checkpoint saved")
        al._transport.send.assert_called_once_with({
            "type": "notify",
            "message": "checkpoint saved",
            "level": "info",
        })

    def test_notify_invalid_level_defaults_to_info(self):
        al = Alchemy()
        al._transport = MagicMock()
        al.notify("something", level="bad_level")
        al._transport.send.assert_called_once_with({
            "type": "notify",
            "message": "something",
            "level": "info",
        })

    def test_notify_all_valid_levels(self):
        al = Alchemy()
        al._transport = MagicMock()
        for level in ("debug", "info", "warning", "critical"):
            al.notify("test", level=level)
        assert al._transport.send.call_count == 4

    def test_notify_noop_no_crash(self):
        al = Alchemy()
        assert isinstance(al._transport, NoopTransport)
        al.notify("test message", level="critical")  # must not raise
