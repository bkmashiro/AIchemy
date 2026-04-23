"""Tests for should_stop signal propagation through SDK."""
import threading
import time
from unittest.mock import MagicMock, patch
import pytest

from alchemy_sdk.transport import ThrottledReporter
from alchemy_sdk.client import Alchemy


class TestThrottledReporterShouldStop:
    def test_should_stop_initially_false(self):
        reporter = ThrottledReporter("http://localhost:3001", "task-123", collect_gpu=False)
        assert reporter.should_stop is False

    def test_should_checkpoint_initially_false(self):
        reporter = ThrottledReporter("http://localhost:3001", "task-123", collect_gpu=False)
        assert reporter.should_checkpoint is False

    def test_should_stop_set_from_server_response(self):
        reporter = ThrottledReporter("http://localhost:3001", "task-123", collect_gpu=False)

        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.json.return_value = {"ok": True, "should_checkpoint": False, "should_stop": True}

        with patch.object(reporter, "_do_post", return_value=mock_resp):
            reporter._send({"task_id": "task-123", "step": 100})

        assert reporter.should_stop is True

    def test_should_checkpoint_set_from_server_response(self):
        reporter = ThrottledReporter("http://localhost:3001", "task-123", collect_gpu=False)

        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.json.return_value = {"ok": True, "should_checkpoint": True, "should_stop": False}

        with patch.object(reporter, "_do_post", return_value=mock_resp):
            reporter._send({"task_id": "task-123", "step": 100})

        assert reporter.should_checkpoint is True
        assert reporter.should_stop is False

    def test_server_error_does_not_change_should_stop(self):
        reporter = ThrottledReporter("http://localhost:3001", "task-123", collect_gpu=False)
        reporter.should_stop = True  # was True before

        mock_resp = MagicMock()
        mock_resp.ok = False
        mock_resp.status_code = 500

        with patch.object(reporter, "_do_post", return_value=mock_resp):
            reporter._send({"task_id": "task-123", "step": 100})

        # Stays True — server error doesn't clear it
        assert reporter.should_stop is True

    def test_network_exception_does_not_crash(self):
        reporter = ThrottledReporter("http://localhost:3001", "task-123", collect_gpu=False)

        with patch.object(reporter, "_do_post", side_effect=Exception("connection refused")):
            # Should not raise
            reporter._send({"task_id": "task-123", "step": 1})

        assert reporter.should_stop is False


class TestAlchemyClientShouldStop:
    def test_should_stop_false_without_task_id(self):
        al = Alchemy(server="http://localhost:3001", task_id="")
        assert al.should_stop is False

    def test_should_stop_delegates_to_reporter(self):
        al = Alchemy(server="http://localhost:3001", task_id="task-abc")
        assert al._reporter is not None
        al._reporter.should_stop = True
        assert al.should_stop is True

    def test_should_checkpoint_delegates_to_reporter(self):
        al = Alchemy(server="http://localhost:3001", task_id="task-abc")
        assert al._reporter is not None
        al._reporter.should_checkpoint = True
        assert al.should_checkpoint is True

    def test_log_does_nothing_without_task_id(self):
        al = Alchemy(server="http://localhost:3001", task_id="")
        # Should not raise
        al.log(step=1, total=100, loss=0.5)

    def test_done_does_nothing_without_task_id(self):
        al = Alchemy(server="http://localhost:3001", task_id="")
        al.done()  # no-op, should not raise

    def test_context_manager_calls_done(self):
        al = Alchemy(server="http://localhost:3001", task_id="")
        with patch.object(al, "done") as mock_done:
            with al:
                pass
            mock_done.assert_called_once()
