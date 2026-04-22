"""Main SDK client class."""
import os
from typing import Any, Optional

from .transport import ThrottledReporter


class Alchemy:
    """
    Alchemy SDK client for training scripts.

    Usage:
        al = Alchemy(server="http://localhost:3001")
        al.log(step=100, total=1000, loss=0.5)
        al.checkpoint("path/to/checkpoint.pt")
        al.done()

        # Or as context manager:
        with Alchemy(server="...") as al:
            for step in range(1000):
                al.log(step=step, total=1000)
    """

    def __init__(
        self,
        server: str,
        task_id: str = "auto",
    ):
        self.server = server.rstrip("/")
        if task_id == "auto":
            task_id = os.environ.get("ALCHEMY_TASK_ID", "")
        self.task_id = task_id

        if not self.task_id:
            # SDK used outside Alchemy — silently no-op
            self._reporter: Optional[ThrottledReporter] = None
        else:
            self._reporter = ThrottledReporter(self.server, self.task_id)

    @property
    def should_checkpoint(self) -> bool:
        if self._reporter is None:
            return False
        return self._reporter.should_checkpoint

    def log(
        self,
        step: int,
        total: int,
        loss: Optional[float] = None,
        metrics: Optional[dict[str, Any]] = None,
    ):
        """Report training progress. Throttled to 1 req/10s."""
        if self._reporter is None:
            return
        payload: dict[str, Any] = {"step": step, "total": total}
        if loss is not None:
            payload["loss"] = loss
        if metrics:
            payload["metrics"] = metrics
        self._reporter.report(**payload)

    def checkpoint(self, path: str):
        """Report a checkpoint was saved."""
        if self._reporter is None:
            return
        self._reporter.report(checkpoint=path)
        self._reporter.flush()  # checkpoints are important, send immediately

    def done(self):
        """Flush any pending reports."""
        if self._reporter is None:
            return
        self._reporter.flush()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.done()
