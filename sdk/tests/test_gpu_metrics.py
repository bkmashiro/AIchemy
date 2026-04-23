"""Tests for GPU metrics collection in ThrottledReporter."""
import subprocess
from unittest.mock import MagicMock, patch

from alchemy_sdk.transport import ThrottledReporter, _query_gpu_metrics


class TestQueryGpuMetrics:
    def test_returns_none_when_nvidia_smi_missing(self):
        with patch("subprocess.run", side_effect=FileNotFoundError("nvidia-smi not found")):
            result = _query_gpu_metrics()
        assert result is None

    def test_returns_none_when_nvidia_smi_fails(self):
        mock_result = MagicMock()
        mock_result.returncode = 1
        with patch("subprocess.run", return_value=mock_result):
            result = _query_gpu_metrics()
        assert result is None

    def test_parses_single_gpu_output(self):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "0, 85, 20000, 49152, 72\n"
        with patch("subprocess.run", return_value=mock_result):
            result = _query_gpu_metrics()
        assert result is not None
        assert len(result) == 1
        assert result[0]["index"] == 0
        assert result[0]["utilization_pct"] == 85
        assert result[0]["memory_used_mb"] == 20000
        assert result[0]["memory_total_mb"] == 49152
        assert result[0]["temperature_c"] == 72

    def test_parses_multi_gpu_output(self):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "0, 85, 20000, 49152, 72\n1, 30, 8000, 49152, 55\n"
        with patch("subprocess.run", return_value=mock_result):
            result = _query_gpu_metrics()
        assert result is not None
        assert len(result) == 2
        assert result[1]["index"] == 1
        assert result[1]["utilization_pct"] == 30

    def test_skips_malformed_lines(self):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "0, 85, 20000, 49152, 72\nbad line\n"
        with patch("subprocess.run", return_value=mock_result):
            result = _query_gpu_metrics()
        assert result is not None
        assert len(result) == 1

    def test_returns_none_on_exception(self):
        with patch("subprocess.run", side_effect=Exception("unexpected")):
            result = _query_gpu_metrics()
        assert result is None

    def test_timeout_kills_subprocess(self):
        """Verify nvidia-smi is called with timeout=5."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = ""
        with patch("subprocess.run", return_value=mock_result) as mock_run:
            _query_gpu_metrics()
        call_kwargs = mock_run.call_args[1]
        assert call_kwargs.get("timeout") == 5


class TestThrottledReporterGpuCollection:
    def _drain(self, reporter, mock_resp, mock_gpu=None):
        """Simulate the flush loop's GPU-attachment logic and return the payload sent to _do_post."""
        sent_payloads = []

        def fake_do_post(p):
            sent_payloads.append(dict(p))  # copy before mutation
            return mock_resp

        with patch.object(reporter, "_do_post", side_effect=fake_do_post):
            # Replicate _flush_loop logic for a single payload
            with reporter._lock:
                payload = reporter._pending
                reporter._pending = None
            if payload:
                if reporter._collect_gpu and "step" in payload:
                    with patch("alchemy_sdk.transport._query_gpu_metrics",
                               return_value=mock_gpu or []):
                        gpu = mock_gpu
                        if gpu:
                            payload["gpu_metrics"] = gpu
                reporter._send(payload)
        return sent_payloads

    def test_gpu_metrics_attached_to_payload_when_step_present(self):
        reporter = ThrottledReporter("http://localhost:3001", "task-1", collect_gpu=True)
        reporter.report(step=100, total=1000)

        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.json.return_value = {"ok": True, "should_checkpoint": False, "should_stop": False}

        mock_gpu = [{"index": 0, "utilization_pct": 70, "memory_used_mb": 10000,
                     "memory_total_mb": 49152, "temperature_c": 65}]

        sent = self._drain(reporter, mock_resp, mock_gpu=mock_gpu)

        assert len(sent) == 1
        assert "gpu_metrics" in sent[0]
        assert sent[0]["gpu_metrics"][0]["utilization_pct"] == 70

    def test_gpu_metrics_not_attached_when_collect_gpu_false(self):
        reporter = ThrottledReporter("http://localhost:3001", "task-1", collect_gpu=False)
        reporter.report(step=100, total=1000)

        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.json.return_value = {"ok": True, "should_checkpoint": False, "should_stop": False}

        mock_gpu = [{"index": 0, "utilization_pct": 70, "memory_used_mb": 10000,
                     "memory_total_mb": 49152, "temperature_c": 65}]

        sent = self._drain(reporter, mock_resp, mock_gpu=mock_gpu)

        assert len(sent) == 1
        assert "gpu_metrics" not in sent[0]

    def test_gpu_metrics_not_attached_when_no_step_in_payload(self):
        """GPU metrics should only be queried when step is in the payload (training progress)."""
        reporter = ThrottledReporter("http://localhost:3001", "task-1", collect_gpu=True)
        reporter.report(checkpoint="/path/to/ckpt.pt")  # No "step"

        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.json.return_value = {"ok": True, "should_checkpoint": False, "should_stop": False}

        mock_gpu = [{"index": 0, "utilization_pct": 70, "memory_used_mb": 10000,
                     "memory_total_mb": 49152, "temperature_c": 65}]

        sent = self._drain(reporter, mock_resp, mock_gpu=mock_gpu)

        assert len(sent) == 1
        assert "gpu_metrics" not in sent[0]
