"""AOP preflight checks — run before the training function."""
from __future__ import annotations

import os
import shutil
import threading
import warnings
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .context import TrainingContext


def run_preflight(
    ctx: "TrainingContext",
    reads: list[str],
    writes: list[str] | None = None,
) -> None:
    """
    Perform pre-training sanity checks:

    1. Verify every path in `reads` exists and is readable. → raise on fail.
    1b. Verify every path in `writes` has a writable parent. → raise on fail.
    2. Ensure run_dir parent is writable (ALCHEMY_RUN_DIR writable). → raise on fail.
    3. Auto-create run_dir + checkpoint_dir with umask 002.
    4. Disk space warning if < 1 GiB free.
    5. GPU availability check (if torch importable). → raise on fail.
    6. Detect existing checkpoint → set ctx.is_resume = True.
    """

    # 1. Read paths check
    for rpath in reads:
        p = Path(rpath)
        if not p.exists():
            raise FileNotFoundError(
                f"Preflight: reads path does not exist: {rpath}"
            )
        if not os.access(rpath, os.R_OK):
            raise PermissionError(
                f"Preflight: reads path is not readable: {rpath}"
            )

    # 1b. Write paths check — verify parent dir exists and is writable
    for wpath in (writes or []):
        p = Path(wpath)
        # If target exists, check it's writable directly
        if p.exists():
            if not os.access(wpath, os.W_OK):
                raise PermissionError(
                    f"Preflight: writes path exists but is not writable: {wpath}"
                )
        else:
            # Target doesn't exist — check parent is writable (so we can create it)
            parent = p.parent
            if parent.exists():
                if not os.access(parent, os.W_OK):
                    raise PermissionError(
                        f"Preflight: writes path parent is not writable: {parent} "
                        f"(needed for {wpath})"
                    )
            else:
                raise FileNotFoundError(
                    f"Preflight: writes path parent does not exist: {parent} "
                    f"(needed for {wpath})"
                )

    # 2. run_dir writable — check parent directory
    run_dir_parent = ctx.run_dir.parent
    if run_dir_parent.exists():
        if not os.access(run_dir_parent, os.W_OK):
            raise PermissionError(
                f"Preflight: ALCHEMY_RUN_DIR parent is not writable: {run_dir_parent}"
            )
    else:
        # Try to create it
        try:
            _makedirs_002(run_dir_parent)
        except OSError as e:
            raise PermissionError(
                f"Preflight: cannot create run_dir parent {run_dir_parent}: {e}"
            ) from e

    # 3. Auto-create run_dir and checkpoint_dir
    _makedirs_002(ctx.run_dir)
    _makedirs_002(ctx.checkpoint_dir)

    # 4. Disk space warning (< 1 GiB = 1_073_741_824 bytes)
    try:
        usage = shutil.disk_usage(ctx.run_dir)
        if usage.free < 1_073_741_824:
            free_gb = usage.free / 1_073_741_824
            warnings.warn(
                f"Preflight: low disk space on {ctx.run_dir}: "
                f"{free_gb:.2f} GiB free (< 1 GiB threshold)",
                stacklevel=3,
            )
    except Exception:
        pass  # disk_usage may fail on exotic filesystems — not fatal

    # 5. GPU check — raise if torch installed but no CUDA
    try:
        import torch  # type: ignore
        if not torch.cuda.is_available():
            raise RuntimeError(
                "Preflight: torch.cuda.is_available() returned False. "
                "No GPU detected. Set CUDA_VISIBLE_DEVICES or check driver."
            )
    except ImportError:
        pass  # torch not installed — skip GPU check

    # 6. Detect existing checkpoint → set is_resume
    ckpt = ctx.latest_checkpoint()
    if ckpt is not None:
        ctx.is_resume = True


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

_umask_lock = threading.Lock()


def _makedirs_002(path: Path) -> None:
    """Create directories with umask 002 (group-writable). Thread-safe."""
    with _umask_lock:
        old_umask = os.umask(0o002)
        try:
            path.mkdir(parents=True, exist_ok=True)
        finally:
            os.umask(old_umask)
