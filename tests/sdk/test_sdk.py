"""
SDK unit tests — pytest.

Tests:
- No-op mode: no env vars → all methods work silently
- Params: ALCHEMY_PARAMS env → params() returns correct dict
- TrainingContext: run_dir allocation, checkpoint detection, steps iterator
- Transport selection: Unix socket / HTTP / noop
"""

import json
import os
import socket
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Make sure we can import from sdk/
import sys
SDK_DIR = Path(__file__).parent.parent.parent / "sdk"
sys.path.insert(0, str(SDK_DIR))

from alchemy_sdk.client import Alchemy
from alchemy_sdk.transport import (
    NoopTransport, HttpTransport, UnixSocketTransport, make_transport
)
from alchemy_sdk.context import TrainingContext


# ─── 1. No-op mode ───────────────────────────────────────────────────────────

class TestNoopMode:
    """SDK with no env vars → everything returns defaults, no IO, no crash."""

    def setup_method(self):
        # Clear all alchemy env vars
        for key in ["ALCHEMY_TASK_ID", "ALCHEMY_STUB_SOCKET", "ALCHEMY_SERVER", "ALCHEMY_PARAMS"]:
            os.environ.pop(key, None)

    def test_init_no_crash(self):
        al = Alchemy()
        assert al is not None

    def test_params_returns_empty_dict(self):
        al = Alchemy()
        assert al.params() == {}

    def test_param_with_default_returns_default(self):
        al = Alchemy()
        val = al.param("seed", default=42)
        assert val == 42

    def test_param_without_default_raises_keyerror(self):
        al = Alchemy()
        with pytest.raises(KeyError):
            al.param("nonexistent_key")

    def test_should_stop_returns_false(self):
        al = Alchemy()
        assert al.should_stop() is False

    def test_should_checkpoint_returns_false(self):
        al = Alchemy()
        assert al.should_checkpoint() is False

    def test_should_eval_returns_false(self):
        al = Alchemy()
        assert al.should_eval() is False

    def test_log_no_crash(self):
        al = Alchemy()
        al.log(step=1, total=100, loss=0.5)
        al.log(step=2, total=100)  # no loss

    def test_log_eval_no_crash(self):
        al = Alchemy()
        al.log_eval({"accuracy": 0.9})

    def test_log_config_no_crash(self):
        al = Alchemy()
        al.log_config({"lr": 0.001})

    def test_checkpoint_no_crash(self):
        al = Alchemy()
        al.checkpoint("/tmp/ckpt.pt")

    def test_done_no_crash(self):
        al = Alchemy()
        al.done()
        al.done(metrics={"final_loss": 0.01})

    def test_context_manager_no_crash(self):
        with Alchemy() as al:
            al.log(step=0, total=10)
        # __exit__ calls done() — should not crash

    def test_transport_is_noop(self):
        al = Alchemy()
        assert isinstance(al._transport, NoopTransport)


# ─── 2. Params ───────────────────────────────────────────────────────────────

class TestParams:
    """ALCHEMY_PARAMS env → params() returns correct dict."""

    def setup_method(self):
        for key in ["ALCHEMY_TASK_ID", "ALCHEMY_STUB_SOCKET", "ALCHEMY_SERVER", "ALCHEMY_PARAMS"]:
            os.environ.pop(key, None)

    def test_params_parsed_from_env(self):
        params = {"seed": 42, "ctx": 256, "lr": 0.001}
        os.environ["ALCHEMY_PARAMS"] = json.dumps(params)
        try:
            al = Alchemy()
            assert al.params() == params
        finally:
            os.environ.pop("ALCHEMY_PARAMS", None)

    def test_params_returns_copy(self):
        """Mutations to returned dict should not affect internal state."""
        os.environ["ALCHEMY_PARAMS"] = json.dumps({"seed": 42})
        try:
            al = Alchemy()
            p1 = al.params()
            p1["seed"] = 999  # mutate
            p2 = al.params()
            assert p2["seed"] == 42  # original unchanged
        finally:
            os.environ.pop("ALCHEMY_PARAMS", None)

    def test_param_returns_correct_value(self):
        os.environ["ALCHEMY_PARAMS"] = json.dumps({"seed": 123, "ctx": 512})
        try:
            al = Alchemy()
            assert al.param("seed") == 123
            assert al.param("ctx") == 512
        finally:
            os.environ.pop("ALCHEMY_PARAMS", None)

    def test_invalid_json_gracefully_defaults_standalone(self):
        os.environ["ALCHEMY_PARAMS"] = "this is not json"
        os.environ.pop("ALCHEMY_TASK_ID", None)
        try:
            al = Alchemy()
            assert al.params() == {}
        finally:
            os.environ.pop("ALCHEMY_PARAMS", None)

    def test_invalid_json_crashes_in_managed_mode(self):
        os.environ["ALCHEMY_PARAMS"] = "this is not json"
        os.environ["ALCHEMY_TASK_ID"] = "fake-task-id"
        try:
            with pytest.raises(RuntimeError, match="not valid JSON"):
                Alchemy()
        finally:
            os.environ.pop("ALCHEMY_PARAMS", None)
            os.environ.pop("ALCHEMY_TASK_ID", None)

    def test_param_default_forbidden_in_managed_mode(self):
        """Under alchemy, param() with default= is rejected to prevent silent typos."""
        os.environ["ALCHEMY_TASK_ID"] = "fake-task-id"
        os.environ["ALCHEMY_PARAMS"] = json.dumps({"seed": 42})
        try:
            al = Alchemy()
            assert al.param("seed") == 42
            # Typo in key name → crash, not silent default
            with pytest.raises(KeyError, match="no defaults"):
                al.param("seeed", default=99)
        finally:
            os.environ.pop("ALCHEMY_TASK_ID", None)
            os.environ.pop("ALCHEMY_PARAMS", None)

    def test_param_default_allowed_in_standalone(self):
        os.environ.pop("ALCHEMY_TASK_ID", None)
        os.environ.pop("ALCHEMY_PARAMS", None)
        al = Alchemy()
        assert al.param("seed", default=42) == 42

    def test_log_throttle(self):
        """log() is throttled to 1 call per 10s — second call within throttle window is dropped."""
        al = Alchemy()
        sent = []
        al._transport = MagicMock()
        al._transport.send.side_effect = lambda m: sent.append(m)

        al._last_log_time = 0.0  # reset throttle
        al.log(step=1, total=100, loss=0.5)  # should send
        al.log(step=2, total=100, loss=0.4)  # throttled — dropped

        assert len(sent) == 1
        assert sent[0]["step"] == 1


# ─── 3. Transport selection ───────────────────────────────────────────────────

class TestTransportSelection:
    """Auto-select transport based on env vars."""

    def setup_method(self):
        for key in ["ALCHEMY_TASK_ID", "ALCHEMY_STUB_SOCKET", "ALCHEMY_SERVER", "ALCHEMY_PARAMS"]:
            os.environ.pop(key, None)

    def test_no_task_id_returns_noop(self):
        transport = make_transport(None, None, None)
        assert isinstance(transport, NoopTransport)

    def test_no_task_id_with_socket_still_noop(self):
        transport = make_transport(None, "/tmp/fake.sock", None)
        assert isinstance(transport, NoopTransport)

    def test_http_transport_when_socket_unavailable(self):
        """task_id + server set + no reachable socket → HttpTransport."""
        transport = make_transport(
            task_id="test-task-123",
            stub_socket="/tmp/nonexistent_socket_xyz.sock",
            server="http://localhost:9999",
        )
        assert isinstance(transport, HttpTransport)

    def test_noop_when_nothing_available(self):
        """task_id set but no socket/server → NoopTransport."""
        transport = make_transport(
            task_id="test-task-456",
            stub_socket=None,
            server=None,
        )
        assert isinstance(transport, NoopTransport)

    def test_unix_socket_transport_when_available(self):
        """If Unix socket is connectable → UnixSocketTransport."""
        # Create a real Unix socket server
        sock_path = f"/tmp/alchemy_test_{os.getpid()}.sock"
        server_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            server_sock.bind(sock_path)
            server_sock.listen(1)

            transport = make_transport(
                task_id="test-task-789",
                stub_socket=sock_path,
                server=None,
            )
            assert isinstance(transport, UnixSocketTransport)
            transport.close()
        finally:
            server_sock.close()
            try:
                os.unlink(sock_path)
            except FileNotFoundError:
                pass

    def test_http_transport_falls_back_when_socket_path_set_but_unreachable(self):
        """Socket path set but not listening → fall through to HTTP."""
        transport = make_transport(
            task_id="task-xyz",
            stub_socket="/tmp/definitely_not_there_12345.sock",
            server="http://localhost:19999",
        )
        assert isinstance(transport, HttpTransport)


# ─── 4. UnixSocketTransport — signal handling ─────────────────────────────────

class TestUnixSocketSignals:
    """UnixSocketTransport receives signals from stub side."""

    def test_signal_should_stop(self):
        """Sending signal JSON over socket sets should_stop=True."""
        sock_path = f"/tmp/alchemy_sig_test_{os.getpid()}.sock"
        server_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            server_sock.bind(sock_path)
            server_sock.listen(1)

            transport = UnixSocketTransport(sock_path=sock_path, task_id="t1")

            # Accept connection from transport
            conn, _ = server_sock.accept()

            # Initially should_stop is False
            assert transport.should_stop() is False

            # Send signal
            conn.sendall(json.dumps({"type": "signal", "signal": "should_stop"}).encode() + b"\n")
            time.sleep(0.2)  # let recv thread process

            assert transport.should_stop() is True
            transport.close()
            conn.close()
        finally:
            server_sock.close()
            try:
                os.unlink(sock_path)
            except FileNotFoundError:
                pass

    def test_signal_should_checkpoint(self):
        sock_path = f"/tmp/alchemy_ckpt_test_{os.getpid()}.sock"
        server_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            server_sock.bind(sock_path)
            server_sock.listen(1)

            transport = UnixSocketTransport(sock_path=sock_path, task_id="t2")
            conn, _ = server_sock.accept()

            assert transport.should_checkpoint() is False
            conn.sendall(json.dumps({"type": "signal", "signal": "should_checkpoint"}).encode() + b"\n")
            time.sleep(0.2)

            assert transport.should_checkpoint() is True
            transport.close()
            conn.close()
        finally:
            server_sock.close()
            try:
                os.unlink(sock_path)
            except FileNotFoundError:
                pass


# ─── 5. TrainingContext ───────────────────────────────────────────────────────

class TestTrainingContext:
    """TrainingContext run_dir allocation, checkpoint detection, steps iterator."""

    def setup_method(self):
        for key in ["ALCHEMY_TASK_ID", "ALCHEMY_STUB_SOCKET", "ALCHEMY_SERVER",
                    "ALCHEMY_PARAMS", "ALCHEMY_RUN_DIR"]:
            os.environ.pop(key, None)

    def _make_al(self, params=None):
        if params:
            os.environ["ALCHEMY_PARAMS"] = json.dumps(params)
        return Alchemy()

    def test_run_dir_allocated_under_cwd_runs(self, tmp_path, monkeypatch):
        """Without ALCHEMY_RUN_DIR → run_dir = cwd/runs/<fingerprint>."""
        monkeypatch.chdir(tmp_path)
        al = self._make_al(params={"seed": 42})
        ctx = TrainingContext(al=al, total_steps=10)
        assert ctx.run_dir.parent == tmp_path / "runs"

    def test_run_dir_deterministic_for_same_params(self, tmp_path, monkeypatch):
        """Same params → same fingerprint → same run_dir."""
        monkeypatch.chdir(tmp_path)
        params = {"seed": 42, "ctx": 256}
        os.environ["ALCHEMY_PARAMS"] = json.dumps(params)

        al1 = Alchemy()
        ctx1 = TrainingContext(al=al1, total_steps=10)

        os.environ["ALCHEMY_PARAMS"] = json.dumps(params)
        al2 = Alchemy()
        ctx2 = TrainingContext(al=al2, total_steps=10)

        assert ctx1.run_dir == ctx2.run_dir

    def test_run_dir_different_for_different_params(self, tmp_path, monkeypatch):
        """Different params → different fingerprint → different run_dir."""
        monkeypatch.chdir(tmp_path)
        os.environ["ALCHEMY_PARAMS"] = json.dumps({"seed": 42})
        al1 = Alchemy()
        ctx1 = TrainingContext(al=al1, total_steps=10)

        os.environ["ALCHEMY_PARAMS"] = json.dumps({"seed": 99})
        al2 = Alchemy()
        ctx2 = TrainingContext(al=al2, total_steps=10)

        assert ctx1.run_dir != ctx2.run_dir

    def test_run_dir_uses_alchemy_run_dir_env(self, tmp_path):
        """ALCHEMY_RUN_DIR env is used directly (server is authoritative)."""
        os.environ["ALCHEMY_RUN_DIR"] = str(tmp_path / "custom_runs")
        try:
            al = self._make_al()
            ctx = TrainingContext(al=al)
            assert ctx.run_dir == tmp_path / "custom_runs"
        finally:
            os.environ.pop("ALCHEMY_RUN_DIR", None)

    def test_checkpoint_dir_is_under_run_dir(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        al = self._make_al()
        ctx = TrainingContext(al=al)
        assert ctx.checkpoint_dir == ctx.run_dir / "checkpoints"

    def test_latest_checkpoint_none_when_no_checkpoints(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        al = self._make_al()
        ctx = TrainingContext(al=al)
        assert ctx.latest_checkpoint() is None

    def test_latest_checkpoint_finds_pt_file(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        al = self._make_al()
        ctx = TrainingContext(al=al)

        # Create checkpoint dir and a .pt file
        ctx.checkpoint_dir.mkdir(parents=True, exist_ok=True)
        ckpt = ctx.checkpoint_dir / "latest.pt"
        ckpt.write_bytes(b"fake checkpoint")

        result = ctx.latest_checkpoint()
        assert result == ckpt

    def test_latest_checkpoint_returns_newest(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        al = self._make_al()
        ctx = TrainingContext(al=al)

        ctx.checkpoint_dir.mkdir(parents=True, exist_ok=True)
        ckpt1 = ctx.checkpoint_dir / "step_100.pt"
        ckpt1.write_bytes(b"old")
        time.sleep(0.01)
        ckpt2 = ctx.checkpoint_dir / "step_200.pt"
        ckpt2.write_bytes(b"newer")

        result = ctx.latest_checkpoint()
        assert result == ckpt2

    def test_is_resume_false_by_default(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        al = self._make_al()
        ctx = TrainingContext(al=al)
        assert ctx.is_resume is False

    def test_steps_yields_correct_range(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        al = self._make_al()
        ctx = TrainingContext(al=al, total_steps=5)
        steps = list(ctx.steps())
        assert steps == [0, 1, 2, 3, 4]

    def test_steps_with_start(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        al = self._make_al()
        ctx = TrainingContext(al=al, total_steps=5)
        steps = list(ctx.steps(start=3))
        assert steps == [3, 4]

    def test_steps_breaks_on_should_stop(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        al = self._make_al()
        # Patch should_stop to return True after step 2
        stop_at = [2]
        original_should_stop = al.should_stop

        call_count = [0]
        def patched_should_stop():
            call_count[0] += 1
            # Return True after we've yielded steps 0,1,2
            return call_count[0] > 3  # stops before step 3

        al.should_stop = patched_should_stop
        ctx = TrainingContext(al=al, total_steps=10)

        steps = list(ctx.steps())
        # Should stop before completing all 10 steps
        assert len(steps) < 10

    def test_should_eval_step_trigger(self, tmp_path, monkeypatch):
        """should_eval returns True at step % eval_every == 0."""
        monkeypatch.chdir(tmp_path)
        al = self._make_al()
        ctx = TrainingContext(al=al, total_steps=100, eval_every=10)
        ctx._current_step = 10  # simulate being at step 10
        assert ctx.should_eval() is True

    def test_should_checkpoint_step_trigger(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        al = self._make_al()
        ctx = TrainingContext(al=al, total_steps=1000, checkpoint_every=50)
        ctx._current_step = 50
        assert ctx.should_checkpoint() is True

    def test_sub_dir_creates_directory(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        al = self._make_al()
        ctx = TrainingContext(al=al)
        p = ctx.sub_dir("results")
        assert p.exists() and p.is_dir()
        assert p == ctx.run_dir / "results"

    def test_artifact_dir_under_artifacts(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        al = self._make_al()
        ctx = TrainingContext(al=al)
        p = ctx.artifact_dir("models")
        assert "artifacts" in str(p)
        assert p.exists() and p.is_dir()

    def test_params_immutable_in_context(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        params = {"seed": 42}
        os.environ["ALCHEMY_PARAMS"] = json.dumps(params)
        al = Alchemy()
        ctx = TrainingContext(al=al)
        ctx_params = ctx.params
        ctx_params["seed"] = 999  # mutate
        # Context params should not be affected
        assert ctx._params["seed"] == 42
        os.environ.pop("ALCHEMY_PARAMS", None)

    def test_log_delegates_to_al(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        al = self._make_al()
        sent = []
        al._transport = MagicMock()
        al._transport.send.side_effect = lambda m: sent.append(m)
        al._transport.should_stop.return_value = False
        al._transport.should_checkpoint.return_value = False
        al._transport.should_eval.return_value = False

        ctx = TrainingContext(al=al, total_steps=100)
        ctx._current_step = 5
        ctx._last_log_time = 0  # reset throttle via al

        # Force throttle reset
        al._last_log_time = 0.0
        ctx.log(loss=0.42, accuracy=0.9)

        # Should have sent a progress message
        assert len(sent) == 1
        assert sent[0]["type"] == "progress"


# ─── 6. NoopTransport ─────────────────────────────────────────────────────────

class TestNoopTransport:
    def test_all_signals_false(self):
        t = NoopTransport()
        assert t.should_stop() is False
        assert t.should_checkpoint() is False
        assert t.should_eval() is False

    def test_send_no_crash(self):
        t = NoopTransport()
        t.send({"type": "progress", "step": 1, "total": 100})

    def test_close_no_crash(self):
        t = NoopTransport()
        t.close()


# ─── 7. HttpTransport ────────────────────────────────────────────────────────

class TestHttpTransport:
    def test_signals_always_false(self):
        t = HttpTransport(server="http://localhost:9999", task_id="test")
        assert t.should_stop() is False
        assert t.should_checkpoint() is False
        assert t.should_eval() is False

    def test_send_silently_fails_if_server_down(self):
        """HTTP transport should not raise even if server is unreachable."""
        t = HttpTransport(server="http://localhost:19876", task_id="test")
        t.send({"type": "progress", "step": 1, "total": 100})  # should not raise
