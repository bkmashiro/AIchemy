"""SLURM walltime sensing and drain logic.

Spec §9 — SLURM Walltime 感知:
  - Detect remaining walltime from SLURM_JOB_END_TIME env var or `squeue`.
  - Check every 60s.
  - When remaining < drain_threshold (10min), enter drain mode:
      1. Stop accepting new tasks.
      2. Send should_checkpoint to all running tasks.
      3. Wait 60s for checkpoint to complete.
      4. Send should_stop to all running tasks.
      5. Wait for tasks to exit (up to walltime - 2min).
      6. Notify server: "draining:walltime".
      7. Remaining tasks → server marks lost, auto-requeue.

Heartbeat reports walltime_remaining_s.
"""
from __future__ import annotations

import logging
import os
import subprocess
import time

log = logging.getLogger(__name__)

DRAIN_THRESHOLD_S = 600   # 10 minutes
CHECK_INTERVAL_S = 60


def _parse_slurm_time(time_str: str) -> int | None:
    """Parse SLURM time string into seconds.

    Formats: D-HH:MM:SS, HH:MM:SS, MM:SS, SS
    Returns None if unparseable.
    """
    time_str = time_str.strip()
    if not time_str or time_str in ("N/A", "UNLIMITED", "NOT_SET"):
        return None
    try:
        days = 0
        if "-" in time_str:
            day_part, time_str = time_str.split("-", 1)
            days = int(day_part)
        parts = time_str.split(":")
        if len(parts) == 3:
            h, m, s = int(parts[0]), int(parts[1]), int(parts[2])
        elif len(parts) == 2:
            h, m, s = 0, int(parts[0]), int(parts[1])
        else:
            h, m, s = 0, 0, int(parts[0])
        return days * 86400 + h * 3600 + m * 60 + s
    except (ValueError, IndexError):
        return None


def get_remaining_walltime() -> int | None:
    """Return remaining walltime in seconds. Non-SLURM → None.

    Priority:
      1. SLURM_JOB_END_TIME env var (unix timestamp) — fast, no subprocess.
      2. `squeue -j JOB_ID -h -o %L` — remaining time string.
    """
    job_id = os.environ.get("SLURM_JOB_ID")
    if not job_id:
        return None

    # Method 1: SLURM_JOB_END_TIME (set by newer SLURM versions)
    end_time_str = os.environ.get("SLURM_JOB_END_TIME")
    if end_time_str:
        try:
            end_ts = int(end_time_str)
            remaining = end_ts - int(time.time())
            return max(0, remaining)
        except (ValueError, TypeError):
            pass

    # Method 2: squeue
    try:
        result = subprocess.run(
            ["squeue", "-j", job_id, "-h", "-o", "%L"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            return _parse_slurm_time(result.stdout.strip())
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        log.debug("squeue failed: %s", e)

    return None
