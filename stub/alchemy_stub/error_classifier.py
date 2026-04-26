"""Task death/failure classification.

Two public APIs:
  - classify_failure(exit_code, log_lines) → {"reason": FailureReason, "detail": str}
    Fine-grained classification using exit code + log content. Used for error
    reporting and UI display.

  - classify_death(exit_code, signal_num, slurm_job_id) → DeathCause string
    Coarse infrastructure-level classification for auto-resume decisions.
    Returns one of: 'success', 'code_error', 'oom', 'walltime', 'preempt', 'lost'.

  - has_checkpoint(run_dir) → bool
    Check if a task's run_dir contains checkpoint files.
"""
from __future__ import annotations

import glob as globmod
import logging
import os
import re
import subprocess
from typing import Literal

log = logging.getLogger(__name__)


# ─── FailureReason (fine-grained, for UI/logging) ────────────────────────────

class FailureReason:
    OOM = "oom"
    CUDA_ERROR = "cuda_error"
    PYTHON_ERROR = "python_error"
    TIMEOUT = "timeout"
    SIGTERM = "sigterm"
    SIGKILL = "sigkill"
    UNKNOWN = "unknown"


# Log patterns
_OOM_RE = re.compile(r"CUDA out of memory|OutOfMemoryError|torch\.cuda\.OutOfMemoryError", re.IGNORECASE)
_CUDA_RE = re.compile(r"CUDA error:|NCCL error|cudaError\w+:", re.IGNORECASE)
_TRACEBACK_RE = re.compile(r"^(\[.*?\]:\s*)?Traceback \(most recent call last\):")
_PYTHON_ERROR_LINE_RE = re.compile(r"^(\[.*?\]:\s*)?(\w+Error|\w+Exception):")


def classify_failure(exit_code: int, last_lines: list[str]) -> dict:
    """Classify task failure from exit code and last N log lines.

    Returns: {"reason": str, "detail": str}
    """
    # ── Exit-code based (highest priority) ────────────────────────────────
    if exit_code in (-9, 137):  # SIGKILL / OOM killer
        return {"reason": FailureReason.OOM, "detail": f"Killed by SIGKILL (exit {exit_code}) — likely OOM"}

    if exit_code in (-15, 143):  # SIGTERM
        return {"reason": FailureReason.SIGTERM, "detail": f"SIGTERM (exit {exit_code})"}

    # ── Log-based classification (scan last 50 lines) ────────────────────
    tail = last_lines[-50:] if len(last_lines) > 50 else last_lines

    # Check OOM patterns first
    for line in tail:
        if _OOM_RE.search(line):
            return {"reason": FailureReason.OOM, "detail": line.strip()[:200]}

    # Check CUDA/NCCL patterns
    for line in tail:
        if _CUDA_RE.search(line):
            return {"reason": FailureReason.CUDA_ERROR, "detail": line.strip()[:200]}

    # Check Python traceback — find last traceback + last error line
    has_traceback = False
    last_error_line = None
    for line in tail:
        if _TRACEBACK_RE.match(line):
            has_traceback = True
        if _PYTHON_ERROR_LINE_RE.match(line):
            last_error_line = line.strip()

    if has_traceback and last_error_line:
        return {"reason": FailureReason.PYTHON_ERROR, "detail": last_error_line[:200]}

    # Unknown
    return {"reason": FailureReason.UNKNOWN, "detail": f"Exit code {exit_code}"}


# ─── DeathCause (coarse, for auto-resume) ────────────────────────────────────

DeathCause = Literal["success", "code_error", "oom", "walltime", "preempt", "lost", "killed"]


def _check_dmesg_oom() -> bool:
    """Check dmesg for recent OOM killer activity.

    Best-effort: returns False if dmesg is not available or unreadable.
    """
    try:
        result = subprocess.run(
            ["dmesg"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return False
        lines = result.stdout.strip().split("\n")[-100:]
        for line in lines:
            if "Out of memory" in line or "oom-kill" in line or "Killed process" in line:
                return True
    except Exception:
        pass
    return False


def classify_death(
    exit_code: int,
    signal_num: int | None = None,
    slurm_job_id: str | None = None,
    killed_by_stub: bool = False,
) -> DeathCause:
    """Classify task death cause for auto-resume decision.

    Args:
        exit_code: Process exit code (may be negative for signals in Python).
        signal_num: Signal number if killed by signal.
        slurm_job_id: SLURM_JOB_ID env var if running under SLURM.

    Returns one of: 'success', 'code_error', 'oom', 'walltime', 'preempt', 'lost'.
    """
    if exit_code == 0:
        return "success"

    # Derive effective signal from exit_code if signal_num not provided
    effective_signal = signal_num
    if effective_signal is None:
        if exit_code < 0:
            effective_signal = abs(exit_code)
        elif exit_code > 128:
            effective_signal = exit_code - 128

    # SIGKILL (9) → likely OOM
    if effective_signal == 9:
        if _check_dmesg_oom():
            return "oom"
        return "lost"

    # SIGTERM (15) under SLURM → walltime (unless stub itself initiated the kill)
    if effective_signal == 15 and slurm_job_id and not killed_by_stub:
        return "walltime"

    # SIGTERM from stub-initiated kill → killed
    if effective_signal == 15 and killed_by_stub:
        return "killed"

    # SIGTERM without SLURM → generic code_error
    if effective_signal == 15:
        return "code_error"

    # Everything else: non-zero exit → code_error
    return "code_error"


def has_checkpoint(run_dir: str | None) -> bool:
    """Check if a task's run_dir contains checkpoint files.

    Looks for: checkpoint*, *.ckpt, *.pt, *.pth, *.safetensors
    """
    if not run_dir or not os.path.isdir(run_dir):
        return False

    patterns = [
        os.path.join(run_dir, "checkpoint*"),
        os.path.join(run_dir, "*.ckpt"),
        os.path.join(run_dir, "*.pt"),
        os.path.join(run_dir, "*.pth"),
        os.path.join(run_dir, "*.safetensors"),
        os.path.join(run_dir, "**", "checkpoint*"),
    ]
    for pattern in patterns:
        if globmod.glob(pattern, recursive=True):
            return True
    return False
