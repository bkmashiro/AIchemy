"""Framework callbacks for PyTorch Lightning and HuggingFace Trainer."""
import os
from typing import Any, Optional

from .client import Alchemy


class AlchemyPLCallback:
    """PyTorch Lightning callback that reports to Alchemy server.

    Usage:
        from alchemy_sdk.callbacks import AlchemyPLCallback
        trainer = pl.Trainer(callbacks=[AlchemyPLCallback()])
    """

    def __init__(self, server: str = "", total_steps: Optional[int] = None):
        self.server = server or os.environ.get("ALCHEMY_SERVER", "")
        self._total = total_steps
        self._al: Optional[Alchemy] = None

    def on_train_start(self, trainer: Any, pl_module: Any) -> None:
        if self.server:
            self._al = Alchemy(server=self.server)
        if self._total is None:
            self._total = trainer.estimated_stepping_batches

    def on_train_batch_end(self, trainer: Any, pl_module: Any, outputs: Any, batch: Any, batch_idx: int) -> None:
        if self._al is None:
            return
        step = trainer.global_step
        total = self._total or 0
        loss = trainer.callback_metrics.get("train_loss")
        loss_val = float(loss) if loss is not None else None
        metrics = {k: float(v) for k, v in trainer.callback_metrics.items() if k != "train_loss"}
        self._al.log(step=step, total=total, loss=loss_val, metrics=metrics or None)

        if self._al.should_stop:
            trainer.should_stop = True

    def on_save_checkpoint(self, trainer: Any, pl_module: Any, checkpoint: Any) -> None:
        if self._al is None:
            return
        ckpt_path = trainer.checkpoint_callback.best_model_path if trainer.checkpoint_callback else ""
        if ckpt_path:
            self._al.checkpoint(ckpt_path)

    def on_train_end(self, trainer: Any, pl_module: Any) -> None:
        if self._al:
            self._al.done()


class AlchemyHFCallback:
    """HuggingFace Trainer callback that reports to Alchemy server.

    Usage:
        from alchemy_sdk.callbacks import AlchemyHFCallback
        trainer = Trainer(..., callbacks=[AlchemyHFCallback()])
    """

    def __init__(self, server: str = ""):
        self.server = server or os.environ.get("ALCHEMY_SERVER", "")
        self._al: Optional[Alchemy] = None

    def on_train_begin(self, args: Any, state: Any, control: Any, **kwargs: Any) -> None:
        if self.server:
            self._al = Alchemy(server=self.server)

    def on_log(self, args: Any, state: Any, control: Any, logs: Optional[dict] = None, **kwargs: Any) -> None:
        if self._al is None or logs is None:
            return
        step = state.global_step
        total = state.max_steps
        loss = logs.get("loss")
        metrics = {k: v for k, v in logs.items() if k != "loss" and isinstance(v, (int, float))}
        self._al.log(step=step, total=total, loss=loss, metrics=metrics or None)

        if self._al.should_stop:
            control.should_training_stop = True

    def on_save(self, args: Any, state: Any, control: Any, **kwargs: Any) -> None:
        if self._al is None:
            return
        output_dir = getattr(args, "output_dir", "")
        if output_dir:
            self._al.checkpoint(f"{output_dir}/checkpoint-{state.global_step}")

    def on_train_end(self, args: Any, state: Any, control: Any, **kwargs: Any) -> None:
        if self._al:
            self._al.done()
