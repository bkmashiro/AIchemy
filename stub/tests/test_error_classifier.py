"""Tests for error_classifier module."""
import pytest

from alchemy_stub.error_classifier import classify_failure, FailureReason


class TestClassifyByExitCode:
    def test_oom_by_exit_137(self):
        result = classify_failure(137, [])
        assert result["reason"] == FailureReason.OOM
        assert "137" in result["detail"] or "OOM" in result["detail"].upper() or "Killed" in result["detail"]

    def test_oom_by_exit_minus9(self):
        result = classify_failure(-9, [])
        assert result["reason"] == FailureReason.OOM

    def test_sigterm_by_exit_143(self):
        result = classify_failure(143, [])
        assert result["reason"] == FailureReason.SIGTERM
        assert "SIGTERM" in result["detail"]

    def test_sigterm_by_exit_minus15(self):
        result = classify_failure(-15, [])
        assert result["reason"] == FailureReason.SIGTERM

    def test_exit_code_takes_priority_over_logs(self):
        # Even with OOM log lines, exit 143 should give SIGTERM
        lines = ["CUDA out of memory", "Traceback (most recent call last)"]
        result = classify_failure(143, lines)
        assert result["reason"] == FailureReason.SIGTERM


class TestClassifyByLogContent:
    def test_cuda_oom_in_logs(self):
        lines = [
            "Training step 100",
            "CUDA out of memory. Tried to allocate 2.50 GiB",
            "RuntimeError: CUDA out of memory",
        ]
        result = classify_failure(1, lines)
        assert result["reason"] == FailureReason.OOM
        assert "CUDA out of memory" in result["detail"]

    def test_torch_cuda_oom_error(self):
        lines = ["torch.cuda.OutOfMemoryError: CUDA out of memory"]
        result = classify_failure(1, lines)
        assert result["reason"] == FailureReason.OOM

    def test_out_of_memory_error(self):
        lines = ["OutOfMemoryError: out of memory"]
        result = classify_failure(1, lines)
        assert result["reason"] == FailureReason.OOM

    def test_cuda_error_in_logs(self):
        lines = [
            "Some training output",
            "CUDA error: device-side assert triggered",
        ]
        result = classify_failure(1, lines)
        assert result["reason"] == FailureReason.CUDA_ERROR

    def test_nccl_error_in_logs(self):
        lines = ["NCCL error in collective operation: unhandled system error"]
        result = classify_failure(1, lines)
        assert result["reason"] == FailureReason.CUDA_ERROR

    def test_cuda_error_no_device(self):
        lines = ["cudaErrorNoDevice: no CUDA-capable device is detected"]
        result = classify_failure(1, lines)
        assert result["reason"] == FailureReason.CUDA_ERROR

    def test_python_traceback(self):
        lines = [
            "Running training",
            "Traceback (most recent call last):",
            '  File "train.py", line 42, in <module>',
            "    model.fit(data)",
            "ValueError: invalid input shape",
        ]
        result = classify_failure(1, lines)
        assert result["reason"] == FailureReason.PYTHON_ERROR
        assert "ValueError" in result["detail"]

    def test_python_traceback_last_line_captured(self):
        lines = [
            "Traceback (most recent call last):",
            '  File "script.py", line 5, in <module>',
            "KeyError: 'missing_key'",
        ]
        result = classify_failure(1, lines)
        assert result["reason"] == FailureReason.PYTHON_ERROR
        assert "KeyError" in result["detail"]

    def test_unknown_fallback(self):
        lines = ["Some random output", "Process finished"]
        result = classify_failure(1, lines)
        assert result["reason"] == FailureReason.UNKNOWN
        assert "1" in result["detail"]  # exit code in detail

    def test_unknown_fallback_exit_zero_is_not_reached(self):
        # classify_failure is only called on failure; but let's confirm unknown for odd codes
        result = classify_failure(2, ["nothing interesting"])
        assert result["reason"] == FailureReason.UNKNOWN

    def test_oom_takes_priority_over_traceback(self):
        # OOM pattern appears before traceback in log
        lines = [
            "Traceback (most recent call last):",
            "  ...",
            "torch.cuda.OutOfMemoryError: CUDA out of memory",
        ]
        result = classify_failure(1, lines)
        # OOM check comes before traceback check
        assert result["reason"] == FailureReason.OOM

    def test_only_last_50_lines_scanned(self):
        # Put OOM signal in the first 100 lines, normal exit after
        early_lines = ["CUDA out of memory"] + ["normal output"] * 100
        result = classify_failure(1, early_lines)
        # Only last 50 lines scanned — OOM line is outside that window
        # (101 lines total; last 50 are all "normal output")
        assert result["reason"] == FailureReason.UNKNOWN

    def test_detail_truncated_to_200_chars(self):
        long_line = "CUDA error: " + "x" * 300
        lines = [long_line]
        result = classify_failure(1, lines)
        assert result["reason"] == FailureReason.CUDA_ERROR
        assert len(result["detail"]) <= 200

    def test_python_error_detail_truncated(self):
        long_exc = "ValueError: " + "x" * 300
        lines = ["Traceback (most recent call last):", "  ...", long_exc]
        result = classify_failure(1, lines)
        assert result["reason"] == FailureReason.PYTHON_ERROR
        assert len(result["detail"]) <= 200
