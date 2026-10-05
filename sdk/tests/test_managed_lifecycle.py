"""Regression tests for ManagedTraining checkpoint lifecycle."""
from __future__ import annotations

import json
import pickle
import warnings
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from alchemy_sdk.managed import ManagedTraining


class TinyTraining(ManagedTraining):
    def setup(self, config):
        pass

    def state(self):
        return {"value": 17}

    def load_state(self, state):
        self.loaded_state = state

    def step_fn(self, batch):
        return {"loss": 1.0}


def _instance(directory: Path, step: int = 0) -> TinyTraining:
    instance = TinyTraining()
    instance._checkpoint_dir = directory
    instance._current_step = step
    instance._alchemy = MagicMock()
    return instance


def test_checkpoint_publication_is_atomic_and_stores_next_step(tmp_path):
    instance = _instance(tmp_path / "checkpoints", step=7)

    path = instance._save_checkpoint()

    with path.open("rb") as file:
        payload = pickle.load(file)
    assert payload == {
        "__alchemy_checkpoint__": "managed-training",
        "schema_version": 1,
        "next_step": 7,
        "state": {"value": 17},
    }
    assert list(path.parent.iterdir()) == [path]


def test_explicit_versioned_resume_restores_next_step(tmp_path):
    path = tmp_path / "checkpoint_99.pkl"
    path.write_bytes(pickle.dumps({
        "__alchemy_checkpoint__": "managed-training",
        "schema_version": 1,
        "next_step": 101,
        "state": {"value": 42},
    }))
    instance = _instance(tmp_path / "other")

    instance._load_checkpoint(path)

    assert instance._current_step == 101
    assert instance.loaded_state == {"value": 42}


def test_latest_checkpoint_uses_numeric_order_and_metadata(tmp_path):
    (tmp_path / "checkpoint_99.pkl").write_bytes(pickle.dumps({"value": 99}))
    (tmp_path / "checkpoint_100.pkl").write_bytes(pickle.dumps({
        "__alchemy_checkpoint__": "managed-training",
        "schema_version": 1, "next_step": 100, "state": {"value": 100}
    }))
    instance = _instance(tmp_path)

    assert instance._find_latest_checkpoint().name == "checkpoint_100.pkl"


def test_latest_checkpoint_orders_by_numeric_filename_without_loading_payload(tmp_path):
    (tmp_path / "checkpoint_200.pkl").write_bytes(pickle.dumps({"value": 200}))
    (tmp_path / "checkpoint_99.pkl").write_bytes(pickle.dumps({
        "__alchemy_checkpoint__": "managed-training",
        "schema_version": 1, "next_step": 250, "state": {"value": 250}
    }))
    instance = _instance(tmp_path)

    latest = instance._find_latest_checkpoint()
    assert latest is not None
    assert latest.name == "checkpoint_200.pkl"


def test_legacy_explicit_resume_warns_and_uses_numeric_filename(tmp_path):
    path = tmp_path / "checkpoint_12.pkl"
    path.write_bytes(pickle.dumps({"value": 12}))
    instance = _instance(tmp_path / "other")

    with pytest.warns(UserWarning, match="legacy checkpoint"):
        instance._load_checkpoint(path)

    assert instance._current_step == 12
    assert instance.loaded_state == {"value": 12}


def test_user_state_with_schema_version_remains_legacy_state(tmp_path):
    path = tmp_path / "checkpoint_12.pkl"
    user_state = {"schema_version": 1, "weights": [1, 2]}
    path.write_bytes(pickle.dumps(user_state))
    instance = _instance(tmp_path / "other")

    with pytest.warns(UserWarning, match="legacy checkpoint"):
        instance._load_checkpoint(path)

    assert instance.loaded_state == user_state


def test_checkpoint_scan_does_not_unpickle_candidates(tmp_path):
    (tmp_path / "checkpoint_10.pkl").write_bytes(b"untrusted payload")
    instance = _instance(tmp_path)

    with patch("alchemy_sdk.managed.pickle.load", side_effect=AssertionError("must not unpickle")):
        latest = instance._find_latest_checkpoint()

    assert latest is not None
    assert latest.name == "checkpoint_10.pkl"


def test_managed_run_resumes_at_next_step_and_closes_transport(tmp_path, monkeypatch):
    calls = []

    class CountingTraining(TinyTraining):
        def state(self):
            return {"calls": len(calls)}

        def load_state(self, state):
            calls.extend(["restored"] * state["calls"])

        def step_fn(self, batch):
            calls.append("step")
            return {}

    checkpoint_dir = tmp_path / "run"
    checkpoint_dir.mkdir()
    checkpoint = checkpoint_dir / "checkpoint_1.pkl"
    checkpoint.write_bytes(pickle.dumps({
        "__alchemy_checkpoint__": "managed-training",
        "schema_version": 1,
        "next_step": 1,
        "state": {"calls": 1},
    }))
    alchemy = MagicMock()
    alchemy.should_stop.return_value = False
    monkeypatch.setattr("alchemy_sdk.managed.Alchemy", lambda: alchemy)
    monkeypatch.setattr("sys.argv", ["train.py"])

    ManagedTraining.run(CountingTraining, total_steps=2, checkpoint_dir=str(checkpoint_dir))

    assert calls == ["restored", "step"]
    assert alchemy.done.call_count == 1
    alchemy.close.assert_called_once()


def test_server_stop_checkpoints_without_reporting_natural_completion(tmp_path, monkeypatch, capsys):
    alchemy = MagicMock()
    alchemy.should_stop.return_value = True
    monkeypatch.setattr("alchemy_sdk.managed.Alchemy", lambda: alchemy)
    monkeypatch.setattr("sys.argv", ["train.py"])

    ManagedTraining.run(TinyTraining, total_steps=2, checkpoint_dir=str(tmp_path / "stop"))

    assert (tmp_path / "stop" / "checkpoint_0.pkl").exists()
    alchemy.done.assert_not_called()
    alchemy.close.assert_called_once()
    assert "Training complete" not in capsys.readouterr().out


def test_step_failure_closes_transport_without_done_and_restores_signal(monkeypatch, tmp_path):
    class FailingTraining(TinyTraining):
        def step_fn(self, batch):
            raise RuntimeError("step failed")

    alchemy = MagicMock()
    alchemy.should_stop.return_value = False
    monkeypatch.setattr("alchemy_sdk.managed.Alchemy", lambda: alchemy)
    monkeypatch.setattr("sys.argv", ["train.py"])
    import signal
    previous_handler = signal.getsignal(signal.SIGUSR1)

    with pytest.raises(RuntimeError, match="step failed"):
        ManagedTraining.run(FailingTraining, total_steps=1, checkpoint_dir=str(tmp_path / "failed"))

    alchemy.done.assert_not_called()
    alchemy.close.assert_called_once()
    assert signal.getsignal(signal.SIGUSR1) is previous_handler


def test_default_checkpoint_directory_is_stable_and_task_scoped_without_attempt_id(monkeypatch, tmp_path):
    from alchemy_sdk.managed import _default_checkpoint_dir

    monkeypatch.setenv("ALCHEMY_TASK_ID", "task-a")
    monkeypatch.setenv("ALCHEMY_RUN_DIR", str(tmp_path / "shared-bucket"))
    first = _default_checkpoint_dir()
    second = _default_checkpoint_dir()

    assert first == second
    assert any(part.startswith("task-a-") for part in first.parts)
    assert first.is_relative_to(tmp_path)
    assert "/tmp/alchemy_checkpoints" not in str(first)
