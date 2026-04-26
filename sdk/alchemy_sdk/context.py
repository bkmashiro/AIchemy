"""TrainingContext — AOP training runtime."""
from __future__ import annotations

import os
import tempfile
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Iterator, Optional

if TYPE_CHECKING:
    from .client import Alchemy

# Hook callback type: (ctx, step) -> None
HookFn = Callable[["TrainingContext", int], None]


class TrainingContext:
    """
    Framework-managed training context.  Injected into @al.managed() functions.

    Gives training code:
      - params: dict from ALCHEMY_PARAMS (immutable, defensive copy)
      - run_dir: from ALCHEMY_RUN_DIR env var (server is single source of truth)
      - checkpoint_dir: run_dir / "checkpoints"
      - is_resume: True if an existing checkpoint was found
      - Path helpers: sub_dir(), artifact_dir()
      - Checkpoint lifecycle: latest_checkpoint(), save_checkpoint()
      - Training loop: steps()
      - Signal proxies: should_eval(), should_checkpoint(), should_stop()
      - Reports: log(), log_eval()
    """

    def __init__(
        self,
        al: "Alchemy",
        total_steps: int = 0,
        eval_every: int = 0,
        checkpoint_every: int = 0,
    ) -> None:
        self._al = al
        self._total_steps = total_steps
        self._eval_every = eval_every
        self._checkpoint_every = checkpoint_every
        self._current_step: int = 0

        # --- Immutable params (defensive copy) ---
        self._params: dict[str, Any] = al.params()

        # --- run_dir: always from ALCHEMY_RUN_DIR (server-authoritative) ---
        self._run_dir = self._resolve_run_dir()
        self._checkpoint_dir = self._run_dir / "checkpoints"

        # is_resume is set by preflight after scanning checkpoint_dir
        self.is_resume: bool = False

        # Lifecycle hooks
        self._hooks: dict[str, list[HookFn]] = {
            "on_step_start": [],
            "on_step_end": [],
            "on_eval": [],
            "on_checkpoint": [],
        }

    # ------------------------------------------------------------------
    # Pure reads
    # ------------------------------------------------------------------

    @property
    def params(self) -> dict[str, Any]:
        """Immutable parameter dict from ALCHEMY_PARAMS. Returns defensive copy."""
        return dict(self._params)

    @property
    def run_dir(self) -> Path:
        return self._run_dir

    @property
    def checkpoint_dir(self) -> Path:
        return self._checkpoint_dir

    # ------------------------------------------------------------------
    # run_dir resolution
    # ------------------------------------------------------------------

    def _resolve_run_dir(self) -> Path:
        """
        Server is the single source of truth for run_dir.
        SDK reads ALCHEMY_RUN_DIR env var — set by stub at task launch.

        Under alchemy (managed): ALCHEMY_RUN_DIR must exist. Missing = crash.
        Standalone (noop): fallback to cwd/runs/{fingerprint[:12]}.
        """
        env_run_dir = os.environ.get("ALCHEMY_RUN_DIR")
        if env_run_dir:
            return Path(env_run_dir)

        if self._al._managed:
            raise RuntimeError(
                "ALCHEMY_RUN_DIR not set. Under alchemy management, "
                "run_dir must be provided by the server via stub. "
                "This is a bug in stub/server — not a user error."
            )

        # No-op mode: compute a local fallback deterministically
        fingerprint = self._compute_fingerprint()
        return Path.cwd() / "runs" / fingerprint[:12]

    def _compute_fingerprint(self) -> str:
        """
        Compute a fingerprint from ALCHEMY_PARAMS for no-op fallback naming.
        Falls back to a fixed tag if params are empty.
        """
        import hashlib
        import json as _json

        params_raw = os.environ.get("ALCHEMY_PARAMS", "{}")
        try:
            params_dict = _json.loads(params_raw)
        except Exception:
            params_dict = {}

        stable = _json.dumps(params_dict, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(stable.encode()).hexdigest()
        return digest

    # ------------------------------------------------------------------
    # Path allocation helpers (SPEC: sub_dir, artifact_dir)
    # ------------------------------------------------------------------

    def sub_dir(self, name: str) -> Path:
        """
        Return run_dir / name.  Auto-creates directory with umask 002.
        Idempotent.
        """
        path = self._run_dir / name
        _makedirs_002(path)
        return path

    def artifact_dir(self, name: str) -> Path:
        """Return run_dir / artifacts / name.  Auto-creates directory."""
        path = self._run_dir / "artifacts" / name
        _makedirs_002(path)
        return path

    # ------------------------------------------------------------------
    # Checkpoint lifecycle
    # ------------------------------------------------------------------

    def latest_checkpoint(self) -> Optional[Path]:
        """
        Scan checkpoint_dir for .pt files. Return the latest by mtime, or None.
        """
        if not self._checkpoint_dir.exists():
            return None
        pts = []
        for p in self._checkpoint_dir.glob("*.pt"):
            try:
                pts.append((p.stat().st_mtime, p))
            except OSError:
                continue  # file deleted between glob and stat
        if not pts:
            return None
        pts.sort(key=lambda x: x[0])
        return pts[-1][1]

    def save_checkpoint(self, state_dict: Any, name: str = "latest") -> Path:
        """
        torch.save(state_dict, checkpoint_dir/name.pt) atomically, then notify stub.

        Requires torch to be installed.  If not, raises ImportError.
        Same name = overwrite (atomic via tmp + rename).
        """
        try:
            import torch  # type: ignore
        except ImportError as exc:
            raise ImportError(
                "torch is required for TrainingContext.save_checkpoint(). "
                "Install PyTorch or use al.checkpoint(path) for manual saves."
            ) from exc

        _makedirs_002(self._checkpoint_dir)
        path = self._checkpoint_dir / f"{name}.pt"

        # Write atomically via tmp file + rename
        tmp = path.with_suffix(".tmp")
        try:
            torch.save(state_dict, tmp)
            tmp.replace(path)
        except Exception:
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass
            raise

        # Notify stub
        self._al.checkpoint(str(path))
        return path

    # ------------------------------------------------------------------
    # Lifecycle hooks
    # ------------------------------------------------------------------

    def on(self, event: str, fn: HookFn) -> "TrainingContext":
        """
        Register a lifecycle hook.

        Events: on_step_start, on_step_end, on_eval, on_checkpoint.
        Callback signature: (ctx, step) -> None.

        Returns self for chaining:
            ctx.on("on_eval", my_eval_fn).on("on_checkpoint", my_save_fn)
        """
        if event not in self._hooks:
            raise ValueError(f"Unknown hook event: {event}. Valid: {list(self._hooks)}")
        self._hooks[event].append(fn)
        return self

    def _fire(self, event: str) -> None:
        """Fire all hooks registered for an event."""
        for fn in self._hooks.get(event, []):
            fn(self, self._current_step)

    # ------------------------------------------------------------------
    # Training loop iterator
    # ------------------------------------------------------------------

    def steps(self, start: int = 0) -> Iterator[int]:
        """
        Yield step indices [start, total_steps).
        Automatically calls al.log() at each step (throttled internally).
        Fires on_step_start before yield, on_step_end after.
        Auto-fires on_eval and on_checkpoint when conditions met.
        Breaks on should_stop().
        """
        self._current_step = start
        total = self._total_steps or 0

        while True:
            step = self._current_step
            if total and step >= total:
                break
            if self._al.should_stop():
                break

            self._fire("on_step_start")
            yield step

            # Auto-report progress after each step
            self._al.log(step=self._current_step, total=total)

            # Fire conditional hooks
            if self.should_eval():
                self._fire("on_eval")
            if self.should_checkpoint():
                self._fire("on_checkpoint")

            self._fire("on_step_end")
            self._current_step += 1

    # ------------------------------------------------------------------
    # Signal proxies
    # ------------------------------------------------------------------

    def should_eval(self) -> bool:
        """True if step % eval_every == 0."""
        return (
            self._eval_every > 0
            and self._current_step > 0
            and self._current_step % self._eval_every == 0
        )

    def should_checkpoint(self) -> bool:
        """True if step % checkpoint_every == 0."""
        return (
            self._checkpoint_every > 0
            and self._current_step > 0
            and self._current_step % self._checkpoint_every == 0
        )

    def should_stop(self) -> bool:
        """True if SIGTERM was received."""
        return self._al.should_stop()

    # ------------------------------------------------------------------
    # Report helpers
    # ------------------------------------------------------------------

    def log(self, **metrics: Any) -> None:
        """
        Report arbitrary metrics.  Maps to al.log() with current step.
        loss= kwarg forwarded as the loss field.
        """
        loss = metrics.pop("loss", None)
        self._al.log(
            step=self._current_step,
            total=self._total_steps or 0,
            loss=loss,
            metrics=metrics if metrics else None,
        )

    def log_eval(self, metrics: dict[str, Any]) -> None:
        """Report evaluation metrics."""
        self._al.log_eval(metrics)


# ---------------------------------------------------------------------------
# Helpers
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
