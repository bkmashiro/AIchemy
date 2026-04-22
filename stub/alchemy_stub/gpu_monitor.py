"""GPU monitoring via nvidia-smi with mock fallback."""
import subprocess
import json
from datetime import datetime, timezone
from typing import Any


class GpuMonitor:
    """Polls nvidia-smi for GPU stats. Falls back to mock data if unavailable."""

    def __init__(self):
        self._available = self._check_available()

    def _check_available(self) -> bool:
        try:
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=count", "--format=csv,noheader"],
                capture_output=True,
                timeout=5,
            )
            return result.returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False

    def query(self) -> dict[str, Any]:
        """Return GpuStats dict."""
        if self._available:
            return self._query_real()
        else:
            return self._query_mock()

    def _query_real(self) -> dict[str, Any]:
        try:
            result = subprocess.run(
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
            for line in result.stdout.strip().split("\n"):
                if not line.strip():
                    continue
                parts = [p.strip() for p in line.split(",")]
                if len(parts) < 6:
                    continue
                gpus.append(
                    {
                        "index": int(parts[0]),
                        "utilization_pct": int(parts[2]),
                        "memory_used_mb": int(parts[3]),
                        "memory_total_mb": int(parts[4]),
                        "temperature_c": int(parts[5]),
                    }
                )
            return {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "gpus": gpus,
            }
        except Exception:
            return self._query_mock()

    def _query_mock(self) -> dict[str, Any]:
        return {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "gpus": [
                {
                    "index": 0,
                    "utilization_pct": 0,
                    "memory_used_mb": 0,
                    "memory_total_mb": 40960,
                    "temperature_c": 30,
                }
            ],
        }

    def get_gpu_info(self) -> dict[str, Any]:
        """Return GPU info for registration."""
        if self._available:
            return self._get_real_gpu_info()
        return {
            "name": "Mock GPU",
            "vram_total_mb": 40960,
            "count": 1,
        }

    def _get_real_gpu_info(self) -> dict[str, Any]:
        try:
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,memory.total,count", "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            lines = result.stdout.strip().split("\n")
            if not lines:
                raise ValueError("No GPU info")
            parts = [p.strip() for p in lines[0].split(",")]
            return {
                "name": parts[0],
                "vram_total_mb": int(parts[1]),
                "count": len(lines),
            }
        except Exception:
            return {
                "name": "Unknown GPU",
                "vram_total_mb": 0,
                "count": 1,
            }
