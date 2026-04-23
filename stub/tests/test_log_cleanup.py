"""Tests for log file auto-cleanup."""
import os
import time
from unittest.mock import patch, MagicMock

import pytest

from alchemy_stub.process_mgr import ProcessManager


def _make_process_mgr(tmp_path, processes=None):
    """Create a ProcessManager with a temp log dir."""
    log_dir = tmp_path / "alchemy_task_logs"
    log_dir.mkdir(exist_ok=True)
    pm = ProcessManager(
        max_concurrent=3,
        pid_file=str(tmp_path / "pids.json"),
    )
    # Patch _log_dir to return our temp dir
    pm._log_dir = lambda: str(log_dir)
    if processes is not None:
        pm.processes = processes
    return pm, log_dir


class TestCleanupOldLogs:
    def test_old_log_deleted(self, tmp_path):
        pm, log_dir = _make_process_mgr(tmp_path)
        log_file = log_dir / "task-old.log"
        log_file.write_text("old output")
        # Set mtime to 25 hours ago
        old_mtime = time.time() - 25 * 3600
        os.utime(str(log_file), (old_mtime, old_mtime))

        pm.cleanup_old_logs(max_age_hours=24)

        assert not log_file.exists()

    def test_recent_log_preserved(self, tmp_path):
        pm, log_dir = _make_process_mgr(tmp_path)
        log_file = log_dir / "task-new.log"
        log_file.write_text("fresh output")
        # mtime is NOW — should not be deleted

        pm.cleanup_old_logs(max_age_hours=24)

        assert log_file.exists()

    def test_running_task_log_preserved_even_if_old(self, tmp_path):
        fake_proc = MagicMock()
        pm, log_dir = _make_process_mgr(tmp_path, processes={"task-running": fake_proc})
        log_file = log_dir / "task-running.log"
        log_file.write_text("active task log")
        # Set mtime to 48 hours ago
        old_mtime = time.time() - 48 * 3600
        os.utime(str(log_file), (old_mtime, old_mtime))

        pm.cleanup_old_logs(max_age_hours=24)

        # Running task log must NOT be deleted
        assert log_file.exists()

    def test_non_log_files_not_touched(self, tmp_path):
        pm, log_dir = _make_process_mgr(tmp_path)
        other_file = log_dir / "task-abc.txt"
        other_file.write_text("not a log")
        old_mtime = time.time() - 48 * 3600
        os.utime(str(other_file), (old_mtime, old_mtime))

        pm.cleanup_old_logs(max_age_hours=24)

        assert other_file.exists()

    def test_multiple_logs_only_old_deleted(self, tmp_path):
        pm, log_dir = _make_process_mgr(tmp_path)

        old_log = log_dir / "task-old.log"
        new_log = log_dir / "task-new.log"
        old_log.write_text("old")
        new_log.write_text("new")

        old_mtime = time.time() - 25 * 3600
        os.utime(str(old_log), (old_mtime, old_mtime))
        # new_log has current mtime

        pm.cleanup_old_logs(max_age_hours=24)

        assert not old_log.exists()
        assert new_log.exists()

    def test_empty_log_dir_no_error(self, tmp_path):
        pm, log_dir = _make_process_mgr(tmp_path)
        # Should not raise even if dir is empty
        pm.cleanup_old_logs(max_age_hours=24)

    def test_custom_max_age(self, tmp_path):
        pm, log_dir = _make_process_mgr(tmp_path)
        log_file = log_dir / "task-mid.log"
        log_file.write_text("data")
        # 3 hours old
        mtime = time.time() - 3 * 3600
        os.utime(str(log_file), (mtime, mtime))

        # max_age_hours=2 → 3h old file should be deleted
        pm.cleanup_old_logs(max_age_hours=2)
        assert not log_file.exists()

    def test_file_permission_error_silently_skipped(self, tmp_path):
        pm, log_dir = _make_process_mgr(tmp_path)
        log_file = log_dir / "task-perm.log"
        log_file.write_text("data")
        old_mtime = time.time() - 48 * 3600
        os.utime(str(log_file), (old_mtime, old_mtime))

        with patch("os.remove", side_effect=PermissionError("denied")):
            # Should not raise
            pm.cleanup_old_logs(max_age_hours=24)
