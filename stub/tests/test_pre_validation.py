"""Tests for pre-task validation."""
import os
from unittest.mock import patch, MagicMock

import pytest

from alchemy_stub.process_mgr import ProcessManager


def _make_pm(max_concurrent=3, processes=None):
    pm = ProcessManager(
        max_concurrent=max_concurrent,
        pid_file="/tmp/test_pids.json",
    )
    if processes is not None:
        pm.processes = processes
    return pm


class TestValidateBeforeStart:
    def test_valid_conditions_pass(self, tmp_path):
        pm = _make_pm()
        cwd = str(tmp_path)
        with patch("alchemy_stub.disk_monitor.shutil.disk_usage") as mock_du:
            mock_du.return_value = MagicMock(total=100e9, used=10e9, free=90e9)
            ok, msg = pm.validate_before_start("python train.py", cwd, {})
        assert ok is True
        assert msg == ""

    def test_fails_when_cwd_missing(self, tmp_path):
        pm = _make_pm()
        missing = str(tmp_path / "does_not_exist")
        with patch("alchemy_stub.disk_monitor.shutil.disk_usage") as mock_du:
            mock_du.return_value = MagicMock(total=100e9, used=10e9, free=90e9)
            ok, msg = pm.validate_before_start("python train.py", missing, {})
        assert ok is False
        assert "does not exist" in msg
        assert missing in msg

    def test_fails_at_max_concurrent(self, tmp_path):
        cwd = str(tmp_path)
        fake_procs = {f"task-{i}": MagicMock() for i in range(3)}
        pm = _make_pm(max_concurrent=3, processes=fake_procs)
        with patch("alchemy_stub.disk_monitor.shutil.disk_usage") as mock_du:
            mock_du.return_value = MagicMock(total=100e9, used=10e9, free=90e9)
            ok, msg = pm.validate_before_start("python train.py", cwd, {})
        assert ok is False
        assert "max concurrent" in msg.lower() or "3" in msg

    def test_fails_on_low_disk(self, tmp_path):
        pm = _make_pm()
        cwd = str(tmp_path)
        with patch("alchemy_stub.disk_monitor.shutil.disk_usage") as mock_du:
            # Only 1GB free
            mock_du.return_value = MagicMock(total=100e9, used=99e9, free=1e9)
            ok, msg = pm.validate_before_start("python train.py", cwd, {})
        assert ok is False
        assert "disk" in msg.lower()

    def test_cwd_none_skips_dir_check(self, tmp_path):
        pm = _make_pm()
        with patch("alchemy_stub.disk_monitor.shutil.disk_usage") as mock_du:
            mock_du.return_value = MagicMock(total=100e9, used=10e9, free=90e9)
            ok, msg = pm.validate_before_start("python train.py", None, {})
        assert ok is True
        assert msg == ""

    def test_below_max_concurrent_passes(self, tmp_path):
        cwd = str(tmp_path)
        # 2 tasks running, max is 3
        fake_procs = {f"task-{i}": MagicMock() for i in range(2)}
        pm = _make_pm(max_concurrent=3, processes=fake_procs)
        with patch("alchemy_stub.disk_monitor.shutil.disk_usage") as mock_du:
            mock_du.return_value = MagicMock(total=100e9, used=10e9, free=90e9)
            ok, msg = pm.validate_before_start("python train.py", cwd, {})
        assert ok is True

    def test_disk_check_uses_2gb_threshold(self, tmp_path):
        pm = _make_pm()
        cwd = str(tmp_path)
        # Exactly 2GB free — not below 2.0, so should pass (2.0 is not < 2.0)
        with patch("alchemy_stub.disk_monitor.shutil.disk_usage") as mock_du:
            mock_du.return_value = MagicMock(total=100e9, used=98e9, free=2e9)
            ok, msg = pm.validate_before_start("python train.py", cwd, {})
        # free_gb = round(2e9/1e9, 1) = 2.0, which is NOT < 2.0
        assert ok is True

    def test_disk_check_1_9gb_fails(self, tmp_path):
        pm = _make_pm()
        cwd = str(tmp_path)
        with patch("alchemy_stub.disk_monitor.shutil.disk_usage") as mock_du:
            mock_du.return_value = MagicMock(total=100e9, used=98.2e9, free=1.8e9)
            ok, msg = pm.validate_before_start("python train.py", cwd, {})
        assert ok is False
