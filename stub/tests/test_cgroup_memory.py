"""Tests for cgroup-based memory reading in SystemMonitor (Bug 4 fix).

When running under SLURM, mem_used_mb should be read from cgroup files
rather than psutil.virtual_memory().used (which reflects global node usage).
"""
from __future__ import annotations

import importlib
import os
import sys
import types
from unittest.mock import MagicMock, patch
from collections import namedtuple

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

Svmem = namedtuple("Svmem", ["total", "used"])


def _make_svmem(total_mb: int = 128 * 1024, used_mb: int = 64 * 1024) -> Svmem:
    return Svmem(total=total_mb * 1024 ** 2, used=used_mb * 1024 ** 2)


def _build_fake_psutil(cpu_pct: float = 10.0, vmem: Svmem | None = None) -> types.ModuleType:
    fake = types.ModuleType("psutil")
    fake.virtual_memory = MagicMock(return_value=vmem or _make_svmem())
    fake.cpu_percent = MagicMock(return_value=cpu_pct)
    proc = MagicMock()
    proc.is_running.return_value = True
    proc.cpu_percent.return_value = 0.0
    mi = MagicMock()
    mi.rss = 100 * 1024 ** 2
    proc.memory_info.return_value = mi
    fake.Process = MagicMock(return_value=proc)
    fake.NoSuchProcess = type("NoSuchProcess", (Exception,), {})
    fake.AccessDenied = type("AccessDenied", (Exception,), {})
    return fake


def _load_sm(fake_psutil: types.ModuleType) -> types.ModuleType:
    """Reload system_monitor with injected psutil."""
    for key in list(sys.modules):
        if "system_monitor" in key and "alchemy_stub" in key:
            del sys.modules[key]
    sys.modules["psutil"] = fake_psutil
    import alchemy_stub.system_monitor as sm
    return sm


class TestCgroupMemoryFallback:
    """mem_used_mb without SLURM uses global psutil.virtual_memory().used"""

    def test_no_slurm_uses_global_mem_used(self, monkeypatch):
        """Without SLURM_MEM_PER_NODE, use psutil global used memory."""
        monkeypatch.delenv("SLURM_MEM_PER_NODE", raising=False)
        global_used_mb = 32 * 1024
        fake = _build_fake_psutil(vmem=_make_svmem(total_mb=128 * 1024, used_mb=global_used_mb))
        sm = _load_sm(fake)
        mon = sm.SystemMonitor()
        stats = mon.collect({})
        assert stats["mem_used_mb"] == global_used_mb
        assert stats["mem_total_mb"] == 128 * 1024


class TestCgroupMemorySlurm:
    """With SLURM_MEM_PER_NODE set, mem_used_mb should prefer cgroup data."""

    def test_cgroup_v1_used_when_available(self, monkeypatch, tmp_path):
        """Read mem_used_mb from cgroup v1 usage file when SLURM job is active."""
        monkeypatch.setenv("SLURM_MEM_PER_NODE", "65536")  # 64 GiB allocation

        # Set up fake cgroup v1 hierarchy
        slurm_dir = tmp_path / "sys" / "fs" / "cgroup" / "memory" / "slurm" / "uid_1001" / "job_12345"
        slurm_dir.mkdir(parents=True)
        cgroup_used_mb = 12 * 1024  # 12 GiB used
        (slurm_dir / "memory.usage_in_bytes").write_text(str(cgroup_used_mb * 1024 ** 2))

        # Patch glob to return our fake path
        fake_pattern = str(slurm_dir / "memory.usage_in_bytes")
        fake = _build_fake_psutil(vmem=_make_svmem(used_mb=99 * 1024))  # should NOT be used
        sm = _load_sm(fake)

        with patch("glob.glob", return_value=[fake_pattern]):
            mon = sm.SystemMonitor()
            stats = mon.collect({})

        assert stats["mem_used_mb"] == cgroup_used_mb, (
            f"Expected cgroup-based {cgroup_used_mb} MB, got {stats['mem_used_mb']}"
        )
        assert stats["mem_total_mb"] == 65536

    def test_cgroup_v2_used_when_v1_absent(self, monkeypatch, tmp_path):
        """Fall back to cgroup v2 memory.current when v1 paths are not found."""
        monkeypatch.setenv("SLURM_MEM_PER_NODE", "32768")  # 32 GiB

        cgroup_v2_used_mb = 8 * 1024  # 8 GiB used
        cgroup_file = tmp_path / "memory.current"
        cgroup_file.write_text(str(cgroup_v2_used_mb * 1024 ** 2))

        fake = _build_fake_psutil(vmem=_make_svmem(used_mb=99 * 1024))
        sm = _load_sm(fake)

        # v1 glob returns nothing, v2 file exists at our tmp path
        with patch("glob.glob", return_value=[]), \
             patch("os.path.exists", return_value=True), \
             patch("builtins.open", create=True) as mock_open:
            # Simulate reading the cgroup v2 file
            mock_open.return_value.__enter__ = lambda s: s
            mock_open.return_value.__exit__ = MagicMock(return_value=False)
            mock_open.return_value.read = MagicMock(return_value=str(cgroup_v2_used_mb * 1024 ** 2))
            mon = sm.SystemMonitor()
            stats = mon.collect({})

        # mem_total should be from SLURM_MEM_PER_NODE
        assert stats["mem_total_mb"] == 32768

    def test_cgroup_unavailable_falls_back_to_psutil(self, monkeypatch):
        """When no cgroup files exist, fall back to psutil.virtual_memory().used."""
        monkeypatch.setenv("SLURM_MEM_PER_NODE", "65536")
        psutil_used_mb = 40 * 1024

        fake = _build_fake_psutil(vmem=_make_svmem(total_mb=256 * 1024, used_mb=psutil_used_mb))
        sm = _load_sm(fake)

        with patch("glob.glob", return_value=[]), \
             patch("os.path.exists", return_value=False):
            mon = sm.SystemMonitor()
            stats = mon.collect({})

        assert stats["mem_used_mb"] == psutil_used_mb
        assert stats["mem_total_mb"] == 65536

    def test_cgroup_file_malformed_falls_back_to_psutil(self, monkeypatch, tmp_path):
        """Malformed cgroup file → fall back to psutil.virtual_memory().used."""
        monkeypatch.setenv("SLURM_MEM_PER_NODE", "65536")
        psutil_used_mb = 25 * 1024

        bad_path = tmp_path / "memory.usage_in_bytes"
        bad_path.write_text("not-a-number\n")

        fake = _build_fake_psutil(vmem=_make_svmem(used_mb=psutil_used_mb))
        sm = _load_sm(fake)

        with patch("glob.glob", return_value=[str(bad_path)]):
            mon = sm.SystemMonitor()
            stats = mon.collect({})

        assert stats["mem_used_mb"] == psutil_used_mb

    def test_no_slurm_mem_per_node_skips_cgroup(self, monkeypatch):
        """Without SLURM_MEM_PER_NODE, cgroup is never consulted."""
        monkeypatch.delenv("SLURM_MEM_PER_NODE", raising=False)
        psutil_used_mb = 10 * 1024
        fake = _build_fake_psutil(vmem=_make_svmem(total_mb=64 * 1024, used_mb=psutil_used_mb))
        sm = _load_sm(fake)

        # glob should never be called
        with patch("glob.glob") as mock_glob:
            mon = sm.SystemMonitor()
            stats = mon.collect({})
            mock_glob.assert_not_called()

        assert stats["mem_used_mb"] == psutil_used_mb
