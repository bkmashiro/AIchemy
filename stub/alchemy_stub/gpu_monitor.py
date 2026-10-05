"""GPU statistics collection via nvidia-smi (with pynvml fallback)."""
from __future__ import annotations

import logging
import os
import re
import subprocess
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger(__name__)

_EMA_ALPHA = 0.3  # weight on the newest sample; ~3-sample effective window


class GpuMonitor:
    """Polls GPU stats. Falls back to mock data if nvidia-smi unavailable."""

    def __init__(self) -> None:
        self._available = self._check_available()
        self._slurm_job_id = os.environ.get("SLURM_JOB_ID")
        self._cuda_visible_devices = os.environ.get("CUDA_VISIBLE_DEVICES")
        self._slurm_job_gpus = os.environ.get("SLURM_JOB_GPUS", "")
        # EMA state: {gpu_index: smoothed_utilization_pct}
        self._ema: dict[int, float] = {}

    def _allocation_scope(self) -> tuple[set[str] | None, bool]:
        """Return permitted nvidia-smi UUID/index keys and whether mapping is safe.

        CUDA ordinals are not assumed to be host ordinals in a Slurm job. UUID
        visibility is directly matchable; numeric IDs are accepted only when
        Slurm's job GPU IDs state the same numeric IDs.
        """
        if not self._slurm_job_id:
            return None, True
        visible = self._cuda_visible_devices
        if visible is None:
            return set(), False
        devices = [item.strip() for item in visible.split(",") if item.strip()]
        if not devices:
            return set(), True
        if all(item.startswith("GPU-") for item in devices):
            return set(devices), True
        if all(re.fullmatch(r"\d+", item) for item in devices):
            allocated = [item.strip() for item in self._slurm_job_gpus.split(",") if item.strip()]
            if allocated and all(re.fullmatch(r"\d+", item) for item in allocated) and set(devices) == set(allocated):
                return set(devices), True
        # Includes MIG UUIDs and mixed/ambiguous identifiers. nvidia-smi's
        # physical GPU rows cannot safely represent a MIG allocation.
        return set(), False

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
        scope, known = self._allocation_scope()
        if not self._available:
            # Without a live query, an allocated Slurm device cannot be
            # confirmed. Do not let old registration totals stand in for it.
            if self._slurm_job_id and scope:
                known = False
            return {"name": "CPU-only", "vram_total_mb": 0, "count": 0, "allocation_known": known}
        if scope == set():
            return {"name": "Unknown GPU allocation", "vram_total_mb": 0, "count": 0, "allocation_known": known}
        try:
            r = subprocess.run(
                ["nvidia-smi", "--query-gpu=index,uuid,name,memory.total", "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if r.returncode != 0:
                raise RuntimeError(f"nvidia-smi exited with status {r.returncode}")
            lines = [l.strip() for l in r.stdout.strip().splitlines() if l.strip()]
            matched: set[str] = set()
            if scope is not None:
                id_column = 0 if all(item.isdigit() for item in scope) else 1
                scoped_lines = []
                for line in lines:
                    parts = [part.strip() for part in line.split(",")]
                    if len(parts) < 4 or parts[id_column] not in scope:
                        continue
                    try:
                        int(parts[3])
                    except ValueError:
                        continue
                    matched.add(parts[id_column])
                    scoped_lines.append(line)
                lines = scoped_lines
                known = known and matched == scope
            if not lines:
                if scope is not None:
                    return {"name": "Unknown GPU allocation", "vram_total_mb": 0, "count": 0, "allocation_known": known}
                raise ValueError("no output")
            first = lines[0].split(",")
            return {
                "name": first[2].strip(),
                "vram_total_mb": int(first[3].strip()),
                "count": len(lines),
                "allocation_known": known,
            }
        except Exception as e:
            log.warning("get_gpu_info failed: %s", e)
            return {"name": "Unknown GPU allocation", "vram_total_mb": 0, "count": 0, "allocation_known": False}

    # ------------------------------------------------------------------ #
    # Per-tick stats                                                       #
    # ------------------------------------------------------------------ #

    def query(self) -> dict[str, Any]:
        """Return GpuStats dict suitable for the gpu_stats socket event."""
        if self._available:
            return self._query_real()
        mock = self._query_mock()
        if self._slurm_job_id:
            mock["allocation_known"] = False
        return mock

    def _query_real(self) -> dict[str, Any]:
        scope, known = self._allocation_scope()
        if scope == set():
            return {"timestamp": datetime.now(timezone.utc).isoformat(), "gpus": [], "allocation_known": known}
        try:
            r = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,uuid",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if r.returncode != 0:
                raise RuntimeError(f"nvidia-smi exited with status {r.returncode}")
            gpus = []
            matched: set[str] = set()
            malformed_scoped_row = False
            for line in r.stdout.strip().splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) < 7:
                    if scope is not None:
                        malformed_scoped_row = True
                    continue
                try:
                    idx = int(parts[0])
                    scope_key = str(idx) if scope is not None and all(item.isdigit() for item in scope) else parts[6]
                    if scope is not None and scope_key not in scope:
                        continue
                    matched.add(scope_key)
                    raw_util = int(parts[2])
                    memory_used = int(parts[3])
                    memory_total = int(parts[4])
                    temperature = int(parts[5])
                    # EMA smoothing: initialise with raw value on first sample
                    prev = self._ema.get(idx, raw_util)
                    smoothed = _EMA_ALPHA * raw_util + (1 - _EMA_ALPHA) * prev
                    self._ema[idx] = smoothed
                    gpus.append(
                        {
                            "index": idx,
                            "name": parts[1],
                            "utilization_pct": round(smoothed, 1),
                            "utilization_pct_raw": raw_util,
                            "memory_used_mb": memory_used,
                            "memory_total_mb": memory_total,
                            "temperature_c": temperature,
                        }
                    )
                except (ValueError, IndexError):
                    if scope is not None:
                        malformed_scoped_row = True
            if scope is not None:
                # A partial map is not a safe capacity sample. In particular,
                # an empty tick for a non-empty allocation must not fall back
                # to registration-time GPU totals in the scheduler.
                known = known and matched == scope and not malformed_scoped_row
            return {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "gpus": gpus,
                "allocation_known": known,
            }
        except Exception as e:
            log.warning("nvidia-smi query failed: %s", e)
            return {**self._query_mock(), "allocation_known": False}

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
