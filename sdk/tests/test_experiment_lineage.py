from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from alchemy_sdk.experiment import Experiment
from alchemy_sdk.experiments import ExperimentClient, render_research_bundle_markdown


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


def _patched_urlopen(queue, calls):
    def fake_urlopen(req, timeout=20.0):
        body = None
        if req.data:
            body = json.loads(req.data.decode("utf-8"))
        calls.append({
            "method": req.method,
            "url": req.full_url,
            "auth": req.headers.get("Authorization"),
            "timeout": timeout,
            "body": body,
        })
        assert queue, f"unexpected request {req.method} {req.full_url}"
        return FakeResponse(queue.pop(0))

    return fake_urlopen


def _run(monkeypatch, action, responses, *, token="secret-token"):
    if token is None:
        monkeypatch.delenv("ALCHEMY_TOKEN", raising=False)
    else:
        monkeypatch.setenv("ALCHEMY_TOKEN", token)
    monkeypatch.delenv("ALCHEMY_SERVER", raising=False)
    monkeypatch.delenv("ALCHEMY_SERVER_URL", raising=False)
    queue = list(responses)
    calls: list[dict] = []
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen(queue, calls)):
        result = action()
    return result, calls


def test_experiment_accepts_intent_fields_and_submit_payload(monkeypatch):
    captured = {}

    def fake_submit_experiment(**kwargs):
        captured.update(kwargs)
        from alchemy_sdk.experiment import ExperimentResult
        return ExperimentResult(
            experiment_id="exp-1",
            task_refs={"train": "task-1"},
            already_exists=False,
            url="http://server/experiments/exp-1",
        )

    monkeypatch.setattr("alchemy_sdk.submit.submit_experiment", fake_submit_experiment)

    exp = Experiment(
        "curiosity_s42",
        server="http://server",
        family="pretrain_nh",
        hypothesis="curiosity improves zn",
        expected_outcome="zn up, loss stable",
    )
    exp.task("train", script="train.py")
    exp.submit()

    assert captured["family"] == "pretrain_nh"
    assert captured["hypothesis"] == "curiosity improves zn"
    assert captured["expected_outcome"] == "zn up, loss stable"


def test_fork_reason_is_submitted(monkeypatch):
    captured = {}

    def fake_submit_experiment(**kwargs):
        captured.update(kwargs)
        from alchemy_sdk.experiment import ExperimentResult
        return ExperimentResult(
            experiment_id="exp-child",
            task_refs={"train": "task-child"},
            already_exists=False,
            url="http://server/experiments/exp-child",
        )

    monkeypatch.setattr("alchemy_sdk.submit.submit_experiment", fake_submit_experiment)

    base = Experiment("baseline", server="http://server", family="pretrain_nh")
    base.config = {"train": {"lr": 3e-4}}
    base.task("train", script="train.py")

    child = base.fork("curiosity_s42", reason="baseline plateaued")
    child.config["train"]["lr"] = 1e-4
    child.submit()

    assert captured["parent_name"] == "baseline"
    assert captured["family"] == "pretrain_nh"
    assert captured["fork_reason"] == "baseline plateaued"
    assert captured["config_diff"] == {"train.lr": {"old": 3e-4, "new": 1e-4}}


def test_replication_plan_returns_manifest_with_replication_suffix(monkeypatch):
    client = ExperimentClient(server="http://server")
    plan, calls = _run(
        monkeypatch,
        lambda: client.replication_plan(
            "alpha",
            set_overrides={"lr": 0.0003, "use_curiosity": True},
            unset=["warmup"],
            reason="replicate this branch",
        ),
        [
            [{"id": "exp-1", "name": "alpha"}],
            {
                "id": "exp-1",
                "name": "alpha",
                "family": "pretrain",
                "config": {"lr": 0.001, "warmup": 100, "seed": 7},
            },
        ],
    )

    assert [c["method"] for c in calls] == ["GET", "GET"]
    assert plan["kind"] == "replication-plan"
    assert plan["dry_run"] is True
    assert plan["parent"] == {"id": "exp-1", "name": "alpha", "family": "pretrain"}
    assert plan["suggested_name"] == "alpha-replication"
    assert plan["reason"] == "replicate this branch"
    assert plan["parent_config"] == {"lr": 0.001, "warmup": 100, "seed": 7}
    assert plan["proposed_config"] == {"lr": 0.0003, "seed": 7, "use_curiosity": True}
    assert plan["config_diff"]["lr"] == {"before": 0.001, "after": 0.0003, "op": "set"}
    assert plan["config_diff"]["use_curiosity"] == {"before": None, "after": True, "op": "add"}
    assert plan["config_diff"]["warmup"] == {"before": 100, "after": None, "op": "unset"}


def test_replication_plan_rejects_dotted_keys(monkeypatch):
    client = ExperimentClient(server="http://server", token="tk")
    queue = [
        [{"id": "exp-1", "name": "alpha"}],
        {"id": "exp-1", "name": "alpha", "config": {}},
    ]
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen(queue, [])):
        with pytest.raises(RuntimeError, match="nested keys"):
            client.replication_plan("alpha", set_overrides={"model.lr": 0.1})


def test_add_note_posts_note_event_with_task_id_and_data(monkeypatch):
    client = ExperimentClient(server="http://server")
    note, calls = _run(
        monkeypatch,
        lambda: client.add_note(
            "alpha",
            "seeded experiment with more data",
            task_id="task-1",
            data={"epoch": 10, "loss": 0.12},
        ),
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"id": "evt-1", "kind": "note", "message": "seeded experiment with more data"},
        ],
    )

    assert [c["method"] for c in calls] == ["GET", "POST"]
    assert calls[1]["url"] == "http://server/api/experiments/exp-1/events"
    assert calls[1]["body"] == {
        "kind": "note",
        "message": "seeded experiment with more data",
        "task_id": "task-1",
        "data": {"epoch": 10, "loss": 0.12},
    }
    assert note["id"] == "evt-1"


def test_decide_patches_decision_and_reason(monkeypatch):
    client = ExperimentClient(server="http://server")
    decided, calls = _run(
        monkeypatch,
        lambda: client.decide("alpha", decision="drop", reason="bad validation curve"),
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"id": "exp-1", "decision": "drop", "decision_reason": "bad validation curve"},
        ],
    )

    assert [c["method"] for c in calls] == ["GET", "PATCH"]
    assert calls[1]["url"] == "http://server/api/experiments/exp-1/decision"
    assert calls[1]["body"] == {"decision": "drop", "reason": "bad validation curve"}
    assert decided["id"] == "exp-1"


def test_decide_rejects_invalid_decision(monkeypatch):
    client = ExperimentClient(server="http://server")
    with pytest.raises(RuntimeError, match="decision must be one of"):
        client.decide("alpha", decision="nudge", reason="not sure")


def test_decide_rejects_empty_reason(monkeypatch):
    client = ExperimentClient(server="http://server")
    with pytest.raises(RuntimeError, match="reason must be a non-empty string"):
        client.decide("alpha", decision="keep", reason="  ")


def test_add_note_rejects_empty_message_before_request(monkeypatch):
    client = ExperimentClient(server="http://server", token="tk")
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen([], [])):
        with pytest.raises(RuntimeError, match="message must be a non-empty string"):
            client.add_note("alpha", "  ")


def test_add_artifact_posts_event_with_merged_data_and_path_locator(monkeypatch):
    client = ExperimentClient(server="http://server")
    result, calls = _run(
        monkeypatch,
        lambda: client.add_artifact(
            "alpha",
            "/runs/abc/ckpt.pt",
            artifact_type="tensorboard",
            name="best",
            task_id="task-9",
            step=100.5,
            data={
                "artifact_type": "file",
                "path": "/shadow/path",
                "name": "wrong",
                "step": 9,
                "region": "us-west-2",
            },
        ),
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"id": "evt-1", "kind": "artifact"},
        ],
    )

    assert result == {"id": "evt-1", "kind": "artifact"}
    assert [c["method"] for c in calls] == ["GET", "POST"]
    assert calls[1]["url"] == "http://server/api/experiments/exp-1/events"
    body = calls[1]["body"]
    assert body["kind"] == "artifact"
    assert body["message"] == "Artifact: best"
    assert body["task_id"] == "task-9"
    assert body["data"]["path"] == "/runs/abc/ckpt.pt"
    assert "uri" not in body["data"]
    assert body["data"]["artifact_type"] == "tensorboard"
    assert body["data"]["name"] == "best"
    assert body["data"]["step"] == 100.5
    assert body["data"]["region"] == "us-west-2"


def test_add_artifact_posts_uri_when_locator_looks_like_uri(monkeypatch):
    client = ExperimentClient(server="http://server")
    _, calls = _run(
        monkeypatch,
        lambda: client.add_artifact(
            "alpha",
            "s3://bucket/run/tb",
            artifact_type="tensorboard",
        ),
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"id": "evt-1", "kind": "artifact"},
        ],
    )

    body = calls[1]["body"]
    assert body["kind"] == "artifact"
    assert body["message"] == "Artifact: s3://bucket/run/tb"
    assert body["data"]["uri"] == "s3://bucket/run/tb"
    assert "path" not in body["data"]


def test_add_checkpoint_defaults_to_checkpoint_type_and_message(monkeypatch):
    client = ExperimentClient(server="http://server")
    _, calls = _run(
        monkeypatch,
        lambda: client.add_checkpoint(
            "alpha",
            "/runs/checkpoints/last.pt",
            name="ep10",
            task_id="task-7",
            step=10,
            data={"artifact_type": "log", "path": "/wrong", "name": "wrong"},
        ),
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"id": "evt-1", "kind": "checkpoint"},
        ],
    )

    body = calls[1]["body"]
    assert body["kind"] == "checkpoint"
    assert body["message"] == "Checkpoint: ep10"
    assert body["task_id"] == "task-7"
    assert body["data"]["artifact_type"] == "checkpoint"
    assert body["data"]["path"] == "/runs/checkpoints/last.pt"
    assert body["data"]["name"] == "ep10"
    assert body["data"]["step"] == 10


def test_add_artifact_rejects_invalid_artifact_type(monkeypatch):
    client = ExperimentClient(server="http://server", token="tk")
    with pytest.raises(RuntimeError, match="artifact_type"):
        client.add_artifact("alpha", "/runs/x", artifact_type="bad", data={})


def test_add_artifact_rejects_invalid_artifact_type_inside_data(monkeypatch):
    client = ExperimentClient(server="http://server", token="tk")
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen([], [])):
        with pytest.raises(RuntimeError, match="artifact_type"):
            client.add_artifact("alpha", "/runs/x", data={"artifact_type": "spaceship"})


def test_add_artifact_rejects_non_finite_step(monkeypatch):
    client = ExperimentClient(server="http://server", token="tk")
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen([], [])):
        with pytest.raises(RuntimeError, match="finite number"):
            client.add_artifact("alpha", "/runs/x", step=float("nan"))


def test_add_artifact_rejects_non_mapping_data(monkeypatch):
    client = ExperimentClient(server="http://server", token="tk")
    with pytest.raises(RuntimeError, match="data"):
        client.add_artifact("alpha", "/runs/x", data=["not", "a", "mapping"])


def test_add_artifact_rejects_empty_locator(monkeypatch):
    client = ExperimentClient(server="http://server", token="tk")
    with pytest.raises(RuntimeError, match="non-empty"):
        client.add_artifact("alpha", "   ", data={})


def test_research_bundle_markdown_render_is_deterministic_for_minimal_payload():
    payload = {
        "experiment": {"id": "exp-1", "name": "alpha", "family": "rl", "status": "passed"},
        "summary": {
            "recommendation": {
                "action": "keep",
                "verdict": "best",
                "reason": "beats baseline",
                "metric": "acc",
                "value": 0.88,
                "baseline_value": 0.8,
                "delta": 0.08,
                "evidence_quality": "high",
                "sample_count": 10,
                "comparable_count": 3,
                "baseline_source": "parent",
            },
            "best_metrics": {"acc": 0.88},
            "primary_metric": {"name": "acc", "value": 0.88},
            "validation": {"source": "held-out"},
        },
        "diff": {"config_diff_summary": {"seed": {"before": 7, "after": 8, "op": "set"}}},
        "timeline": {"events": [{"kind": "artifact", "created_at": "t", "message": "saved"}]},
        "decision": {"decision": "keep", "reason": "improves"},
        "artifacts": [{"kind": "artifact", "data": {"uri": "s3://bucket", "name": "best", "step": 3}}],
        "generated_at": "2026-06-02T00:00:00Z",
    }

    md = render_research_bundle_markdown(payload)
    assert "# Research Bundle: alpha (exp-1)" in md
    assert "## Decision" in md
    assert "## Artifacts" in md
    assert "keep" in md
    assert "beats baseline" in md
    assert "metric: acc" in md
    assert "baseline_value: 0.8" in md
    assert "baseline_source: parent" in md
    assert "s3://bucket" in md
    md_repeat = render_research_bundle_markdown(payload)
    assert md == md_repeat


def test_experiment_client_research_bundle_markdown_fetches_and_renders(monkeypatch):
    client = ExperimentClient(server="http://server")
    bundle = {
        "experiment": {"id": "exp-1", "name": "alpha", "status": "running"},
        "summary": {},
        "diff": {},
        "manifest": {},
        "timeline": {"events": []},
        "decision": {"decision": None, "reason": None},
        "artifacts": [],
        "generated_at": "2026-06-02T00:00:00Z",
    }
    markdown, calls = _run(
        monkeypatch,
        lambda: client.research_bundle_markdown("alpha"),
        [
            [{"id": "exp-1", "name": "alpha"}],
            bundle,
        ],
    )

    assert [c["method"] for c in calls] == ["GET", "GET"]
    assert calls[1]["url"] == "http://server/api/experiments/exp-1/research-bundle"
    assert markdown.startswith("# Research Bundle:")
