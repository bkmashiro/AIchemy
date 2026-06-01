from __future__ import annotations

import json
from unittest.mock import patch

from alchemy_sdk.cli import main as cli


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


def run_cli(monkeypatch, argv, responses):
    calls = []
    queue = list(responses)

    def fake_urlopen(req, timeout=20.0):
        body = req.data.decode("utf-8") if req.data else None
        calls.append({
            "method": req.method,
            "url": req.full_url,
            "body": json.loads(body) if body else None,
            "auth": req.headers.get("Authorization"),
            "timeout": timeout,
        })
        assert queue, f"unexpected request {req.method} {req.full_url}"
        return FakeResponse(queue.pop(0))

    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")
    with patch("alchemy_sdk.cli.main.urlopen", fake_urlopen):
        code = cli.main(argv)
    assert code == 0
    return calls


def test_stubs_drain_uses_patch_payload(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["stubs", "drain", "worker-a"],
        [
            [{"id": "stub-1", "name": "worker-a", "status": "online"}],
            {"ok": True, "stub": {"id": "stub-1", "name": "worker-a", "max_concurrent": 0}},
        ],
    )

    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == "http://localhost:3002/api/stubs"
    assert calls[1]["method"] == "PATCH"
    assert calls[1]["url"] == "http://localhost:3002/api/stubs/stub-1"
    assert calls[1]["body"] == {"max_concurrent": 0}
    assert calls[1]["auth"] == "Bearer secret-token"


def test_tasks_resubmit_resume_drops_run_dir_and_targets_tags(monkeypatch):
    source = {
        "id": "task-1",
        "script": "/work/train.py",
        "raw_args": "--config cfg.yaml",
        "cwd": "/work",
        "run_dir": "/work/runs/locked",
        "name": "old",
        "display_name": "old-display",
        "status": "failed",
        "target_tags": ["a30", "slurm"],
    }
    created = {**source, "id": "task-2", "seq": 42, "status": "pending", "raw_args": "--config cfg.yaml --resume"}
    calls = run_cli(
        monkeypatch,
        ["tasks", "resubmit", "task-1", "--resume", "--to-tags", "t4,slurm"],
        [source, created],
    )

    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == "http://localhost:3002/api/tasks/task-1"
    assert calls[1]["method"] == "POST"
    assert calls[1]["url"] == "http://localhost:3002/api/tasks"
    body = calls[1]["body"]
    assert body["script"] == "/work/train.py"
    assert body["raw_args"] == "--config cfg.yaml --resume"
    assert body["target_tags"] == ["t4", "slurm"]
    assert body["name"] == "old-display_resubmit"
    assert "run_dir" not in body
    assert body["idempotency_key"].startswith("resubmit:task-1:")


def test_cancel_running_requires_yes(monkeypatch):
    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")

    def fake_urlopen(req, timeout=20.0):
        assert req.method == "GET"
        return FakeResponse({"id": "task-1", "status": "running"})

    with patch("alchemy_sdk.cli.main.urlopen", fake_urlopen):
        code = cli.main(["tasks", "cancel", "task-1"])

    assert code == 1


def test_slurm_submit_t4_posts_deploy_restart(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["slurm", "submit", "t4"],
        [{"ok": True, "job_id": "123"}],
    )

    assert calls == [
        {
            "method": "POST",
            "url": "http://localhost:3002/api/deploy/stubs/slurm-t4/restart",
            "body": {},
            "auth": "Bearer secret-token",
            "timeout": 20.0,
        }
    ]


def test_experiments_ls_returns_short_summary(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "ls"],
        [[
            {"id": "exp-1", "name": "alpha", "status": "running", "family": "ablation"},
            {"id": "exp-2", "name": "beta", "status": "passed"},
        ]],
    )

    assert calls == [{
        "method": "GET",
        "url": "http://localhost:3002/api/experiments",
        "body": None,
        "auth": "Bearer secret-token",
        "timeout": 20.0,
    }]


def test_experiments_show_resolves_name_then_fetches_detail(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "show", "alpha"],
        [
            [{"id": "exp-1", "name": "alpha"}, {"id": "exp-2", "name": "beta"}],
            {"id": "exp-1", "name": "alpha", "status": "running", "tasks": []},
        ],
    )

    assert calls[0]["url"] == "http://localhost:3002/api/experiments"
    assert calls[1]["method"] == "GET"
    assert calls[1]["url"] == "http://localhost:3002/api/experiments/exp-1"


def test_experiments_timeline_fetches_by_id(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "timeline", "exp-1"],
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"experiment_id": "exp-1", "events": []},
        ],
    )

    assert calls[1]["method"] == "GET"
    assert calls[1]["url"] == "http://localhost:3002/api/experiments/exp-1/timeline"


def test_experiments_note_posts_event_without_actor(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "note", "exp-1", "looks good", "--data", '{"metric": 0.9}'],
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"id": "evt-1", "kind": "note"},
        ],
    )

    assert calls[1]["method"] == "POST"
    assert calls[1]["url"] == "http://localhost:3002/api/experiments/exp-1/events"
    assert calls[1]["body"] == {"kind": "note", "message": "looks good", "data": {"metric": 0.9}}
    assert "actor" not in calls[1]["body"]


def test_experiments_note_rejects_non_object_data(monkeypatch):
    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")

    def fake_urlopen(req, timeout=20.0):
        assert req.method == "GET"
        return FakeResponse([{"id": "exp-1", "name": "alpha"}])

    with patch("alchemy_sdk.cli.main.urlopen", fake_urlopen):
        code = cli.main(["experiments", "note", "exp-1", "hi", "--data", "[1,2,3]"])

    assert code == 1


def test_experiments_decide_sends_patch(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "decide", "exp-1", "keep", "best run so far"],
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"id": "exp-1", "decision": "keep", "decision_reason": "best run so far"},
        ],
    )

    assert calls[1]["method"] == "PATCH"
    assert calls[1]["url"] == "http://localhost:3002/api/experiments/exp-1/decision"
    assert calls[1]["body"] == {"decision": "keep", "reason": "best run so far"}


def test_experiments_decide_accepts_reason_flag(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "decide", "exp-1", "fork", "--reason", "needs ablation"],
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"id": "exp-1", "decision": "fork", "decision_reason": "needs ablation"},
        ],
    )

    assert calls[1]["method"] == "PATCH"
    assert calls[1]["url"] == "http://localhost:3002/api/experiments/exp-1/decision"
    assert calls[1]["body"] == {"decision": "fork", "reason": "needs ablation"}


def test_experiments_show_ambiguous_name_fails(monkeypatch):
    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")

    def fake_urlopen(req, timeout=20.0):
        assert req.method == "GET"
        return FakeResponse([
            {"id": "exp-1", "name": "alpha"},
            {"id": "exp-2", "name": "alpha"},
        ])

    with patch("alchemy_sdk.cli.main.urlopen", fake_urlopen):
        code = cli.main(["experiments", "show", "alpha"])

    assert code == 1


def test_move_to_stub_cancels_then_posts_target_stub(monkeypatch):
    task = {
        "id": "task-1",
        "script": "/work/train.py",
        "raw_args": "--x 1",
        "cwd": "/work",
        "status": "pending",
        "display_name": "task-one",
        "target_tags": ["a30", "slurm"],
    }
    calls = run_cli(
        monkeypatch,
        ["tasks", "move", "task-1", "--to-stub", "stub-a"],
        [
            task,
            [{"id": "stub-1", "name": "stub-a", "status": "online"}],
            {"id": "task-1", "status": "cancelled"},
            {**task, "id": "task-2", "status": "pending", "stub_id": "stub-1"},
        ],
    )

    assert calls[2]["method"] == "PATCH"
    assert calls[2]["body"] == {"status": "cancelled"}
    assert calls[3]["method"] == "POST"
    assert calls[3]["body"]["target_stub_id"] == "stub-1"
    assert "target_tags" not in calls[3]["body"]
