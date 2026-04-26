"""Tests for sliding-window / EMA smoothing in GpuMonitor and SystemMonitor."""
from __future__ import annotations

import sys
import types
from collections import deque
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# GpuMonitor EMA tests
# ---------------------------------------------------------------------------

def _make_gpu_monitor(available: bool = True):
    """Return a GpuMonitor with nvidia-smi availability mocked."""
    from alchemy_stub.gpu_monitor import GpuMonitor

    with patch.object(GpuMonitor, "_check_available", return_value=available):
        m = GpuMonitor()
    return m


def _fake_smi_output(*util_values: int) -> str:
    """Build fake nvidia-smi CSV output for a single GPU with given utilisation values."""
    # Format: index, name, utilization.gpu, memory.used, memory.total, temperature.gpu
    return "\n".join(
        f"0, Tesla T4, {v}, 1024, 16160, 55" for v in util_values
    )


def _run_query(monitor, util: int):
    """Patch subprocess.run to return *util* for GPU 0 and call monitor.query()."""
    import subprocess
    result = MagicMock()
    result.stdout = _fake_smi_output(util)
    result.returncode = 0
    with patch("subprocess.run", return_value=result):
        return monitor.query()


class TestGpuMonitorEMA:
    def test_first_sample_equals_raw(self):
        m = _make_gpu_monitor()
        out = _run_query(m, 80)
        gpu = out["gpus"][0]
        assert gpu["utilization_pct_raw"] == 80
        # First sample: EMA initialised to raw value
        assert gpu["utilization_pct"] == 80.0

    def test_ema_smooths_spike(self):
        """After several high samples a sudden 0 should not drop reported value to 0."""
        m = _make_gpu_monitor()
        # Warm up EMA with high utilisation
        for _ in range(5):
            _run_query(m, 100)
        # Now a single 0 sample
        out = _run_query(m, 0)
        gpu = out["gpus"][0]
        assert gpu["utilization_pct_raw"] == 0
        # Smoothed value must still be significantly above 0
        assert gpu["utilization_pct"] > 50

    def test_ema_converges_to_stable_value(self):
        """After many identical samples EMA should be very close to that value."""
        m = _make_gpu_monitor()
        for _ in range(20):
            out = _run_query(m, 60)
        gpu = out["gpus"][0]
        assert abs(gpu["utilization_pct"] - 60.0) < 0.5

    def test_raw_field_present(self):
        m = _make_gpu_monitor()
        out = _run_query(m, 42)
        assert "utilization_pct_raw" in out["gpus"][0]

    def test_ema_alpha_weighting(self):
        """Verify EMA formula: new = 0.3*raw + 0.7*prev."""
        from alchemy_stub.gpu_monitor import _EMA_ALPHA
        m = _make_gpu_monitor()
        # First sample primes EMA to 50
        _run_query(m, 50)
        # Second sample: raw=100
        out = _run_query(m, 100)
        expected = round(_EMA_ALPHA * 100 + (1 - _EMA_ALPHA) * 50, 1)
        assert out["gpus"][0]["utilization_pct"] == expected

    def test_multiple_gpus_tracked_independently(self):
        """Each GPU index has its own EMA state."""
        import subprocess
        from alchemy_stub.gpu_monitor import GpuMonitor, _EMA_ALPHA

        with patch.object(GpuMonitor, "_check_available", return_value=True):
            m = GpuMonitor()

        def two_gpu_output(util0: int, util1: int) -> str:
            return (
                f"0, Tesla T4, {util0}, 1024, 16160, 55\n"
                f"1, Tesla T4, {util1}, 2048, 16160, 60"
            )

        result = MagicMock()
        result.returncode = 0

        # Prime both GPUs
        result.stdout = two_gpu_output(100, 0)
        with patch("subprocess.run", return_value=result):
            m.query()

        # Second query: GPU0 stays 100, GPU1 jumps to 100
        result.stdout = two_gpu_output(100, 100)
        with patch("subprocess.run", return_value=result):
            out = m.query()

        gpu0 = next(g for g in out["gpus"] if g["index"] == 0)
        gpu1 = next(g for g in out["gpus"] if g["index"] == 1)

        # GPU0: 2nd update of EMA(100, prev=100) → still 100
        assert gpu0["utilization_pct"] == 100.0
        # GPU1: 2nd update of EMA(100, prev=0) → 30.0
        assert gpu1["utilization_pct"] == round(_EMA_ALPHA * 100 + (1 - _EMA_ALPHA) * 0, 1)


# ---------------------------------------------------------------------------
# SystemMonitor sliding-window tests (no psutil required)
# ---------------------------------------------------------------------------

def _make_system_monitor_no_psutil():
    """Return a SystemMonitor with psutil mocked out at module level."""
    import alchemy_stub.system_monitor as sm_mod

    # Patch psutil availability flag and inject a minimal fake psutil
    fake_psutil = types.SimpleNamespace(
        cpu_percent=MagicMock(return_value=0.0),
        virtual_memory=MagicMock(return_value=MagicMock(used=1024**3, total=8 * 1024**3)),
        Process=MagicMock,
        NoSuchProcess=Exception,
        AccessDenied=Exception,
    )
    with (
        patch.object(sm_mod, "_PSUTIL_OK", True),
        patch.object(sm_mod, "psutil", fake_psutil, create=True),
    ):
        mon = sm_mod.SystemMonitor()
    return mon, fake_psutil, sm_mod


class TestSystemMonitorWindow:
    def test_window_mean_of_one(self):
        from alchemy_stub.system_monitor import SystemMonitor, _WINDOW
        mon = SystemMonitor.__new__(SystemMonitor)
        mon._gpu_monitor = None
        mon._cpu_window = deque(maxlen=_WINDOW)
        mon._task_cpu_windows = {}
        assert mon._host_cpu_smoothed(50.0) == 50.0

    def test_window_mean_multiple(self):
        from alchemy_stub.system_monitor import SystemMonitor, _WINDOW
        mon = SystemMonitor.__new__(SystemMonitor)
        mon._gpu_monitor = None
        mon._cpu_window = deque(maxlen=_WINDOW)
        mon._task_cpu_windows = {}
        mon._host_cpu_smoothed(0.0)
        mon._host_cpu_smoothed(100.0)
        result = mon._host_cpu_smoothed(50.0)
        assert abs(result - 50.0) < 0.01  # mean of [0, 100, 50]

    def test_window_bounded_by_maxlen(self):
        from alchemy_stub.system_monitor import SystemMonitor, _WINDOW
        mon = SystemMonitor.__new__(SystemMonitor)
        mon._gpu_monitor = None
        mon._cpu_window = deque(maxlen=_WINDOW)
        mon._task_cpu_windows = {}
        # Fill beyond window size with 0, then push _WINDOW 100s
        for _ in range(_WINDOW + 3):
            mon._host_cpu_smoothed(0.0)
        for _ in range(_WINDOW):
            result = mon._host_cpu_smoothed(100.0)
        # Window is full of 100s now
        assert result == 100.0

    def test_spike_dampened_by_window(self):
        from alchemy_stub.system_monitor import SystemMonitor, _WINDOW
        mon = SystemMonitor.__new__(SystemMonitor)
        mon._gpu_monitor = None
        mon._cpu_window = deque(maxlen=_WINDOW)
        mon._task_cpu_windows = {}
        # Warm up with high CPU
        for _ in range(_WINDOW):
            mon._host_cpu_smoothed(80.0)
        # Single 0 spike
        result = mon._host_cpu_smoothed(0.0)
        assert result > 50.0

    def test_task_cpu_smoothed_independent_per_task(self):
        from alchemy_stub.system_monitor import SystemMonitor, _WINDOW
        mon = SystemMonitor.__new__(SystemMonitor)
        mon._gpu_monitor = None
        mon._cpu_window = deque(maxlen=_WINDOW)
        mon._task_cpu_windows = {}

        mon._task_cpu_smoothed("task-a", 100.0)
        mon._task_cpu_smoothed("task-b", 0.0)
        a = mon._task_cpu_smoothed("task-a", 100.0)
        b = mon._task_cpu_smoothed("task-b", 0.0)
        assert a == 100.0
        assert b == 0.0

    def test_task_window_evicted_when_task_gone(self):
        from alchemy_stub.system_monitor import SystemMonitor, _WINDOW
        import alchemy_stub.system_monitor as sm_mod

        fake_psutil = types.SimpleNamespace(
            cpu_percent=MagicMock(return_value=40.0),
            virtual_memory=MagicMock(
                return_value=MagicMock(used=512 * 1024 ** 2, total=8 * 1024 ** 2)
            ),
            Process=MagicMock,
            NoSuchProcess=Exception,
            AccessDenied=Exception,
        )

        with (
            patch.object(sm_mod, "_PSUTIL_OK", True),
            patch.object(sm_mod, "psutil", fake_psutil, create=True),
        ):
            mon = sm_mod.SystemMonitor()
            # prime task window
            mon._task_cpu_smoothed("dead-task", 99.0)
            assert "dead-task" in mon._task_cpu_windows
            # collect with no pids → should evict dead-task
            mon.collect({})
            assert "dead-task" not in mon._task_cpu_windows

    def test_collect_returns_raw_and_smoothed(self):
        from alchemy_stub.system_monitor import SystemMonitor
        import alchemy_stub.system_monitor as sm_mod

        fake_psutil = types.SimpleNamespace(
            cpu_percent=MagicMock(return_value=42.0),
            virtual_memory=MagicMock(
                return_value=MagicMock(used=1024 ** 3, total=8 * 1024 ** 3)
            ),
            Process=MagicMock,
            NoSuchProcess=Exception,
            AccessDenied=Exception,
        )

        with (
            patch.object(sm_mod, "_PSUTIL_OK", True),
            patch.object(sm_mod, "psutil", fake_psutil, create=True),
        ):
            mon = sm_mod.SystemMonitor()
            stats = mon.collect({})

        assert "cpu_pct" in stats
        assert "cpu_pct_raw" in stats
        assert stats["cpu_pct_raw"] == 42.0
        assert stats["cpu_pct"] == 42.0  # single sample → mean == raw
