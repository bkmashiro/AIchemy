"""Tests for PyTorch Lightning and HuggingFace trainer callbacks."""
import os
from unittest.mock import MagicMock, patch, PropertyMock

import pytest

from alchemy_sdk.callbacks import AlchemyPLCallback, AlchemyHFCallback


# ─── PyTorch Lightning Callback ──────────────────────────────────────────────

class TestAlchemyPLCallback:
    def test_on_train_start_creates_alchemy_client(self):
        cb = AlchemyPLCallback(server="http://localhost:3001")
        trainer = MagicMock()
        trainer.estimated_stepping_batches = 1000
        cb.on_train_start(trainer, MagicMock())
        assert cb._al is not None

    def test_on_train_start_uses_env_var_when_no_server(self):
        with patch.dict(os.environ, {"ALCHEMY_SERVER": "http://env-server:3001"}):
            cb = AlchemyPLCallback()
            trainer = MagicMock()
            trainer.estimated_stepping_batches = 500
            cb.on_train_start(trainer, MagicMock())
            assert cb._al is not None
            assert cb._al.server == "http://env-server:3001"

    def test_on_train_start_no_client_when_no_server(self):
        with patch.dict(os.environ, {}, clear=True):
            # Ensure ALCHEMY_SERVER is not set
            os.environ.pop("ALCHEMY_SERVER", None)
            cb = AlchemyPLCallback(server="")
            trainer = MagicMock()
            trainer.estimated_stepping_batches = 100
            cb.on_train_start(trainer, MagicMock())
            assert cb._al is None

    def test_on_train_batch_end_calls_log(self):
        cb = AlchemyPLCallback(server="http://localhost:3001", total_steps=100)
        cb._al = MagicMock()
        cb._al.should_stop = False

        trainer = MagicMock()
        trainer.global_step = 50
        trainer.callback_metrics = {"train_loss": 0.3, "val_acc": 0.85}

        cb.on_train_batch_end(trainer, MagicMock(), MagicMock(), MagicMock(), 50)

        cb._al.log.assert_called_once()
        call_args = cb._al.log.call_args
        assert call_args[1]["step"] == 50
        assert call_args[1]["total"] == 100
        assert call_args[1]["loss"] == pytest.approx(0.3)

    def test_on_train_batch_end_sets_trainer_should_stop(self):
        cb = AlchemyPLCallback(server="http://localhost:3001", total_steps=100)
        cb._al = MagicMock()
        cb._al.should_stop = True

        trainer = MagicMock()
        trainer.global_step = 50
        trainer.callback_metrics = {"train_loss": 0.9}
        trainer.should_stop = False

        cb.on_train_batch_end(trainer, MagicMock(), MagicMock(), MagicMock(), 50)

        assert trainer.should_stop is True

    def test_on_train_batch_end_does_nothing_without_al(self):
        cb = AlchemyPLCallback(server="", total_steps=100)
        cb._al = None
        trainer = MagicMock()
        trainer.global_step = 10
        trainer.callback_metrics = {}
        # Should not raise
        cb.on_train_batch_end(trainer, MagicMock(), MagicMock(), MagicMock(), 10)

    def test_on_save_checkpoint_reports_path(self):
        cb = AlchemyPLCallback(server="http://localhost:3001")
        cb._al = MagicMock()

        trainer = MagicMock()
        trainer.checkpoint_callback = MagicMock()
        trainer.checkpoint_callback.best_model_path = "/runs/exp1/best.ckpt"

        cb.on_save_checkpoint(trainer, MagicMock(), MagicMock())

        cb._al.checkpoint.assert_called_once_with("/runs/exp1/best.ckpt")

    def test_on_train_end_calls_done(self):
        cb = AlchemyPLCallback(server="http://localhost:3001")
        cb._al = MagicMock()
        cb.on_train_end(MagicMock(), MagicMock())
        cb._al.done.assert_called_once()

    def test_total_steps_inferred_from_trainer(self):
        cb = AlchemyPLCallback(server="http://localhost:3001")  # no total_steps
        trainer = MagicMock()
        trainer.estimated_stepping_batches = 2000
        cb.on_train_start(trainer, MagicMock())
        assert cb._total == 2000


# ─── HuggingFace Callback ────────────────────────────────────────────────────

class TestAlchemyHFCallback:
    def _make_args(self):
        args = MagicMock()
        args.output_dir = "/runs/hf_exp"
        return args

    def _make_state(self, step=10, max_steps=1000):
        state = MagicMock()
        state.global_step = step
        state.max_steps = max_steps
        return state

    def test_on_train_begin_creates_client(self):
        cb = AlchemyHFCallback(server="http://localhost:3001")
        cb.on_train_begin(MagicMock(), MagicMock(), MagicMock())
        assert cb._al is not None

    def test_on_train_begin_no_client_when_no_server(self):
        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop("ALCHEMY_SERVER", None)
            cb = AlchemyHFCallback(server="")
            cb.on_train_begin(MagicMock(), MagicMock(), MagicMock())
            assert cb._al is None

    def test_on_log_calls_alchemy_log(self):
        cb = AlchemyHFCallback(server="http://localhost:3001")
        cb._al = MagicMock()
        cb._al.should_stop = False

        control = MagicMock()
        control.should_training_stop = False

        logs = {"loss": 0.5, "learning_rate": 1e-4}
        cb.on_log(self._make_args(), self._make_state(step=100), control, logs=logs)

        cb._al.log.assert_called_once()
        kwargs = cb._al.log.call_args[1]
        assert kwargs["step"] == 100
        assert kwargs["total"] == 1000
        assert kwargs["loss"] == 0.5
        assert "learning_rate" in kwargs["metrics"]

    def test_on_log_sets_should_training_stop(self):
        cb = AlchemyHFCallback(server="http://localhost:3001")
        cb._al = MagicMock()
        cb._al.should_stop = True

        control = MagicMock()
        control.should_training_stop = False

        cb.on_log(self._make_args(), self._make_state(), control, logs={"loss": 0.9})

        assert control.should_training_stop is True

    def test_on_log_skips_non_numeric_metrics(self):
        cb = AlchemyHFCallback(server="http://localhost:3001")
        cb._al = MagicMock()
        cb._al.should_stop = False

        control = MagicMock()
        logs = {"loss": 0.5, "epoch": "3", "extra": [1, 2, 3]}  # non-numeric values
        cb.on_log(self._make_args(), self._make_state(), control, logs=logs)

        kwargs = cb._al.log.call_args[1]
        # "epoch" and "extra" should be excluded (non int/float)
        assert "epoch" not in (kwargs.get("metrics") or {})
        assert "extra" not in (kwargs.get("metrics") or {})

    def test_on_save_reports_checkpoint(self):
        cb = AlchemyHFCallback(server="http://localhost:3001")
        cb._al = MagicMock()

        state = self._make_state(step=200)
        cb.on_save(self._make_args(), state, MagicMock())

        cb._al.checkpoint.assert_called_once_with("/runs/hf_exp/checkpoint-200")

    def test_on_train_end_calls_done(self):
        cb = AlchemyHFCallback(server="http://localhost:3001")
        cb._al = MagicMock()
        cb.on_train_end(MagicMock(), MagicMock(), MagicMock())
        cb._al.done.assert_called_once()

    def test_on_log_does_nothing_without_al(self):
        cb = AlchemyHFCallback(server="")
        cb._al = None
        # Should not raise
        cb.on_log(MagicMock(), MagicMock(), MagicMock(), logs={"loss": 0.5})
