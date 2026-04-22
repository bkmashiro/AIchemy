"""ManagedTraining base class for auto-checkpoint/restore training loops."""
import argparse
import json
import os
import pickle
import signal
import sys
import threading
import time
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Iterator, Optional

from .client import Alchemy


class ManagedTraining(ABC):
    """
    Base class for managed training loops with auto-checkpoint/restore.

    Subclass this and implement:
      - setup(config)
      - state() -> dict
      - load_state(state)
      - step_fn(batch) -> dict  (returns metrics like {"loss": 0.5})

    Then start with:
      ManagedTraining.run(MyTraining, config="cfg.yaml")
    """

    # Configuration (set by run())
    _alchemy: Optional[Alchemy] = None
    _checkpoint_dir: Optional[Path] = None
    _checkpoint_every_steps: int = 1000
    _checkpoint_every_minutes: float = 30.0
    _report_throttle_s: float = 10.0
    _last_checkpoint_time: float = 0.0
    _last_report_time: float = 0.0
    _current_step: int = 0
    _immediate_checkpoint: bool = False

    # ─── Abstract interface ───────────────────────────────────────────────────

    @abstractmethod
    def setup(self, config: dict) -> None:
        """Initialize model, optimizer, etc. Called once before training."""

    @abstractmethod
    def state(self) -> dict:
        """Return full serializable state for checkpointing."""

    @abstractmethod
    def load_state(self, state: dict) -> None:
        """Restore state from a checkpoint dict."""

    @abstractmethod
    def step_fn(self, batch: Any) -> dict:
        """Single training step. Return metrics dict (must include 'loss' if any)."""

    def data_iterator(self) -> Iterator[Any]:
        """Override to yield batches. Default: infinite None iterator."""
        while True:
            yield None

    # ─── Internal helpers ─────────────────────────────────────────────────────

    def _checkpoint_path(self, step: int) -> Path:
        assert self._checkpoint_dir is not None
        return self._checkpoint_dir / f"checkpoint_{step}.pkl"

    def _save_checkpoint(self) -> Path:
        state = self.state()
        path = self._checkpoint_path(self._current_step)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as f:
            pickle.dump(state, f)
        self._last_checkpoint_time = time.time()
        print(f"[ManagedTraining] Checkpoint saved: {path}", flush=True)

        # Report to server
        if self._alchemy:
            self._alchemy.checkpoint(str(path))

        return path

    def _load_checkpoint(self, path: Path) -> None:
        with open(path, "rb") as f:
            state = pickle.load(f)
        self.load_state(state)
        print(f"[ManagedTraining] Restored from: {path}", flush=True)

    def _find_latest_checkpoint(self) -> Optional[Path]:
        if not self._checkpoint_dir or not self._checkpoint_dir.exists():
            return None
        checkpoints = sorted(self._checkpoint_dir.glob("checkpoint_*.pkl"))
        return checkpoints[-1] if checkpoints else None

    def _should_checkpoint(self, step: int) -> bool:
        if self._immediate_checkpoint:
            return True
        # Step-based
        if step > 0 and step % self._checkpoint_every_steps == 0:
            return True
        # Time-based
        elapsed = time.time() - self._last_checkpoint_time
        if elapsed >= self._checkpoint_every_minutes * 60:
            return True
        # Server says checkpoint
        if self._alchemy and self._alchemy.should_checkpoint:
            return True
        return False

    def _report_metrics(self, step: int, total: int, metrics: dict) -> None:
        if self._alchemy is None:
            return
        now = time.time()
        if now - self._last_report_time < self._report_throttle_s:
            return
        loss = metrics.get("loss")
        self._alchemy.log(step=step, total=total, loss=loss, metrics=metrics)
        self._last_report_time = now

    # ─── Entry point ──────────────────────────────────────────────────────────

    @classmethod
    def run(
        cls,
        training_class: "type[ManagedTraining]",
        config: Any = None,
        total_steps: int = 1_000_000,
        checkpoint_every_steps: int = 1000,
        checkpoint_every_minutes: float = 30.0,
        checkpoint_dir: Optional[str] = None,
        resume_from: Optional[str] = None,
    ) -> None:
        """
        Parse CLI args and run the training loop.

        CLI args override function arguments:
          --config PATH
          --resume-from PATH
          --total-steps N
          --checkpoint-every-steps N
          --checkpoint-dir DIR
        """
        parser = argparse.ArgumentParser(add_help=False)
        parser.add_argument("--config", default=None)
        parser.add_argument("--resume-from", default=resume_from)
        parser.add_argument("--total-steps", type=int, default=total_steps)
        parser.add_argument("--checkpoint-every-steps", type=int, default=checkpoint_every_steps)
        parser.add_argument("--checkpoint-every-minutes", type=float, default=checkpoint_every_minutes)
        parser.add_argument("--checkpoint-dir", default=checkpoint_dir)
        args, _ = parser.parse_known_args()

        # Load config
        cfg: dict = {}
        config_path = args.config or (config if isinstance(config, str) else None)
        if config_path and os.path.exists(config_path):
            try:
                import yaml  # type: ignore
                with open(config_path) as f:
                    cfg = yaml.safe_load(f) or {}
            except ImportError:
                with open(config_path) as f:
                    cfg = json.load(f)
        elif isinstance(config, dict):
            cfg = config

        # Create instance
        instance = training_class()
        instance._checkpoint_every_steps = args.checkpoint_every_steps
        instance._checkpoint_every_minutes = args.checkpoint_every_minutes
        instance._checkpoint_dir = Path(args.checkpoint_dir) if args.checkpoint_dir else Path("/tmp/alchemy_checkpoints")
        instance._last_checkpoint_time = time.time()

        # Connect to Alchemy server
        server_url = os.environ.get("ALCHEMY_SERVER", "")
        task_id = os.environ.get("ALCHEMY_TASK_ID", "")
        if server_url and task_id:
            instance._alchemy = Alchemy(server=server_url, task_id=task_id)
        else:
            instance._alchemy = None

        # SIGUSR1 → immediate checkpoint
        def _sigusr1_handler(signum, frame):
            instance._immediate_checkpoint = True
        signal.signal(signal.SIGUSR1, _sigusr1_handler)

        # Setup model
        instance.setup(cfg)

        # Restore from checkpoint
        resume_path = args.resume_from
        if resume_path:
            instance._load_checkpoint(Path(resume_path))
        else:
            latest = instance._find_latest_checkpoint()
            if latest:
                instance._load_checkpoint(latest)
                # Extract step from filename
                try:
                    step_str = latest.stem.split("_")[-1]
                    instance._current_step = int(step_str)
                except ValueError:
                    pass

        # Training loop
        total = args.total_steps
        data_iter = iter(instance.data_iterator())

        while instance._current_step < total:
            step = instance._current_step

            try:
                batch = next(data_iter)
            except StopIteration:
                break

            metrics = instance.step_fn(batch)
            instance._current_step += 1
            instance._report_metrics(instance._current_step, total, metrics)

            # Checkpoint if needed
            if instance._should_checkpoint(instance._current_step):
                instance._immediate_checkpoint = False
                instance._save_checkpoint()

        # Final checkpoint
        instance._save_checkpoint()

        if instance._alchemy:
            instance._alchemy.done()

        print("[ManagedTraining] Training complete.", flush=True)
