"""Unit tests for alchemy_sdk/context.py — TrainingContext."""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch, call

import pytest

# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------

def _make_ctx(tmp_path, total_steps=10, eval_every=0, checkpoint_every=0, managed=False):
    """Build a TrainingContext backed by a temp directory, with a mock Alchemy."""
    from alchemy_sdk.context import TrainingContext

    al = MagicMock()
    al.params.return_value = {"lr": 1e-3}
    al._managed = managed
    al.should_stop.return_value = False

    run_dir = str(tmp_path / "run")
    with patch.dict(os.environ, {"ALCHEMY_RUN_DIR": run_dir}):
        ctx = TrainingContext(
            al=al,
            total_steps=total_steps,
            eval_every=eval_every,
            checkpoint_every=checkpoint_every,
        )
    return ctx, al


# ---------------------------------------------------------------------------
# _makedirs_002 — umask thread safety
# ---------------------------------------------------------------------------

class TestMakedirs002:
    def test_creates_directory(self, tmp_path):
        from alchemy_sdk.context import _makedirs_002
        target = tmp_path / "a" / "b" / "c"
        _makedirs_002(target)
        assert target.is_dir()

    def test_idempotent(self, tmp_path):
        from alchemy_sdk.context import _makedirs_002
        target = tmp_path / "idempotent"
        _makedirs_002(target)
        _makedirs_002(target)  # second call must not raise
        assert target.is_dir()

    def test_umask_restored_after_call(self, tmp_path):
        from alchemy_sdk.context import _makedirs_002
        original = os.umask(0o022)
        os.umask(original)  # restore immediately
        _makedirs_002(tmp_path / "restore_test")
        restored = os.umask(0o022)
        os.umask(restored)
        assert restored == original

    def test_thread_safe_umask(self, tmp_path):
        """Concurrent _makedirs_002 calls must not leak foreign umasks."""
        from alchemy_sdk.context import _makedirs_002
        errors = []

        def worker(idx):
            try:
                _makedirs_002(tmp_path / f"thread_{idx}")
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        # Verify umask was restored after all threads finished
        original = os.umask(0o022)
        os.umask(original)
        assert original == 0o022


# ---------------------------------------------------------------------------
# TrainingContext initialisation
# ---------------------------------------------------------------------------

class TestTrainingContextInit:
    def test_params_defensive_copy(self, tmp_path):
        ctx, al = _make_ctx(tmp_path)
        p = ctx.params
        p["injected"] = True
        assert "injected" not in ctx.params

    def test_run_dir_from_env(self, tmp_path):
        run_dir = tmp_path / "myrun"
        with patch.dict(os.environ, {"ALCHEMY_RUN_DIR": str(run_dir)}):
            from alchemy_sdk.context import TrainingContext
            al = MagicMock()
            al.params.return_value = {}
            al._managed = False
            al.should_stop.return_value = False
            ctx = TrainingContext(al=al)
        assert ctx.run_dir == run_dir

    def test_checkpoint_dir_under_run_dir(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path)
        assert ctx.checkpoint_dir == ctx.run_dir / "checkpoints"

    def test_is_resume_defaults_false(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path)
        assert ctx.is_resume is False

    def test_managed_missing_run_dir_raises(self):
        """Under managed mode, missing ALCHEMY_RUN_DIR must raise RuntimeError."""
        from alchemy_sdk.context import TrainingContext
        al = MagicMock()
        al.params.return_value = {}
        al._managed = True
        env = {k: v for k, v in os.environ.items() if k != "ALCHEMY_RUN_DIR"}
        with patch.dict(os.environ, env, clear=True):
            with pytest.raises(RuntimeError, match="ALCHEMY_RUN_DIR not set"):
                TrainingContext(al=al)

    def test_noop_mode_fallback_run_dir(self):
        """Without ALCHEMY_RUN_DIR and not managed, fallback is cwd/runs/<hash>."""
        from alchemy_sdk.context import TrainingContext
        al = MagicMock()
        al.params.return_value = {}
        al._managed = False
        env = {k: v for k, v in os.environ.items() if k != "ALCHEMY_RUN_DIR"}
        with patch.dict(os.environ, env, clear=True):
            ctx = TrainingContext(al=al)
        assert "runs" in ctx.run_dir.parts


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

class TestPathHelpers:
    def test_sub_dir_creates(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path)
        d = ctx.sub_dir("logs")
        assert d.is_dir()
        assert d == ctx.run_dir / "logs"

    def test_artifact_dir_creates(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path)
        d = ctx.artifact_dir("plots")
        assert d.is_dir()
        assert d == ctx.run_dir / "artifacts" / "plots"

    def test_sub_dir_idempotent(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path)
        d1 = ctx.sub_dir("same")
        d2 = ctx.sub_dir("same")
        assert d1 == d2


# ---------------------------------------------------------------------------
# Hooks
# ---------------------------------------------------------------------------

class TestHooks:
    def test_register_valid_event(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path)
        fn = MagicMock()
        returned = ctx.on("on_step_start", fn)
        assert returned is ctx  # chaining

    def test_register_unknown_event_raises(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path)
        with pytest.raises(ValueError, match="Unknown hook event"):
            ctx.on("on_foo", MagicMock())

    def test_hook_fires_with_correct_args(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path, total_steps=3)
        fired = []
        ctx.on("on_step_start", lambda c, s: fired.append(("start", s)))
        ctx.on("on_step_end", lambda c, s: fired.append(("end", s)))
        list(ctx.steps())
        # step_start fires before yield, step_end fires after
        assert ("start", 0) in fired
        assert ("end", 0) in fired

    def test_multiple_hooks_same_event(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path, total_steps=1)
        calls = []
        ctx.on("on_step_start", lambda c, s: calls.append("a"))
        ctx.on("on_step_start", lambda c, s: calls.append("b"))
        list(ctx.steps())
        assert calls == ["a", "b"]

    def test_on_eval_fires_at_correct_steps(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path, total_steps=6, eval_every=2)
        eval_steps = []
        ctx.on("on_eval", lambda c, s: eval_steps.append(s))
        list(ctx.steps())
        # should_eval is true when step > 0 and step % 2 == 0  → steps 2, 4
        assert eval_steps == [2, 4]

    def test_on_checkpoint_fires_at_correct_steps(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path, total_steps=6, checkpoint_every=3)
        ckpt_steps = []
        ctx.on("on_checkpoint", lambda c, s: ckpt_steps.append(s))
        list(ctx.steps())
        # should_checkpoint true when step > 0 and step % 3 == 0 → step 3
        assert ckpt_steps == [3]

    def test_chain_registration(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path)
        fn1 = MagicMock()
        fn2 = MagicMock()
        ctx.on("on_eval", fn1).on("on_checkpoint", fn2)
        assert fn1 in ctx._hooks["on_eval"]
        assert fn2 in ctx._hooks["on_checkpoint"]


# ---------------------------------------------------------------------------
# steps() iterator
# ---------------------------------------------------------------------------

class TestStepsIterator:
    def test_yields_correct_range(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path, total_steps=5)
        assert list(ctx.steps()) == [0, 1, 2, 3, 4]

    def test_start_offset(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path, total_steps=5)
        assert list(ctx.steps(start=3)) == [3, 4]

    def test_zero_total_steps_loops_until_stop(self, tmp_path):
        """total_steps=0 → infinite loop, only breaks on should_stop()."""
        ctx, al = _make_ctx(tmp_path, total_steps=0)
        call_count = 0
        stop_after = 3

        def side_effect():
            nonlocal call_count
            call_count += 1
            return call_count > stop_after

        al.should_stop.side_effect = side_effect
        results = list(ctx.steps())
        assert len(results) == stop_after

    def test_breaks_on_should_stop(self, tmp_path):
        ctx, al = _make_ctx(tmp_path, total_steps=100)
        # Stop after 3 checks (each step checks once before yield)
        call_count = 0

        def stop_at_3():
            nonlocal call_count
            call_count += 1
            return call_count > 3

        al.should_stop.side_effect = stop_at_3
        results = list(ctx.steps())
        assert len(results) < 100

    def test_log_called_each_step(self, tmp_path):
        ctx, al = _make_ctx(tmp_path, total_steps=3)
        list(ctx.steps())
        assert al.log.call_count == 3

    def test_current_step_tracks_iteration(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path, total_steps=5)
        visited = []
        for step in ctx.steps():
            visited.append(ctx._current_step)
        # During yield the step hasn't been incremented yet
        assert visited == [0, 1, 2, 3, 4]

    def test_step_zero_not_eval_or_checkpoint(self, tmp_path):
        """Step 0 must not trigger eval or checkpoint (off-by-one guard)."""
        ctx, _ = _make_ctx(tmp_path, total_steps=1, eval_every=1, checkpoint_every=1)
        eval_fired = []
        ckpt_fired = []
        ctx.on("on_eval", lambda c, s: eval_fired.append(s))
        ctx.on("on_checkpoint", lambda c, s: ckpt_fired.append(s))
        list(ctx.steps())
        assert 0 not in eval_fired
        assert 0 not in ckpt_fired


# ---------------------------------------------------------------------------
# Signal proxies
# ---------------------------------------------------------------------------

class TestSignalProxies:
    def test_should_stop_delegates(self, tmp_path):
        ctx, al = _make_ctx(tmp_path)
        al.should_stop.return_value = True
        assert ctx.should_stop() is True

    def test_should_eval_false_when_zero(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path, eval_every=0)
        ctx._current_step = 10
        assert ctx.should_eval() is False

    def test_should_eval_true(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path, eval_every=5)
        ctx._current_step = 10
        assert ctx.should_eval() is True

    def test_should_eval_false_at_zero_step(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path, eval_every=1)
        ctx._current_step = 0
        assert ctx.should_eval() is False

    def test_should_checkpoint_true(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path, checkpoint_every=5)
        ctx._current_step = 5
        assert ctx.should_checkpoint() is True

    def test_should_checkpoint_false_at_step_zero(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path, checkpoint_every=1)
        ctx._current_step = 0
        assert ctx.should_checkpoint() is False


# ---------------------------------------------------------------------------
# Checkpoint lifecycle
# ---------------------------------------------------------------------------

class TestCheckpointLifecycle:
    def test_latest_checkpoint_none_when_dir_missing(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path)
        # checkpoint_dir not yet created
        assert ctx.latest_checkpoint() is None

    def test_latest_checkpoint_none_when_no_pt_files(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path)
        ctx._checkpoint_dir.mkdir(parents=True, exist_ok=True)
        assert ctx.latest_checkpoint() is None

    def test_latest_checkpoint_returns_newest_by_mtime(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path)
        ckpt_dir = ctx._checkpoint_dir
        ckpt_dir.mkdir(parents=True, exist_ok=True)

        older = ckpt_dir / "step_100.pt"
        newer = ckpt_dir / "step_200.pt"
        older.touch()
        time.sleep(0.01)  # ensure mtime differs
        newer.touch()

        result = ctx.latest_checkpoint()
        assert result == newer

    def test_latest_checkpoint_handles_deleted_file_gracefully(self, tmp_path):
        """OSError during stat (file deleted mid-glob) must be swallowed."""
        ctx, _ = _make_ctx(tmp_path)
        ckpt_dir = ctx._checkpoint_dir
        ckpt_dir.mkdir(parents=True, exist_ok=True)
        (ckpt_dir / "only.pt").touch()

        original_stat = Path.stat

        def flaky_stat(self, **kwargs):
            if self.name == "only.pt":
                raise OSError("deleted")
            return original_stat(self, **kwargs)

        with patch.object(Path, "stat", flaky_stat):
            result = ctx.latest_checkpoint()
        assert result is None  # file excluded due to OSError

    def _patch_torch(self, save_side_effect):
        """Context manager that injects a fake torch module with a custom save."""
        import sys
        import types
        mock_torch = types.ModuleType("torch")
        mock_torch.save = save_side_effect
        return patch.dict(sys.modules, {"torch": mock_torch})

    def test_save_checkpoint_atomic_write(self, tmp_path):
        """save_checkpoint must rename tmp → final path; no .tmp left behind."""
        ctx, al = _make_ctx(tmp_path)
        ctx._checkpoint_dir.mkdir(parents=True, exist_ok=True)

        fake_state = {"weights": [1, 2, 3]}

        with self._patch_torch(lambda obj, f: Path(f).write_bytes(b"x")):
            saved_path = ctx.save_checkpoint(fake_state, name="step_50")

        assert saved_path.exists()
        assert saved_path.suffix == ".pt"
        assert not saved_path.with_suffix(".tmp").exists()

    def test_save_checkpoint_notifies_stub(self, tmp_path):
        ctx, al = _make_ctx(tmp_path)
        ctx._checkpoint_dir.mkdir(parents=True, exist_ok=True)

        with self._patch_torch(lambda obj, f: Path(f).write_bytes(b"x")):
            saved_path = ctx.save_checkpoint({"x": 1})

        al.checkpoint.assert_called_once_with(str(saved_path))

    def test_save_checkpoint_cleans_tmp_on_error(self, tmp_path):
        """If torch.save raises, .tmp file must be cleaned up."""
        ctx, al = _make_ctx(tmp_path)
        ctx._checkpoint_dir.mkdir(parents=True, exist_ok=True)

        def failing_save(obj, f):
            Path(f).write_bytes(b"partial")
            raise RuntimeError("disk full")

        with self._patch_torch(failing_save):
            with pytest.raises(RuntimeError, match="disk full"):
                ctx.save_checkpoint({"x": 1})

        tmp = ctx._checkpoint_dir / "latest.tmp"
        assert not tmp.exists()

    def test_save_checkpoint_raises_without_torch(self, tmp_path):
        ctx, _ = _make_ctx(tmp_path)
        ctx._checkpoint_dir.mkdir(parents=True, exist_ok=True)

        import sys
        with patch.dict(sys.modules, {"torch": None}):
            with pytest.raises(ImportError, match="torch is required"):
                ctx.save_checkpoint({"x": 1})

    def test_save_checkpoint_overwrite_same_name(self, tmp_path):
        """Saving twice with same name must atomically overwrite."""
        ctx, al = _make_ctx(tmp_path)
        ctx._checkpoint_dir.mkdir(parents=True, exist_ok=True)

        with self._patch_torch(lambda obj, f: Path(f).write_bytes(b"v1")):
            p1 = ctx.save_checkpoint({"v": 1}, name="latest")

        with self._patch_torch(lambda obj, f: Path(f).write_bytes(b"v2")):
            p2 = ctx.save_checkpoint({"v": 2}, name="latest")

        assert p1 == p2
        assert p2.read_bytes() == b"v2"


# ---------------------------------------------------------------------------
# Report helpers
# ---------------------------------------------------------------------------

class TestReportHelpers:
    def test_log_forwards_loss(self, tmp_path):
        ctx, al = _make_ctx(tmp_path, total_steps=5)
        ctx._current_step = 2
        ctx.log(loss=0.42, acc=0.9)
        al.log.assert_called_with(step=2, total=5, loss=0.42, metrics={"acc": 0.9})

    def test_log_no_loss(self, tmp_path):
        ctx, al = _make_ctx(tmp_path, total_steps=5)
        ctx._current_step = 1
        ctx.log(acc=0.8)
        al.log.assert_called_with(step=1, total=5, loss=None, metrics={"acc": 0.8})

    def test_log_no_extra_metrics(self, tmp_path):
        ctx, al = _make_ctx(tmp_path, total_steps=5)
        ctx._current_step = 0
        ctx.log(loss=1.0)
        al.log.assert_called_with(step=0, total=5, loss=1.0, metrics=None)

    def test_log_eval_delegates(self, tmp_path):
        ctx, al = _make_ctx(tmp_path)
        ctx.log_eval({"reward": 42.0})
        al.log_eval.assert_called_once_with({"reward": 42.0})
