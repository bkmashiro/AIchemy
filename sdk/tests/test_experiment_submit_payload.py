from __future__ import annotations

import io
import json
import urllib.error

from alchemy_sdk.experiment import Experiment, ExperimentResult
from alchemy_sdk.submit import submit_experiment
from alchemy_sdk.submit import ExperimentSubmissionError


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
    assert captured["sdk_spec"]["metadata"]["sdk_version"] == "2.2.0"
    assert captured["sdk_spec"]["tasks"] == [{"ref": "train", "script": "train.py"}]
    assert captured["idempotency_key"]


def test_experiment_reuses_generated_key_after_timeout(monkeypatch):
    payloads = []

    def fake_urlopen(req, timeout=30):
        payloads.append(json.loads(req.data.decode()))
        if len(payloads) == 1:
            raise TimeoutError("response timed out")
        return _Response()

    monkeypatch.setattr("alchemy_sdk.submit.urllib.request.urlopen", fake_urlopen)
    exp = Experiment("retry", server="http://alchemy")
    exp.task("train", script="train.py")

    try:
        exp.submit()
    except ExperimentSubmissionError as exc:
        assert exc.outcome == "unknown"
        assert exc.idempotency_key == exp.idempotency_key
        retry_key = exc.request_key
    else:
        raise AssertionError("timeout must be reported")

    result = exp.submit()
    assert result.experiment_id == "exp-1"
    assert payloads[0] == payloads[1]
    assert payloads[0]["idempotency_key"] == retry_key


def test_submit_custom_key_and_explicit_new_key(monkeypatch):
    keys = []

    def fake_urlopen(req, timeout=30):
        keys.append(json.loads(req.data.decode())["idempotency_key"])
        return _Response()

    monkeypatch.setattr("alchemy_sdk.submit.urllib.request.urlopen", fake_urlopen)
    exp = Experiment("custom", server="http://alchemy")
    exp.task("train", script="train.py")

    exp.submit(idempotency_key="caller-key")
    exp.submit()
    exp.submit(idempotency_key="intentional-rerun")
    assert keys == ["caller-key", "caller-key", "intentional-rerun"]
    assert exp.idempotency_key == "intentional-rerun"


def test_submit_reports_idempotency_conflict(monkeypatch):
    def fake_urlopen(req, timeout=30):
        raise urllib.error.HTTPError(
            req.full_url, 409, "Conflict", {},
            io.BytesIO(b'{"error":"idempotency_key reused with a different experiment payload"}'),
        )

    monkeypatch.setattr("alchemy_sdk.submit.urllib.request.urlopen", fake_urlopen)
    try:
        submit_experiment(
            server="http://alchemy", name="payload", description="",
            task_specs=[{"ref": "train", "script": "train.py"}],
            idempotency_key="same-key",
        )
    except ExperimentSubmissionError as exc:
        assert exc.code == "idempotency_conflict"
        assert exc.status == 409
        assert exc.request_key == "same-key"
        assert exc.outcome == "rejected"
        assert "different experiment payload" in exc.response_body
    else:
        raise AssertionError("409 must be reported")


def test_experiment_successful_repeat_keeps_key_and_reports_existing(monkeypatch):
    calls = []

    class ExistingResponse(_Response):
        status = 200

    def fake_urlopen(req, timeout=30):
        payload = json.loads(req.data.decode())
        calls.append(payload)
        return _Response() if len(calls) == 1 else ExistingResponse()

    monkeypatch.setattr("alchemy_sdk.submit.urllib.request.urlopen", fake_urlopen)
    exp = Experiment("repeat", server="http://alchemy")
    task = exp.task("train", script="train.py")

    first = exp.submit()
    second = exp.submit()

    assert task.task_id == "task-1"
    assert first.already_exists is False
    assert second.already_exists is True
    assert calls[0] == calls[1]


def test_invalid_idempotency_key_is_typed_and_not_sent(monkeypatch):
    def unexpected_request(*args, **kwargs):
        raise AssertionError("invalid key must not send a request")

    monkeypatch.setattr("alchemy_sdk.submit.urllib.request.urlopen", unexpected_request)
    exp = Experiment("invalid", server="http://alchemy")
    exp.task("train", script="train.py")

    try:
        exp.submit(idempotency_key=" ")
    except ExperimentSubmissionError as exc:
        assert isinstance(exc, RuntimeError)
        assert exc.code == "invalid_idempotency_key"
        assert exc.outcome == "not_submitted"
    else:
        raise AssertionError("empty key must be rejected")


def test_http_error_json_with_non_object_shape_is_typed(monkeypatch):
    def fake_urlopen(req, timeout=30):
        raise urllib.error.HTTPError(
            req.full_url, 422, "Unprocessable Entity", {}, io.BytesIO(b'["bad", null]'),
        )

    monkeypatch.setattr("alchemy_sdk.submit.urllib.request.urlopen", fake_urlopen)
    try:
        submit_experiment("http://alchemy", "bad", "", [])
    except ExperimentSubmissionError as exc:
        assert exc.code == "http_422"
        assert exc.outcome == "rejected"
        assert exc.response_body == '["bad", null]'
    else:
        raise AssertionError("HTTP error must be typed for non-object JSON")


def test_success_response_without_experiment_id_is_unknown_and_closed(monkeypatch):
    class MissingIdResponse:
        status = 201
        closed = False

        def read(self):
            return b'{"task_refs":{}}'

        def close(self):
            self.closed = True

    response = MissingIdResponse()
    monkeypatch.setattr("alchemy_sdk.submit.urllib.request.urlopen", lambda *a, **k: response)
    try:
        submit_experiment("http://alchemy", "bad", "", [], idempotency_key="retry-key")
    except ExperimentSubmissionError as exc:
        assert exc.code == "invalid_response"
        assert exc.outcome == "unknown"
        assert exc.idempotency_key == "retry-key"
    else:
        raise AssertionError("a success response without an id must not appear successful")
    assert response.closed


def test_success_response_read_failure_is_typed_and_closed(monkeypatch):
    class BrokenResponse:
        status = 201
        closed = False

        def read(self):
            raise OSError("connection reset while reading")

        def close(self):
            self.closed = True

    response = BrokenResponse()
    monkeypatch.setattr("alchemy_sdk.submit.urllib.request.urlopen", lambda *a, **k: response)
    try:
        submit_experiment("http://alchemy", "bad", "", [], idempotency_key="retry-key")
    except ExperimentSubmissionError as exc:
        assert exc.code == "invalid_response"
        assert exc.outcome == "unknown"
        assert exc.idempotency_key == "retry-key"
    else:
        raise AssertionError("response read failure must be typed")
    assert response.closed


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
