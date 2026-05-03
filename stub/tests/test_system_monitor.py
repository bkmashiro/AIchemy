"""Tests for SystemMonitor — especially the psutil cpu_percent priming fix.

psutil is not installed in the test environment, so we inject a fake module
into sys.modules before importing/reloading system_monitor.
"""
from __future__ import annotations

import importlib
import logging
import sys
import os
import types
from collections import namedtuple
from unittest.mock import MagicMock, patch, call

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


# ---------------------------------------------------------------------------
# Fake psutil
# ---------------------------------------------------------------------------

Svmem = namedtuple("Svmem", ["total", "used"])


def _make_svmem(total_mb: int = 8192, used_mb: int = 4096) -> Svmem:
    return Svmem(total=total_mb * 1024 ** 2, used=used_mb * 1024 ** 2)


def _build_fake_psutil(
    cpu_pct: float = 20.0,
    vmem: Svmem | None = None,
    vmem_error: Exception | None = None,
) -> types.ModuleType:
    """Return a minimal fake psutil module."""
    fake = types.ModuleType("psutil")

    if vmem_error is not None:
        fake.virtual_memory = MagicMock(side_effect=vmem_error)
    else:
        fake.virtual_memory = MagicMock(return_value=vmem or _make_svmem())

    fake.cpu_percent = MagicMock(return_value=cpu_pct)

    proc = MagicMock()
    proc.is_running.return_value = True
    proc.cpu_percent.return_value = 5.0
    mi = MagicMock()
    mi.rss = 200 * 1024 ** 2
    proc.memory_info.return_value = mi
    fake.Process = MagicMock(return_value=proc)

    # Exception classes
    fake.NoSuchProcess = type("NoSuchProcess", (Exception,), {})
    fake.AccessDenied = type("AccessDenied", (Exception,), {})

    return fake


def _load_sm(fake_psutil: types.ModuleType | None = None):
    """Load (or reload) system_monitor with the given fake psutil injected.

    Pass fake_psutil=None to simulate psutil being unavailable (ImportError).
    Pass a fake module to simulate a specific psutil behaviour.
    """
    # Remove cached module so we get a fresh import
    for key in list(sys.modules):
        if "system_monitor" in key and "alchemy_stub" in key:
            del sys.modules[key]

    if fake_psutil is not None:
        sys.modules["psutil"] = fake_psutil
        import alchemy_stub.system_monitor as sm
        return sm
    else:
        # Simulate psutil being unavailable by temporarily blocking the import
        import builtins
        real_import = builtins.__import__

        def _blocked_import(name, *args, **kwargs):
            if name == "psutil":
                raise ImportError("psutil not available (test-injected)")
            return real_import(name, *args, **kwargs)

        builtins.__import__ = _blocked_import
        try:
            import alchemy_stub.system_monitor as sm
            return sm
        finally:
            builtins.__import__ = real_import


# ---------------------------------------------------------------------------
# Priming: cpu_percent called once in __init__
# ---------------------------------------------------------------------------

class TestCpuPercentPriming:
    """cpu_percent(interval=None) must be called once at construction time."""

    def test_priming_call_on_init(self):
        """__init__ must call psutil.cpu_percent exactly once with interval=None."""
        fake = _build_fake_psutil()
        sm = _load_sm(fake)
        fake.cpu_percent.reset_mock()  # ignore any calls during module import
        sm.SystemMonitor()
        fake.cpu_percent.assert_called_once_with(interval=None)

    def test_collect_also_calls_cpu_percent(self):
        """collect() itself calls cpu_percent once (the real measurement)."""
        fake = _build_fake_psutil(cpu_pct=42.5)
        sm = _load_sm(fake)
        mon = sm.SystemMonitor()
        fake.cpu_percent.reset_mock()  # ignore priming call
        stats = mon.collect({})
        fake.cpu_percent.assert_called_once_with(interval=None)
        # cpu_pct is now smoothed; since there's only 1 sample, it equals raw
        assert stats["cpu_pct"] == 42.5

    def test_priming_skipped_when_psutil_unavailable(self):
        """No error if psutil is not importable (_PSUTIL_OK=False)."""
        sm = _load_sm(fake_psutil=None)  # no psutil → _PSUTIL_OK=False
        mon = sm.SystemMonitor()
        assert mon is not None


# ---------------------------------------------------------------------------
# Collect — normal path
# ---------------------------------------------------------------------------

class TestCollect:
    def test_returns_expected_keys(self):
        fake = _build_fake_psutil(
            cpu_pct=10.0,
            vmem=_make_svmem(total_mb=16384, used_mb=8192),
        )
        sm = _load_sm(fake)
        mon = sm.SystemMonitor()
        stats = mon.collect({})
        assert stats["mem_total_mb"] == 16384
        assert stats["mem_used_mb"] == 8192
        assert stats["cpu_pct"] == 10.0
        assert stats["per_task"] == {}

    def test_psutil_unavailable_returns_zeros(self):
        sm = _load_sm(fake_psutil=None)
        mon = sm.SystemMonitor()
        stats = mon.collect({})
        assert stats["mem_total_mb"] == 0
        assert stats["mem_used_mb"] == 0
        assert stats["cpu_pct"] == 0.0

    def test_zero_mem_total_logs_warning(self, caplog):
        """When virtual_memory().total == 0 a WARNING surfaces A30 issues."""
        fake = _build_fake_psutil(vmem=_make_svmem(total_mb=0, used_mb=0))
        sm = _load_sm(fake)
        mon = sm.SystemMonitor()
        with caplog.at_level(logging.WARNING, logger="alchemy_stub.system_monitor"):
            stats = mon.collect({})
        assert stats["mem_total_mb"] == 0
        assert any(
            "mem_total_mb=0" in r.message or "total=0" in r.message
            for r in caplog.records
        ), f"Expected warning about zero mem. Records: {[r.message for r in caplog.records]}"

    def test_exception_in_collect_returns_zeros(self):
        fake = _build_fake_psutil(vmem_error=RuntimeError("oops"))
        sm = _load_sm(fake)
        mon = sm.SystemMonitor()
        stats = mon.collect({})
        assert stats["mem_total_mb"] == 0
        assert stats["cpu_pct"] == 0.0


# ---------------------------------------------------------------------------
# Per-task stats
# ---------------------------------------------------------------------------

class TestPerTaskStats:
    def test_per_task_populated(self):
        fake = _build_fake_psutil(vmem=_make_svmem())
        # Customise the process mock
        proc = MagicMock()
        proc.is_running.return_value = True
        proc.cpu_percent.return_value = 25.0
        mi = MagicMock()
        mi.rss = 512 * 1024 ** 2
        proc.memory_info.return_value = mi
        fake.Process = MagicMock(return_value=proc)

        sm = _load_sm(fake)
        mon = sm.SystemMonitor()
        stats = mon.collect({"task-1": 12345})
        assert "task-1" in stats["per_task"]
        assert stats["per_task"]["task-1"]["mem_mb"] == 512
        assert stats["per_task"]["task-1"]["cpu_pct"] == 25.0
