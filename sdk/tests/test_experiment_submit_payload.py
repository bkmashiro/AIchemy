from __future__ import annotations

import json

from alchemy_sdk.experiment import Experiment, ExperimentResult
from alchemy_sdk.submit import submit_experiment


class _Response:
    status = 201

    def read(self):
        return b'{"id":"exp-1","task_refs":{"train":"task-1"}}'


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
