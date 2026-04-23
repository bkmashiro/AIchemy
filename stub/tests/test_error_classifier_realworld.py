"""Real-world failure log snippet tests for error_classifier.

These use representative snippets from actual GPU training failures:
- Multi-GPU NCCL errors (distributed training)
- CUDA segfaults
- OOM with multi-process context
- Python errors with long tracebacks
"""
from alchemy_stub.error_classifier import classify_failure, FailureReason


# ─── Multi-GPU NCCL Errors ────────────────────────────────────────────────────

class TestNCCLErrors:
    NCCL_TIMEOUT_LOG = [
        "[W ProcessGroupNCCL.cpp:1389] Warning: 10 ranks failed to rendezvous in time",
        "Traceback (most recent call last):",
        "  File \"train.py\", line 224, in <module>",
        "    trainer.fit(model, datamodule=dm)",
        "  File \"/opt/conda/lib/python3.10/site-packages/pytorch_lightning/trainer/trainer.py\"",
        "    self._run(model, ckpt_path=ckpt_path)",
        "RuntimeError: NCCL error in: /opt/conda/conda-bld/pytorch-nightly_1668734418820/work/torch/lib/c10d/ProcessGroupNCCL.cpp:1191, unhandled system error, NCCL version 2.14.3",
        "ncclSystemError: System call (e.g. socket, malloc) or external library call failed",
    ]

    def test_nccl_error_classified_as_cuda_error(self):
        result = classify_failure(1, self.NCCL_TIMEOUT_LOG)
        assert result["reason"] == FailureReason.CUDA_ERROR

    def test_nccl_detail_contains_error_message(self):
        result = classify_failure(1, self.NCCL_TIMEOUT_LOG)
        assert "NCCL" in result["detail"] or "nccl" in result["detail"].lower()

    NCCL_INIT_FAIL_LOG = [
        "[rank0]: Traceback (most recent call last):",
        "[rank0]:   File \"train_distributed.py\", line 45, in main",
        "[rank0]:     dist.init_process_group(backend='nccl')",
        "[rank0]: RuntimeError: NCCL error: unhandled system error, NCCL version 2.12.12",
    ]

    def test_nccl_init_failure(self):
        result = classify_failure(1, self.NCCL_INIT_FAIL_LOG)
        assert result["reason"] == FailureReason.CUDA_ERROR

    NCCL_MULTI_RANK_LOG = [
        "terminate called after throwing an instance of 'std::runtime_error'",
        "  what():  NCCL error: internal error, NCCL version 2.14.3",
        "Aborted (core dumped)",
    ]

    def test_nccl_abort_with_core_dump(self):
        result = classify_failure(134, self.NCCL_MULTI_RANK_LOG)  # SIGABRT
        assert result["reason"] == FailureReason.CUDA_ERROR


# ─── CUDA Segfaults ───────────────────────────────────────────────────────────

class TestCUDASegfaults:
    SEGFAULT_LOG = [
        "Signal: Segmentation fault (11)",
        "Signal code: Address not mapped (1)",
        "Failing at address: (nil)",
        "#0  0x00007f3a4b2c3d00 in cuLaunchKernel () from /usr/lib/x86_64-linux-gnu/libcuda.so.1",
        "#1  0x00007f3a4b1c5e00 in cudaLaunchKernel_ptsz () from /usr/local/cuda/lib64/libcudart.so.11.0",
        "CUDA error: an illegal memory access was encountered",
    ]

    def test_cuda_segfault_classified_as_cuda_error(self):
        result = classify_failure(139, self.SEGFAULT_LOG)  # SIGSEGV exit code
        assert result["reason"] == FailureReason.CUDA_ERROR

    CUDA_DEVICE_LOST_LOG = [
        "RuntimeError: CUDA error: device-side assert triggered",
        "CUDA kernel errors might be asynchronously reported at some other API call,",
        "so the stacktrace below might be incorrect.",
        "For debugging consider passing CUDA_LAUNCH_BLOCKING=1.",
        "Compile with `TORCH_USE_RTLD_GLOBAL=YES` for device-side assertions.",
    ]

    def test_cuda_device_assert_classified_as_cuda_error(self):
        result = classify_failure(1, self.CUDA_DEVICE_LOST_LOG)
        assert result["reason"] == FailureReason.CUDA_ERROR

    NO_CUDA_DEVICE_LOG = [
        "Traceback (most recent call last):",
        "  File \"train.py\", line 10, in <module>",
        "    model = model.cuda()",
        "RuntimeError: cudaErrorNoDevice: no CUDA-capable device is detected",
    ]

    def test_no_cuda_device_classified_as_cuda_error(self):
        result = classify_failure(1, self.NO_CUDA_DEVICE_LOG)
        assert result["reason"] == FailureReason.CUDA_ERROR


# ─── Multi-Process OOM ────────────────────────────────────────────────────────

class TestOOMErrors:
    MULTIPROC_OOM_LOG = [
        "[rank3]: Traceback (most recent call last):",
        "[rank3]:   File \"/opt/conda/lib/python3.10/multiprocessing/spawn.py\", line 125, in _main",
        "[rank3]:   File \"train.py\", line 88, in train",
        "[rank3]:     loss = model(batch)",
        "[rank3]: torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.50 GiB",
        "[rank3]: (GPU 3; 79.20 GiB total capacity; 74.78 GiB already allocated)",
    ]

    def test_multiprocess_oom_classified_correctly(self):
        result = classify_failure(1, self.MULTIPROC_OOM_LOG)
        assert result["reason"] == FailureReason.OOM

    OOM_VIA_SIGKILL = []  # process killed by OOM killer, no useful log

    def test_oom_via_sigkill_exit_137(self):
        result = classify_failure(137, self.OOM_VIA_SIGKILL)
        assert result["reason"] == FailureReason.OOM

    def test_oom_via_negative_9(self):
        result = classify_failure(-9, [])
        assert result["reason"] == FailureReason.OOM


# ─── Python Errors with Long Tracebacks ──────────────────────────────────────

class TestPythonErrors:
    LONG_TRACEBACK_LOG = [
        "  File \"train.py\", line 1",
        "  File \"train.py\", line 2",
        "  File \"train.py\", line 3",
        "  File \"train.py\", line 4",
        "  File \"train.py\", line 5",
        "  File \"train.py\", line 6",
        "  File \"train.py\", line 7",
        "  File \"train.py\", line 8",
        "  File \"train.py\", line 9",
        "  File \"train.py\", line 10",
        "Traceback (most recent call last):",
        "  File \"train.py\", line 55, in main",
        "    optimizer.step()",
        "ValueError: invalid parameter configuration: learning_rate cannot be negative",
    ]

    def test_python_error_captured(self):
        result = classify_failure(1, self.LONG_TRACEBACK_LOG)
        assert result["reason"] == FailureReason.PYTHON_ERROR
        assert "ValueError" in result["detail"] or "learning_rate" in result["detail"]

    def test_only_last_50_lines_used(self):
        """Lines before the last 50 are not scanned."""
        # 60 lines of noise before the traceback, then error in last 10
        noise_lines = [f"noise line {i}" for i in range(60)]
        real_lines = [
            "Traceback (most recent call last):",
            "  File \"train.py\", line 1",
            "AttributeError: 'NoneType' object has no attribute 'forward'",
        ]
        all_lines = noise_lines + real_lines
        # The traceback is in the last 13 lines, well within the 50-line window
        result = classify_failure(1, all_lines)
        assert result["reason"] == FailureReason.PYTHON_ERROR

    def test_detail_truncated_to_200_chars(self):
        long_error = "ValueError: " + "x" * 300
        result = classify_failure(1, [
            "Traceback (most recent call last):",
            "  File \"train.py\", line 1",
            long_error,
        ])
        assert result["reason"] == FailureReason.PYTHON_ERROR
        assert len(result["detail"]) <= 200


# ─── SIGTERM ──────────────────────────────────────────────────────────────────

class TestSIGTERM:
    def test_exit_143_classified_as_sigterm(self):
        result = classify_failure(143, [])
        assert result["reason"] == FailureReason.SIGTERM

    def test_exit_minus15_classified_as_sigterm(self):
        result = classify_failure(-15, [])
        assert result["reason"] == FailureReason.SIGTERM

    def test_sigterm_takes_priority_over_log_patterns(self):
        """Even if log has a CUDA error message, SIGTERM exit code wins."""
        result = classify_failure(143, ["CUDA error: something bad"])
        assert result["reason"] == FailureReason.SIGTERM


# ─── Unknown ─────────────────────────────────────────────────────────────────

class TestUnknown:
    def test_no_matching_pattern_returns_unknown(self):
        result = classify_failure(2, ["nothing interesting here", "some other output"])
        assert result["reason"] == FailureReason.UNKNOWN

    def test_empty_log_with_nonzero_exit(self):
        result = classify_failure(1, [])
        assert result["reason"] == FailureReason.UNKNOWN
        assert "1" in result["detail"]
