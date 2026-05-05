"""Tests for GPU availability check in SDK preflight."""
import os
from pathlib import Path
from unittest.mock import MagicMock, patch
import tempfile

import pytest

from alchemy_sdk.context import TrainingContext
from alchemy_sdk.preflight import run_preflight
from alchemy_sdk.client import Alchemy


def _make_ctx(tmp_path: Path) -> TrainingContext:
    """Create a TrainingContext with run_dir pointing to tmp_path."""
    al = Alchemy()
    with patch.dict(os.environ, {"ALCHEMY_RUN_DIR": str(tmp_path)}):
        ctx = TrainingContext(al=al)
    return ctx


class TestPreflightGpuCheck:
    def test_raises_when_torch_available_but_no_cuda(self, tmp_path):
        al = Alchemy()
        mock_torch = MagicMock()
        mock_torch.cuda.is_available.return_value = False

        with patch.dict(os.environ, {"ALCHEMY_RUN_DIR": str(tmp_path)}):
            ctx = TrainingContext(al=al)

        with patch.dict("sys.modules", {"torch": mock_torch}):
            with pytest.raises(RuntimeError, match="No GPU detected"):
                run_preflight(ctx, reads=[])

    def test_passes_when_torch_available_with_cuda(self, tmp_path):
        al = Alchemy()
        mock_torch = MagicMock()
        mock_torch.cuda.is_available.return_value = True

        with patch.dict(os.environ, {"ALCHEMY_RUN_DIR": str(tmp_path)}):
            ctx = TrainingContext(al=al)

        with patch.dict("sys.modules", {"torch": mock_torch}):
            # Should not raise
            run_preflight(ctx, reads=[])

    def test_skips_gpu_check_when_torch_not_installed(self, tmp_path):
        al = Alchemy()

        with patch.dict(os.environ, {"ALCHEMY_RUN_DIR": str(tmp_path)}):
            ctx = TrainingContext(al=al)

        with patch.dict("sys.modules", {"torch": None}):
            # Should not raise even without torch
            run_preflight(ctx, reads=[])

    def test_raises_on_missing_reads_path(self, tmp_path):
        al = Alchemy()
        mock_torch = MagicMock()
        mock_torch.cuda.is_available.return_value = True

        with patch.dict(os.environ, {"ALCHEMY_RUN_DIR": str(tmp_path)}):
            ctx = TrainingContext(al=al)

        with patch.dict("sys.modules", {"torch": mock_torch}):
            with pytest.raises(FileNotFoundError, match="does not exist"):
                run_preflight(ctx, reads=["/nonexistent/path/that/does/not/exist"])

    def test_sets_is_resume_when_checkpoint_exists(self, tmp_path):
        al = Alchemy()
        mock_torch = MagicMock()
        mock_torch.cuda.is_available.return_value = True

        with patch.dict(os.environ, {"ALCHEMY_RUN_DIR": str(tmp_path)}):
            ctx = TrainingContext(al=al)

        # Create a fake checkpoint
        ckpt_dir = tmp_path / "checkpoints"
        ckpt_dir.mkdir(parents=True, exist_ok=True)
        fake_ckpt = ckpt_dir / "latest.pt"
        fake_ckpt.write_bytes(b"fake")

        with patch.dict("sys.modules", {"torch": mock_torch}):
            run_preflight(ctx, reads=[])

        assert ctx.is_resume is True

    def test_is_resume_false_when_no_checkpoint(self, tmp_path):
        al = Alchemy()
        mock_torch = MagicMock()
        mock_torch.cuda.is_available.return_value = True

        with patch.dict(os.environ, {"ALCHEMY_RUN_DIR": str(tmp_path)}):
            ctx = TrainingContext(al=al)

        with patch.dict("sys.modules", {"torch": mock_torch}):
            run_preflight(ctx, reads=[])

        assert ctx.is_resume is False

    def test_warns_on_low_disk_space(self, tmp_path):
        al = Alchemy()
        mock_torch = MagicMock()
        mock_torch.cuda.is_available.return_value = True

        with patch.dict(os.environ, {"ALCHEMY_RUN_DIR": str(tmp_path)}):
            ctx = TrainingContext(al=al)

        # Simulate very low disk space (100 bytes free)
        mock_usage = MagicMock()
        mock_usage.free = 100

        with patch.dict("sys.modules", {"torch": mock_torch}), \
             patch("shutil.disk_usage", return_value=mock_usage):
            with pytest.warns(UserWarning, match="low disk space"):
                run_preflight(ctx, reads=[])
