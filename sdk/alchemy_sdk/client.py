"""Main SDK client class."""
import json
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
                if al.should_stop:
                    break
    """

    def __init__(
        self,
        server: str,
        task_id: str = "auto",
        collect_gpu: bool = True,
    ):
        self.server = server.rstrip("/")
        if task_id == "auto":
            task_id = os.environ.get("ALCHEMY_TASK_ID", "")
        self.task_id = task_id

        if not self.task_id:
            self._reporter: Optional[ThrottledReporter] = None
        else:
            self._reporter = ThrottledReporter(self.server, self.task_id, collect_gpu=collect_gpu)

    @property
    def should_checkpoint(self) -> bool:
        if self._reporter is None:
            return False
        return self._reporter.should_checkpoint

    @property
    def should_stop(self) -> bool:
        """Server requests early termination."""
        if self._reporter is None:
            return False
        return self._reporter.should_stop

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
        self._reporter.flush()

    def done(self):
        """Flush any pending reports."""
        if self._reporter is None:
            return
        self._reporter.flush()

    def param(self, key: str, default: Any = None) -> Any:
        """Get a parameter from ALCHEMY_PARAMS env var."""
        params = json.loads(os.environ.get("ALCHEMY_PARAMS", "{}"))
        if key not in params and default is None:
            raise KeyError(f"Parameter '{key}' not found. Available: {list(params.keys())}")
        return params.get(key, default)

    def params(self) -> dict[str, Any]:
        """Get all parameters from ALCHEMY_PARAMS env var."""
        return json.loads(os.environ.get("ALCHEMY_PARAMS", "{}"))

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.done()
