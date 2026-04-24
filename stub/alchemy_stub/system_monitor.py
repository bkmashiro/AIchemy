"""System-level resource monitoring via psutil.

Collects CPU/MEM for the stub host and per-task resource usage.
"""
from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)

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

        try:
            mem = psutil.virtual_memory()
            stats: dict[str, Any] = {
                "cpu_pct": psutil.cpu_percent(interval=None),
                "mem_used_mb": mem.used // (1024 ** 2),
                "mem_total_mb": mem.total // (1024 ** 2),
                "per_task": {},
            }

            for task_id, pid in task_pids.items():
                try:
                    proc = psutil.Process(pid)
                    if not proc.is_running():
                        continue
                    cpu = proc.cpu_percent(interval=None)
                    mem_rss = proc.memory_info().rss // (1024 ** 2)
                    gpu_mem = 0
                    if self._gpu_monitor:
                        gpu_mem = self._gpu_monitor.get_gpu_mem_for_pid(pid)
                    stats["per_task"][task_id] = {
                        "cpu_pct": cpu,
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
