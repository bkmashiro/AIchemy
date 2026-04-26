"""Main Alchemy SDK client class."""
from __future__ import annotations

import json
import os
import signal
import time
from typing import Any, Optional

from .transport import make_transport, NoopTransport, HttpTransport, UnixSocketTransport

_MISSING = object()

# Valid notification levels
_NOTIFY_LEVELS = ("debug", "info", "warning", "critical")

# Valid lifecycle phases
_VALID_PHASES = ("warmup", "training", "eval", "checkpoint", "cooldown")


class Alchemy:
    """
    Alchemy SDK client for training scripts.

    Auto-initialised from environment variables:
      ALCHEMY_TASK_ID       - Task UUID assigned by stub
      ALCHEMY_STUB_SOCKET   - Path to Unix socket (e.g. /tmp/alchemy_task_xxx.sock)
      ALCHEMY_SERVER        - HTTP server base URL (fallback)
      ALCHEMY_PARAMS        - JSON-encoded parameter dict

    Missing vars → no-op mode: all methods return defaults silently.

    Usage (manual):
        al = Alchemy()
        for step in range(total):
            loss = train_step()
            al.log(step, total, loss=loss)
            if al.should_stop():
                break
        al.done()

    Usage (context manager):
        with Alchemy() as al:
            ...

    Usage (AOP decorator):
        @al.managed(total_steps=500_000, eval_every=10_000)
        def train(ctx: TrainingContext):
            ...
    """

    _THROTTLE_S = 10.0  # max 1 log() call per 10s

    def __init__(self) -> None:
        self._task_id: Optional[str] = os.environ.get("ALCHEMY_TASK_ID") or None
        stub_socket: Optional[str] = os.environ.get("ALCHEMY_STUB_SOCKET") or None
        server: Optional[str] = os.environ.get("ALCHEMY_SERVER") or None

        # Managed mode: alchemy is in control → strict, zero tolerance
        self._managed: bool = self._task_id is not None

        # Parse params once at init — immutable for lifetime
        raw_params = os.environ.get("ALCHEMY_PARAMS", "{}")
        try:
            self._params: dict[str, Any] = json.loads(raw_params)
        except Exception:
            if self._managed:
                raise RuntimeError("ALCHEMY_PARAMS is set but not valid JSON")
            self._params = {}

        # Build transport (no-op if nothing available)
        self._transport = make_transport(self._task_id, stub_socket, server)

        # Throttle state for log()
        self._last_log_time: float = 0.0

        # SIGTERM-based stop flag — set by signal handler, read by should_stop()
        self._stop_flag: bool = False
        self._install_sigterm_handler()

    def _install_sigterm_handler(self) -> None:
        """Install SIGTERM handler that sets the stop flag. Chains with existing handler."""
        try:
            prev = signal.getsignal(signal.SIGTERM)

            def _handler(signum: int, frame: Any) -> None:
                self._stop_flag = True
                # Chain previous handler if callable
                if callable(prev) and prev not in (signal.SIG_DFL, signal.SIG_IGN):
                    prev(signum, frame)

            signal.signal(signal.SIGTERM, _handler)
        except (OSError, ValueError):
            # Can't install in some environments (e.g. non-main thread) — silently skip
            pass

    # ------------------------------------------------------------------
    # Pure reads (no IO)
    # ------------------------------------------------------------------

    @property
    def is_managed(self) -> bool:
        """True when running under alchemy (ALCHEMY_TASK_ID present). Strict mode."""
        return self._managed

    def params(self) -> dict[str, Any]:
        """Return all params from ALCHEMY_PARAMS. Same value every call."""
        return dict(self._params)

    def param(self, key: str, default: Any = _MISSING) -> Any:
        """
        Return a single param.

        Under alchemy (managed mode): default is FORBIDDEN. Missing param = crash.
        This prevents silent typos like param("seeed", default=42) producing wrong experiments.

        Standalone (noop mode): default is allowed for convenience.
        """
        if key in self._params:
            return self._params[key]
        if self._managed:
            raise KeyError(
                f"Parameter '{key}' not found in ALCHEMY_PARAMS. "
                f"Available: {list(self._params.keys())}. "
                f"Under alchemy management, all params must be explicitly provided — no defaults."
            )
        if default is _MISSING:
            raise KeyError(f"Parameter '{key}' not found. Available: {list(self._params.keys())}")
        return default

    # ------------------------------------------------------------------
    # Signal queries
    # ------------------------------------------------------------------

    def should_stop(self) -> bool:
        """Return True if SIGTERM was received (SLURM preemption, manual kill, server kill)."""
        return self._stop_flag

    # ------------------------------------------------------------------
    # Reports (side-effects only — never modify training state)
    # ------------------------------------------------------------------

    def log(
        self,
        step: int,
        total: int,
        loss: Optional[float] = None,
        metrics: Optional[dict[str, Any]] = None,
    ) -> None:
        """
        Report training progress.
        Throttled to at most one message per 10 seconds. Non-blocking.
        """
        now = time.monotonic()
        if now - self._last_log_time < self._THROTTLE_S:
            return
        self._last_log_time = now

        msg: dict[str, Any] = {"type": "progress", "step": step, "total": total}
        if loss is not None:
            msg["loss"] = loss
        if metrics:
            msg["metrics"] = metrics
        self._transport.send(msg)

    def log_eval(self, metrics: dict[str, Any]) -> None:
        """Report evaluation metrics immediately (not throttled)."""
        self._transport.send({"type": "eval", "metrics": metrics})

    def log_config(self, config: dict[str, Any]) -> None:
        """Report training config snapshot (e.g. hyperparams)."""
        self._transport.send({"type": "config", "config": config})

    def checkpoint(self, path: str) -> None:
        """
        Declare that a checkpoint has been saved at the given path.
        Does NOT call torch.save — caller is responsible for saving.
        """
        self._transport.send({"type": "checkpoint", "path": path})

    def notify(self, msg: str, level: str = "info") -> None:
        """
        Send a user-defined notification via the transport.

        Levels:
          "debug"    — stored in task log only
          "info"     — stored + emitted to web frontend
          "warning"  — stored + emitted + Discord notification
          "critical" — stored + emitted + Discord mention (emphasis)
        """
        if level not in _NOTIFY_LEVELS:
            level = "info"
        self._transport.send({"type": "notify", "message": msg, "level": level})

    def set_phase(self, phase: str) -> None:
        """
        Report the current training lifecycle phase.

        Valid phases: warmup, training, eval, checkpoint, cooldown.
        Server uses this for scheduling decisions (e.g. won't preempt during checkpoint).
        """
        if phase not in _VALID_PHASES:
            raise ValueError(
                f"Invalid phase '{phase}'. Valid: {_VALID_PHASES}"
            )
        self._transport.send({"type": "phase", "phase": phase})

    def phase(self, phase: str) -> "_PhaseContext":
        """
        Context manager for lifecycle phases.

        Usage:
            with alchemy.phase("eval"):
                run_evaluation()
        """
        return _PhaseContext(self, phase)

    def done(self, metrics: Optional[dict[str, Any]] = None) -> None:
        """Signal that training is complete. Sends final metrics if provided."""
        msg: dict[str, Any] = {"type": "done"}
        if metrics:
            msg["metrics"] = metrics
        self._transport.send(msg)

    # ------------------------------------------------------------------
    # Context manager
    # ------------------------------------------------------------------

    def __enter__(self) -> "Alchemy":
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        if exc_type is None:
            self.done()
        else:
            self.notify(f"Training crashed: {exc_type.__name__}: {exc_val}", level="critical")

    # ------------------------------------------------------------------
    # AOP decorator
    # ------------------------------------------------------------------

    def managed(
        self,
        total_steps: int = 0,
        eval_every: int = 0,
        checkpoint_every: int = 0,
        reads: Optional[list[str]] = None,
        writes: Optional[list[str]] = None,
    ):
        """
        Decorator that wraps a training function with a TrainingContext.

        run_dir comes from ALCHEMY_RUN_DIR env var (set by stub at launch).
        The server is the single source of truth for run_dir.

        @al.managed(total_steps=500_000, eval_every=10_000, checkpoint_every=50_000,
                    reads=["data/atari/"])
        def train(ctx: TrainingContext):
            ...
        """
        def decorator(fn):
            import functools
            from .preflight import run_preflight
            from .context import TrainingContext

            @functools.wraps(fn)
            def wrapper(*args, **kwargs):
                ctx = TrainingContext(
                    al=self,
                    total_steps=total_steps,
                    eval_every=eval_every,
                    checkpoint_every=checkpoint_every,
                )
                run_preflight(ctx, reads=reads or [], writes=writes or [])
                try:
                    result = fn(ctx, *args, **kwargs)
                except KeyboardInterrupt:
                    self.notify("Training interrupted (KeyboardInterrupt)", level="warning")
                    raise
                except Exception as e:
                    # Emergency checkpoint if possible
                    self.notify(f"Training crashed: {type(e).__name__}: {e}", level="critical")
                    raise
                else:
                    self.done(metrics=result if isinstance(result, dict) else None)
                    return result

            return wrapper
        return decorator


class _PhaseContext:
    """Context manager for lifecycle phase reporting."""

    def __init__(self, al: Alchemy, phase: str) -> None:
        self._al = al
        self._phase = phase

    def __enter__(self) -> "_PhaseContext":
        self._al.set_phase(self._phase)
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        # Revert to training phase when exiting a phase block
        self._al.set_phase("training")
