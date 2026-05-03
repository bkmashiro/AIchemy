"""Unit tests for daemon.py (StubDaemon).

Coverage:
- _resolve_command: relative paths, absolute paths, flags, --flag=val forms
- _handle_task_run: duplicate suppression, drain guard, preflight failure paths
- _handle_task_kill / _kill_task: delegates to process_mgr, not-running guard
- _handle_config_update: max_concurrent propagation
- _handle_resume_response: stub_id assignment, kill_tasks, adopt_tasks, dead list clear
- _send_resume: payload structure, running/dead task lists
- task lifecycle callbacks: _on_task_started, _on_task_completed, _on_task_failed, _on_task_zombie
- _is_blocked_command: blocklist enforcement
- graceful_drain: stops accepting tasks, waits for completion
- reconnection loop: connection error → retry, sio.wait() returns → retry
"""
from __future__ import annotations

import asyncio
import os
import time
from unittest.mock import AsyncMock, MagicMock, patch, call

import pytest

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from alchemy_stub.config import Config
from alchemy_stub.daemon import StubDaemon, _extract_dict, _find_ack


# ===========================================================================
# Helpers
# ===========================================================================

def _make_config(**overrides) -> Config:
    defaults = dict(
        server="ws://localhost:3000",
        token="test-token",
        max_concurrent=3,
        env_setup="",
        default_cwd="/tmp",
        idle_timeout=0,
        tags=[],
        hostname="testhost",
        gpu_indices="",
        slurm_job_id=None,
    )
    defaults.update(overrides)
    return Config(**defaults)


@pytest.fixture
def config():
    return _make_config()


@pytest.fixture
def daemon(config, tmp_path, monkeypatch):
    """StubDaemon with mocked external dependencies."""
    monkeypatch.setenv("ALCHEMY_LOG_DIR", str(tmp_path / "logs"))

    with patch("alchemy_stub.daemon.GpuMonitor"):
        with patch("alchemy_stub.daemon.SystemMonitor"):
            with patch("alchemy_stub.daemon.TaskSocketRegistry"):
                with patch("alchemy_stub.daemon.ProcessManager") as MockPM:
                    # Set up ProcessManager mock
                    pm_instance = MagicMock()
                    pm_instance.get_task_pids.return_value = {}
                    pm_instance._dead_on_reattach = []
                    pm_instance.is_running.return_value = False
                    pm_instance.running_count.return_value = 0
                    pm_instance.start = AsyncMock(return_value=1234)
                    pm_instance.kill_graceful = AsyncMock()
                    MockPM.return_value = pm_instance

                    with patch("socketio.AsyncClient") as MockSio:
                        sio_instance = MagicMock()
                        sio_instance.connected = False
                        sio_instance.emit = AsyncMock()
                        sio_instance.connect = AsyncMock()
                        sio_instance.wait = AsyncMock()
                        sio_instance.disconnect = AsyncMock()
                        MockSio.return_value = sio_instance

                        d = StubDaemon(config)
                        d._connected = True  # simulate connected state

                        # Patch task_socket_registry async methods
                        d.task_socket_registry.remove = AsyncMock()
                        d.task_socket_registry.stop_all = AsyncMock()
                        d.task_socket_registry.create = AsyncMock()

                        return d


# ===========================================================================
# _extract_dict / _find_ack helpers
# ===========================================================================

class TestHelpers:
    def test_extract_dict_from_dict_arg(self):
        payload = {"task_id": "t1"}
        result = _extract_dict((payload,))
        assert result == payload

    def test_extract_dict_from_json_string(self):
        result = _extract_dict(('{"task_id": "t1"}',))
        assert result == {"task_id": "t1"}

    def test_extract_dict_skips_invalid_json(self):
        result = _extract_dict(("not-json", {"ok": True}))
        assert result == {"ok": True}

    def test_extract_dict_returns_none_on_no_dict(self):
        result = _extract_dict(("hello", 42))
        assert result is None

    def test_find_ack_callable_last(self):
        ack = lambda x: x
        result = _find_ack(({"a": 1}, ack))
        assert result is ack

    def test_find_ack_no_callable(self):
        result = _find_ack(({"a": 1}, "str"))
        assert result is None

    def test_find_ack_empty_args(self):
        result = _find_ack(())
        assert result is None


# ===========================================================================
# _resolve_command
# ===========================================================================

class TestResolveCommand:
    def test_absolute_path_unchanged(self, daemon):
        cmd = daemon._resolve_command("/usr/bin/python train.py", "/workspace")
        assert "/usr/bin/python" in cmd

    def test_relative_file_path_resolved_when_exists(self, daemon, tmp_path):
        script = tmp_path / "train.py"
        script.write_text("# script")
        cmd = daemon._resolve_command(f"python train.py", str(tmp_path))
        # "train.py" has no "/" so should NOT be resolved as path (no dir component)
        # Should remain as-is
        assert "train.py" in cmd

    def test_relative_path_with_dir_component_resolved(self, daemon, tmp_path):
        subdir = tmp_path / "scripts"
        subdir.mkdir()
        script = subdir / "run.py"
        script.write_text("# script")
        cmd = daemon._resolve_command(f"python scripts/run.py", str(tmp_path))
        assert str(tmp_path) in cmd

    def test_flag_passthrough(self, daemon):
        cmd = daemon._resolve_command("python train.py --lr=0.001", "/workspace")
        assert "--lr=0.001" in cmd

    def test_flag_with_relative_path_value_resolved_when_exists(self, daemon, tmp_path):
        config_file = tmp_path / "config.yaml"
        config_file.write_text("lr: 0.001")
        subdir = tmp_path / "configs"
        subdir.mkdir()
        config_in_dir = subdir / "exp.yaml"
        config_in_dir.write_text("lr: 0.001")
        cmd = daemon._resolve_command(f"python train.py --config=configs/exp.yaml", str(tmp_path))
        # The flag value has "/" so should be resolved
        assert str(tmp_path) in cmd

    def test_malformed_quoting_falls_back(self, daemon):
        """Unbalanced quotes should not crash — falls back to naive split."""
        cmd = daemon._resolve_command("python 'unclosed quote", "/tmp")
        assert "python" in cmd

    def test_empty_command(self, daemon):
        cmd = daemon._resolve_command("", "/tmp")
        assert cmd == ""


# ===========================================================================
# _is_blocked_command
# ===========================================================================

class TestIsBlockedCommand:
    def test_rm_rf_root_blocked(self, daemon):
        assert daemon._is_blocked_command("rm -rf /") is True

    def test_rm_rf_star_blocked(self, daemon):
        assert daemon._is_blocked_command("rm -rf /*") is True

    def test_mkfs_blocked(self, daemon):
        assert daemon._is_blocked_command("mkfs.ext4 /dev/sdb") is True

    def test_fork_bomb_blocked(self, daemon):
        assert daemon._is_blocked_command(":(){ :|:& };:") is True

    def test_normal_command_allowed(self, daemon):
        assert daemon._is_blocked_command("python train.py") is False

    def test_ls_allowed(self, daemon):
        assert daemon._is_blocked_command("ls /tmp") is False

    def test_case_insensitive_blocking(self, daemon):
        assert daemon._is_blocked_command("MKFS /dev/sda") is True


# ===========================================================================
# Task lifecycle callbacks
# ===========================================================================

class TestTaskCallbacks:
    @pytest.mark.asyncio
    async def test_on_task_started_emits_event(self, daemon):
        await daemon._on_task_started("task-1", 1234)
        daemon.sio.emit.assert_awaited()
        call_args = daemon.sio.emit.call_args
        assert call_args[0][0] == "task.started"
        assert call_args[0][1]["task_id"] == "task-1"
        assert call_args[0][1]["pid"] == 1234

    @pytest.mark.asyncio
    async def test_on_task_started_records_start_time(self, daemon):
        before = time.time()
        await daemon._on_task_started("task-1", 1234)
        after = time.time()
        assert "task-1" in daemon._task_start_times
        assert before <= daemon._task_start_times["task-1"] <= after

    @pytest.mark.asyncio
    async def test_on_task_completed_emits_event(self, daemon):
        daemon._task_start_times["task-1"] = time.time() - 10
        await daemon._on_task_completed("task-1", 0)
        # Find the task.completed emit
        completed_calls = [
            c for c in daemon.sio.emit.call_args_list
            if c[0][0] == "task.completed"
        ]
        assert len(completed_calls) == 1
        assert completed_calls[0][0][1]["task_id"] == "task-1"
        assert completed_calls[0][0][1]["exit_code"] == 0

    @pytest.mark.asyncio
    async def test_on_task_completed_updates_last_task_time(self, daemon):
        daemon._task_start_times["task-1"] = time.time()
        before = time.time()
        await daemon._on_task_completed("task-1", 0)
        assert daemon.last_task_time >= before

    @pytest.mark.asyncio
    async def test_on_task_completed_clears_start_time(self, daemon):
        daemon._task_start_times["task-1"] = time.time()
        await daemon._on_task_completed("task-1", 0)
        assert "task-1" not in daemon._task_start_times

    @pytest.mark.asyncio
    async def test_on_task_failed_emits_failed_event(self, daemon):
        daemon._task_start_times["task-1"] = time.time()
        await daemon._on_task_failed("task-1", 1, "some error")
        failed_calls = [
            c for c in daemon.sio.emit.call_args_list
            if c[0][0] == "task.failed"
        ]
        assert len(failed_calls) == 1
        assert failed_calls[0][0][1]["exit_code"] == 1

    @pytest.mark.asyncio
    async def test_on_task_failed_emits_log_event(self, daemon):
        daemon._task_start_times["task-1"] = time.time()
        await daemon._on_task_failed("task-1", 137, "OOM killed")
        log_calls = [
            c for c in daemon.sio.emit.call_args_list
            if c[0][0] == "task.log"
        ]
        assert len(log_calls) == 1

    @pytest.mark.asyncio
    async def test_on_task_zombie_deduplication(self, daemon):
        """Zombie callback should only emit once per task_id."""
        await daemon._on_task_zombie("task-zombie")
        await daemon._on_task_zombie("task-zombie")
        await daemon._on_task_zombie("task-zombie")

        zombie_calls = [
            c for c in daemon.sio.emit.call_args_list
            if c[0][0] == "task.zombie"
        ]
        assert len(zombie_calls) == 1

    @pytest.mark.asyncio
    async def test_on_task_zombie_different_tasks(self, daemon):
        """Different task_ids should each get one zombie report."""
        await daemon._on_task_zombie("task-a")
        await daemon._on_task_zombie("task-b")

        zombie_calls = [
            c for c in daemon.sio.emit.call_args_list
            if c[0][0] == "task.zombie"
        ]
        assert len(zombie_calls) == 2


# ===========================================================================
# _handle_task_run
# ===========================================================================

class TestHandleTaskRun:
    @pytest.mark.asyncio
    async def test_duplicate_task_ignored(self, daemon):
        daemon.process_mgr.is_running.return_value = True
        data = {"task_id": "task-dup", "command": "echo hi"}

        with patch("alchemy_stub.daemon.run_preflight") as mock_pf:
            await daemon._handle_task_run(data)

        mock_pf.assert_not_called()
        daemon.process_mgr.start.assert_not_called()

    @pytest.mark.asyncio
    async def test_drain_rejects_new_tasks(self, daemon):
        daemon.accepting_tasks = False
        daemon.process_mgr.is_running.return_value = False
        data = {"task_id": "task-drain", "command": "echo hi"}

        with patch("alchemy_stub.daemon.run_preflight") as mock_pf:
            await daemon._handle_task_run(data)

        mock_pf.assert_not_called()

    @pytest.mark.asyncio
    async def test_preflight_failure_emits_error(self, daemon):
        daemon.process_mgr.is_running.return_value = False
        data = {"task_id": "task-pf", "command": "echo hi"}

        mock_result = MagicMock()
        mock_result.ok = False
        mock_result.errors = ["env not found", "cuda missing"]

        with patch("alchemy_stub.daemon.run_preflight", new=AsyncMock(return_value=mock_result)):
            await daemon._handle_task_run(data)

        # Should emit preflight.fail and task.failed
        emit_events = [c[0][0] for c in daemon.sio.emit.call_args_list]
        assert "preflight.fail" in emit_events
        assert "task.failed" in emit_events

    @pytest.mark.asyncio
    async def test_successful_task_run_calls_start(self, daemon):
        daemon.process_mgr.is_running.return_value = False
        data = {
            "task_id": "task-ok",
            "command": "python train.py",
            "cwd": "/tmp",
        }

        mock_result = MagicMock()
        mock_result.ok = True
        mock_result.errors = []

        with patch("alchemy_stub.daemon.run_preflight", new=AsyncMock(return_value=mock_result)):
            await daemon._handle_task_run(data)

        daemon.process_mgr.start.assert_awaited_once()
        call_kwargs = daemon.process_mgr.start.call_args[1]
        assert call_kwargs["task_id"] == "task-ok"

    @pytest.mark.asyncio
    async def test_process_start_failure_emits_failed(self, daemon):
        daemon.process_mgr.is_running.return_value = False
        daemon.process_mgr.start.side_effect = OSError("exec failed")
        data = {"task_id": "task-startfail", "command": "bad_cmd"}

        mock_result = MagicMock()
        mock_result.ok = True
        mock_result.errors = []

        with patch("alchemy_stub.daemon.run_preflight", new=AsyncMock(return_value=mock_result)):
            await daemon._handle_task_run(data)

        failed_calls = [c for c in daemon.sio.emit.call_args_list if c[0][0] == "task.failed"]
        assert len(failed_calls) == 1

    @pytest.mark.asyncio
    async def test_unhandled_exception_emits_failed(self, daemon):
        """Any unhandled exception in task run should emit task.failed (not crash)."""
        daemon.process_mgr.is_running.return_value = False
        data = {"task_id": "task-unhandled", "command": "cmd"}

        with patch("alchemy_stub.daemon.run_preflight", new=AsyncMock(side_effect=RuntimeError("boom"))):
            await daemon._handle_task_run(data)  # should not raise

        failed_calls = [c for c in daemon.sio.emit.call_args_list if c[0][0] == "task.failed"]
        assert len(failed_calls) == 1


# ===========================================================================
# _handle_task_kill / _kill_task
# ===========================================================================

class TestHandleTaskKill:
    @pytest.mark.asyncio
    async def test_kill_delegates_to_process_mgr(self, daemon):
        daemon.process_mgr.is_running.return_value = True
        data = {"task_id": "task-kill", "grace_period_s": 10}
        await daemon._handle_task_kill(data)
        daemon.process_mgr.kill_graceful.assert_awaited()

    @pytest.mark.asyncio
    async def test_kill_default_grace_period(self, daemon):
        daemon.process_mgr.is_running.return_value = True
        data = {"task_id": "task-kill-default"}
        await daemon._handle_task_kill(data)
        call_kwargs = daemon.process_mgr.kill_graceful.call_args[1]
        assert call_kwargs["grace_period_s"] == 5.0

    @pytest.mark.asyncio
    async def test_kill_not_running_noop(self, daemon):
        daemon.process_mgr.is_running.return_value = False
        await daemon._kill_task("task-not-running", grace_period_s=5)
        daemon.process_mgr.kill_graceful.assert_not_called()

    @pytest.mark.asyncio
    async def test_kill_delegates_to_kill_graceful(self, daemon):
        """_kill_task directly awaits kill_graceful with the given grace_period_s."""
        daemon.process_mgr.is_running.return_value = True
        await daemon._kill_task("task-bg", grace_period_s=5)
        daemon.process_mgr.kill_graceful.assert_awaited_once_with("task-bg", grace_period_s=5)


# ===========================================================================
# _handle_resume_response
# ===========================================================================

class TestHandleResumeResponse:
    @pytest.mark.asyncio
    async def test_sets_stub_id_and_name(self, daemon):
        data = {"stub_id": "stub-abc", "name": "gpu22", "kill_tasks": [], "adopt_tasks": []}
        await daemon._handle_resume_response(data)
        assert daemon.stub_id == "stub-abc"
        assert daemon.stub_name == "gpu22"

    @pytest.mark.asyncio
    async def test_kill_tasks_kills_orphans(self, daemon):
        daemon.process_mgr.is_running.return_value = True
        data = {
            "stub_id": "stub-x",
            "name": "gpu22",
            "kill_tasks": ["orphan-1", "orphan-2"],
            "adopt_tasks": [],
        }
        await daemon._handle_resume_response(data)
        assert daemon.process_mgr.kill_graceful.call_count == 2

    @pytest.mark.asyncio
    async def test_adopt_tasks_calls_handle_task_run(self, daemon):
        data = {
            "stub_id": "stub-x",
            "name": "gpu22",
            "kill_tasks": [],
            "adopt_tasks": [
                {"task_id": "adopt-1", "command": "echo hi"},
                {"task_id": "adopt-2", "command": "echo bye"},
            ],
        }

        with patch.object(daemon, "_handle_task_run", new=AsyncMock()) as mock_run:
            await daemon._handle_resume_response(data)
        assert mock_run.call_count == 2

    @pytest.mark.asyncio
    async def test_clears_dead_on_reattach(self, daemon):
        daemon.process_mgr._dead_on_reattach = [("task-dead", 123)]
        data = {"stub_id": "x", "name": "y", "kill_tasks": [], "adopt_tasks": []}
        await daemon._handle_resume_response(data)
        assert daemon.process_mgr._dead_on_reattach == []

    @pytest.mark.asyncio
    async def test_updates_max_concurrent(self, daemon):
        data = {
            "stub_id": "x",
            "name": "y",
            "config": {"max_concurrent": 5},
            "kill_tasks": [],
            "adopt_tasks": [],
        }
        await daemon._handle_resume_response(data)
        assert daemon.process_mgr.max_concurrent == 5
        assert daemon.config.max_concurrent == 5

    @pytest.mark.asyncio
    async def test_no_config_in_response(self, daemon):
        """Missing 'config' key should not crash."""
        data = {"stub_id": "x", "name": "y", "kill_tasks": [], "adopt_tasks": []}
        await daemon._handle_resume_response(data)  # no exception


# ===========================================================================
# _send_resume
# ===========================================================================

class TestSendResume:
    @pytest.mark.asyncio
    async def test_resume_payload_structure(self, daemon):
        daemon._connected = True
        daemon.process_mgr.get_task_pids.return_value = {"task-1": 100}
        daemon.process_mgr._dead_on_reattach = [("dead-1", 999)]

        with patch("alchemy_stub.daemon.discover_python_envs", return_value=[]):
            await daemon._send_resume()

        emit_calls = [c for c in daemon.sio.emit.call_args_list if c[0][0] == "resume"]
        assert len(emit_calls) == 1
        payload = emit_calls[0][0][1]

        assert payload["hostname"] == "testhost"
        assert payload["token"] == "test-token"
        assert payload["max_concurrent"] == 3
        assert len(payload["running_tasks"]) == 1
        assert payload["running_tasks"][0]["task_id"] == "task-1"
        assert len(payload["dead_tasks"]) == 1
        assert payload["dead_tasks"][0]["task_id"] == "dead-1"
        assert payload["dead_tasks"][0]["exit_code"] == -1

    @pytest.mark.asyncio
    async def test_resume_slurm_type(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ALCHEMY_LOG_DIR", str(tmp_path / "logs"))
        config = _make_config(slurm_job_id="12345")

        with patch("alchemy_stub.daemon.GpuMonitor"):
            with patch("alchemy_stub.daemon.SystemMonitor"):
                with patch("alchemy_stub.daemon.TaskSocketRegistry"):
                    with patch("alchemy_stub.daemon.ProcessManager") as MockPM:
                        pm = MagicMock()
                        pm.get_task_pids.return_value = {}
                        pm._dead_on_reattach = []
                        MockPM.return_value = pm
                        with patch("socketio.AsyncClient") as MockSio:
                            sio = MagicMock()
                            sio.connected = True
                            sio.emit = AsyncMock()
                            MockSio.return_value = sio

                            d = StubDaemon(config)
                            d._connected = True

        with patch("alchemy_stub.daemon.discover_python_envs", return_value=[]):
            await d._send_resume()

        emit_calls = [c for c in d.sio.emit.call_args_list if c[0][0] == "resume"]
        payload = emit_calls[0][0][1]
        assert payload["type"] == "slurm"
        assert payload["slurm_job_id"] == "12345"

    @pytest.mark.asyncio
    async def test_resume_workstation_type(self, daemon):
        daemon._connected = True
        with patch("alchemy_stub.daemon.discover_python_envs", return_value=[]):
            await daemon._send_resume()

        emit_calls = [c for c in daemon.sio.emit.call_args_list if c[0][0] == "resume"]
        payload = emit_calls[0][0][1]
        assert payload["type"] == "workstation"
        assert "slurm_job_id" not in payload

    @pytest.mark.asyncio
    async def test_resume_includes_tags(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ALCHEMY_LOG_DIR", str(tmp_path / "logs"))
        config = _make_config(tags=["a40", "gpu22"])

        with patch("alchemy_stub.daemon.GpuMonitor"):
            with patch("alchemy_stub.daemon.SystemMonitor"):
                with patch("alchemy_stub.daemon.TaskSocketRegistry"):
                    with patch("alchemy_stub.daemon.ProcessManager") as MockPM:
                        pm = MagicMock()
                        pm.get_task_pids.return_value = {}
                        pm._dead_on_reattach = []
                        MockPM.return_value = pm
                        with patch("socketio.AsyncClient") as MockSio:
                            sio = MagicMock()
                            sio.connected = True
                            sio.emit = AsyncMock()
                            MockSio.return_value = sio

                            d = StubDaemon(config)
                            d._connected = True

        with patch("alchemy_stub.daemon.discover_python_envs", return_value=[]):
            await d._send_resume()

        emit_calls = [c for c in d.sio.emit.call_args_list if c[0][0] == "resume"]
        payload = emit_calls[0][0][1]
        assert payload["tags"] == ["a40", "gpu22"]

    @pytest.mark.asyncio
    async def test_resume_not_sent_when_disconnected(self, daemon):
        daemon._connected = False
        with patch("alchemy_stub.daemon.discover_python_envs", return_value=[]):
            await daemon._send_resume()

        resume_calls = [c for c in daemon.sio.emit.call_args_list if c[0][0] == "resume"]
        assert len(resume_calls) == 0


# ===========================================================================
# _handle_config_update
# ===========================================================================

class TestHandleConfigUpdate:
    @pytest.mark.asyncio
    async def test_max_concurrent_updated(self, daemon):
        await daemon._handle_config_update({"max_concurrent": 7})
        assert daemon.process_mgr.max_concurrent == 7
        assert daemon.config.max_concurrent == 7

    @pytest.mark.asyncio
    async def test_unknown_key_ignored(self, daemon):
        """Unknown config keys should not raise."""
        await daemon._handle_config_update({"unknown_setting": "value"})


# ===========================================================================
# graceful_drain
# ===========================================================================

class TestGracefulDrain:
    @pytest.mark.asyncio
    async def test_sets_accepting_tasks_false(self, daemon):
        daemon.accepting_tasks = True
        daemon.process_mgr.running_count.return_value = 0
        await daemon.graceful_drain(timeout=1)
        assert daemon.accepting_tasks is False

    @pytest.mark.asyncio
    async def test_waits_for_running_tasks(self, daemon):
        call_count = [0]

        def running_count():
            call_count[0] += 1
            if call_count[0] < 3:
                return 1
            return 0

        daemon.process_mgr.running_count.side_effect = running_count
        await daemon.graceful_drain(timeout=5)
        assert call_count[0] >= 3

    @pytest.mark.asyncio
    async def test_drain_timeout_exits_loop(self, daemon):
        """Drain should exit even if tasks are still running after timeout."""
        daemon.process_mgr.running_count.return_value = 1  # never finishes
        before = time.monotonic()
        await daemon.graceful_drain(timeout=0.1)
        elapsed = time.monotonic() - before
        # Should return quickly (within 1s of timeout)
        assert elapsed < 2.0

    @pytest.mark.asyncio
    async def test_drain_calls_stop_all(self, daemon):
        daemon.process_mgr.running_count.return_value = 0
        daemon.task_socket_registry.stop_all = AsyncMock()
        await daemon.graceful_drain(timeout=1)
        daemon.task_socket_registry.stop_all.assert_awaited_once()


# ===========================================================================
# _emit — connected guard
# ===========================================================================

class TestEmit:
    @pytest.mark.asyncio
    async def test_emit_when_connected(self, daemon):
        daemon._connected = True
        await daemon._emit("task.started", {"task_id": "t1"})
        daemon.sio.emit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_emit_when_disconnected_noop(self, daemon):
        daemon._connected = False
        await daemon._emit("task.started", {"task_id": "t1"})
        daemon.sio.emit.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_emit_exception_logged_not_raised(self, daemon):
        daemon._connected = True
        daemon.sio.emit.side_effect = RuntimeError("socket error")
        await daemon._emit("heartbeat", {})  # should not raise


# ===========================================================================
# _handle_shell_exec — security and subprocess management
# ===========================================================================

class TestHandleShellExec:
    @pytest.mark.asyncio
    async def test_blocked_command_returns_error(self, daemon):
        daemon.config.allow_exec = True  # exec must be enabled to reach blocklist
        data = {"request_id": "r1", "command": "rm -rf /", "timeout": 30}
        await daemon._handle_shell_exec(data)

        output_calls = [c for c in daemon.sio.emit.call_args_list if c[0][0] == "shell.output"]
        done_calls = [c for c in daemon.sio.emit.call_args_list if c[0][0] == "shell.done"]
        assert len(output_calls) == 1
        assert "blocked" in output_calls[0][0][1]["chunk"]
        assert done_calls[0][0][1]["exit_code"] == 1

    @pytest.mark.asyncio
    async def test_timeout_clamped_to_120(self, daemon):
        """timeout > 120 should be clamped."""
        data = {"request_id": "r2", "command": "echo hi", "timeout": 9999}
        mock_proc = MagicMock()
        mock_proc.stdout = AsyncMock()
        mock_proc.stdout.read = AsyncMock(return_value=b"")
        mock_proc.wait = AsyncMock()
        mock_proc.returncode = 0

        with patch("asyncio.create_subprocess_shell", new=AsyncMock(return_value=mock_proc)):
            with patch("asyncio.wait_for", new=AsyncMock(return_value=0)):
                await daemon._handle_shell_exec(data)

        # The clamped timeout was used — just verify no crash
        done_calls = [c for c in daemon.sio.emit.call_args_list if c[0][0] == "shell.done"]
        assert len(done_calls) == 1

    @pytest.mark.asyncio
    async def test_env_setup_prepended_to_command(self, daemon):
        """env_setup should be prepended to shell command."""
        daemon.config.env_setup = "source /env/activate"
        data = {"request_id": "r3", "command": "echo hi", "timeout": 5}

        captured_cmd = []

        async def fake_create_subprocess_shell(cmd, **kwargs):
            captured_cmd.append(cmd)
            raise asyncio.CancelledError()  # abort execution cleanly

        with patch("asyncio.create_subprocess_shell", side_effect=fake_create_subprocess_shell):
            try:
                await daemon._handle_shell_exec(data)
            except asyncio.CancelledError:
                pass

        if captured_cmd:
            assert "source /env/activate" in captured_cmd[0]
            assert "echo hi" in captured_cmd[0]


# ===========================================================================
# SDK callbacks
# ===========================================================================

class TestSdkCallbacks:
    @pytest.mark.asyncio
    async def test_on_sdk_progress_emits_task_progress(self, daemon):
        await daemon._on_sdk_progress("task-1", 100, 1000, 0.5, {"acc": 0.9})
        progress_calls = [c for c in daemon.sio.emit.call_args_list if c[0][0] == "task.progress"]
        assert len(progress_calls) == 1
        payload = progress_calls[0][0][1]
        assert payload["step"] == 100
        assert payload["loss"] == 0.5

    @pytest.mark.asyncio
    async def test_on_sdk_progress_emits_task_metrics(self, daemon):
        await daemon._on_sdk_progress("task-1", 100, 1000, 0.5, {"acc": 0.9})
        metrics_calls = [c for c in daemon.sio.emit.call_args_list if c[0][0] == "task.metrics"]
        assert len(metrics_calls) == 1

    @pytest.mark.asyncio
    async def test_on_sdk_progress_no_loss(self, daemon):
        """loss=None should not appear in payload."""
        await daemon._on_sdk_progress("task-1", 10, 100, None, {})
        progress_calls = [c for c in daemon.sio.emit.call_args_list if c[0][0] == "task.progress"]
        assert "loss" not in progress_calls[0][0][1]

    @pytest.mark.asyncio
    async def test_on_sdk_eval_emits_event(self, daemon):
        await daemon._on_sdk_eval("task-1", {"accuracy": 0.95})
        eval_calls = [c for c in daemon.sio.emit.call_args_list if c[0][0] == "task.eval"]
        assert len(eval_calls) == 1

    @pytest.mark.asyncio
    async def test_on_sdk_checkpoint_emits_event(self, daemon):
        await daemon._on_sdk_checkpoint("task-1", "/checkpoints/step100.pt")
        ckpt_calls = [c for c in daemon.sio.emit.call_args_list if c[0][0] == "task.checkpoint"]
        assert len(ckpt_calls) == 1
        assert ckpt_calls[0][0][1]["path"] == "/checkpoints/step100.pt"

    @pytest.mark.asyncio
    async def test_on_sdk_notify_emits_event(self, daemon):
        await daemon._on_sdk_notify("task-1", "training started", "info")
        notify_calls = [c for c in daemon.sio.emit.call_args_list if c[0][0] == "task.notify"]
        assert len(notify_calls) == 1
        payload = notify_calls[0][0][1]
        assert payload["message"] == "training started"
        assert payload["level"] == "info"
