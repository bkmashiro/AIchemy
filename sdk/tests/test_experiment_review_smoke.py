"""End-to-end smoke test for the experiment review workflow.

Exercises the full local loop a researcher walks through:

    1. ``ExperimentClient.research_report(...)`` — family rollup
    2. ``ExperimentClient.research_report_markdown(...)`` — same payload, rendered
    3. ``alch experiments report --format markdown`` — same payload, CLI rendered
    4. ``ExperimentClient.research_bundle(<ref>)`` — selected run export
    5. ``alch experiments bundle <ref>`` — same via CLI
    6. ``ExperimentClient.fork_plan(<ref>, ...)`` — local dry-run
    7. ``alch experiments fork-plan <ref> --reason ...`` — same via CLI

All requests are intercepted by a single fake ``urlopen``. No network, no
filesystem state, no live server. The point is to prove the contract
between server payload shape, client request sequence, and CLI output
stays intact when any of those three pieces change.
"""
from __future__ import annotations

import json
from unittest.mock import patch

from alchemy_sdk.cli import main as cli
from alchemy_sdk.experiments import (
    ExperimentClient,
    render_research_report_markdown,
)


class _FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


def _make_urlopen(queue, calls):
    """Pop from ``queue`` and record every (method, url, body) it sees."""
    def fake(req, timeout=20.0):
        body = req.data.decode("utf-8") if req.data else None
        calls.append(
            {
                "method": req.method,
                "url": req.full_url,
                "body": json.loads(body) if body else None,
                "auth": req.headers.get("Authorization"),
            }
        )
        assert queue, f"unexpected request {req.method} {req.full_url}"
        return _FakeResponse(queue.pop(0))

    return fake


# ───────────────── Fixture payloads ─────────────────

EXPERIMENTS_LIST = [
    {"id": "exp-1", "name": "rep-alpha-1", "family": "alpha"},
    {"id": "exp-2", "name": "rep-alpha-2", "family": "alpha"},
    {"id": "exp-3", "name": "rep-beta-1", "family": "beta"},
]

REPORT_PAYLOAD = {
    "filters": {"family": "alpha", "decision": None, "status": None, "limit": 50},
    "generated_at": "2026-06-02T00:00:00.000Z",
    "counts": {
        "total": 2,
        "by_status": {"running": 1, "passed": 1},
        "by_decision": {"keep": 1, "none": 1},
    },
    "metric": {"name": "loss", "direction": "min"},
    "leaderboard": [
        {
            "rank": 1,
            "id": "exp-1",
            "name": "rep-alpha-1",
            "status": "passed",
            "decision": "keep",
            "value": 0.123,
            "metric": "loss",
        },
        {
            "rank": 2,
            "id": "exp-2",
            "name": "rep-alpha-2",
            "status": "running",
            "decision": None,
            "value": 0.420,
            "metric": "loss",
        },
    ],
    "experiments": [
        {
            "id": "exp-1",
            "name": "rep-alpha-1",
            "family": "alpha",
            "status": "passed",
            "decision": "keep",
            "decision_reason": "best so far",
            "decision_at": "2026-06-01T00:00:00.000Z",
            "created_at": "2026-05-30T00:00:00.000Z",
            "parent_id": None,
            "children": [],
            "task_counts": {"completed": 1},
            "primary_metric": {"metric": "loss", "direction": "min", "best": 0.123},
            "artifact_count": 1,
            "checkpoint_count": 0,
            "recent_events": [
                {"kind": "decision", "message": "Marked keep", "created_at": "2026-06-01T00:00:00Z"},
            ],
        },
        {
            "id": "exp-2",
            "name": "rep-alpha-2",
            "family": "alpha",
            "status": "running",
            "decision": None,
            "decision_reason": None,
            "decision_at": None,
            "created_at": "2026-05-31T00:00:00.000Z",
            "parent_id": None,
            "children": [],
            "task_counts": {"running": 1},
            "primary_metric": {"metric": "loss", "direction": "min", "best": 0.420},
            "artifact_count": 0,
            "checkpoint_count": 0,
            "recent_events": [],
        },
    ],
}

BUNDLE_PAYLOAD = {
    "experiment": {"id": "exp-1", "name": "rep-alpha-1", "family": "alpha"},
    "summary": {"id": "exp-1", "name": "rep-alpha-1"},
    "diff": {"experiment_id": "exp-1"},
    "manifest": {"enabled": False, "content": None, "status": "not_enabled", "error": None},
    "timeline": {"experiment_id": "exp-1", "events": []},
    "decision": {"decision": "keep", "reason": "best so far", "decided_at": "2026-06-01T00:00:00Z"},
    "artifacts": [],
    "generated_at": "2026-06-02T00:00:00.000Z",
}

DETAIL_PAYLOAD = {
    "id": "exp-1",
    "name": "rep-alpha-1",
    "family": "alpha",
    "config": {"lr": 0.001, "warmup": 100, "model": "tiny"},
}


# ───────────────── Test ─────────────────


def test_experiment_review_smoke_full_loop(monkeypatch, capsys, tmp_path):
    """Walk the whole review loop through both client + CLI surfaces.

    The single queue below pins the expected request sequence end-to-end —
    if any step calls the server out of order or skips a step, the next
    response will be consumed by the wrong call and assertions fail loudly.
    """
    # Client reads ALCHEMY_SERVER; CLI reads ALCHEMY_SERVER_URL. Point both at
    # the same fake host so the request-sequence assertion below compares
    # apples to apples instead of mixing localhost defaults with the explicit
    # server URL.
    monkeypatch.setenv("ALCHEMY_TOKEN", "dummy-review-token")
    monkeypatch.setenv("ALCHEMY_SERVER", "http://server")
    monkeypatch.setenv("ALCHEMY_SERVER_URL", "http://server")

    calls: list[dict] = []
    queue: list = [
        # 1. client.research_report(family="alpha")  → one GET
        REPORT_PAYLOAD,
        # 2. client.research_report_markdown(family="alpha")  → one GET (no caching)
        REPORT_PAYLOAD,
        # 3. CLI: alch experiments report --family alpha --format markdown
        REPORT_PAYLOAD,
        # 4. client.research_bundle("rep-alpha-1")  → list, then bundle
        EXPERIMENTS_LIST,
        BUNDLE_PAYLOAD,
        # 5. CLI: alch experiments bundle rep-alpha-1  → list, then bundle
        EXPERIMENTS_LIST,
        BUNDLE_PAYLOAD,
        # 6. client.fork_plan("rep-alpha-1", ...)  → list, then detail
        EXPERIMENTS_LIST,
        DETAIL_PAYLOAD,
        # 7. CLI: alch experiments fork-plan rep-alpha-1 ...  → list, then detail
        EXPERIMENTS_LIST,
        DETAIL_PAYLOAD,
    ]

    # Each surface (client vs CLI) patches a different urlopen import. Patch
    # both with the same fake so they share the same queue and call log —
    # that's what proves the end-to-end ordering, not just per-surface
    # ordering.
    client_urlopen = _make_urlopen(queue, calls)
    with patch("alchemy_sdk.experiments.urlopen", client_urlopen), \
         patch("alchemy_sdk.cli.main.urlopen", client_urlopen):

        client = ExperimentClient(server="http://server")

        # 1. JSON report
        report = client.research_report(family="alpha")
        assert report == REPORT_PAYLOAD
        assert report["counts"]["total"] == 2
        assert report["metric"] == {"name": "loss", "direction": "min"}
        assert [row["rank"] for row in report["leaderboard"]] == [1, 2]

        # 2. Local markdown render via the convenience wrapper
        md_via_client = client.research_report_markdown(family="alpha")
        assert md_via_client.startswith("# Experiment Research Report")
        assert "## Leaderboard" in md_via_client
        assert "rep-alpha-1" in md_via_client
        assert "loss" in md_via_client
        assert "loss=0.123" in md_via_client
        # The render is pure — calling it directly on the payload should
        # produce byte-identical output to the wrapper's render.
        assert md_via_client == render_research_report_markdown(REPORT_PAYLOAD)

        # 3. CLI markdown (writes to a file so stdout stays clean)
        md_out = tmp_path / "alpha-report.md"
        code = cli.main(
            [
                "experiments",
                "report",
                "--family",
                "alpha",
                "--format",
                "markdown",
                "--output",
                str(md_out),
            ]
        )
        assert code == 0
        cli_md = md_out.read_text(encoding="utf-8")
        assert cli_md.startswith("# Experiment Research Report")
        # CLI markdown and client markdown share the same renderer →
        # must produce identical output for the same payload.
        assert cli_md == md_via_client

        # 4. Bundle via client
        bundle = client.research_bundle("rep-alpha-1")
        assert bundle == BUNDLE_PAYLOAD
        assert bundle["decision"]["decision"] == "keep"
        assert bundle["manifest"]["status"] == "not_enabled"

        # 5. Bundle via CLI
        code = cli.main(["experiments", "bundle", "rep-alpha-1"])
        assert code == 0
        cli_bundle = json.loads(capsys.readouterr().out)
        assert cli_bundle == BUNDLE_PAYLOAD

        # 6. Fork plan via client
        plan = client.fork_plan(
            "rep-alpha-1",
            set_overrides={"lr": 0.0002, "use_curiosity": True},
            unset_keys=["warmup"],
            name="alpha-curiosity",
            reason="ablate curiosity contribution",
        )
        assert plan["kind"] == "fork-plan"
        assert plan["dry_run"] is True
        assert plan["parent"]["id"] == "exp-1"
        assert plan["suggested_name"] == "alpha-curiosity"
        assert plan["proposed_config"]["lr"] == 0.0002
        assert plan["proposed_config"]["use_curiosity"] is True
        assert "warmup" not in plan["proposed_config"]
        assert plan["config_diff"]["lr"]["op"] == "set"
        assert plan["config_diff"]["use_curiosity"]["op"] == "add"
        assert plan["config_diff"]["warmup"]["op"] == "unset"

        # 7. Fork plan via CLI — same logic, prints JSON
        code = cli.main(
            [
                "experiments",
                "fork-plan",
                "rep-alpha-1",
                "--set",
                "lr=0.0002",
                "--unset",
                "warmup",
                "--reason",
                "ablate curiosity contribution",
            ]
        )
        assert code == 0
        cli_plan = json.loads(capsys.readouterr().out)
        assert cli_plan["kind"] == "fork-plan"
        assert cli_plan["dry_run"] is True
        assert cli_plan["parent"]["id"] == "exp-1"
        # CLI fork-plan does not auto-suggest a name unless --name is passed
        # (parity with the explicit `--name` flag on `experiments fork-plan`).
        # We accept either: the contract is "fork_plan stays dry-run".
        assert "warmup" not in cli_plan["proposed_config"]

    # Every queued response was consumed → no missing steps, no extras.
    assert queue == [], f"un-consumed responses: {queue}"

    # ---------- End-to-end request sequence ----------
    urls = [c["url"] for c in calls]
    methods = [c["method"] for c in calls]
    # Every request is a GET (no writes happened during the review loop).
    assert set(methods) == {"GET"}, f"non-GET requests found: {methods}"
    # Every request carried the bearer token from ALCHEMY_TOKEN.
    assert all(c["auth"] == "Bearer dummy-review-token" for c in calls)

    expected_urls = [
        # 1. client research_report
        "http://server/api/experiments/research-report?family=alpha",
        # 2. client research_report_markdown
        "http://server/api/experiments/research-report?family=alpha",
        # 3. CLI experiments report --format markdown
        "http://server/api/experiments/research-report?family=alpha",
        # 4. client research_bundle → list + bundle
        "http://server/api/experiments",
        "http://server/api/experiments/exp-1/research-bundle",
        # 5. CLI experiments bundle → list + bundle
        "http://server/api/experiments",
        "http://server/api/experiments/exp-1/research-bundle",
        # 6. client fork_plan → list + detail
        "http://server/api/experiments",
        "http://server/api/experiments/exp-1",
        # 7. CLI experiments fork-plan → list + detail
        "http://server/api/experiments",
        "http://server/api/experiments/exp-1",
    ]
    assert urls == expected_urls


def test_review_workflow_markdown_renderer_is_deterministic():
    """Two renders of the same payload must produce identical bytes.

    The review workspace's "export markdown" affordance leans on this:
    if the renderer ever became time-dependent, copies pasted into PRs /
    Discord would diverge between runs and the local-only contract would
    break silently.
    """
    a = render_research_report_markdown(REPORT_PAYLOAD)
    b = render_research_report_markdown(REPORT_PAYLOAD)
    assert a == b
    # Sanity: the payload's leaderboard rows actually appear in order.
    a_lines = a.splitlines()
    pos_first = next(i for i, line in enumerate(a_lines) if "rep-alpha-1" in line)
    pos_second = next(i for i, line in enumerate(a_lines) if "rep-alpha-2" in line)
    assert pos_first < pos_second
