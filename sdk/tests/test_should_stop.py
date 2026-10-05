"""Tests for should_stop/should_checkpoint/should_eval signal handling."""
import os
import threading
import time
from unittest.mock import MagicMock, patch

import pytest

from alchemy_sdk.transport import UnixSocketTransport, NoopTransport, HttpTransport, make_transport
from alchemy_sdk.client import Alchemy


class TestNoopTransportSignals:
    def test_should_stop_false(self):
        t = NoopTransport()
        assert t.should_stop() is False

    def test_should_checkpoint_false(self):
        t = NoopTransport()
        assert t.should_checkpoint() is False

    def test_should_eval_false(self):
        t = NoopTransport()
        assert t.should_eval() is False

    def test_send_noop(self):
        t = NoopTransport()
        t.send({"type": "progress", "step": 1, "total": 100})  # must not raise


class TestHttpTransportSignals:
    def test_should_stop_always_false(self):
        t = HttpTransport("http://localhost:3001", "task-123")
        assert t.should_stop() is False

    def test_should_checkpoint_always_false(self):
        t = HttpTransport("http://localhost:3001", "task-123")
        assert t.should_checkpoint() is False

    def test_should_eval_always_false(self):
        t = HttpTransport("http://localhost:3001", "task-123")
        assert t.should_eval() is False


class TestUnixSocketTransportSignals:
    def test_periodic_checkpoint_does_not_reuse_completed_request_id(self):
        with patch.object(UnixSocketTransport, "_connect", return_value=False), \
             patch.object(UnixSocketTransport, "_recv_loop"), \
             patch.object(UnixSocketTransport, "_heartbeat_loop"):
            transport = UnixSocketTransport("/tmp/nonexistent.sock", "task-abc")
            al = Alchemy()
            al._transport = transport
            with patch.object(transport, "send") as send:
                transport._handle_message('{"type":"signal","signal":"should_checkpoint","request_id":"requested"}')
                assert al.should_checkpoint() is True
                al.checkpoint("/runs/requested.pt")
                assert send.call_args.args[0]["request_id"] == "requested"
                al.checkpoint("/runs/periodic.pt")
                assert "request_id" not in send.call_args.args[0]
                transport._handle_message('{"type":"signal","signal":"should_checkpoint","request_id":"requested"}')
                assert send.call_args.args[0] == {"type": "checkpoint", "request_id": "requested", "path": "/runs/requested.pt"}
                assert al.should_checkpoint() is False
            transport.close()

    def test_signals_initially_false(self):
        """Signal flags start False before any message received."""
        with patch.object(UnixSocketTransport, "_connect", return_value=False), \
             patch.object(UnixSocketTransport, "_recv_loop"), \
             patch.object(UnixSocketTransport, "_heartbeat_loop"):
            t = UnixSocketTransport("/tmp/nonexistent.sock", "task-abc")
            assert t.should_stop() is False
            assert t.should_checkpoint() is False
            assert t.should_eval() is False

    def test_handle_should_stop_signal(self):
        with patch.object(UnixSocketTransport, "_connect", return_value=False), \
             patch.object(UnixSocketTransport, "_recv_loop"), \
             patch.object(UnixSocketTransport, "_heartbeat_loop"):
            t = UnixSocketTransport("/tmp/nonexistent.sock", "task-abc")
            t._handle_message('{"type": "signal", "signal": "should_stop"}')
            assert t.should_stop() is True
            assert t.should_checkpoint() is False

    def test_handle_should_checkpoint_signal(self):
        with patch.object(UnixSocketTransport, "_connect", return_value=False), \
             patch.object(UnixSocketTransport, "_recv_loop"), \
             patch.object(UnixSocketTransport, "_heartbeat_loop"):
            t = UnixSocketTransport("/tmp/nonexistent.sock", "task-abc")
            t._handle_message('{"type": "signal", "signal": "should_checkpoint", "request_id": "ckpt-1"}')
            assert t.should_checkpoint() is True
            assert t.should_checkpoint() is False
            assert t.should_stop() is False

    def test_handle_should_eval_signal(self):
        with patch.object(UnixSocketTransport, "_connect", return_value=False), \
             patch.object(UnixSocketTransport, "_recv_loop"), \
             patch.object(UnixSocketTransport, "_heartbeat_loop"):
            t = UnixSocketTransport("/tmp/nonexistent.sock", "task-abc")
            t._handle_message('{"type": "signal", "signal": "should_eval"}')
            assert t.should_eval() is True

    def test_checkpoint_retry_is_deduped_and_new_request_is_one_shot(self):
        with patch.object(UnixSocketTransport, "_connect", return_value=False), \
             patch.object(UnixSocketTransport, "_recv_loop"), \
             patch.object(UnixSocketTransport, "_heartbeat_loop"):
            t = UnixSocketTransport("/tmp/nonexistent.sock", "task-abc")
            t._handle_message('{"type":"signal","signal":"should_checkpoint","request_id":"same"}')
            t._handle_message('{"type":"signal","signal":"should_checkpoint","request_id":"same"}')
            assert t.should_checkpoint() is True
            assert t.should_checkpoint() is False
            t._handle_message('{"type":"signal","signal":"should_checkpoint","request_id":"next"}')
            assert t.should_checkpoint() is True

    def test_stop_is_level_triggered_and_acknowledged_once(self):
        with patch.object(UnixSocketTransport, "_connect", return_value=False), \
             patch.object(UnixSocketTransport, "_recv_loop"), \
             patch.object(UnixSocketTransport, "_heartbeat_loop"):
            t = UnixSocketTransport("/tmp/nonexistent.sock", "task-abc")
            with patch.object(t, "send") as send:
                t._handle_message('{"type":"signal","signal":"should_stop","request_id":"stop-1"}')
                t._handle_message('{"type":"signal","signal":"should_stop","request_id":"stop-1"}')
                assert t.should_stop() is True
                assert t.should_stop() is True
                assert send.call_count == 2
                send.assert_called_with({"type": "control.received", "request_id": "stop-1"})

    def test_handle_unknown_signal_ignored(self):
        with patch.object(UnixSocketTransport, "_connect", return_value=False), \
             patch.object(UnixSocketTransport, "_recv_loop"), \
             patch.object(UnixSocketTransport, "_heartbeat_loop"):
            t = UnixSocketTransport("/tmp/nonexistent.sock", "task-abc")
            t._handle_message('{"type": "signal", "signal": "unknown_signal"}')
            assert t.should_stop() is False

    def test_handle_malformed_json_ignored(self):
        with patch.object(UnixSocketTransport, "_connect", return_value=False), \
             patch.object(UnixSocketTransport, "_recv_loop"), \
             patch.object(UnixSocketTransport, "_heartbeat_loop"):
            t = UnixSocketTransport("/tmp/nonexistent.sock", "task-abc")
            t._handle_message("not valid json{{{")
            # Must not crash, signals stay False
            assert t.should_stop() is False

    def test_signals_thread_safe(self):
        """Signals can be set from recv thread and read from main thread."""
        with patch.object(UnixSocketTransport, "_connect", return_value=False), \
             patch.object(UnixSocketTransport, "_recv_loop"), \
             patch.object(UnixSocketTransport, "_heartbeat_loop"):
            t = UnixSocketTransport("/tmp/nonexistent.sock", "task-abc")

            def set_signal():
                time.sleep(0.01)
                t._handle_message('{"type": "signal", "signal": "should_stop"}')

            thread = threading.Thread(target=set_signal)
            thread.start()
            thread.join()
            assert t.should_stop() is True


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
            # _probe returned True, so UnixSocketTransport was constructed
            assert isinstance(t, UnixSocketTransport)

    def test_http_fallback_when_socket_not_connectable(self):
        with patch("alchemy_sdk.transport._probe_unix_socket", return_value=False):
            t = make_transport("task-123", "/tmp/test.sock", "http://localhost:3001")
        assert isinstance(t, HttpTransport)

    def test_noop_fallback_when_socket_unreachable_and_no_server(self):
        with patch("alchemy_sdk.transport._probe_unix_socket", return_value=False):
            t = make_transport("task-123", "/tmp/test.sock", None)
        assert isinstance(t, NoopTransport)


class TestAlchemyClientSignals:
    def test_should_stop_false_in_noop_mode(self):
        with patch.dict(os.environ, {}, clear=True):
            for k in ["ALCHEMY_TASK_ID", "ALCHEMY_STUB_SOCKET", "ALCHEMY_SERVER", "ALCHEMY_PARAMS"]:
                os.environ.pop(k, None)
            al = Alchemy()
        assert al.should_stop() is False

    def test_should_checkpoint_false_in_noop_mode(self):
        with patch.dict(os.environ, {}, clear=True):
            for k in ["ALCHEMY_TASK_ID", "ALCHEMY_STUB_SOCKET", "ALCHEMY_SERVER", "ALCHEMY_PARAMS"]:
                os.environ.pop(k, None)
            al = Alchemy()
        assert al.should_checkpoint() is False

    def test_should_eval_false_in_noop_mode(self):
        with patch.dict(os.environ, {}, clear=True):
            for k in ["ALCHEMY_TASK_ID", "ALCHEMY_STUB_SOCKET", "ALCHEMY_SERVER", "ALCHEMY_PARAMS"]:
                os.environ.pop(k, None)
            al = Alchemy()
        assert al.should_eval() is False

    def test_delegates_should_stop_to_transport(self):
        al = Alchemy()
        al._transport = MagicMock()
        al._transport.should_stop.return_value = True
        assert al.should_stop() is True

    def test_delegates_should_checkpoint_to_transport(self):
        al = Alchemy()
        al._transport = MagicMock()
        al._transport.should_checkpoint.return_value = True
        assert al.should_checkpoint() is True

    def test_delegates_should_eval_to_transport(self):
        al = Alchemy()
        al._transport = MagicMock()
        al._transport.should_eval.return_value = True
        assert al.should_eval() is True

    def test_context_manager_calls_done(self):
        al = Alchemy()
        with patch.object(al, "done") as mock_done:
            with al:
                pass
            mock_done.assert_called_once()
