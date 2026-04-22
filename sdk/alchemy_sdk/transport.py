"""HTTP reporter with throttling — max 1 request per 10s."""
import threading
import time
from typing import Any

import requests


class ThrottledReporter:
    """Batches progress reports and sends at most once per THROTTLE_S seconds."""

    THROTTLE_S = 10

    def __init__(self, server: str, task_id: str):
        self.server = server.rstrip("/")
        self.task_id = task_id
        self._pending: dict[str, Any] | None = None
        self._lock = threading.Lock()
        self._last_sent = 0.0
        self._thread = threading.Thread(target=self._flush_loop, daemon=True)
        self._thread.start()
        self.should_checkpoint = False

    def report(self, **kwargs: Any):
        """Queue a report. Will be sent on next flush cycle."""
        with self._lock:
            self._pending = {"task_id": self.task_id, **kwargs}

    def flush(self):
        """Force immediate send."""
        with self._lock:
            payload = self._pending
            self._pending = None
        if payload:
            self._send(payload)

    def _flush_loop(self):
        while True:
            time.sleep(0.5)
            now = time.time()
            if now - self._last_sent < self.THROTTLE_S:
                continue
            with self._lock:
                payload = self._pending
                self._pending = None
            if payload:
                self._send(payload)

    def _send(self, payload: dict[str, Any]):
        try:
            resp = requests.post(
                f"{self.server}/api/sdk/report",
                json=payload,
                timeout=5,
            )
            if resp.ok:
                data = resp.json()
                self.should_checkpoint = data.get("should_checkpoint", False)
            self._last_sent = time.time()
        except Exception:
            pass  # silently fail — don't crash training
