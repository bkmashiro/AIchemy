from __future__ import annotations

import json
import shlex
import sqlite3
from pathlib import Path
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


def run_cli_with_exit(monkeypatch, argv, responses):
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
        try:
            code = cli.main(argv)
        except SystemExit as exc:  # pragma: no cover - defensive for odd parser exits
            code = exc.code if isinstance(exc.code, int) else 1
    return code, calls


def run_cli(monkeypatch, argv, responses):
    code, calls = run_cli_with_exit(monkeypatch, argv, responses)
    assert code == 0
    return calls


def test_experiments_scaffold_writes_code_first_experiment_file(tmp_path):
    output = tmp_path / "exp_atari.py"

    code = cli.main([
        "experiments",
        "scaffold",
        "--code-id", "jema.atari.coverage500.v1",
        "--name", "Atari coverage500",
        "--family", "jema-atari",
        "--output", str(output),
    ])

    assert code == 0
    text = output.read_text()
    assert 'Experiment(code_id="jema.atari.coverage500.v1", name="Atari coverage500", family="jema-atari")' in text
    assert "# alchemy-ledger: start" in text
    assert "# alchemy-ledger: end" in text
    assert "exp.task(\"train\", script=\"train.py\")" in text
    assert "if __name__ == \"__main__\":" in text


def test_experiments_scaffold_refuses_to_overwrite_without_force(tmp_path):
    output = tmp_path / "existing.py"
    output.write_text("keep me")

    code = cli.main([
        "experiments", "scaffold",
        "--code-id", "jema.existing.v1",
        "--name", "Existing",
        "--output", str(output),
    ])

    assert code == 1
    assert output.read_text() == "keep me"


def test_experiments_inject_ledger_adds_decision_idempotently(tmp_path):
    output = tmp_path / "exp.py"
    cli.main([
        "experiments", "scaffold",
        "--code-id", "jema.ledger.v1",
        "--name", "Ledger",
        "--output", str(output),
    ])

    args = [
        "experiments", "inject-ledger", str(output),
        "--decision-id", "keep-baseline",
        "--decision", "keep",
        "--reason", "best score",
        "--evidence", "jema.atari.coverage500.v1",
    ]
    assert cli.main(args) == 0
    first = output.read_text()
    assert cli.main(args) == 0
    assert output.read_text() == first
    assert '"id": "keep-baseline"' in first
    assert '"decision": "keep"' in first
    assert '"ref": "jema.atari.coverage500.v1"' in first


def test_experiments_sync_ledger_posts_missing_decision_events(monkeypatch, tmp_path):
    output = tmp_path / "exp.py"
    cli.main(["experiments", "scaffold", "--code-id", "jema.sync.v1", "--name", "Sync", "--output", str(output)])
    cli.main(["experiments", "inject-ledger", str(output), "--decision-id", "keep-baseline", "--decision", "keep", "--reason", "best"])

    calls = run_cli(
        monkeypatch,
        ["experiments", "sync-ledger", str(output), "jema.sync.v1"],
        [
            [{"id": "exp-1", "name": "Sync", "code_id": "jema.sync.v1"}],
            {"events": []},
            {"id": "evt-1", "kind": "decision"},
        ],
    )

    assert calls[1]["method"] == "GET"
    assert calls[1]["url"] == "http://localhost:3002/api/experiments/exp-1/timeline"
    assert calls[2]["method"] == "POST"
    assert calls[2]["url"] == "http://localhost:3002/api/experiments/exp-1/events"
    payload = calls[2]["body"]
    assert payload["kind"] == "decision"
    assert payload["message"] == "keep: best"
    assert payload["data"]["source"] == "code-ledger"
    assert payload["data"]["source_id"] == "keep-baseline"
    assert payload["data"]["decision"] == "keep"
    assert payload["data"]["reason"] == "best"
    assert isinstance(payload["data"]["content_hash"], str)


def test_experiments_sync_ledger_skips_existing_source_ids(monkeypatch, tmp_path):
    output = tmp_path / "exp.py"
    cli.main(["experiments", "scaffold", "--code-id", "jema.sync.v1", "--name", "Sync", "--output", str(output)])
    cli.main(["experiments", "inject-ledger", str(output), "--decision-id", "keep-baseline", "--decision", "keep"])

    calls = run_cli(
        monkeypatch,
        ["experiments", "sync-ledger", str(output), "jema.sync.v1"],
        [
            [{"id": "exp-1", "name": "Sync", "code_id": "jema.sync.v1"}],
            {"events": [{"kind": "decision", "data": {"source": "code-ledger", "source_id": "keep-baseline"}}]},
        ],
    )

    assert len(calls) == 2


def test_experiments_inject_and_sync_ledger_comment(monkeypatch, tmp_path):
    output = tmp_path / "exp.py"
    cli.main(["experiments", "scaffold", "--code-id", "jema.comment.v1", "--name", "Comment", "--output", str(output)])

    code = cli.main([
        "experiments", "inject-ledger", str(output),
        "--comment-id", "freeway-coverage",
        "--comment", "Freeway coverage still zero",
        "--evidence", "task:abc",
    ])

    assert code == 0
    assert "Freeway coverage still zero" in output.read_text()

    calls = run_cli(
        monkeypatch,
        ["experiments", "sync-ledger", str(output), "jema.comment.v1"],
        [
            [{"id": "exp-1", "name": "Comment", "code_id": "jema.comment.v1"}],
            {"events": []},
            {"id": "evt-1", "kind": "note"},
        ],
    )

    payload = calls[2]["body"]
    assert payload["kind"] == "note"
    assert payload["message"] == "Freeway coverage still zero"
    assert payload["data"]["source"] == "code-ledger"
    assert payload["data"]["source_id"] == "freeway-coverage"
    assert payload["data"]["evidence"] == ["task:abc"]
    assert isinstance(payload["data"]["content_hash"], str)


def test_experiments_decide_normalizes_try_more_alias(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "decide", "alpha", "try-more", "needs seeds"],
        [[{"id": "exp-1", "name": "alpha"}], {"id": "exp-1", "decision": "try_more"}],
    )
    assert calls[1]["method"] == "PATCH"
    assert calls[1]["body"] == {"decision": "try_more", "reason": "needs seeds"}


def test_experiments_comment_posts_note_event(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "comment", "alpha", "coverage too low"],
        [[{"id": "exp-1", "name": "alpha"}], {"id": "evt-1", "kind": "note"}],
    )
    assert calls[1]["method"] == "POST"
    assert calls[1]["url"] == "http://localhost:3002/api/experiments/exp-1/events"
    assert calls[1]["body"] == {"kind": "note", "message": "coverage too low"}


def test_experiments_series_decision_posts_series_event(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "series-decision", "world-rule", "try-more", "--reason", "need seeds"],
        [{"created": 2, "events": []}],
    )
    assert calls[0]["method"] == "POST"
    assert calls[0]["url"] == "http://localhost:3002/api/experiments/series/world-rule/events"
    assert calls[0]["body"] == {"kind": "decision", "decision": "try_more", "reason": "need seeds"}


def test_experiments_series_comment_posts_series_event(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "series-comment", "world-rule", "random500 improved Pong"],
        [{"created": 2, "events": []}],
    )
    assert calls[0]["method"] == "POST"
    assert calls[0]["url"] == "http://localhost:3002/api/experiments/series/world-rule/events"
    assert calls[0]["body"] == {"kind": "note", "message": "random500 improved Pong"}


def test_clone_task_body_preserves_structured_argv():
    body = cli.clone_task_body({
        "script": "/workspace/train.py",
        "argv": ["--name", "$(whoami)", "--message", "hello world"],
        "raw_args": None,
    })
    assert body == {
        "script": "/workspace/train.py",
        "argv": ["--name", "$(whoami)", "--message", "hello world"],
    }


def test_webhooks_add_posts_subscription(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["webhooks", "add", "hermes-terminal", "https://hermes.example/webhook/alchemy", "--events", "task.failed,task.completed", "--secret", "shh"],
        [{"id": "sub-1", "name": "hermes-terminal", "url": "https://hermes.example/webhook/alchemy", "events": ["task.failed", "task.completed"], "enabled": True}],
    )

    assert calls[0]["method"] == "POST"
    assert calls[0]["url"] == "http://localhost:3002/api/webhooks"
    assert calls[0]["body"] == {
        "name": "hermes-terminal",
        "url": "https://hermes.example/webhook/alchemy",
        "events": ["task.failed", "task.completed"],
        "enabled": True,
        "secret": "shh",
    }


def test_webhooks_ls_gets_subscriptions(monkeypatch):
    calls = run_cli(monkeypatch, ["webhooks", "ls"], [[{"id": "sub-1", "name": "terminal"}]])
    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == "http://localhost:3002/api/webhooks"


def test_webhooks_delete_deletes_subscription(monkeypatch):
    calls = run_cli(monkeypatch, ["webhooks", "delete", "terminal"], [{"ok": True}])
    assert calls[0]["method"] == "DELETE"
    assert calls[0]["url"] == "http://localhost:3002/api/webhooks/terminal"


def test_webhooks_deliveries_lists_subscription_delivery_history(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["webhooks", "deliveries", "terminal", "--limit", "5"],
        [{"deliveries": [{"id": "delivery-1", "status": "success"}]}],
    )
    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == "http://localhost:3002/api/webhooks/terminal/deliveries?limit=5"


def test_doctor_collects_read_only_health_and_counts(monkeypatch, capsys):
    calls = run_cli(
        monkeypatch,
        ["doctor"],
        [
            {"ok": True, "version": "2.1.0"},
            [
                {"id": "stub-1", "name": "worker-a", "status": "online"},
                {"id": "stub-2", "name": "worker-b", "status": "offline"},
            ],
            {
                "tasks": [
                    {"id": "task-1", "status": "running"},
                    {"id": "task-2", "status": "blocked", "error_message": "Dependency parent-1 failed"},
                    {"id": "task-3", "status": "pending", "target_stub_id": "stub-bad"},
                ]
            },
            {
                "tasks": [
                    {"id": "task-4", "status": "failed", "exit_code": 137, "death_cause": "oom", "error_message": "CUDA out of memory"},
                ]
            },
            [{"id": "sub-1", "enabled": True}],
        ],
    )

    assert [(c["method"], c["url"]) for c in calls] == [
        ("GET", "http://localhost:3002/health"),
        ("GET", "http://localhost:3002/api/stubs"),
        ("GET", "http://localhost:3002/api/tasks?limit=50&logs=false&sort=seq&order=desc&status_group=active"),
        ("GET", "http://localhost:3002/api/tasks?limit=5&logs=false&sort=seq&order=desc&status=failed"),
        ("GET", "http://localhost:3002/api/webhooks"),
    ]
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is True
    assert out["counts"] == {
        "active_tasks": 3,
        "blocked_tasks": 1,
        "enabled_webhooks": 1,
        "online_stubs": 1,
        "running_tasks": 1,
        "webhooks": 1,
    }
    assert out["task_triage"]["counts"] == {
        "active": 3,
        "running": 1,
        "blocked": 1,
        "pending": 1,
        "assigned": 0,
        "paused": 0,
        "failed_recent": 1,
    }


def test_doctor_includes_task_triage_diagnostics(monkeypatch, capsys):
    run_cli(
        monkeypatch,
        ["doctor"],
        [
            {"ok": True},
            [{"id": "stub-1", "status": "online"}],
            {
                "tasks": [
                    {"id": "blocked-1", "status": "blocked", "error_message": "Dependency parent-1 failed"},
                    {"id": "pending-1", "status": "pending", "target_tags": ["a30", "slurm"]},
                ]
            },
            {
                "tasks": [
                    {"id": "fail-oom", "status": "failed", "exit_code": 137, "death_cause": "oom", "error_message": "CUDA out of memory"},
                ]
            },
            [{"id": "sub-1", "enabled": True}],
        ],
    )

    out = json.loads(capsys.readouterr().out)
    assert out["task_triage"]["blocked"][0]["diagnosis"] == {
        "kind": "dependency_failed",
        "detail": "Dependency parent-1 failed",
        "next": "inspect the failed dependency, then resubmit or cancel this blocked task",
    }
    assert out["task_triage"]["pending"][0]["diagnosis"] == {
        "kind": "waiting_for_matching_stub",
        "detail": "target_tags=a30,slurm",
        "next": "start a matching stub or move the task to a live stub",
    }
    assert out["task_triage"]["failed_recent"][0]["diagnosis"] == {
        "kind": "oom",
        "detail": "exit_code=137 death_cause=oom",
        "next": "reduce memory use or resubmit on a larger-memory stub",
    }


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


def test_stubs_exec_posts_exec2_and_prints_output(monkeypatch, capsys):
    code, calls = run_cli_with_exit(
        monkeypatch,
        ["stubs", "exec", "worker-a", "--timeout", "2", "--", "echo", "hello"],
        [
            [{"id": "stub-1", "name": "worker-a", "status": "online"}],
            {"stdout": "stdout\n", "stderr": "stderr\n", "exit_code": 0, "truncated": False},
        ],
    )

    assert code == 0
    assert calls[0] == {
        "method": "GET",
        "url": "http://localhost:3002/api/stubs",
        "body": None,
        "auth": "Bearer secret-token",
        "timeout": 20.0,
    }
    assert calls[1] == {
        "method": "POST",
        "url": "http://localhost:3002/api/stubs/stub-1/exec2",
        "body": {"command": "echo hello", "timeout": 2000},
        "auth": "Bearer secret-token",
        "timeout": 20.0,
    }

    output = capsys.readouterr()
    assert output.out == "stdout\n"
    assert output.err == "stderr\n"


def test_stubs_exec_returns_remote_exit_code(monkeypatch):
    code, calls = run_cli_with_exit(
        monkeypatch,
        ["stubs", "exec", "worker-a", "--timeout", "2", "--", "false"],
        [
            [{"id": "stub-1", "name": "worker-a", "status": "online"}],
            {"stdout": "", "stderr": "", "exit_code": 7, "truncated": False},
        ],
    )

    assert code == 7
    assert calls[1]["body"]["command"] == "false"


def test_stubs_exec_preserves_quoted_command_arguments(monkeypatch):
    code, calls = run_cli_with_exit(
        monkeypatch,
        ["stubs", "exec", "worker-a", "--", "python", "-c", "print('hello world')"],
        [
            [{"id": "stub-1", "name": "worker-a", "status": "online"}],
            {"stdout": "hello world\n", "stderr": "", "exit_code": 0, "truncated": False},
        ],
    )

    assert code == 0
    assert calls[1]["body"]["command"] == shlex.join(["python", "-c", "print('hello world')"])


def test_stubs_exec_preserves_single_shell_command_string(monkeypatch):
    code, calls = run_cli_with_exit(
        monkeypatch,
        ["stubs", "exec", "worker-a", "--", "pwd && hostname"],
        [
            [{"id": "stub-1", "name": "worker-a", "status": "online"}],
            {"stdout": "/work\nnode\n", "stderr": "", "exit_code": 0, "truncated": False},
        ],
    )

    assert code == 0
    assert calls[1]["body"]["command"] == "pwd && hostname"


def test_tasks_top_summarizes_active_and_recent_failed(monkeypatch, capsys):
    calls = run_cli(
        monkeypatch,
        ["tasks", "top", "--limit", "3", "--failed-limit", "2"],
        [
            {"tasks": [
                {"id": "run-1", "seq": 11, "display_name": "train", "status": "running", "stub_name": "a30", "started_at": "2026-06-10T10:00:00Z", "pid": 123, "run_dir": "/runs/train"},
                {"id": "block-1", "seq": 10, "name": "eval", "status": "blocked", "error_message": "Dependency dep-1 failed", "target_stub_id": "stub-a"},
                {"id": "pend-1", "seq": 9, "name": "queued", "status": "pending", "target_tags": ["a30", "slurm"]},
            ]},
            {"tasks": [
                {"id": "fail-1", "seq": 8, "name": "bad", "status": "failed", "exit_code": 137, "death_cause": "oom", "error_message": "CUDA out of memory"},
            ]},
        ],
    )

    assert [(c["method"], c["url"]) for c in calls] == [
        ("GET", "http://localhost:3002/api/tasks?limit=3&logs=false&sort=seq&order=desc&status_group=active"),
        ("GET", "http://localhost:3002/api/tasks?limit=2&logs=false&sort=seq&order=desc&status=failed"),
    ]
    out = json.loads(capsys.readouterr().out)
    assert out["counts"] == {"active": 3, "running": 1, "blocked": 1, "pending": 1, "assigned": 0, "paused": 0, "failed_recent": 1}
    assert out["running"][0] == {
        "seq": 11,
        "id": "run-1",
        "name": "train",
        "status": "running",
        "stub_id": None,
        "stub_name": "a30",
        "started_at": "2026-06-10T10:00:00Z",
        "pid": 123,
        "run_dir": "/runs/train",
        "target": {"target_stub_id": None, "target_tags": None},
        "commands": [
            "alch tasks get run-1",
            "alch tasks logs run-1 --tail 200",
            "ls -la /runs/train",
        ],
    }
    assert out["blocked"][0]["reason"] == "Dependency dep-1 failed"
    assert out["pending"][0]["target"] == {"target_stub_id": None, "target_tags": ["a30", "slurm"]}
    assert out["failed_recent"][0]["failure"] == {"exit_code": 137, "death_cause": "oom", "error_message": "CUDA out of memory"}


def test_tasks_top_adds_actionable_task_diagnostics(monkeypatch, capsys):
    run_cli(
        monkeypatch,
        ["tasks", "top"],
        [
            {"tasks": [
                {"id": "blocked-1", "seq": 3, "name": "blocked", "status": "blocked", "error_message": "Dependency parent-1 failed"},
                {"id": "pending-1", "seq": 2, "name": "pending", "status": "pending", "target_stub_id": "stub-dead"},
            ]},
            {"tasks": [
                {"id": "oom-1", "seq": 1, "name": "oom", "status": "failed", "exit_code": 137, "death_cause": "oom", "error_message": "CUDA out of memory", "run_dir": "/runs/oom"},
            ]},
        ],
    )

    out = json.loads(capsys.readouterr().out)
    assert out["blocked"][0]["diagnosis"] == {
        "kind": "dependency_failed",
        "detail": "Dependency parent-1 failed",
        "next": "inspect the failed dependency, then resubmit or cancel this blocked task",
    }
    assert out["pending"][0]["diagnosis"] == {
        "kind": "waiting_for_target_stub",
        "detail": "target_stub_id=stub-dead",
        "next": "bring that stub online or move the task to a live stub",
    }
    assert out["failed_recent"][0]["diagnosis"] == {
        "kind": "oom",
        "detail": "exit_code=137 death_cause=oom",
        "next": "reduce memory use or resubmit on a larger-memory stub",
    }
    assert out["failed_recent"][0]["commands"] == [
        "alch tasks get oom-1",
        "alch tasks logs oom-1 --tail 200",
        "ls -la /runs/oom",
    ]


def test_tasks_repair_dry_run_emits_compact_recommendations(monkeypatch, capsys):
    calls = run_cli(
        monkeypatch,
        ["tasks", "repair", "--limit", "5"],
        [
            {"tasks": [
                {"id": "blocked-1", "seq": 4, "status": "blocked", "error_message": "Dependency dep-1 failed"},
                {"id": "pending-stub", "seq": 3, "status": "pending", "target_stub_id": "stub-123"},
                {"id": "pending-tags", "seq": 2, "status": "pending", "target_tags": ["a30", "slurm"]},
                {"id": "ok-1", "seq": 1, "status": "running"},
            ]},
        ],
    )

    assert calls == [{
        "method": "GET",
        "url": "http://localhost:3002/api/tasks?limit=5&logs=false&sort=seq&order=desc&status_group=active",
        "body": None,
        "auth": "Bearer secret-token",
        "timeout": 20.0,
    }]

    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is True
    assert out["dry_run"] is True
    assert len(out["recommendations"]) == 3

    by_id = {row["task_id"]: row for row in out["recommendations"]}
    assert by_id["blocked-1"]["action"] == "inspect_dependency"
    assert by_id["blocked-1"]["commands"] == [
        "alch tasks get blocked-1",
        "alch tasks logs blocked-1 --tail 200",
        "alch tasks cancel blocked-1",
        "alch tasks resubmit blocked-1",
    ]

    assert by_id["pending-stub"]["action"] == "move_to_live_stub_or_start_stub"
    assert by_id["pending-stub"]["detail"] == {"target_stub_id": "stub-123"}
    assert by_id["pending-stub"]["commands"] == [
        "alch tasks get pending-stub",
        "alch tasks logs pending-stub --tail 200",
        "alch tasks move pending-stub --to-stub stub-123",
    ]

    assert by_id["pending-tags"]["action"] == "start_matching_stub_or_move"
    assert by_id["pending-tags"]["detail"] == {"target_tags": ["a30", "slurm"]}
    assert by_id["pending-tags"]["commands"][2] == "alch tasks move pending-tags --to-tags a30,slurm"


def test_tasks_repair_no_mutations(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["tasks", "repair"],
        [{"tasks": []}],
    )

    assert [call["method"] for call in calls] == ["GET"]


def test_tasks_inbox_json_uses_actor_limit_bucket_and_prints_json(monkeypatch, capsys):
    payload = {
        "actor": "akashi",
        "generated_at": "2026-06-14T00:00:00Z",
        "summary": {"unread_terminal": 1},
        "items": [
            {
                "seq": 7,
                "status": "completed",
                "buckets": ["unread_terminal"],
                "name": "train",
                "task_id": "task-1",
                "suggested_next_action": "Read task result",
            }
        ],
    }
    calls = run_cli(
        monkeypatch,
        ["tasks", "inbox", "--json", "--actor", "akashi", "--limit", "10", "--bucket", "unread_terminal"],
        [payload],
    )

    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == "http://localhost:3002/api/tasks/inbox?actor=akashi&limit=10&bucket=unread_terminal"
    out = json.loads(capsys.readouterr().out)
    assert out == payload


def test_tasks_mark_read_posts_actor_payload(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["tasks", "mark-read", "task-1", "--actor", "akashi"],
        [{"ok": True, "task_id": "task-1"}],
    )

    assert calls[0]["method"] == "POST"
    assert calls[0]["url"] == "http://localhost:3002/api/tasks/task-1/read"
    assert calls[0]["body"] == {"actor": "akashi"}


def test_tasks_pin_posts_note_and_pinned_true(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["tasks", "pin", "task-1", "--actor", "akashi", "--note", "important"],
        [{"ok": True, "task_id": "task-1", "pinned": True, "note": "important"}],
    )

    assert calls[0]["method"] == "POST"
    assert calls[0]["url"] == "http://localhost:3002/api/tasks/task-1/pin"
    assert calls[0]["body"] == {"actor": "akashi", "pinned": True, "note": "important"}


def test_tasks_unwatch_posts_unwatch_payload(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["tasks", "unwatch", "task-1", "--actor", "akashi"],
        [{"ok": True, "task_id": "task-1", "watched": False}],
    )

    assert calls[0]["method"] == "POST"
    assert calls[0]["url"] == "http://localhost:3002/api/tasks/task-1/watch"
    assert calls[0]["body"] == {"actor": "akashi", "watched": False}


def test_tasks_resubmit_clone_preserves_run_dir_and_targets_tags(monkeypatch):
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


def test_tasks_wait_completed_returns_zero(monkeypatch, capsys):
    code, calls = run_cli_with_exit(
        monkeypatch,
        ["tasks", "wait", "task-1", "--interval", "0", "--timeout", "5"],
        [
            {"id": "task-1", "status": "running", "seq": 1},
            {"id": "task-1", "status": "completed", "seq": 1},
        ],
    )

    assert code == 0
    assert [c["url"] for c in calls] == [
        "http://localhost:3002/api/tasks/task-1",
        "http://localhost:3002/api/tasks/task-1",
    ]
    assert json.loads(capsys.readouterr().out)["status"] == "completed"


def test_tasks_wait_failed_returns_one(monkeypatch, capsys):
    code, _calls = run_cli_with_exit(
        monkeypatch,
        ["tasks", "wait", "task-1", "--interval", "0", "--timeout", "5"],
        [
            {"id": "task-1", "status": "assigned", "seq": 1},
            {"id": "task-1", "status": "failed", "seq": 1, "exit_code": 2},
        ],
    )

    assert code == 1
    assert json.loads(capsys.readouterr().out)["status"] == "failed"


def test_tasks_wait_timeout_returns_124(monkeypatch, capsys):
    ticks = iter([0.0, 2.0])
    monkeypatch.setattr(cli.time, "monotonic", lambda: next(ticks))
    monkeypatch.setattr(cli.time, "sleep", lambda _seconds: None)

    code, calls = run_cli_with_exit(
        monkeypatch,
        ["tasks", "wait", "task-1", "--interval", "0", "--timeout", "1"],
        [{"id": "task-1", "status": "running", "seq": 1}],
    )

    assert code == 124
    assert len(calls) == 1
    err = capsys.readouterr().err
    assert "timed out waiting for task task-1" in err


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
            "body": {"server_url": "http://localhost:3002", "token": "secret-token"},
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


def test_experiments_show_resolves_code_id_then_fetches_detail(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "show", "jema.atari.coverage500.v1"],
        [
            [
                {"id": "exp-1", "name": "alpha", "code_id": "jema.atari.coverage500.v1"},
                {"id": "exp-2", "name": "beta", "code_id": "jema.atari.other.v1"},
            ],
            {"id": "exp-1", "name": "alpha", "code_id": "jema.atari.coverage500.v1", "status": "running", "tasks": []},
        ],
    )

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


def test_experiments_adopt_posts_existing_tasks_when_confirmed(monkeypatch):
    calls = run_cli(
        monkeypatch,
        [
            "experiments", "adopt", "--name", "retro", "--task", "task-1", "--task", "task-2",
            "--family", "nh", "--goal-metric", "score", "--goal-direction", "max",
            "--criteria", '{"score": "> 0"}', "--config", '{"seed": 42}', "--yes",
        ],
        [{"id": "exp-1", "name": "retro"}],
    )

    assert calls[0]["method"] == "POST"
    assert calls[0]["url"] == "http://localhost:3002/api/experiments/adopt"
    assert calls[0]["body"] == {
        "name": "retro",
        "task_ids": ["task-1", "task-2"],
        "family": "nh",
        "goal_metric": "score",
        "goal_direction": "max",
        "criteria": {"score": "> 0"},
        "config": {"seed": 42},
    }


def test_experiments_adopt_dry_run_does_not_post(monkeypatch, capsys):
    calls = run_cli(
        monkeypatch,
        ["experiments", "adopt", "--name", "retro", "--task", "task-1"],
        [],
    )

    assert calls == []
    out = json.loads(capsys.readouterr().out)
    assert out["dry_run"] is True
    assert out["method"] == "POST"
    assert out["path"] == "/experiments/adopt"


def test_experiments_adopt_task_dry_run_resolves_but_does_not_post(monkeypatch, capsys):
    calls = run_cli(
        monkeypatch,
        ["experiments", "adopt-task", "retro", "--task", "task-1"],
        [[{"id": "exp-1", "name": "retro"}]],
    )

    assert [c["method"] for c in calls] == ["GET"]
    out = json.loads(capsys.readouterr().out)
    assert out["dry_run"] is True
    assert out["method"] == "POST"
    assert out["path"] == "/experiments/exp-1/tasks/adopt"


def test_experiments_patch_dry_run_resolves_but_does_not_patch(monkeypatch, capsys):
    calls = run_cli(
        monkeypatch,
        ["experiments", "patch", "retro", "--family", "nh"],
        [[{"id": "exp-1", "name": "retro"}]],
    )

    assert [c["method"] for c in calls] == ["GET"]
    out = json.loads(capsys.readouterr().out)
    assert out["dry_run"] is True
    assert out["method"] == "PATCH"
    assert out["path"] == "/experiments/exp-1"


def test_experiments_adopt_task_resolves_and_posts_move(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "adopt-task", "retro", "--task", "task-1", "--mode", "move", "--yes"],
        [
            [{"id": "exp-1", "name": "retro"}],
            {"ok": True},
        ],
    )

    assert calls[0]["url"] == "http://localhost:3002/api/experiments"
    assert calls[1]["method"] == "POST"
    assert calls[1]["url"] == "http://localhost:3002/api/experiments/exp-1/tasks/adopt"
    assert calls[1]["body"] == {"task_ids": ["task-1"], "mode": "move"}


def test_experiments_patch_updates_metadata(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "patch", "retro", "--family", "nh", "--goal-direction", "min", "--yes"],
        [
            [{"id": "exp-1", "name": "retro"}],
            {"id": "exp-1", "family": "nh"},
        ],
    )

    assert calls[1]["method"] == "PATCH"
    assert calls[1]["url"] == "http://localhost:3002/api/experiments/exp-1"
    assert calls[1]["body"] == {"family": "nh", "goal_direction": "min"}


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
            {"id": "exp-1", "decision": "try_more", "decision_reason": "needs ablation"},
        ],
    )

    assert calls[1]["method"] == "PATCH"
    assert calls[1]["url"] == "http://localhost:3002/api/experiments/exp-1/decision"
    assert calls[1]["body"] == {"decision": "try_more", "reason": "needs ablation"}


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


def test_experiments_recommend_prints_recommendation(monkeypatch, capsys):
    calls = run_cli(
        monkeypatch,
        ["experiments", "recommend", "alpha"],
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"best": "run"},
        ],
    )

    assert calls[1]["method"] == "GET"
    assert calls[1]["url"] == "http://localhost:3002/api/experiments/exp-1/recommendation"
    assert json.loads(capsys.readouterr().out) == {"best": "run"}


def test_experiments_recommend_falls_back_to_summary_if_recommendation_missing(monkeypatch, capsys):
    import io
    from urllib.error import HTTPError

    calls: list[dict] = []

    def fake_urlopen(req, timeout=20.0):
        calls.append({"method": req.method, "url": req.full_url})
        if req.full_url == "http://localhost:3002/api/experiments":
            return FakeResponse([{"id": "exp-1", "name": "alpha"}])
        if req.full_url == "http://localhost:3002/api/experiments/exp-1/recommendation":
            raise HTTPError(
                req.full_url,
                404,
                "Not Found",
                hdrs=None,  # type: ignore[arg-type]
                fp=io.BytesIO(b'{"error":"not implemented"}'),
            )
        if req.full_url == "http://localhost:3002/api/experiments/exp-1/summary":
            return FakeResponse({"recommendation": {"best": "run"}, "id": "exp-1"})
        raise AssertionError(f"unexpected request {req.method} {req.full_url}")

    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")
    with patch("alchemy_sdk.cli.main.urlopen", fake_urlopen):
        code = cli.main(["experiments", "recommend", "alpha"])

    assert code == 0
    assert ["http://localhost:3002/api/experiments", "http://localhost:3002/api/experiments/exp-1/recommendation", "http://localhost:3002/api/experiments/exp-1/summary"] == [
        c["url"] for c in calls
    ]
    assert json.loads(capsys.readouterr().out) == {"best": "run"}


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



def test_experiments_bundle_markdown_prints_markdown(monkeypatch, capsys):
    payload = {
        "experiment": {
            "id": "exp-1",
            "name": "alpha",
            "family": "rl",
            "status": "passed",
        },
        "summary": {
            "recommendation": {
                "evidence_quality": "high",
                "evidence_reason": "strong holdout",
                "sample_count": 120,
                "comparable_count": 10,
                "baseline_source": "leaderboard-v2",
            },
            "best_metrics": {"return": 1.23},
            "validation": {"dataset": "held-out", "coverage": "complete"},
            "primary_metric": {"name": "return", "value": 1.23},
        },
        "diff": {
            "config_diff_summary": {
                "learning_rate": {"before": 0.001, "after": 0.002, "op": "set"}
            }
        },
        "manifest": {"enabled": True},
        "timeline": {
            "events": [
                {
                    "kind": "decision",
                    "created_at": "2026-06-02T12:00:00Z",
                    "message": "kept",
                }
            ]
        },
        "decision": {
            "decision": "keep",
            "reason": "best-of-family",
            "decided_at": "2026-06-02T11:00:00Z",
        },
        "artifacts": [
            {
                "kind": "artifact",
                "data": {
                    "name": "best",
                    "uri": "s3://bucket/alpha.ckpt",
                    "step": 10,
                },
            }
        ],
        "generated_at": "2026-06-02T12:34:56Z",
    }
    calls = run_cli(
        monkeypatch,
        ["experiments", "bundle", "alpha", "--format", "markdown"],
        [
            [{"id": "exp-1", "name": "alpha"}],
            payload,
        ],
    )

    assert len(calls) == 2
    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == "http://localhost:3002/api/experiments"
    assert calls[1]["method"] == "GET"
    assert calls[1]["url"] == "http://localhost:3002/api/experiments/exp-1/research-bundle"

    out = capsys.readouterr().out
    assert out.startswith("# Research Bundle:")
    assert "## Decision" in out
    assert "## Recommendation" in out
    assert "baseline_source" in out
    assert "alpha" in out


def test_experiments_bundle_default_format_remains_json(monkeypatch, capsys):
    payload = {
        "experiment": {"id": "exp-1", "name": "alpha"},
        "summary": {},
        "diff": {},
        "manifest": {},
        "timeline": {},
        "decision": {"decision": None, "reason": None},
        "artifacts": [],
        "generated_at": "2026-06-02T12:34:56Z",
    }
    run_cli(
        monkeypatch,
        ["experiments", "bundle", "alpha"],
        [[{"id": "exp-1", "name": "alpha"}], payload],
    )
    out = capsys.readouterr().out
    assert out.lstrip().startswith("{")
    parsed = json.loads(out)
    assert parsed == payload
    assert "# Research Bundle:" not in out


def test_experiments_bundle_output_writes_markdown_to_file(monkeypatch, tmp_path, capsys):
    payload = {
        "experiment": {"id": "exp-1", "name": "alpha"},
        "summary": {"recommendation": {}},
        "diff": {},
        "manifest": {},
        "timeline": {"events": []},
        "decision": {"decision": "keep", "reason": "good"},
        "artifacts": [],
        "generated_at": "2026-06-02T12:34:56Z",
    }
    out_path = tmp_path / "bundle.md"
    run_cli(
        monkeypatch,
        [
            "experiments",
            "bundle",
            "alpha",
            "--format",
            "markdown",
            "--output",
            str(out_path),
        ],
        [[{"id": "exp-1", "name": "alpha"}], payload],
    )
    captured = capsys.readouterr()
    assert captured.out == ""
    assert str(out_path) in captured.err
    contents = out_path.read_text(encoding="utf-8")
    assert contents.startswith("# Research Bundle:")
    assert contents.endswith("\n")


def test_experiments_report_sends_get_with_filters(monkeypatch):
    payload = {
        "filters": {"family": "alpha", "decision": "none", "status": None, "limit": 10},
        "counts": {"total": 0, "by_status": {}, "by_decision": {}},
        "metric": None,
        "leaderboard": [],
        "experiments": [],
        "generated_at": "2026-06-02T00:00:00.000Z",
    }
    calls = run_cli(
        monkeypatch,
        ["experiments", "report", "--family", "alpha", "--decision", "none", "--limit", "10"],
        [payload],
    )
    assert len(calls) == 1
    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == (
        "http://localhost:3002/api/experiments/research-report"
        "?family=alpha&decision=none&limit=10"
    )
    assert calls[0]["body"] is None


def test_experiments_report_with_no_filters_hits_bare_endpoint(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["experiments", "report"],
        [{"experiments": []}],
    )
    assert calls[0]["url"] == "http://localhost:3002/api/experiments/research-report"


def test_experiments_report_markdown_format_prints_markdown(monkeypatch, capsys):
    payload = {
        "filters": {"family": "alpha", "decision": None, "status": None, "limit": 50},
        "generated_at": "2026-06-02T00:00:00.000Z",
        "counts": {
            "total": 1,
            "by_status": {"running": 1},
            "by_decision": {"keep": 1},
        },
        "metric": {"name": "loss", "direction": "min"},
        "leaderboard": [
            {
                "rank": 1,
                "id": "exp-1",
                "name": "rep-alpha-1",
                "status": "running",
                "decision": "keep",
                "value": 0.123,
                "metric": "loss",
            }
        ],
        "experiments": [
            {
                "id": "exp-1",
                "name": "rep-alpha-1",
                "family": "alpha",
                "status": "running",
                "decision": "keep",
                "task_counts": {"running": 1},
                "primary_metric": {"name": "loss", "value": 0.123},
                "artifact_count": 0,
                "checkpoint_count": 0,
                "recent_events": [],
            }
        ],
    }
    calls = run_cli(
        monkeypatch,
        ["experiments", "report", "--family", "alpha", "--format", "markdown"],
        [payload],
    )
    assert len(calls) == 1
    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == (
        "http://localhost:3002/api/experiments/research-report?family=alpha"
    )
    out = capsys.readouterr().out
    # Markdown, not JSON.
    assert out.startswith("# Experiment Research Report")
    assert '"filters"' not in out
    assert "## Leaderboard" in out
    assert "rep-alpha-1" in out
    assert "loss" in out


def test_experiments_report_default_format_remains_json(monkeypatch, capsys):
    payload = {
        "filters": {"family": None, "decision": None, "status": None, "limit": 50},
        "counts": {"total": 0, "by_status": {}, "by_decision": {}},
        "metric": None,
        "leaderboard": [],
        "experiments": [],
        "generated_at": "2026-06-02T00:00:00.000Z",
    }
    run_cli(monkeypatch, ["experiments", "report"], [payload])
    out = capsys.readouterr().out
    # JSON output starts with `{` and is sorted/indented.
    assert out.lstrip().startswith("{")
    parsed = json.loads(out)
    assert parsed == payload
    assert "# Experiment Research Report" not in out


def test_experiments_report_invalid_format_rejected(monkeypatch, capsys):
    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")
    try:
        cli.main(["experiments", "report", "--format", "yaml"])
    except SystemExit as exc:
        assert exc.code != 0
    else:
        raise AssertionError("argparse should have rejected --format yaml")
    err = capsys.readouterr().err
    assert "--format" in err or "invalid choice" in err


def test_experiments_report_output_writes_markdown_to_file(monkeypatch, tmp_path, capsys):
    payload = {
        "filters": {"family": None, "decision": None, "status": None, "limit": 50},
        "counts": {"total": 0, "by_status": {}, "by_decision": {}},
        "metric": None,
        "leaderboard": [],
        "experiments": [],
        "generated_at": "2026-06-02T00:00:00.000Z",
    }
    out_path = tmp_path / "report.md"
    run_cli(
        monkeypatch,
        ["experiments", "report", "--format", "markdown", "--output", str(out_path)],
        [payload],
    )
    captured = capsys.readouterr()
    # Markdown is written to the file, not stdout. Stdout stays empty;
    # confirmation goes to stderr.
    assert captured.out == ""
    assert str(out_path) in captured.err
    contents = out_path.read_text(encoding="utf-8")
    assert contents.startswith("# Experiment Research Report")
    assert contents.endswith("\n")


def test_experiments_report_output_writes_json_when_default_format(monkeypatch, tmp_path):
    payload = {
        "filters": {"family": None, "decision": None, "status": None, "limit": 50},
        "counts": {"total": 0, "by_status": {}, "by_decision": {}},
        "metric": None,
        "leaderboard": [],
        "experiments": [],
        "generated_at": "2026-06-02T00:00:00.000Z",
    }
    out_path = tmp_path / "report.json"
    run_cli(
        monkeypatch,
        ["experiments", "report", "--output", str(out_path)],
        [payload],
    )
    parsed = json.loads(out_path.read_text(encoding="utf-8"))
    assert parsed == payload


def test_experiments_report_help_documents_read_only_contract(capsys):
    out = _help_text(["experiments", "report", "--help"], capsys)
    assert "read-only" in out.lower()
    assert "research-report" in out


def test_experiments_help_lists_report(capsys):
    out = _help_text(["experiments", "--help"], capsys)
    assert "report" in out
    assert "recommend" in out


def test_config_set_persists_state_and_default_client_uses_it(monkeypatch, tmp_path):
    config_path = tmp_path / "alch-config.json"
    state_db = tmp_path / "state.db"
    con = sqlite3.connect(state_db)
    con.execute("create table tokens (token text)")
    con.execute("insert into tokens values ('state-token')")
    con.commit()
    con.close()
    monkeypatch.delenv("ALCHEMY_TOKEN", raising=False)
    monkeypatch.setenv("ALCHEMY_CLI_CONFIG", str(config_path))

    assert cli.main(["config", "set", "--server", "http://alchemy.local", "--state-db", str(state_db)]) == 0

    calls = []
    def fake_urlopen(req, timeout=20.0):
        calls.append({"url": req.full_url, "auth": req.headers.get("Authorization")})
        return FakeResponse([])

    with patch("alchemy_sdk.cli.main.urlopen", fake_urlopen):
        assert cli.main(["stubs", "ls"]) == 0

    assert json.loads(config_path.read_text())["state_db"] == str(state_db)
    assert calls == [{"url": "http://alchemy.local/api/stubs", "auth": "Bearer state-token"}]


def test_tasks_logs_reads_task_log_buffer(monkeypatch, capsys):
    calls = run_cli(
        monkeypatch,
        ["tasks", "logs", "task-1", "--tail", "2"],
        [{"id": "task-1", "log_buffer": ["a", "b", "c"]}],
    )
    assert calls[0]["url"] == "http://localhost:3002/api/tasks/task-1"
    assert capsys.readouterr().out == "b\nc\n"


def test_tasks_metrics_reads_task_metric_buffers(monkeypatch, capsys):
    run_cli(
        monkeypatch,
        ["tasks", "metrics", "task-1"],
        [{"id": "task-1", "metrics_buffer": [{"step": 1, "loss": 0.5}], "metrics": {"loss": 0.5}}],
    )
    out = json.loads(capsys.readouterr().out)
    assert out == {"metrics": {"loss": 0.5}, "metrics_buffer": [{"step": 1, "loss": 0.5}]}


def test_stubs_canary_posts_deploy_with_connection_body(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["stubs", "canary", "a30", "--mem", "40G", "--idle-timeout", "600", "--stub-server-url", "https://alchemy-v2.yuzhes.com", "--yes"],
        [{"ok": True, "job_id": "247"}],
    )
    assert calls[0]["method"] == "POST"
    assert calls[0]["url"] == "http://localhost:3002/api/deploy/stubs/slurm-a30"
    assert calls[0]["body"]["server_url"] == "https://alchemy-v2.yuzhes.com"
    assert calls[0]["body"]["token"] == "secret-token"
    assert calls[0]["body"]["mem"] == "40G"
    assert calls[0]["body"]["idle_timeout"] == 600


def test_slurm_submit_posts_idle_timeout_override(monkeypatch):
    calls = run_cli(
        monkeypatch,
        ["slurm", "submit", "a30", "--idle-timeout", "600", "--yes"],
        [{"ok": True, "job_id": "248"}],
    )
    assert calls[0]["method"] == "POST"
    assert calls[0]["url"] == "http://localhost:3002/api/deploy/stubs/slurm-a30/restart"
    assert calls[0]["body"]["idle_timeout"] == 600


def test_slurm_submit_posts_default_output_dir_override(monkeypatch):
    calls = run_cli(
        monkeypatch,
        [
            "slurm", "submit", "a30",
            "--default-output-dir", "/vol/gpudata/ys25-MySpace/alchemy-runs",
            "--yes",
        ],
        [{"ok": True, "job_id": "249"}],
    )
    assert calls[0]["method"] == "POST"
    assert calls[0]["url"] == "http://localhost:3002/api/deploy/stubs/slurm-a30/restart"
    assert calls[0]["body"]["default_output_dir"] == "/vol/gpudata/ys25-MySpace/alchemy-runs"


def test_tasks_lost_filters_terminal_pretrain_without_active_successor(monkeypatch, capsys):
    failed = {
        "id": "old-1", "seq": 1, "status": "failed", "script": "/repo/scripts/train_pretrain_nethack.py",
        "raw_args": "--config configs/a.yaml --seed 42 --policy twostage", "name": "old",
    }
    active_successor = {
        "id": "new-1", "seq": 2, "status": "running", "script": failed["script"],
        "raw_args": failed["raw_args"] + " --resume", "name": "old_resume",
    }
    orphan = {
        "id": "old-2", "seq": 3, "status": "cancelled", "script": "/repo/scripts/train_pretrain_nethack.py",
        "raw_args": "--config configs/b.yaml --seed 7", "name": "orphan",
    }
    run_cli(
        monkeypatch,
        ["tasks", "lost", "--kind", "nethack-pretrain"],
        [
            {"tasks": [failed, orphan]},
            {"tasks": [active_successor]},
        ],
    )
    out = json.loads(capsys.readouterr().out)
    assert [row["id"] for row in out] == ["old-2"]


def test_tasks_resume_lost_dry_run_does_not_post(monkeypatch, capsys):
    orphan = {
        "id": "old-2", "seq": 3, "status": "failed", "script": "/repo/scripts/train_pretrain_nethack.py",
        "raw_args": "--config configs/b.yaml --seed 7", "name": "orphan", "cwd": "/repo", "run_dir": "/repo/runs/x",
    }
    calls = run_cli(
        monkeypatch,
        ["tasks", "resume-lost", "--kind", "nethack-pretrain", "--to-stub", "stub-a", "--dry-run"],
        [
            {"tasks": [orphan]},
            {"tasks": []},
            [{"id": "stub-1", "name": "stub-a", "status": "online"}],
        ],
    )
    assert [c["method"] for c in calls] == ["GET", "GET", "GET"]
    planned = json.loads(capsys.readouterr().out)
    assert planned[0]["body"]["target_stub_id"] == "stub-1"
    assert planned[0]["body"]["raw_args"].endswith("--resume")
    assert "run_dir" not in planned[0]["body"]


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
    assert "replication-plan" in out
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


def test_experiments_replication_plan_returns_manifest_without_posting(monkeypatch, capsys):
    calls = run_cli(
        monkeypatch,
        [
            "experiments", "replication-plan", "alpha",
            "--set", "lr=0.0003",
            "--set", "use_curiosity=true",
            "--unset", "warmup",
            "--reason", "replicate this branch",
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
    assert manifest["kind"] == "replication-plan"
    assert manifest["dry_run"] is True
    assert manifest["parent"]["name"] == "alpha"
    assert manifest["suggested_name"] == "alpha-replication"
    assert manifest["reason"] == "replicate this branch"
    assert manifest["parent_config"] == {"lr": 0.001, "warmup": 100, "seed": 7}
    assert manifest["proposed_config"] == {"lr": 0.0003, "seed": 7, "use_curiosity": True}
    assert manifest["config_diff"]["lr"] == {"before": 0.001, "after": 0.0003, "op": "set"}
    assert manifest["config_diff"]["use_curiosity"] == {"before": None, "after": True, "op": "add"}
    assert manifest["config_diff"]["warmup"] == {"before": 100, "after": None, "op": "unset"}


def test_experiments_replication_plan_rejects_dotted_keys(monkeypatch, capsys):
    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")

    responses = [
        [{"id": "exp-1", "name": "alpha"}],
        {"id": "exp-1", "name": "alpha", "config": {}},
    ]

    def fake_urlopen(req, timeout=20.0):
        return FakeResponse(responses.pop(0))

    with patch("alchemy_sdk.cli.main.urlopen", fake_urlopen):
        code = cli.main([
            "experiments", "replication-plan", "alpha",
            "--set", "model.lr=0.1",
        ])
    assert code == 1
    err = capsys.readouterr().err
    assert "nested keys" in err


def test_experiments_replication_plan_help_documents_dry_run_contract(capsys):
    out = _help_text(["experiments", "replication-plan", "--help"], capsys)
    assert "dry-run" in out
    assert "Does NOT submit" in out
    assert "--set" in out
    assert "--unset" in out
