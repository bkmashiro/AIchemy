"""Tests for classify_death() and has_checkpoint() — Stream B1."""
import os
import pytest
from unittest.mock import patch

from alchemy_stub.error_classifier import classify_death, has_checkpoint


class TestClassifyDeath:
    """Test coarse death classification for auto-resume decisions."""

    def test_exit_zero_is_success(self):
        assert classify_death(0) == "success"

    def test_exit_zero_with_slurm(self):
        assert classify_death(0, slurm_job_id="12345") == "success"

    def test_sigkill_exit_137_is_oom(self):
        assert classify_death(137) == "oom"

    def test_sigkill_exit_minus9_is_oom(self):
        assert classify_death(-9) == "oom"

    def test_sigkill_signal_9_is_oom(self):
        assert classify_death(137, signal_num=9) == "oom"

    def test_sigterm_exit_143_without_slurm_is_code_error(self):
        assert classify_death(143) == "code_error"

    def test_sigterm_exit_143_with_slurm_is_walltime(self):
        assert classify_death(143, slurm_job_id="12345") == "walltime"

    def test_sigterm_exit_minus15_with_slurm_is_walltime(self):
        assert classify_death(-15, slurm_job_id="12345") == "walltime"

    def test_sigterm_exit_minus15_without_slurm_is_code_error(self):
        assert classify_death(-15) == "code_error"

    def test_sigterm_signal_15_with_slurm(self):
        assert classify_death(143, signal_num=15, slurm_job_id="99") == "walltime"

    def test_nonzero_exit_1_is_code_error(self):
        assert classify_death(1) == "code_error"

    def test_nonzero_exit_2_is_code_error(self):
        assert classify_death(2) == "code_error"

    def test_sigabrt_134_is_code_error(self):
        assert classify_death(134) == "code_error"

    def test_sigsegv_139_is_code_error(self):
        assert classify_death(139) == "code_error"

    @patch("alchemy_stub.error_classifier._check_dmesg_oom", return_value=True)
    def test_sigkill_with_dmesg_oom_is_oom(self, mock_dmesg):
        assert classify_death(137) == "oom"
        mock_dmesg.assert_called_once()

    @patch("alchemy_stub.error_classifier._check_dmesg_oom", return_value=False)
    def test_sigkill_without_dmesg_still_oom(self, mock_dmesg):
        # SIGKILL without dmesg confirmation still defaults to OOM
        assert classify_death(137) == "oom"


class TestHasCheckpoint:
    """Test checkpoint detection in run directories."""

    def test_none_run_dir(self):
        assert has_checkpoint(None) is False

    def test_nonexistent_dir(self):
        assert has_checkpoint("/nonexistent/path") is False

    def test_empty_dir(self, tmp_path):
        assert has_checkpoint(str(tmp_path)) is False

    def test_checkpoint_file(self, tmp_path):
        (tmp_path / "checkpoint_100.pt").touch()
        assert has_checkpoint(str(tmp_path)) is True

    def test_ckpt_file(self, tmp_path):
        (tmp_path / "model.ckpt").touch()
        assert has_checkpoint(str(tmp_path)) is True

    def test_pt_file(self, tmp_path):
        (tmp_path / "model.pt").touch()
        assert has_checkpoint(str(tmp_path)) is True

    def test_pth_file(self, tmp_path):
        (tmp_path / "weights.pth").touch()
        assert has_checkpoint(str(tmp_path)) is True

    def test_safetensors_file(self, tmp_path):
        (tmp_path / "model.safetensors").touch()
        assert has_checkpoint(str(tmp_path)) is True

    def test_checkpoint_dir(self, tmp_path):
        (tmp_path / "checkpoint-500").mkdir()
        assert has_checkpoint(str(tmp_path)) is True

    def test_nested_checkpoint(self, tmp_path):
        sub = tmp_path / "checkpoints"
        sub.mkdir()
        (sub / "checkpoint_best.pt").touch()
        assert has_checkpoint(str(tmp_path)) is True

    def test_unrelated_files_no_match(self, tmp_path):
        (tmp_path / "train.log").touch()
        (tmp_path / "config.yaml").touch()
        assert has_checkpoint(str(tmp_path)) is False
