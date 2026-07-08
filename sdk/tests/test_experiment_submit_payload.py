from __future__ import annotations

import json

from alchemy_sdk.experiment import Experiment, ExperimentResult
from alchemy_sdk.submit import submit_experiment


class _Response:
    status = 201

    def read(self):
        return b'{"id":"exp-1","task_refs":{"train":"task-1"}}'


class _WarningResponse:
    status = 201

    def read(self):
        return b'{"id":"exp-1","task_refs":{"train":"task-1"},"submission_warnings":[{"code":"high_priority_unrouted"}]}'


def test_submit_forwards_sdk_storage_and_metadata_spec(monkeypatch):
    captured = {}

    def fake_submit_experiment(**kwargs):
        captured.update(kwargs)
        return ExperimentResult(
            experiment_id="exp-1",
            task_refs={"train": "task-1"},
            already_exists=False,
            url="http://alchemy/experiments/exp-1",
        )

    monkeypatch.setattr("alchemy_sdk.submit.submit_experiment", fake_submit_experiment)

    exp = (
        Experiment("storage-submit", server="http://alchemy")
        .storage(root="/vol/gpudata/runs", artifact_root="/vol/gpudata/artifacts")
        .base_config({"train": {"batch_size": 64}})
    )
    exp.task("train", script="train.py")

    result = exp.submit()

    assert result.experiment_id == "exp-1"
    assert captured["storage"] == {
        "root": "/vol/gpudata/runs",
        "artifact_root": "/vol/gpudata/artifacts",
    }
    assert captured["sdk_spec"]["storage"] == captured["storage"]
    assert captured["sdk_spec"]["metadata"]["sdk_version"] == "2.1.0"
    assert captured["sdk_spec"]["tasks"] == [{"ref": "train", "script": "train.py"}]


def test_submit_forwards_code_id_to_http_payload(monkeypatch):
    captured = {}

    def fake_submit_experiment(**kwargs):
        captured.update(kwargs)
        return ExperimentResult(
            experiment_id="exp-1",
            task_refs={"train": "task-1"},
            already_exists=False,
            url="http://alchemy/experiments/exp-1",
        )

    monkeypatch.setattr("alchemy_sdk.submit.submit_experiment", fake_submit_experiment)

    exp = Experiment(code_id="jema.atari.coverage500.v1", name="Atari coverage500", server="http://alchemy")
    exp.task("train", script="train.py")

    exp.submit()

    assert captured["code_id"] == "jema.atari.coverage500.v1"
    assert captured["sdk_spec"]["code_id"] == "jema.atari.coverage500.v1"


def test_submit_experiment_http_payload_includes_sdk_storage(monkeypatch):
    calls = []

    def fake_urlopen(req, timeout=30):
        calls.append(json.loads(req.data.decode()))
        return _Response()

    monkeypatch.setattr("alchemy_sdk.submit.urllib.request.urlopen", fake_urlopen)

    submit_experiment(
        server="http://alchemy",
        name="payload",
        description="",
        task_specs=[{"ref": "train", "script": "train.py"}],
        storage={"root": "/runs"},
        sdk_spec={"name": "payload", "storage": {"root": "/runs"}},
    )

    assert calls == [
        {
            "name": "payload",
            "description": "",
            "task_specs": [{"ref": "train", "script": "train.py"}],
            "force": False,
            "storage": {"root": "/runs"},
            "sdk_spec": {"name": "payload", "storage": {"root": "/runs"}},
        }
    ]



def test_submit_experiment_returns_submission_warnings(monkeypatch):
    def fake_urlopen(req, timeout=30):
        return _WarningResponse()

    monkeypatch.setattr("alchemy_sdk.submit.urllib.request.urlopen", fake_urlopen)

    result = submit_experiment(
        server="http://alchemy",
        name="payload",
        description="",
        task_specs=[{"ref": "train", "script": "train.py"}],
    )

    assert result.submission_warnings == [{"code": "high_priority_unrouted"}]

def test_submit_experiment_uses_alchemy_token_for_authorization(monkeypatch):
    calls = []

    def fake_urlopen(req, timeout=30):
        calls.append(req.headers.get("Authorization"))
        return _Response()

    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")
    monkeypatch.setattr("alchemy_sdk.submit.urllib.request.urlopen", fake_urlopen)

    submit_experiment(
        server="http://alchemy",
        name="payload",
        description="",
        task_specs=[{"ref": "train", "script": "train.py"}],
    )

    assert calls == ["Bearer secret-token"]


def test_config_yaml_file_mode_includes_resolved_config_in_spec_and_submit(monkeypatch):
    captured = {}

    def fake_submit_experiment(**kwargs):
        captured.update(kwargs)
        return ExperimentResult(
            experiment_id="exp-1",
            task_refs={"train": "task-1"},
            already_exists=False,
            url="http://alchemy/experiments/exp-1",
        )

    monkeypatch.setattr("alchemy_sdk.submit.submit_experiment", fake_submit_experiment)

    exp = Experiment("sidecar", server="http://alchemy").base_config(
        {"train": {"batch_size": 64, "lr": 1e-4}}
    )
    exp.task(
        "train",
        script="train.py",
        config_mode="yaml_file",
        config_overrides={"train.lr": 3e-4},
    )

    dry_task = exp.dry_run()["tasks"][0]
    assert dry_task["config_mode"] == "yaml_file"
    assert dry_task["resolved_config"] == {"train": {"batch_size": 64, "lr": 3e-4}}

    exp.submit()

    submitted_task = captured["task_specs"][0]
    assert submitted_task["config_mode"] == "yaml_file"
    assert submitted_task["resolved_config"] == {"train": {"batch_size": 64, "lr": 3e-4}}


def test_task_rejects_unknown_config_mode():
    exp = Experiment("bad")

    try:
        exp.task("train", script="train.py", config_mode="magic")
    except ValueError as exc:
        assert "config_mode" in str(exc)
    else:
        raise AssertionError("unknown config_mode should fail")
