"""System-level resource monitoring via psutil.

Collects CPU/MEM for the stub host and per-task resource usage.
"""
from __future__ import annotations

import logging
import os
from collections import deque
from typing import Any

log = logging.getLogger(__name__)

_WINDOW = 5  # samples kept for sliding-window mean


def _read_cgroup_mem_used_mb() -> int | None:
    """Read per-job memory usage from SLURM cgroup (v1 or v2).

    Returns used memory in MB, or None if cgroup files are not accessible.

    Cgroup v1 path: /sys/fs/cgroup/memory/slurm/uid_*/job_*/memory.usage_in_bytes
    Cgroup v2 path: /sys/fs/cgroup/memory.current  (also checked via SLURM uid/job hierarchy)
    """
    import glob

    # Cgroup v1: SLURM creates per-job directories under /sys/fs/cgroup/memory/slurm/
    patterns_v1 = [
        "/sys/fs/cgroup/memory/slurm/uid_*/job_*/memory.usage_in_bytes",
        "/sys/fs/cgroup/memory/slurm/uid_*/job_*/step_*/memory.usage_in_bytes",
    ]
    for pattern in patterns_v1:
        matches = glob.glob(pattern)
        if matches:
            # Use the job-level file (not step) if available
            job_level = [m for m in matches if "step_" not in m]
            path = job_level[0] if job_level else matches[0]
            try:
                with open(path) as f:
                    usage_bytes = int(f.read().strip())
                if usage_bytes > 0:
                    return usage_bytes // (1024 ** 2)
            except (OSError, ValueError):
                pass

    # Cgroup v2: /sys/fs/cgroup/memory.current (process's own cgroup)
    cgroup2_usage = "/sys/fs/cgroup/memory.current"
    if os.path.exists(cgroup2_usage):
        try:
            with open(cgroup2_usage) as f:
                val = f.read().strip()
                if val != "max":
                    usage_bytes = int(val)
                    if usage_bytes > 0:
                        return usage_bytes // (1024 ** 2)
        except (OSError, ValueError):
            pass

    return None


try:
    import psutil
    _PSUTIL_OK = True
except ImportError:
    _PSUTIL_OK = False
    log.warning("psutil not available — system stats will be empty")


class SystemMonitor:
    """Collects CPU/MEM stats for host and running tasks."""

    def __init__(self, gpu_monitor=None) -> None:
        """
        Args:
            gpu_monitor: optional GpuMonitor instance for per-PID GPU memory.
        """
        self._gpu_monitor = gpu_monitor
        # psutil.cpu_percent(interval=None) returns 0.0 on the very first call
        # because it has no prior measurement to compare against.  Prime it now
        # so subsequent collect() calls return real values immediately.
        if _PSUTIL_OK:
            try:
                psutil.cpu_percent(interval=None)
            except Exception:
                pass

        # Host CPU sliding window
        self._cpu_window: deque[float] = deque(maxlen=_WINDOW)
        # Per-task CPU sliding windows: {task_id: deque[float]}
        self._task_cpu_windows: dict[str, deque[float]] = {}

    def _host_cpu_smoothed(self, raw: float) -> float:
        """Push raw host CPU sample and return window mean."""
        self._cpu_window.append(raw)
        return sum(self._cpu_window) / len(self._cpu_window)

    def _task_cpu_smoothed(self, task_id: str, raw: float) -> float:
        """Push raw per-task CPU sample and return window mean."""
        if task_id not in self._task_cpu_windows:
            self._task_cpu_windows[task_id] = deque(maxlen=_WINDOW)
        w = self._task_cpu_windows[task_id]
        w.append(raw)
        return sum(w) / len(w)

    def collect(self, task_pids: dict[str, int]) -> dict[str, Any]:
        """Return SystemStats dict.

        Args:
            task_pids: {task_id: pid} for currently running tasks.
        """
        if not _PSUTIL_OK:
            return {
                "cpu_pct": 0.0,
                "mem_used_mb": 0,
                "mem_total_mb": 0,
                "per_task": {},
            }

        # Evict windows for tasks that are no longer running
        gone = set(self._task_cpu_windows) - set(task_pids)
        for tid in gone:
            del self._task_cpu_windows[tid]

        try:
            mem = psutil.virtual_memory()
            # If running under SLURM, use SLURM-allocated memory as the limit
            slurm_mem = os.environ.get("SLURM_MEM_PER_NODE")  # in MB
            if slurm_mem:
                mem_total_mb = int(slurm_mem)
                # Try to read cgroup memory usage for accuracy (per-job, not global)
                mem_used_mb = _read_cgroup_mem_used_mb()
                if mem_used_mb is None:
                    mem_used_mb = mem.used // (1024 ** 2)
            else:
                # Fallback to physical memory for workstation stubs
                mem_total_mb = mem.total // (1024 ** 2)
                mem_used_mb = mem.used // (1024 ** 2)
            if mem_total_mb == 0:
                log.warning(
                    "system_monitor: psutil.virtual_memory() returned total=0 "
                    "(used=%d) — host RAM stats will be zero; check psutil "
                    "compatibility on this node",
                    mem.used,
                )

            raw_cpu = psutil.cpu_percent(interval=None)
            stats: dict[str, Any] = {
                "cpu_pct": round(self._host_cpu_smoothed(raw_cpu), 1),
                "cpu_pct_raw": raw_cpu,
                "mem_used_mb": mem_used_mb,
                "mem_total_mb": mem_total_mb,
                "per_task": {},
            }

            for task_id, pid in task_pids.items():
                try:
                    proc = psutil.Process(pid)
                    if not proc.is_running():
                        continue
                    raw_task_cpu = proc.cpu_percent(interval=None)
                    smoothed_task_cpu = self._task_cpu_smoothed(task_id, raw_task_cpu)
                    mem_rss = proc.memory_info().rss // (1024 ** 2)
                    gpu_mem = 0
                    if self._gpu_monitor:
                        gpu_mem = self._gpu_monitor.get_gpu_mem_for_pid(pid)
                    stats["per_task"][task_id] = {
                        "cpu_pct": round(smoothed_task_cpu, 1),
                        "cpu_pct_raw": raw_task_cpu,
                        "mem_mb": mem_rss,
                        "gpu_mem_mb": gpu_mem,
                    }
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
                except Exception as e:
                    log.debug("per-task stats error pid=%d: %s", pid, e)

            return stats
        except Exception as e:
            log.warning("system stats collection failed: %s", e)
            return {
                "cpu_pct": 0.0,
                "mem_used_mb": 0,
                "mem_total_mb": 0,
                "per_task": {},
            }
