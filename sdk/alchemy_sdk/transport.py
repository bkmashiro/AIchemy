"""HTTP reporter with throttling — max 1 request per 10s."""
import subprocess
import threading
import time
from typing import Any


def _query_gpu_metrics() -> list[dict] | None:
    """Query nvidia-smi for GPU metrics from the training process side."""
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return None
        gpus = []
        for line in result.stdout.strip().split("\n"):
            if not line.strip():
                continue
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 5:
                continue
            gpus.append({
                "index": int(parts[0]),
                "utilization_pct": int(parts[1]),
                "memory_used_mb": int(parts[2]),
                "memory_total_mb": int(parts[3]),
                "temperature_c": int(parts[4]),
            })
        return gpus
    except Exception:
        return None


class ThrottledReporter:
    """Batches progress reports and sends at most once per THROTTLE_S seconds."""

    THROTTLE_S = 10

    def __init__(self, server: str, task_id: str, collect_gpu: bool = True):
        self.server = server.rstrip("/")
        self.task_id = task_id
        self._collect_gpu = collect_gpu
        self._pending: dict[str, Any] | None = None
        self._lock = threading.Lock()
        self._last_sent = 0.0
        self._thread = threading.Thread(target=self._flush_loop, daemon=True)
        self._thread.start()
        self.should_checkpoint = False
        self.should_stop = False

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
                # Attach GPU metrics if enabled
                if self._collect_gpu and "step" in payload:
                    gpu = _query_gpu_metrics()
                    if gpu:
                        payload["gpu_metrics"] = gpu
                self._send(payload)

    def _send(self, payload: dict[str, Any]):
        try:
            resp = self._do_post(payload)
            if resp.ok:
                data = resp.json()
                self.should_checkpoint = data.get("should_checkpoint", False)
                self.should_stop = data.get("should_stop", False)
            self._last_sent = time.time()
        except Exception:
            pass  # silently fail — don't crash training

    def _do_post(self, payload: dict[str, Any]):
        """HTTP POST with fallback for environments where requests fails (e.g. A30 certs)."""
        import requests
        return requests.post(
            f"{self.server}/api/sdk/report",
            json=payload,
            timeout=5,
        )
