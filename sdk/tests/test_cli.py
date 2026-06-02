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


def test_experiments_artifact_posts_event_with_path(monkeypatch):
    calls = run_cli(
        monkeypatch,
        [
            "experiments", "artifact", "alpha", "/runs/abc/ckpt-100.pt",
            "--type", "checkpoint", "--name", "best", "--task", "task-9", "--step", "100",
        ],
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"id": "evt-1", "kind": "artifact"},
        ],
    )
    assert calls[1]["method"] == "POST"
    assert calls[1]["url"] == "http://localhost:3002/api/experiments/exp-1/events"
    body = calls[1]["body"]
    assert body["kind"] == "artifact"
    assert body["task_id"] == "task-9"
    assert body["data"]["path"] == "/runs/abc/ckpt-100.pt"
    assert body["data"]["artifact_type"] == "checkpoint"
    assert body["data"]["name"] == "best"
    assert body["data"]["step"] == 100.0
    assert "actor" not in body


def test_experiments_artifact_detects_uri_and_merges_data(monkeypatch):
    calls = run_cli(
        monkeypatch,
        [
            "experiments", "artifact", "alpha", "s3://bucket/run/tb",
            "--type", "tensorboard", "--data", '{"region": "us-west-2"}',
        ],
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"id": "evt-1", "kind": "artifact"},
        ],
    )
    body = calls[1]["body"]
    assert body["data"]["uri"] == "s3://bucket/run/tb"
    assert body["data"]["artifact_type"] == "tensorboard"
    assert body["data"]["region"] == "us-west-2"
    assert "path" not in body["data"]


def test_experiments_checkpoint_defaults_type_and_message(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "checkpoint", "alpha", "/runs/abc/last.pt", "--name", "ep10"],
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"id": "evt-1", "kind": "checkpoint"},
        ],
    )
    body = calls[1]["body"]
    assert body["kind"] == "checkpoint"
    assert body["message"] == "Checkpoint: ep10"
    assert body["data"]["path"] == "/runs/abc/last.pt"
    assert body["data"]["artifact_type"] == "checkpoint"


def test_experiments_artifact_rejects_empty_location(monkeypatch, capsys):
    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")

    def fake_urlopen(req, timeout=20.0):
        return FakeResponse([{"id": "exp-1", "name": "alpha"}])

    with patch("alchemy_sdk.cli.main.urlopen", fake_urlopen):
        code = cli.main(["experiments", "artifact", "alpha", "   "])
    assert code == 1
    assert "non-empty path" in capsys.readouterr().err


def test_experiments_artifact_rejects_non_object_data(monkeypatch):
    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")

    def fake_urlopen(req, timeout=20.0):
        return FakeResponse([{"id": "exp-1", "name": "alpha"}])

    with patch("alchemy_sdk.cli.main.urlopen", fake_urlopen):
        code = cli.main(["experiments", "artifact", "alpha", "/p", "--data", "[1,2]"])
    assert code == 1


def test_experiments_fork_plan_returns_manifest_without_posting(monkeypatch, capsys):
    calls = run_cli(
        monkeypatch,
        [
            "experiments", "fork-plan", "alpha",
            "--set", "lr=0.0003",
            "--set", "use_curiosity=true",
            "--unset", "warmup",
            "--name", "alpha-curiosity",
            "--reason", "test curiosity contribution",
        ],
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

    # Two GETs only — must not POST/PATCH.
    assert [c["method"] for c in calls] == ["GET", "GET"]
    out = capsys.readouterr().out
    manifest = json.loads(out)
    assert manifest["kind"] == "fork-plan"
    assert manifest["dry_run"] is True
    assert manifest["parent"]["name"] == "alpha"
    assert manifest["suggested_name"] == "alpha-curiosity"
    assert manifest["reason"] == "test curiosity contribution"
    assert manifest["parent_config"] == {"lr": 0.001, "warmup": 100, "seed": 7}
    assert manifest["proposed_config"] == {"lr": 0.0003, "seed": 7, "use_curiosity": True}
    assert manifest["config_diff"]["lr"] == {"before": 0.001, "after": 0.0003, "op": "set"}
    assert manifest["config_diff"]["use_curiosity"] == {"before": None, "after": True, "op": "add"}
    assert manifest["config_diff"]["warmup"] == {"before": 100, "after": None, "op": "unset"}


def test_experiments_fork_plan_rejects_dotted_keys(monkeypatch, capsys):
    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")

    responses = [
        [{"id": "exp-1", "name": "alpha"}],
        {"id": "exp-1", "name": "alpha", "config": {}},
    ]

    def fake_urlopen(req, timeout=20.0):
        return FakeResponse(responses.pop(0))

    with patch("alchemy_sdk.cli.main.urlopen", fake_urlopen):
        code = cli.main([
            "experiments", "fork-plan", "alpha",
            "--set", "model.lr=0.1",
        ])
    assert code == 1
    err = capsys.readouterr().err
    assert "nested keys" in err



def test_experiments_fork_plan_rejects_empty_unset_key(monkeypatch, capsys):
    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")

    responses = [
        [{"id": "exp-1", "name": "alpha"}],
        {"id": "exp-1", "name": "alpha", "config": {}},
    ]

    def fake_urlopen(req, timeout=20.0):
        return FakeResponse(responses.pop(0))

    with patch("alchemy_sdk.cli.main.urlopen", fake_urlopen):
        code = cli.main(["experiments", "fork-plan", "alpha", "--unset", "  "])
    assert code == 1
    assert "--unset key must be non-empty" in capsys.readouterr().err


def test_experiments_ls_passes_filters_as_query(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "ls", "--family", "alpha", "--decision", "keep", "--status", "passed"],
        [[{"id": "exp-1", "name": "alpha", "status": "passed", "family": "alpha", "decision": "keep"}]],
    )
    assert calls[0]["method"] == "GET"
    # urlencoded params, order from dict insertion.
    assert calls[0]["url"].startswith("http://localhost:3002/api/experiments?")
    assert "family=alpha" in calls[0]["url"]
    assert "decision=keep" in calls[0]["url"]
    assert "status=passed" in calls[0]["url"]


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


def test_experiments_tree_fetches_tree_endpoint(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "tree"],
        [{"roots": []}],
    )

    assert calls == [{
        "method": "GET",
        "url": "http://localhost:3002/api/experiments/tree",
        "body": None,
        "auth": "Bearer secret-token",
        "timeout": 20.0,
    }]


def test_experiments_compare_resolves_names_and_preserves_order(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "compare", "beta", "alpha", "exp-3"],
        [
            [
                {"id": "exp-1", "name": "alpha"},
                {"id": "exp-2", "name": "beta"},
                {"id": "exp-3", "name": "gamma"},
            ],
            {"experiments": []},
        ],
    )

    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == "http://localhost:3002/api/experiments"
    assert calls[1]["method"] == "GET"
    assert calls[1]["url"] == "http://localhost:3002/api/experiments/compare?ids=exp-2%2Cexp-1%2Cexp-3"


def test_experiments_compare_unknown_ref_fails(monkeypatch):
    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")

    def fake_urlopen(req, timeout=20.0):
        assert req.method == "GET"
        return FakeResponse([{"id": "exp-1", "name": "alpha"}])

    with patch("alchemy_sdk.cli.main.urlopen", fake_urlopen):
        code = cli.main(["experiments", "compare", "alpha", "ghost"])

    assert code == 1


def test_experiments_compare_rejects_duplicate_refs(monkeypatch, capsys):
    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")
    # Fail fast before any HTTP traffic — the server would otherwise compare
    # the same experiment against itself.
    called = False

    def fake_urlopen(req, timeout=20.0):
        nonlocal called
        called = True
        return FakeResponse([])

    with patch("alchemy_sdk.cli.main.urlopen", fake_urlopen):
        code = cli.main(["experiments", "compare", "alpha", "alpha"])

    assert code == 1
    assert called is False
    err = capsys.readouterr().err
    assert "duplicate compare refs" in err


def test_experiments_compare_rejects_more_than_six_refs(monkeypatch, capsys):
    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")
    refs = [f"exp-{i}" for i in range(7)]
    with patch("alchemy_sdk.cli.main.urlopen", lambda *a, **k: FakeResponse([])):
        code = cli.main(["experiments", "compare", *refs])
    assert code == 1
    assert "at most 6" in capsys.readouterr().err


def test_experiments_compare_rejects_name_uuid_alias_to_same_id(monkeypatch, capsys):
    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")
    # Two refs that both resolve to exp-1 (name + id of same record). The
    # earlier dedupe pass only checks the literal strings; this case proves
    # the resolved-id check fires too.
    experiments = [{"id": "exp-1", "name": "alpha"}]

    def fake_urlopen(req, timeout=20.0):
        assert req.method == "GET"
        return FakeResponse(experiments)

    with patch("alchemy_sdk.cli.main.urlopen", fake_urlopen):
        code = cli.main(["experiments", "compare", "alpha", "exp-1"])

    assert code == 1
    assert "resolve to the same experiment" in capsys.readouterr().err


def test_experiments_summary_resolves_name(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "summary", "alpha"],
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"id": "exp-1", "metrics": {}},
        ],
    )

    assert calls[1]["method"] == "GET"
    assert calls[1]["url"] == "http://localhost:3002/api/experiments/exp-1/summary"


def test_experiments_diff_fetches_by_id(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "diff", "exp-1"],
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"changes": []},
        ],
    )

    assert calls[1]["method"] == "GET"
    assert calls[1]["url"] == "http://localhost:3002/api/experiments/exp-1/diff"


def test_experiments_manifest_fetches_by_id(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "manifest", "alpha"],
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"manifest_version": 1, "tasks": []},
        ],
    )

    assert calls[1]["method"] == "GET"
    assert calls[1]["url"] == "http://localhost:3002/api/experiments/exp-1/manifest"


def test_experiments_bundle_fetches_research_bundle_endpoint(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "bundle", "alpha"],
        [
            [{"id": "exp-1", "name": "alpha"}],
            {
                "experiment": {"id": "exp-1", "name": "alpha"},
                "summary": {"id": "exp-1"},
                "diff": {"experiment_id": "exp-1"},
                "manifest": {"enabled": False, "content": None, "status": "not_enabled", "error": None},
                "timeline": {"experiment_id": "exp-1", "events": []},
                "decision": {"decision": None, "reason": None, "decided_at": None},
                "artifacts": [],
                "generated_at": "2026-06-02T00:00:00.000Z",
            },
        ],
    )
    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == "http://localhost:3002/api/experiments"
    assert calls[1]["method"] == "GET"
    assert calls[1]["url"] == "http://localhost:3002/api/experiments/exp-1/research-bundle"


def test_experiments_bundle_help_documents_read_only_contract(capsys):
    out = _help_text(["experiments", "bundle", "--help"], capsys)
    assert "read-only" in out.lower() or "Only GET" in out or "only GET" in out
    assert "research-bundle" in out


def test_experiments_help_lists_bundle(capsys):
    out = _help_text(["experiments", "--help"], capsys)
    assert "bundle" in out


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



def _help_text(argv, capsys):
    try:
        cli.main(argv)
    except SystemExit as exc:
        assert exc.code == 0
    return capsys.readouterr().out


def test_experiments_help_surfaces_research_loop_commands(capsys):
    out = _help_text(["experiments", "--help"], capsys)
    assert "fork-plan" in out
    assert "artifact" in out
    assert "checkpoint" in out
    assert "decide" in out
    assert "Actor is derived server-side" in out
    assert "never reschedule tasks" in out


def test_experiments_fork_plan_help_documents_dry_run_contract(capsys):
    out = _help_text(["experiments", "fork-plan", "--help"], capsys)
    assert "dry-run" in out
    assert "Does NOT submit" in out
    assert "Top-level keys only" in out
    assert "--set" in out
    assert "--unset" in out
