"""Unit tests for alchemy_sdk/preflight.py — run_preflight."""
from __future__ import annotations

import os
import stat
import warnings
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from alchemy_sdk.preflight import run_preflight, _makedirs_002


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_ctx(tmp_path, is_resume=False):
    """Return a minimal mock TrainingContext pointing into tmp_path."""
    ctx = MagicMock()
    ctx.run_dir = tmp_path / "run"
    ctx.checkpoint_dir = ctx.run_dir / "checkpoints"
    ctx.is_resume = is_resume
    ctx.latest_checkpoint.return_value = None
    return ctx


# ---------------------------------------------------------------------------
# _makedirs_002 (preflight's own copy)
# ---------------------------------------------------------------------------

class TestMakedirs002Preflight:
    def test_creates_with_group_write(self, tmp_path):
        target = tmp_path / "gw_test"
        _makedirs_002(target)
        assert target.is_dir()
        mode = target.stat().st_mode
        # group-write bit must be set (depends on umask 002 being applied)
        assert mode & stat.S_IWGRP

    def test_idempotent(self, tmp_path):
        target = tmp_path / "idem"
        _makedirs_002(target)
        _makedirs_002(target)
        assert target.is_dir()


# ---------------------------------------------------------------------------
# Read-path validation
# ---------------------------------------------------------------------------

class TestReadPathValidation:
    def test_read_path_missing_raises_file_not_found(self, tmp_path):
        ctx = _make_ctx(tmp_path)
        with pytest.raises(FileNotFoundError, match="reads path does not exist"):
            run_preflight(ctx, reads=[str(tmp_path / "nonexistent")])

    def test_read_path_not_readable_raises_permission_error(self, tmp_path):
        target = tmp_path / "no_read"
        target.mkdir()
        with patch("os.access", side_effect=lambda p, m: False if m == os.R_OK else True):
            with pytest.raises(PermissionError, match="reads path is not readable"):
                run_preflight(ctx=_make_ctx(tmp_path), reads=[str(target)])

    def test_read_path_exists_and_readable(self, tmp_path):
        target = tmp_path / "data"
        target.mkdir()
        ctx = _make_ctx(tmp_path)
        # Should not raise — no-op GPU check will fail so mock torch
        with patch.dict("sys.modules", {"torch": None}):
            run_preflight(ctx, reads=[str(target)])

    def test_multiple_read_paths_all_checked(self, tmp_path):
        ok = tmp_path / "ok"
        ok.mkdir()
        missing = tmp_path / "missing"
        with pytest.raises(FileNotFoundError):
            run_preflight(_make_ctx(tmp_path), reads=[str(ok), str(missing)])

    def test_no_reads_passes(self, tmp_path):
        ctx = _make_ctx(tmp_path)
        with patch.dict("sys.modules", {"torch": None}):
            run_preflight(ctx, reads=[])


# ---------------------------------------------------------------------------
# Write-path validation
# ---------------------------------------------------------------------------

class TestWritePathValidation:
    def test_write_path_exists_and_writable(self, tmp_path):
        target = tmp_path / "output"
        target.mkdir()
        ctx = _make_ctx(tmp_path)
        with patch.dict("sys.modules", {"torch": None}):
            run_preflight(ctx, reads=[], writes=[str(target)])

    def test_write_path_exists_not_writable_raises(self, tmp_path):
        target = tmp_path / "ro_output"
        target.mkdir()

        def fake_access(p, m):
            if str(p) == str(target) and m == os.W_OK:
                return False
            return True

        with patch("os.access", side_effect=fake_access):
            with pytest.raises(PermissionError, match="writes path exists but is not writable"):
                run_preflight(_make_ctx(tmp_path), reads=[], writes=[str(target)])

    def test_write_path_parent_missing_raises_file_not_found(self, tmp_path):
        target = tmp_path / "ghost_parent" / "output"
        with pytest.raises(FileNotFoundError, match="writes path parent does not exist"):
            run_preflight(_make_ctx(tmp_path), reads=[], writes=[str(target)])

    def test_write_path_parent_not_writable_raises(self, tmp_path):
        parent = tmp_path / "ro_parent"
        parent.mkdir()
        target = parent / "output"

        def fake_access(p, m):
            if str(p) == str(parent) and m == os.W_OK:
                return False
            # target doesn't exist, parent check happens
            return True

        with patch("os.access", side_effect=fake_access):
            with pytest.raises(PermissionError, match="writes path parent is not writable"):
                run_preflight(_make_ctx(tmp_path), reads=[], writes=[str(target)])

    def test_writes_none_is_allowed(self, tmp_path):
        ctx = _make_ctx(tmp_path)
        with patch.dict("sys.modules", {"torch": None}):
            run_preflight(ctx, reads=[], writes=None)


# ---------------------------------------------------------------------------
# run_dir writable check
# ---------------------------------------------------------------------------

class TestRunDirWritableCheck:
    def test_run_dir_parent_not_writable_raises(self, tmp_path):
        ctx = _make_ctx(tmp_path)
        parent = ctx.run_dir.parent  # = tmp_path

        def fake_access(p, m):
            if Path(p) == parent and m == os.W_OK:
                return False
            return True

        with patch("os.access", side_effect=fake_access):
            with pytest.raises(PermissionError, match="ALCHEMY_RUN_DIR parent is not writable"):
                run_preflight(ctx, reads=[])

    def test_run_dir_parent_missing_tries_create(self, tmp_path):
        ctx = _make_ctx(tmp_path)
        # Point run_dir into a non-existent parent
        ctx.run_dir = tmp_path / "deep" / "nested" / "run"
        ctx.checkpoint_dir = ctx.run_dir / "checkpoints"

        with patch.dict("sys.modules", {"torch": None}):
            run_preflight(ctx, reads=[])
        assert ctx.run_dir.is_dir()

    def test_run_dir_parent_missing_and_cannot_create_raises(self, tmp_path):
        ctx = _make_ctx(tmp_path)
        ctx.run_dir = tmp_path / "deep" / "run"
        ctx.checkpoint_dir = ctx.run_dir / "checkpoints"

        with patch("pathlib.Path.mkdir", side_effect=PermissionError("read-only fs")):
            with pytest.raises(PermissionError, match="cannot create run_dir parent"):
                run_preflight(ctx, reads=[])


# ---------------------------------------------------------------------------
# Auto-create run_dir / checkpoint_dir
# ---------------------------------------------------------------------------

class TestAutocreate:
    def test_run_dir_created(self, tmp_path):
        ctx = _make_ctx(tmp_path)
        assert not ctx.run_dir.exists()
        with patch.dict("sys.modules", {"torch": None}):
            run_preflight(ctx, reads=[])
        assert ctx.run_dir.is_dir()

    def test_checkpoint_dir_created(self, tmp_path):
        ctx = _make_ctx(tmp_path)
        assert not ctx.checkpoint_dir.exists()
        with patch.dict("sys.modules", {"torch": None}):
            run_preflight(ctx, reads=[])
        assert ctx.checkpoint_dir.is_dir()


# ---------------------------------------------------------------------------
# Disk space warning
# ---------------------------------------------------------------------------

class TestDiskSpaceWarning:
    def test_warns_when_free_below_1gib(self, tmp_path):
        ctx = _make_ctx(tmp_path)
        fake_usage = MagicMock()
        fake_usage.free = 512 * 1024 * 1024  # 512 MiB = 0.50 GiB

        with patch("shutil.disk_usage", return_value=fake_usage):
            with patch.dict("sys.modules", {"torch": None}):
                with warnings.catch_warnings(record=True) as w:
                    warnings.simplefilter("always")
                    run_preflight(ctx, reads=[])
                disk_warnings = [x for x in w if "low disk space" in str(x.message)]
                assert len(disk_warnings) == 1
                assert "0.50" in str(disk_warnings[0].message)

    def test_no_warning_when_free_above_1gib(self, tmp_path):
        ctx = _make_ctx(tmp_path)
        fake_usage = MagicMock()
        fake_usage.free = 10 * 1024 * 1024 * 1024  # 10 GiB

        with patch("shutil.disk_usage", return_value=fake_usage):
            with patch.dict("sys.modules", {"torch": None}):
                with warnings.catch_warnings(record=True) as w:
                    warnings.simplefilter("always")
                    run_preflight(ctx, reads=[])
                disk_warnings = [x for x in w if "low disk space" in str(x.message)]
                assert len(disk_warnings) == 0

    def test_disk_usage_failure_is_not_fatal(self, tmp_path):
        ctx = _make_ctx(tmp_path)
        with patch("shutil.disk_usage", side_effect=OSError("exotic fs")):
            with patch.dict("sys.modules", {"torch": None}):
                run_preflight(ctx, reads=[])  # must not raise

    def test_disk_space_warning_at_exact_boundary(self, tmp_path):
        """Exactly 1 GiB free should NOT trigger a warning."""
        ctx = _make_ctx(tmp_path)
        fake_usage = MagicMock()
        fake_usage.free = 1_073_741_824  # exactly 1 GiB

        with patch("shutil.disk_usage", return_value=fake_usage):
            with patch.dict("sys.modules", {"torch": None}):
                with warnings.catch_warnings(record=True) as w:
                    warnings.simplefilter("always")
                    run_preflight(ctx, reads=[])
                disk_warnings = [x for x in w if "low disk space" in str(x.message)]
                assert len(disk_warnings) == 0


# ---------------------------------------------------------------------------
# GPU availability check
# ---------------------------------------------------------------------------

class TestGPUCheck:
    def test_raises_when_torch_present_but_no_cuda(self, tmp_path):
        ctx = _make_ctx(tmp_path)
        mock_torch = MagicMock()
        mock_torch.cuda.is_available.return_value = False

        with patch.dict("sys.modules", {"torch": mock_torch}):
            with pytest.raises(RuntimeError, match="torch.cuda.is_available\\(\\) returned False"):
                run_preflight(ctx, reads=[])

    def test_passes_when_cuda_available(self, tmp_path):
        ctx = _make_ctx(tmp_path)
        mock_torch = MagicMock()
        mock_torch.cuda.is_available.return_value = True

        with patch.dict("sys.modules", {"torch": mock_torch}):
            run_preflight(ctx, reads=[])

    def test_skips_gpu_check_when_torch_not_installed(self, tmp_path):
        ctx = _make_ctx(tmp_path)
        with patch.dict("sys.modules", {"torch": None}):
            run_preflight(ctx, reads=[])  # must not raise


# ---------------------------------------------------------------------------
# Resume detection
# ---------------------------------------------------------------------------

class TestResumeDetection:
    def test_is_resume_set_true_when_checkpoint_found(self, tmp_path):
        ctx = _make_ctx(tmp_path)
        fake_ckpt = tmp_path / "checkpoints" / "step_100.pt"
        ctx.latest_checkpoint.return_value = fake_ckpt

        with patch.dict("sys.modules", {"torch": None}):
            run_preflight(ctx, reads=[])

        assert ctx.is_resume is True

    def test_is_resume_stays_false_when_no_checkpoint(self, tmp_path):
        ctx = _make_ctx(tmp_path)
        ctx.latest_checkpoint.return_value = None

        with patch.dict("sys.modules", {"torch": None}):
            run_preflight(ctx, reads=[])

        assert ctx.is_resume is not True  # was not set by preflight

    def test_latest_checkpoint_called_exactly_once(self, tmp_path):
        ctx = _make_ctx(tmp_path)
        with patch.dict("sys.modules", {"torch": None}):
            run_preflight(ctx, reads=[])
        ctx.latest_checkpoint.assert_called_once()

    def test_is_resume_scan_uses_ctx_latest_checkpoint(self, tmp_path):
        """Preflight delegates resume detection to ctx.latest_checkpoint, not its own scan."""
        ctx = _make_ctx(tmp_path)
        fake_path = Path("/some/other/path/ckpt.pt")
        ctx.latest_checkpoint.return_value = fake_path

        with patch.dict("sys.modules", {"torch": None}):
            run_preflight(ctx, reads=[])

        assert ctx.is_resume is True


# ---------------------------------------------------------------------------
# Integration: combined successful preflight
# ---------------------------------------------------------------------------

class TestIntegration:
    def test_full_preflight_success(self, tmp_path):
        reads_dir = tmp_path / "data"
        reads_dir.mkdir()
        writes_dir = tmp_path / "output"
        writes_dir.mkdir()

        ctx = _make_ctx(tmp_path)
        ctx.run_dir = tmp_path / "run"
        ctx.checkpoint_dir = ctx.run_dir / "checkpoints"

        mock_torch = MagicMock()
        mock_torch.cuda.is_available.return_value = True

        fake_usage = MagicMock()
        fake_usage.free = 5 * 1024 * 1024 * 1024

        with patch.dict("sys.modules", {"torch": mock_torch}):
            with patch("shutil.disk_usage", return_value=fake_usage):
                run_preflight(ctx, reads=[str(reads_dir)], writes=[str(writes_dir)])

        assert ctx.run_dir.is_dir()
        assert ctx.checkpoint_dir.is_dir()
        assert ctx.is_resume is not True
