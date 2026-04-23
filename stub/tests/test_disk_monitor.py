"""Tests for disk_monitor module."""
from unittest.mock import patch, MagicMock

import pytest

from alchemy_stub.disk_monitor import get_disk_usage, check_low_disk


def _make_usage(total, used, free):
    """Helper: create a shutil.disk_usage-like namedtuple."""
    u = MagicMock()
    u.total = total
    u.used = used
    u.free = free
    return u


class TestGetDiskUsage:
    def test_returns_dict_per_path(self):
        fake = _make_usage(total=100_000_000_000, used=40_000_000_000, free=60_000_000_000)
        with patch("alchemy_stub.disk_monitor.shutil.disk_usage", return_value=fake):
            result = get_disk_usage(["/tmp"])
        assert "/tmp" in result
        stats = result["/tmp"]
        assert stats["total_gb"] == 100.0
        assert stats["used_gb"] == 40.0
        assert stats["free_gb"] == 60.0
        assert stats["pct"] == 40.0

    def test_multiple_paths(self):
        fake = _make_usage(total=500_000_000_000, used=100_000_000_000, free=400_000_000_000)
        with patch("alchemy_stub.disk_monitor.shutil.disk_usage", return_value=fake):
            result = get_disk_usage(["/tmp", "/home"])
        assert "/tmp" in result
        assert "/home" in result

    def test_bad_path_skipped(self):
        def side_effect(path):
            if path == "/nonexistent":
                raise FileNotFoundError
            return _make_usage(10_000_000_000, 5_000_000_000, 5_000_000_000)

        with patch("alchemy_stub.disk_monitor.shutil.disk_usage", side_effect=side_effect):
            result = get_disk_usage(["/nonexistent", "/tmp"])
        assert "/nonexistent" not in result
        assert "/tmp" in result

    def test_default_paths_used_when_none(self):
        fake = _make_usage(100_000_000_000, 50_000_000_000, 50_000_000_000)
        with patch("alchemy_stub.disk_monitor.shutil.disk_usage", return_value=fake) as mock_du:
            result = get_disk_usage()
        # Should have been called at least once (for /tmp and HOME)
        assert mock_du.call_count >= 1
        assert len(result) >= 1

    def test_pct_rounding(self):
        # 1/3 used → pct should be 33.3
        total = 300_000_000_000
        used = 100_000_000_000
        free = 200_000_000_000
        fake = _make_usage(total, used, free)
        with patch("alchemy_stub.disk_monitor.shutil.disk_usage", return_value=fake):
            result = get_disk_usage(["/tmp"])
        assert result["/tmp"]["pct"] == 33.3


class TestCheckLowDisk:
    def test_no_warnings_when_plenty_of_space(self):
        fake = _make_usage(100_000_000_000, 10_000_000_000, 90_000_000_000)
        with patch("alchemy_stub.disk_monitor.shutil.disk_usage", return_value=fake):
            warnings = check_low_disk(["/tmp"], threshold_gb=5.0)
        assert warnings == []

    def test_warning_when_below_threshold(self):
        # Only 2GB free
        fake = _make_usage(100_000_000_000, 98_000_000_000, 2_000_000_000)
        with patch("alchemy_stub.disk_monitor.shutil.disk_usage", return_value=fake):
            warnings = check_low_disk(["/tmp"], threshold_gb=5.0)
        assert len(warnings) == 1
        assert warnings[0]["path"] == "/tmp"
        assert warnings[0]["free_gb"] == 2.0

    def test_exactly_at_threshold_not_warned(self):
        # Exactly 5.0 GB free — not below threshold
        fake = _make_usage(100_000_000_000, 95_000_000_000, 5_000_000_000)
        with patch("alchemy_stub.disk_monitor.shutil.disk_usage", return_value=fake):
            warnings = check_low_disk(["/tmp"], threshold_gb=5.0)
        assert warnings == []

    def test_multiple_paths_some_low(self):
        def side_effect(path):
            if path == "/tmp":
                return _make_usage(100_000_000_000, 99_000_000_000, 1_000_000_000)
            return _make_usage(100_000_000_000, 10_000_000_000, 90_000_000_000)

        with patch("alchemy_stub.disk_monitor.shutil.disk_usage", side_effect=side_effect):
            warnings = check_low_disk(["/tmp", "/home"], threshold_gb=5.0)
        assert len(warnings) == 1
        assert warnings[0]["path"] == "/tmp"

    def test_warning_contains_required_keys(self):
        fake = _make_usage(100_000_000_000, 98_000_000_000, 2_000_000_000)
        with patch("alchemy_stub.disk_monitor.shutil.disk_usage", return_value=fake):
            warnings = check_low_disk(["/tmp"], threshold_gb=5.0)
        w = warnings[0]
        assert "path" in w
        assert "free_gb" in w
        assert "pct" in w
