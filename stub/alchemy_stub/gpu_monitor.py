"""GPU statistics collection via nvidia-smi (with pynvml fallback)."""
from __future__ import annotations

import logging
import subprocess
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger(__name__)


class GpuMonitor:
    """Polls GPU stats. Falls back to mock data if nvidia-smi unavailable."""

    def __init__(self) -> None:
        self._available = self._check_available()

    # ------------------------------------------------------------------ #
    # Availability                                                         #
    # ------------------------------------------------------------------ #

    def _check_available(self) -> bool:
        try:
            r = subprocess.run(
                ["nvidia-smi", "--query-gpu=count", "--format=csv,noheader"],
                capture_output=True,
                timeout=5,
            )
            return r.returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False

    # ------------------------------------------------------------------ #
    # GPU info (for registration / resume payload)                        #
    # ------------------------------------------------------------------ #

    def get_gpu_info(self) -> dict[str, Any]:
        """Return {name, vram_total_mb, count} for registration."""
        if not self._available:
            return {"name": "CPU-only", "vram_total_mb": 0, "count": 0}
        try:
            r = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            lines = [l.strip() for l in r.stdout.strip().splitlines() if l.strip()]
            if not lines:
                raise ValueError("no output")
            first = lines[0].split(",")
            return {
                "name": first[0].strip(),
                "vram_total_mb": int(first[1].strip()),
                "count": len(lines),
            }
        except Exception as e:
            log.warning("get_gpu_info failed: %s", e)
            return {"name": "Unknown GPU", "vram_total_mb": 0, "count": 1}

    # ------------------------------------------------------------------ #
    # Per-tick stats                                                       #
    # ------------------------------------------------------------------ #

    def query(self) -> dict[str, Any]:
        """Return GpuStats dict suitable for the gpu_stats socket event."""
        if self._available:
            return self._query_real()
        return self._query_mock()

    def _query_real(self) -> dict[str, Any]:
        try:
            r = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            gpus = []
            for line in r.stdout.strip().splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) < 6:
                    continue
                try:
                    gpus.append(
                        {
                            "index": int(parts[0]),
                            "name": parts[1],
                            "utilization_pct": int(parts[2]),
                            "memory_used_mb": int(parts[3]),
                            "memory_total_mb": int(parts[4]),
                            "temperature_c": int(parts[5]),
                        }
                    )
                except (ValueError, IndexError):
                    pass
            return {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "gpus": gpus,
            }
        except Exception as e:
            log.warning("nvidia-smi query failed: %s", e)
            return self._query_mock()

    def _query_mock(self) -> dict[str, Any]:
        return {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "gpus": [],
        }

    # ------------------------------------------------------------------ #
    # Per-PID GPU memory (best-effort)                                    #
    # ------------------------------------------------------------------ #

    def get_gpu_mem_for_pid(self, pid: int) -> int:
        """Return GPU memory in MB used by the given PID. 0 if unknown."""
        if not self._available:
            return 0
        try:
            r = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-compute-apps=pid,used_memory",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=5,
            )
            for line in r.stdout.strip().splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 2 and parts[0] == str(pid):
                    return int(parts[1])
        except Exception:
            pass
        return 0
