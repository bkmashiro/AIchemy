"""Unit tests for process_mgr.py.

Coverage:
- ProcessInfo.poll() — Popen vs re-attached paths
- ProcessManager.start() — subprocess spawn, log file, PID file atomicity, fd leak
- ProcessManager.kill_graceful() — SIGTERM + wait + SIGKILL chain
- ProcessManager.load_and_reattach() — alive / dead / corrupt pid file
- ProcessManager._monitor_loop() — log tailing, flush, completion detection
- ProcessManager._tail_logs() — offset tracking, missing file, binary-safe
- ProcessManager._save_pid() / _remove_pid() — atomic write, concurrent safety
- ProcessManager.cleanup_old_logs() — age filter, skip active tasks
- ProcessManager._build_script() — env_setup ordering, shlex quoting
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import tempfile
import threading
import time
from collections import deque
from unittest.mock import AsyncMock, MagicMock, patch, call

import pytest

# ---------------------------------------------------------------------------
# Import the module under test
# ---------------------------------------------------------------------------
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from alchemy_stub.process_mgr import ProcessInfo, ProcessManager, _log_path, _log_dir


# ===========================================================================
# Helpers / fixtures
# ===========================================================================

@pytest.fixture
def pid_file(tmp_path):
    return str(tmp_path / "tasks.json")


@pytest.fixture
def log_dir(tmp_path, monkeypatch):
    d = tmp_path / "logs"
    d.mkdir()
    monkeypatch.setenv("ALCHEMY_LOG_DIR", str(d))
    return d


@pytest.fixture
def mgr(pid_file, log_dir):
    """A ProcessManager with no callbacks (tests add them per-case)."""
    return ProcessManager(
        max_concurrent=3,
        env_setup="",
        default_cwd="",
        pid_file=pid_file,
    )


@pytest.fixture
def mgr_with_callbacks(pid_file, log_dir):
    """A ProcessManager whose callbacks are AsyncMocks."""
    on_started = AsyncMock()
    on_log = AsyncMock()
    on_completed = AsyncMock()
    on_failed = AsyncMock()
    on_zombie = AsyncMock()
    m = ProcessManager(
        max_concurrent=3,
        env_setup="",
        default_cwd="",
        pid_file=pid_file,
        on_started=on_started,
        on_log=on_log,
        on_completed=on_completed,
        on_failed=on_failed,
        on_zombie=on_zombie,
    )
    m._on_started = on_started
    m._on_log = on_log
    m._on_completed = on_completed
    m._on_failed = on_failed
    m._on_zombie = on_zombie
    return m


# ===========================================================================
# ProcessInfo
# ===========================================================================

class TestProcessInfo:
    def test_poll_with_proc_alive(self):
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        info = ProcessInfo("t1", 12345, proc=mock_proc)
        assert info.poll() is None
        mock_proc.poll.assert_called_once()

    def test_poll_with_proc_exited(self):
        mock_proc = MagicMock()
        mock_proc.poll.return_value = 0
        info = ProcessInfo("t1", 12345, proc=mock_proc)
        assert info.poll() == 0

    def test_poll_reattached_alive(self):
        """Re-attached process: poll via os.kill(pid, 0)."""
        info = ProcessInfo("t1", os.getpid(), proc=None)  # use our own PID — guaranteed alive
        assert info.poll() is None

    def test_poll_reattached_dead(self):
        """Re-attached process with non-existent PID → returns -1."""
        info = ProcessInfo("t1", 999999999, proc=None)
        result = info.poll()
        assert result == -1

    def test_poll_reattached_permission_error(self):
        """PermissionError means alive (different user)."""
        info = ProcessInfo("t1", 1, proc=None)  # PID 1 = init, always running
        result = info.poll()
        # On most systems pid 1 is alive; poll() returns None (alive) or raises
        # PermissionError which is caught → None
        assert result is None

    def test_log_buffer_maxlen(self):
        info = ProcessInfo("t1", 1)
        assert isinstance(info.log_buffer, deque)
        assert info.log_buffer.maxlen == 500


# ===========================================================================
# _build_script
# ===========================================================================

class TestBuildScript:
    def test_basic_script_structure(self, mgr):
        script = mgr._build_script("t1", "", {}, "python train.py")
        assert script.startswith("set -e")
        assert "python train.py" in script

    def test_env_setup_ordering(self):
        """stub env_setup comes before task env_setup."""
        mgr = ProcessManager(env_setup="source /stub/activate")
        script = mgr._build_script("t1", "source /task/activate", {}, "python train.py")
        stub_pos = script.index("source /stub/activate")
        task_pos = script.index("source /task/activate")
        cmd_pos = script.index("python train.py")
        assert stub_pos < task_pos < cmd_pos

    def test_env_vars_not_in_script(self, mgr):
        """Env vars are injected via proc_env (Popen env=), NOT exported in script."""
        env = {"MY_VAR": "hello world", "OTHER": "value"}
        script = mgr._build_script("t1", "", env, "run.sh")
        # Script should NOT contain env var exports — they go via proc_env
        assert "MY_VAR" not in script
        assert "export" not in script

    def test_alchemy_env_vars_excluded_from_script(self, mgr):
        """ALCHEMY_* vars go into proc_env directly, not via export in script."""
        env = {"ALCHEMY_TASK_ID": "xyz", "USER_VAR": "val"}
        script = mgr._build_script("t1", "", env, "cmd")
        assert "ALCHEMY_TASK_ID" not in script
        assert "USER_VAR" not in script

    def test_no_env_setup(self, mgr):
        """With no env_setup at either level, script is minimal."""
        script = mgr._build_script("t1", "", {}, "mycommand")
        lines = [l for l in script.splitlines() if l.strip()]
        assert lines[0] == "set -e"
        assert lines[-1] == "mycommand"


# ===========================================================================
# _save_pid / _remove_pid atomicity
# ===========================================================================

class TestPidFileAtomicity:
    def test_save_creates_file(self, mgr, pid_file):
        mgr._save_pid("task-1", 1234)
        assert os.path.exists(pid_file)
        with open(pid_file) as f:
            data = json.load(f)
        assert data == {"task-1": 1234}

    def test_save_multiple_tasks(self, mgr, pid_file):
        mgr._save_pid("task-1", 1234)
        mgr._save_pid("task-2", 5678)
        with open(pid_file) as f:
            data = json.load(f)
        assert data == {"task-1": 1234, "task-2": 5678}

    def test_remove_pid(self, mgr, pid_file):
        mgr._save_pid("task-1", 1234)
        mgr._save_pid("task-2", 5678)
        mgr._remove_pid("task-1")
        with open(pid_file) as f:
            data = json.load(f)
        assert "task-1" not in data
        assert "task-2" in data

    def test_remove_nonexistent_task_is_noop(self, mgr, pid_file):
        mgr._save_pid("task-1", 1234)
        mgr._remove_pid("task-99")  # should not raise
        with open(pid_file) as f:
            data = json.load(f)
        assert "task-1" in data

    def test_remove_when_no_file(self, mgr, pid_file):
        """_remove_pid with missing PID file should not raise."""
        assert not os.path.exists(pid_file)
        mgr._remove_pid("task-1")  # no exception

    def test_atomic_write_uses_tmp_then_replace(self, mgr, pid_file):
        """Verify tmp file is used (no partial writes visible)."""
        tmp_file = pid_file + ".tmp"
        mgr._save_pid("task-1", 1234)
        # After save, tmp should be cleaned up (replaced)
        assert not os.path.exists(tmp_file)
        assert os.path.exists(pid_file)

    def test_concurrent_saves_thread_safe(self, mgr, pid_file):
        """Concurrent _save_pid calls from threads should not corrupt file."""
        errors = []

        def saver(task_id, pid):
            try:
                for _ in range(20):
                    mgr._save_pid(task_id, pid)
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=saver, args=(f"task-{i}", i)) for i in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        with open(pid_file) as f:
            data = json.load(f)
        assert isinstance(data, dict)

    def test_save_pid_tolerates_corrupt_existing_file(self, mgr, pid_file):
        """Corrupt PID file should not crash _save_pid."""
        with open(pid_file, "w") as f:
            f.write("NOT JSON {{{{")
        # Should not raise — falls back to empty dict
        mgr._save_pid("task-1", 999)
        # After save, file should be valid JSON
        with open(pid_file) as f:
            data = json.load(f)
        assert "task-1" in data


# ===========================================================================
# load_and_reattach
# ===========================================================================

class TestLoadAndReattach:
    def test_no_pid_file(self, mgr, pid_file):
        result = mgr.load_and_reattach()
        assert result == {}
        assert mgr._dead_on_reattach == []

    def test_reattach_alive_process(self, mgr, pid_file, log_dir):
        """Processes that are alive should appear in result dict."""
        our_pid = os.getpid()
        mgr._save_pid("task-alive", our_pid)
        result = mgr.load_and_reattach()
        assert "task-alive" in result
        assert result["task-alive"] == our_pid
        assert "task-alive" in mgr._procs

    def test_reattach_dead_process(self, mgr, pid_file):
        """Dead PIDs should go to _dead_on_reattach, not _procs."""
        mgr._save_pid("task-dead", 999999999)
        result = mgr.load_and_reattach()
        assert result == {}
        assert len(mgr._dead_on_reattach) == 1
        dead_task_id, dead_pid = mgr._dead_on_reattach[0]
        assert dead_task_id == "task-dead"
        # Dead task removed from pid file
        assert not os.path.exists(pid_file) or "task-dead" not in json.load(open(pid_file))

    def test_reattach_sets_log_offset_to_file_size(self, mgr, pid_file, log_dir):
        """Re-attached process log_offset should start at existing file size."""
        our_pid = os.getpid()
        mgr._save_pid("task-alive", our_pid)
        # Write some existing log content
        log_path = str(log_dir / "task-alive.log")
        with open(log_path, "w") as f:
            f.write("previous output\n" * 10)
        expected_size = os.path.getsize(log_path)

        result = mgr.load_and_reattach()
        assert "task-alive" in result
        assert mgr._procs["task-alive"].log_offset == expected_size

    def test_reattach_no_log_file_sets_offset_zero(self, mgr, pid_file, log_dir):
        """If log file doesn't exist yet, log_offset = 0."""
        our_pid = os.getpid()
        mgr._save_pid("task-nolog", our_pid)
        result = mgr.load_and_reattach()
        assert "task-nolog" in result
        assert mgr._procs["task-nolog"].log_offset == 0

    def test_reattach_corrupt_pid_file(self, mgr, pid_file):
        """Corrupt pid file should not crash — returns empty dict."""
        with open(pid_file, "w") as f:
            f.write("NOT JSON")
        result = mgr.load_and_reattach()
        assert result == {}

    def test_reattach_clears_previous_dead_list(self, mgr, pid_file):
        """Each call to load_and_reattach resets _dead_on_reattach."""
        mgr._dead_on_reattach = [("stale-task", 111)]
        result = mgr.load_and_reattach()
        # Dead list is reset (no file → empty)
        assert mgr._dead_on_reattach == []

    def test_reattach_mixed_alive_and_dead(self, mgr, pid_file, log_dir):
        """Mix of alive and dead PIDs handled correctly."""
        our_pid = os.getpid()
        mgr._save_pid("alive", our_pid)
        mgr._save_pid("dead", 999999999)

        result = mgr.load_and_reattach()
        assert "alive" in result
        assert "dead" not in result
        assert len(mgr._dead_on_reattach) == 1
        assert mgr._dead_on_reattach[0][0] == "dead"


# ===========================================================================
# _tail_logs
# ===========================================================================

class TestTailLogs:
    def test_tail_reads_new_content(self, mgr, log_dir):
        task_id = "task-tail"
        log_path = str(log_dir / f"{task_id}.log")
        with open(log_path, "w") as f:
            f.write("line1\nline2\n")

        info = ProcessInfo(task_id, 1)
        info.log_offset = 0
        mgr._procs[task_id] = info

        mgr._tail_logs()

        assert "line1" in info.log_buffer
        assert "line2" in info.log_buffer
        assert info.log_offset == os.path.getsize(log_path)

    def test_tail_incremental_offset(self, mgr, log_dir):
        """Second tail call should only read new content."""
        task_id = "task-incr"
        log_path = str(log_dir / f"{task_id}.log")
        with open(log_path, "w") as f:
            f.write("line1\n")

        info = ProcessInfo(task_id, 1)
        info.log_offset = 0
        mgr._procs[task_id] = info

        mgr._tail_logs()
        assert list(info.log_buffer) == ["line1"]

        with open(log_path, "a") as f:
            f.write("line2\n")

        mgr._tail_logs()
        assert list(info.log_buffer) == ["line1", "line2"]

    def test_tail_missing_log_file_no_crash(self, mgr, log_dir):
        """Missing log file should be silently skipped."""
        task_id = "task-nofile"
        info = ProcessInfo(task_id, 1)
        info.log_offset = 0
        mgr._procs[task_id] = info

        mgr._tail_logs()  # should not raise
        assert len(info.log_buffer) == 0

    def test_tail_fills_log_pending(self, mgr, log_dir):
        """Lines should go into both log_buffer and log_pending."""
        task_id = "task-pending"
        log_path = str(log_dir / f"{task_id}.log")
        with open(log_path, "w") as f:
            f.write("alpha\nbeta\n")

        info = ProcessInfo(task_id, 1)
        info.log_offset = 0
        mgr._procs[task_id] = info

        mgr._tail_logs()
        assert info.log_pending == ["alpha", "beta"]

    def test_tail_handles_binary_replacement(self, mgr, log_dir):
        """Invalid UTF-8 bytes should not crash (errors='replace')."""
        task_id = "task-binary"
        log_path = str(log_dir / f"{task_id}.log")
        with open(log_path, "wb") as f:
            f.write(b"valid line\n\xff\xfe bad bytes\n")

        info = ProcessInfo(task_id, 1)
        info.log_offset = 0
        mgr._procs[task_id] = info

        mgr._tail_logs()  # should not raise
        assert len(info.log_buffer) >= 1

    def test_tail_buffer_maxlen_enforced(self, mgr, log_dir):
        """log_buffer maxlen=500 should drop oldest entries."""
        task_id = "task-maxlen"
        log_path = str(log_dir / f"{task_id}.log")
        content = "\n".join(f"line{i}" for i in range(600)) + "\n"
        with open(log_path, "w") as f:
            f.write(content)

        info = ProcessInfo(task_id, 1)
        info.log_offset = 0
        mgr._procs[task_id] = info

        mgr._tail_logs()
        assert len(info.log_buffer) == 500  # maxlen enforced


# ===========================================================================
# _flush_logs
# ===========================================================================

class TestFlushLogs:
    @pytest.mark.asyncio
    async def test_flush_calls_on_log(self, mgr_with_callbacks):
        task_id = "task-fl"
        info = ProcessInfo(task_id, 1)
        info.log_pending = ["line1", "line2"]
        mgr_with_callbacks._procs[task_id] = info

        await mgr_with_callbacks._flush_logs()

        mgr_with_callbacks.on_log.assert_awaited_once_with(task_id, ["line1", "line2"])
        assert info.log_pending == []

    @pytest.mark.asyncio
    async def test_flush_clears_pending_on_callback_error(self, mgr_with_callbacks):
        """Even if on_log raises, log_pending is cleared to prevent double-send."""
        mgr_with_callbacks.on_log.side_effect = RuntimeError("socket dead")
        task_id = "task-err"
        info = ProcessInfo(task_id, 1)
        info.log_pending = ["line1"]
        mgr_with_callbacks._procs[task_id] = info

        await mgr_with_callbacks._flush_logs()  # should not raise
        # log_pending is cleared before await, so it's empty
        assert info.log_pending == []

    @pytest.mark.asyncio
    async def test_flush_empty_pending_no_call(self, mgr_with_callbacks):
        task_id = "task-empty"
        info = ProcessInfo(task_id, 1)
        info.log_pending = []
        mgr_with_callbacks._procs[task_id] = info

        await mgr_with_callbacks._flush_logs()
        mgr_with_callbacks.on_log.assert_not_awaited()


# ===========================================================================
# _check_completions
# ===========================================================================

class TestCheckCompletions:
    @pytest.mark.asyncio
    async def test_completed_zero_exit(self, mgr_with_callbacks, pid_file):
        task_id = "task-ok"
        mock_proc = MagicMock()
        mock_proc.poll.return_value = 0
        info = ProcessInfo(task_id, 123, proc=mock_proc)
        mgr_with_callbacks._procs[task_id] = info

        await mgr_with_callbacks._check_completions()

        mgr_with_callbacks.on_completed.assert_awaited_once()
        call_args = mgr_with_callbacks.on_completed.call_args
        assert call_args[0][0] == task_id
        assert call_args[0][1] == 0  # exit_code
        # death_cause and has_checkpoint are also passed
        mgr_with_callbacks.on_failed.assert_not_awaited()
        assert task_id not in mgr_with_callbacks._procs

    @pytest.mark.asyncio
    async def test_failed_nonzero_exit(self, mgr_with_callbacks, pid_file):
        task_id = "task-fail"
        mock_proc = MagicMock()
        mock_proc.poll.return_value = 1
        info = ProcessInfo(task_id, 456, proc=mock_proc)
        mgr_with_callbacks._procs[task_id] = info

        await mgr_with_callbacks._check_completions()

        mgr_with_callbacks.on_failed.assert_awaited_once()
        call_args = mgr_with_callbacks.on_failed.call_args
        assert call_args[0][0] == task_id
        assert call_args[0][1] == 1
        assert task_id not in mgr_with_callbacks._procs

    @pytest.mark.asyncio
    async def test_still_running_not_reported(self, mgr_with_callbacks):
        task_id = "task-running"
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        info = ProcessInfo(task_id, 789, proc=mock_proc)
        mgr_with_callbacks._procs[task_id] = info

        await mgr_with_callbacks._check_completions()

        mgr_with_callbacks.on_completed.assert_not_awaited()
        mgr_with_callbacks.on_failed.assert_not_awaited()
        assert task_id in mgr_with_callbacks._procs

    @pytest.mark.asyncio
    async def test_flush_remaining_logs_on_completion(self, mgr_with_callbacks, pid_file):
        """Remaining log_pending should be flushed when task completes."""
        task_id = "task-lastlog"
        mock_proc = MagicMock()
        mock_proc.poll.return_value = 0
        info = ProcessInfo(task_id, 111, proc=mock_proc)
        info.log_pending = ["final log line"]
        mgr_with_callbacks._procs[task_id] = info

        await mgr_with_callbacks._check_completions()

        mgr_with_callbacks.on_log.assert_awaited_once_with(task_id, ["final log line"])

    @pytest.mark.asyncio
    async def test_removes_pid_from_file_on_completion(self, mgr_with_callbacks, pid_file):
        task_id = "task-cleanup"
        mock_proc = MagicMock()
        mock_proc.poll.return_value = 0
        info = ProcessInfo(task_id, 222, proc=mock_proc)
        mgr_with_callbacks._procs[task_id] = info
        mgr_with_callbacks._save_pid(task_id, 222)

        await mgr_with_callbacks._check_completions()

        if os.path.exists(pid_file):
            with open(pid_file) as f:
                data = json.load(f)
            assert task_id not in data


# ===========================================================================
# kill_graceful
# ===========================================================================

class TestKillGraceful:
    @pytest.mark.asyncio
    async def test_sigterm_then_exit(self, mgr):
        """Process exits after SIGTERM; SIGKILL should NOT be sent."""
        task_id = "task-term"
        mock_proc = MagicMock()
        # First few polls return None (alive), then None (alive) returns done
        mock_proc.poll.side_effect = [None, None, 0]
        info = ProcessInfo(task_id, 1234, proc=mock_proc)
        mgr._procs[task_id] = info

        sent_signals = []

        # _send_signal_to_group is a @staticmethod; patch.object replaces descriptor
        # so when called via self._send_signal_to_group(pid, sig), self is passed first
        def fake_send_signal(pid_or_self, sig_or_pid=None, sig=None):
            actual_sig = sig if sig is not None else sig_or_pid
            sent_signals.append(actual_sig)

        with patch.object(ProcessManager, "_send_signal_to_group", staticmethod(lambda pid, sig: sent_signals.append(sig))):
            await mgr.kill_graceful(task_id, grace_period_s=2.0)

        assert signal.SIGTERM in sent_signals
        assert signal.SIGKILL not in sent_signals

    @pytest.mark.asyncio
    async def test_sigkill_after_grace_period(self, mgr):
        """Process doesn't exit → SIGKILL after grace period."""
        task_id = "task-kill"
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None  # never exits
        info = ProcessInfo(task_id, 5678, proc=mock_proc)
        mgr._procs[task_id] = info

        sent_signals = []

        with patch.object(ProcessManager, "_send_signal_to_group", staticmethod(lambda pid, sig: sent_signals.append(sig))):
            await mgr.kill_graceful(task_id, grace_period_s=0.05)

        assert signal.SIGTERM in sent_signals
        assert signal.SIGKILL in sent_signals
        assert sent_signals.index(signal.SIGTERM) < sent_signals.index(signal.SIGKILL)

    @pytest.mark.asyncio
    async def test_kill_nonexistent_task_noop(self, mgr):
        """kill_graceful on unknown task_id should not raise."""
        await mgr.kill_graceful("does-not-exist", grace_period_s=0)

    @pytest.mark.asyncio
    async def test_zero_grace_period_immediate_sigkill(self, mgr):
        """grace_period_s=0 → SIGTERM then immediately SIGKILL."""
        task_id = "task-zero"
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        info = ProcessInfo(task_id, 9999, proc=mock_proc)
        mgr._procs[task_id] = info

        sent_signals = []

        with patch.object(ProcessManager, "_send_signal_to_group", staticmethod(lambda pid, sig: sent_signals.append(sig))):
            await mgr.kill_graceful(task_id, grace_period_s=0)

        assert signal.SIGTERM in sent_signals
        assert signal.SIGKILL in sent_signals


# ===========================================================================
# start() — spawn + PID save + fd leak
# ===========================================================================

class TestStart:
    @pytest.mark.asyncio
    async def test_start_spawns_process(self, mgr, log_dir):
        """start() should call subprocess.Popen and return PID."""
        mock_proc = MagicMock()
        mock_proc.pid = 42

        with patch("subprocess.Popen", return_value=mock_proc) as mock_popen:
            pid = await mgr.start(
                task_id="task-spawn",
                command="echo hello",
                cwd="/tmp",
            )

        assert pid == 42
        assert "task-spawn" in mgr._procs
        mock_popen.assert_called_once()

    @pytest.mark.asyncio
    async def test_start_saves_pid(self, mgr, log_dir, pid_file):
        mock_proc = MagicMock()
        mock_proc.pid = 77

        with patch("subprocess.Popen", return_value=mock_proc):
            await mgr.start(task_id="task-pid", command="sleep 10")

        with open(pid_file) as f:
            data = json.load(f)
        assert data.get("task-pid") == 77

    @pytest.mark.asyncio
    async def test_start_calls_on_started(self, mgr_with_callbacks, log_dir):
        mock_proc = MagicMock()
        mock_proc.pid = 55

        with patch("subprocess.Popen", return_value=mock_proc):
            await mgr_with_callbacks.start(task_id="task-cb", command="true")

        mgr_with_callbacks.on_started.assert_awaited_once_with("task-cb", 55)

    @pytest.mark.asyncio
    async def test_start_duplicate_task_returns_existing_pid(self, mgr, log_dir):
        """Calling start() for an already-running task returns existing PID (no new Popen)."""
        mock_proc = MagicMock()
        mock_proc.pid = 100
        info = ProcessInfo("task-dup", 100, proc=mock_proc)
        mgr._procs["task-dup"] = info

        with patch("subprocess.Popen") as mock_popen:
            pid = await mgr.start(task_id="task-dup", command="other")

        assert pid == 100
        mock_popen.assert_not_called()

    @pytest.mark.asyncio
    async def test_start_closes_log_fd_on_popen_failure(self, mgr, log_dir):
        """Log file fd must be closed even if Popen raises."""
        opened_fds = []
        real_open = open

        def tracking_open(path, mode="r", **kwargs):
            fobj = real_open(path, mode, **kwargs)
            if "log" in str(path) or ".log" in str(path):
                opened_fds.append(fobj)
            return fobj

        with patch("builtins.open", side_effect=tracking_open):
            with patch("subprocess.Popen", side_effect=OSError("exec failed")):
                with pytest.raises(OSError):
                    await mgr.start(task_id="task-fdleak", command="badcmd")

        # All log file descriptors should be closed
        for fd in opened_fds:
            assert fd.closed, f"fd {fd.name} was not closed after Popen failure"

    @pytest.mark.asyncio
    async def test_start_injects_alchemy_env_vars(self, mgr, log_dir):
        """ALCHEMY_TASK_ID and ALCHEMY_STUB_SOCKET must be in proc_env."""
        mock_proc = MagicMock()
        mock_proc.pid = 10
        captured_env = {}

        def capture_popen(*args, **kwargs):
            captured_env.update(kwargs.get("env", {}))
            return mock_proc

        with patch("subprocess.Popen", side_effect=capture_popen):
            await mgr.start(task_id="task-env", command="cmd")

        assert captured_env.get("ALCHEMY_TASK_ID") == "task-env"
        assert "ALCHEMY_STUB_SOCKET" in captured_env

    @pytest.mark.asyncio
    async def test_start_injects_params_as_json(self, mgr, log_dir):
        """params dict should be serialized as ALCHEMY_PARAMS env var."""
        mock_proc = MagicMock()
        mock_proc.pid = 11
        captured_env = {}

        def capture_popen(*args, **kwargs):
            captured_env.update(kwargs.get("env", {}))
            return mock_proc

        params = {"lr": 0.001, "epochs": 100}
        with patch("subprocess.Popen", side_effect=capture_popen):
            await mgr.start(task_id="task-params", command="cmd", params=params)

        assert "ALCHEMY_PARAMS" in captured_env
        assert json.loads(captured_env["ALCHEMY_PARAMS"]) == params

    @pytest.mark.asyncio
    async def test_start_injects_run_dir(self, mgr, log_dir):
        mock_proc = MagicMock()
        mock_proc.pid = 12
        captured_env = {}

        def capture_popen(*args, **kwargs):
            captured_env.update(kwargs.get("env", {}))
            return mock_proc

        with patch("subprocess.Popen", side_effect=capture_popen):
            await mgr.start(task_id="task-rundir", command="cmd", run_dir="/runs/exp1")

        assert captured_env.get("ALCHEMY_RUN_DIR") == "/runs/exp1"

    @pytest.mark.asyncio
    async def test_start_uses_start_new_session(self, mgr, log_dir):
        """Process must start with start_new_session=True for process group isolation."""
        mock_proc = MagicMock()
        mock_proc.pid = 13
        popen_kwargs = {}

        def capture_popen(*args, **kwargs):
            popen_kwargs.update(kwargs)
            return mock_proc

        with patch("subprocess.Popen", side_effect=capture_popen):
            await mgr.start(task_id="task-session", command="cmd")

        assert popen_kwargs.get("start_new_session") is True


# ===========================================================================
# _monitor_loop
# ===========================================================================

class TestMonitorLoop:
    @pytest.mark.asyncio
    async def test_monitor_loop_calls_tail_and_flush(self, mgr_with_callbacks, log_dir):
        """Monitor loop should call _tail_logs and _flush_logs."""
        tail_calls = []
        flush_calls = []

        original_tail = mgr_with_callbacks._tail_logs
        original_flush = mgr_with_callbacks._flush_logs

        async def fake_flush():
            flush_calls.append(1)
            if len(flush_calls) >= 1:
                raise asyncio.CancelledError()

        with patch.object(mgr_with_callbacks, "_tail_logs", side_effect=lambda: tail_calls.append(1)):
            with patch.object(mgr_with_callbacks, "_flush_logs", new=fake_flush):
                with patch.object(mgr_with_callbacks, "_check_completions", new=AsyncMock()):
                    with pytest.raises(asyncio.CancelledError):
                        await mgr_with_callbacks._monitor_loop()

        assert len(tail_calls) >= 1

    @pytest.mark.asyncio
    async def test_monitor_loop_continues_after_error(self, mgr):
        """Monitor loop should catch exceptions and continue."""
        call_count = [0]

        async def fake_sleep(s):
            call_count[0] += 1
            if call_count[0] >= 3:
                raise asyncio.CancelledError()

        with patch("asyncio.sleep", side_effect=fake_sleep):
            with patch.object(mgr, "_tail_logs", side_effect=RuntimeError("oops")):
                with patch.object(mgr, "_flush_logs", new=AsyncMock()):
                    with patch.object(mgr, "_check_completions", new=AsyncMock()):
                        with pytest.raises(asyncio.CancelledError):
                            await mgr._monitor_loop()

        # Loop continued despite error
        assert call_count[0] >= 3


# ===========================================================================
# is_running / running_count / get_task_pids
# ===========================================================================

class TestQueryMethods:
    def test_is_running_true(self, mgr):
        mgr._procs["task-x"] = ProcessInfo("task-x", 1)
        assert mgr.is_running("task-x") is True

    def test_is_running_false(self, mgr):
        assert mgr.is_running("task-missing") is False

    def test_running_count(self, mgr):
        mgr._procs["t1"] = ProcessInfo("t1", 1)
        mgr._procs["t2"] = ProcessInfo("t2", 2)
        assert mgr.running_count() == 2

    def test_get_task_pids(self, mgr):
        mgr._procs["t1"] = ProcessInfo("t1", 100)
        mgr._procs["t2"] = ProcessInfo("t2", 200)
        pids = mgr.get_task_pids()
        assert pids == {"t1": 100, "t2": 200}


# ===========================================================================
# cleanup_old_logs
# ===========================================================================

class TestCleanupOldLogs:
    def test_old_log_removed(self, mgr, log_dir):
        log_path = log_dir / "old-task.log"
        log_path.write_text("old content")
        # backdate mtime
        old_time = time.time() - 48 * 3600
        os.utime(str(log_path), (old_time, old_time))

        mgr.cleanup_old_logs(max_age_hours=24)
        assert not log_path.exists()

    def test_recent_log_kept(self, mgr, log_dir):
        log_path = log_dir / "recent-task.log"
        log_path.write_text("fresh content")
        # recent mtime (default)

        mgr.cleanup_old_logs(max_age_hours=24)
        assert log_path.exists()

    def test_active_task_log_not_removed(self, mgr, log_dir):
        """Log for a running task should NOT be deleted even if old."""
        task_id = "active-task"
        log_path = log_dir / f"{task_id}.log"
        log_path.write_text("active log")
        old_time = time.time() - 48 * 3600
        os.utime(str(log_path), (old_time, old_time))

        # Register as active
        mgr._procs[task_id] = ProcessInfo(task_id, 1)

        mgr.cleanup_old_logs(max_age_hours=24)
        assert log_path.exists()

    def test_non_log_file_ignored(self, mgr, log_dir):
        other = log_dir / "notes.txt"
        other.write_text("notes")
        old_time = time.time() - 48 * 3600
        os.utime(str(other), (old_time, old_time))

        mgr.cleanup_old_logs(max_age_hours=24)
        assert other.exists()  # only .log files are cleaned

    def test_cleanup_no_crash_empty_dir(self, mgr, log_dir):
        """Empty log dir should not crash."""
        mgr.cleanup_old_logs(max_age_hours=24)


# ===========================================================================
# _send_signal_to_group
# ===========================================================================

class TestSendSignalToGroup:
    def test_signal_sent_to_group(self):
        with patch("os.getpgid", return_value=1234) as mock_getpgid:
            with patch("os.killpg") as mock_killpg:
                ProcessManager._send_signal_to_group(100, signal.SIGTERM)
        mock_getpgid.assert_called_once_with(100)
        mock_killpg.assert_called_once_with(1234, signal.SIGTERM)

    def test_process_lookup_error_ignored(self):
        with patch("os.getpgid", side_effect=ProcessLookupError):
            # Should not raise
            ProcessManager._send_signal_to_group(999999, signal.SIGTERM)

    def test_other_error_logged_not_raised(self):
        with patch("os.getpgid", return_value=1234):
            with patch("os.killpg", side_effect=PermissionError("denied")):
                # Should not raise — logged at debug level
                ProcessManager._send_signal_to_group(100, signal.SIGKILL)
