from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from alchemy_sdk.experiments import (
    ExperimentClient,
    render_research_report_markdown,
)


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
        body = req.data.decode("utf-8") if req.data else None
        call = {
            "method": req.method,
            "url": req.full_url,
            "auth": req.headers.get("Authorization"),
            "timeout": timeout,
        }
        if body:
            call["body"] = json.loads(body)
        calls.append(call)
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


def test_missing_token_raises_clear_error(monkeypatch):
    monkeypatch.delenv("ALCHEMY_TOKEN", raising=False)
    client = ExperimentClient(server="http://server")
    with pytest.raises(RuntimeError, match="missing Alchemy token"):
        client.list()


def test_list_sends_get_experiments_with_bearer(monkeypatch):
    client = ExperimentClient(server="http://server")
    result, calls = _run(
        monkeypatch,
        client.list,
        [[{"id": "exp-1", "name": "alpha"}]],
    )
    assert result == [{"id": "exp-1", "name": "alpha"}]
    assert calls == [{
        "method": "GET",
        "url": "http://server/api/experiments",
        "auth": "Bearer secret-token",
        "timeout": 20.0,
    }]


def test_resolve_by_id_and_by_name(monkeypatch):
    client = ExperimentClient(server="http://server")
    experiments = [
        {"id": "exp-1", "name": "alpha"},
        {"id": "exp-2", "name": "beta"},
    ]
    by_id, _ = _run(monkeypatch, lambda: client.resolve("exp-2"), [experiments])
    assert by_id["id"] == "exp-2"

    by_name, _ = _run(monkeypatch, lambda: client.resolve("alpha"), [experiments])
    assert by_name["id"] == "exp-1"


def test_resolve_ambiguous_name_fails(monkeypatch):
    client = ExperimentClient(server="http://server")
    duplicates = [
        {"id": "exp-1", "name": "alpha"},
        {"id": "exp-2", "name": "alpha"},
    ]
    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")
    with patch(
        "alchemy_sdk.experiments.urlopen",
        _patched_urlopen([duplicates], []),
    ):
        with pytest.raises(RuntimeError, match="ambiguous experiment ref"):
            client.resolve("alpha")


def test_resolve_not_found_fails(monkeypatch):
    client = ExperimentClient(server="http://server")
    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")
    with patch(
        "alchemy_sdk.experiments.urlopen",
        _patched_urlopen([[{"id": "exp-1", "name": "alpha"}]], []),
    ):
        with pytest.raises(RuntimeError, match="experiment not found"):
            client.resolve("ghost")


def test_summary_resolves_then_gets_summary(monkeypatch):
    client = ExperimentClient(server="http://server")
    result, calls = _run(
        monkeypatch,
        lambda: client.summary("alpha"),
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"id": "exp-1", "metrics": {"loss": 0.1}},
        ],
    )
    assert result == {"id": "exp-1", "metrics": {"loss": 0.1}}
    assert calls[0]["url"] == "http://server/api/experiments"
    assert calls[1]["method"] == "GET"
    assert calls[1]["url"] == "http://server/api/experiments/exp-1/summary"
    assert calls[1]["auth"] == "Bearer secret-token"


def test_recommend_fetches_recommendation_endpoint(monkeypatch):
    client = ExperimentClient(server="http://server")
    recommendation = {"winner": "exp-2", "reason": "best_val_accuracy"}
    result, calls = _run(
        monkeypatch,
        lambda: client.recommend("alpha"),
        [
            [{"id": "exp-1", "name": "alpha"}],
            recommendation,
        ],
    )
    assert result == recommendation
    assert calls[0]["url"] == "http://server/api/experiments"
    assert calls[1]["method"] == "GET"
    assert calls[1]["url"] == "http://server/api/experiments/exp-1/recommendation"


def test_recommend_falls_back_to_summary_on_missing_endpoint(monkeypatch):
    import io
    from urllib.error import HTTPError

    client = ExperimentClient(server="http://server", token="secret-token")
    calls: list[dict] = []

    def fake_urlopen(req, timeout=20.0):
        calls.append({"method": req.method, "url": req.full_url})
        if req.full_url == "http://server/api/experiments":
            return FakeResponse([{"id": "exp-1", "name": "alpha"}])
        if req.full_url == "http://server/api/experiments/exp-1/recommendation":
            raise HTTPError(
                req.full_url,
                404,
                "Not Found",
                hdrs=None,  # type: ignore[arg-type]
                fp=io.BytesIO(b'{"error":"not implemented"}'),
            )
        if req.full_url == "http://server/api/experiments/exp-1/summary":
            return FakeResponse({"recommendation": {"winner": "exp-2"}, "id": "exp-1"})
        raise AssertionError(f"unexpected request {req.method} {req.full_url}")

    with patch("alchemy_sdk.experiments.urlopen", fake_urlopen):
        result = client.recommend("alpha")

    assert result == {"winner": "exp-2"}
    assert [c["url"] for c in calls] == [
        "http://server/api/experiments",
        "http://server/api/experiments/exp-1/recommendation",
        "http://server/api/experiments/exp-1/summary",
    ]


def test_diff_and_manifest_hit_lineage_endpoints(monkeypatch):
    client = ExperimentClient(server="http://server")
    _, diff_calls = _run(
        monkeypatch,
        lambda: client.diff("alpha"),
        [[{"id": "exp-1", "name": "alpha"}], {"changes": []}],
    )
    assert diff_calls[1]["url"] == "http://server/api/experiments/exp-1/diff"

    _, manifest_calls = _run(
        monkeypatch,
        lambda: client.manifest("exp-1"),
        [[{"id": "exp-1", "name": "alpha"}], {"manifest_version": 1}],
    )
    assert manifest_calls[1]["url"] == "http://server/api/experiments/exp-1/manifest"


def test_tree_hits_tree_endpoint(monkeypatch):
    client = ExperimentClient(server="http://server")
    result, calls = _run(
        monkeypatch,
        client.tree,
        [{"roots": []}],
    )
    assert result == {"roots": []}
    assert calls == [{
        "method": "GET",
        "url": "http://server/api/experiments/tree",
        "auth": "Bearer secret-token",
        "timeout": 20.0,
    }]


def test_compare_resolves_and_preserves_order(monkeypatch):
    client = ExperimentClient(server="http://server")
    experiments = [
        {"id": "exp-1", "name": "alpha"},
        {"id": "exp-2", "name": "beta"},
        {"id": "exp-3", "name": "gamma"},
    ]
    _, calls = _run(
        monkeypatch,
        lambda: client.compare(["beta", "alpha", "exp-3"]),
        [experiments, {"experiments": []}],
    )
    assert calls[0]["url"] == "http://server/api/experiments"
    assert calls[1]["url"] == "http://server/api/experiments/compare?ids=exp-2%2Cexp-1%2Cexp-3"


def test_compare_unknown_ref_fails(monkeypatch):
    client = ExperimentClient(server="http://server")
    monkeypatch.setenv("ALCHEMY_TOKEN", "secret-token")
    with patch(
        "alchemy_sdk.experiments.urlopen",
        _patched_urlopen([[{"id": "exp-1", "name": "alpha"}]], []),
    ):
        with pytest.raises(RuntimeError, match="experiment not found"):
            client.compare(["alpha", "ghost"])


def test_http_error_includes_status_and_body(monkeypatch):
    from urllib.error import HTTPError
    import io

    client = ExperimentClient(server="http://server", token="secret-token")

    def fake_urlopen(req, timeout=20.0):
        raise HTTPError(
            req.full_url,
            503,
            "Service Unavailable",
            hdrs=None,  # type: ignore[arg-type]
            fp=io.BytesIO(b'{"error":"db down"}'),
        )

    with patch("alchemy_sdk.experiments.urlopen", fake_urlopen):
        with pytest.raises(RuntimeError) as exc_info:
            client.list()

    msg = str(exc_info.value)
    assert "503" in msg
    assert "db down" in msg


def test_server_defaults_from_env(monkeypatch):
    monkeypatch.delenv("ALCHEMY_SERVER", raising=False)
    monkeypatch.setenv("ALCHEMY_SERVER_URL", "http://env-host:9000")
    monkeypatch.setenv("ALCHEMY_TOKEN", "tk")
    client = ExperimentClient()
    assert client.server == "http://env-host:9000"

    monkeypatch.setenv("ALCHEMY_SERVER", "http://primary:1234")
    client2 = ExperimentClient()
    assert client2.server == "http://primary:1234"


def test_exported_from_package():
    from alchemy_sdk import ExperimentClient as Exported
    assert Exported is ExperimentClient


def test_explicit_token_arg_beats_env(monkeypatch):
    monkeypatch.setenv("ALCHEMY_TOKEN", "env-token")
    client = ExperimentClient(server="http://server", token="ctor-token")
    queue = [[{"id": "exp-1", "name": "alpha"}]]
    calls: list[dict] = []
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen(queue, calls)):
        client.list()
    assert calls[0]["auth"] == "Bearer ctor-token"


def test_constructor_token_used_when_env_unset(monkeypatch):
    monkeypatch.delenv("ALCHEMY_TOKEN", raising=False)
    client = ExperimentClient(server="http://server", token="ctor-only")
    queue = [[]]
    calls: list[dict] = []
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen(queue, calls)):
        client.list()
    assert calls[0]["auth"] == "Bearer ctor-only"


def test_trailing_slash_in_server_is_normalized(monkeypatch):
    monkeypatch.setenv("ALCHEMY_TOKEN", "tk")
    client = ExperimentClient(server="http://server:9000//")
    # Both leading-slash normalizations should apply: server has no trailing
    # slash, and the path joins cleanly without `//`.
    assert client.server == "http://server:9000"
    queue = [[]]
    calls: list[dict] = []
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen(queue, calls)):
        client.list()
    assert calls[0]["url"] == "http://server:9000/api/experiments"


def test_list_raises_on_non_list_response(monkeypatch):
    monkeypatch.setenv("ALCHEMY_TOKEN", "tk")
    client = ExperimentClient(server="http://server")
    # Server returned an error envelope (dict) instead of a list — we used to
    # silently turn that into `list({"error": "..."}.keys())`. Now it must
    # raise so the operator can see the real failure mode.
    queue = [{"error": "db down"}]
    calls: list[dict] = []
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen(queue, calls)):
        with pytest.raises(RuntimeError, match="unexpected /experiments response shape"):
            client.list()


def test_cache_disabled_by_default_refetches_experiments(monkeypatch):
    client = ExperimentClient(server="http://server")
    monkeypatch.setenv("ALCHEMY_TOKEN", "tk")
    experiments = [{"id": "exp-1", "name": "alpha"}]
    queue = [experiments, experiments]
    calls: list[dict] = []
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen(queue, calls)):
        client.list()
        client.list()
    assert len(calls) == 2


def test_cache_enabled_reuses_experiments_list_across_resolutions(monkeypatch):
    client = ExperimentClient(server="http://server", cache_experiments=True)
    monkeypatch.setenv("ALCHEMY_TOKEN", "tk")
    experiments = [{"id": "exp-1", "name": "alpha"}]
    queue = [
        experiments,          # first list()
        {"metrics": {}},      # summary
        {"changes": []},      # diff
    ]
    calls: list[dict] = []
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen(queue, calls)):
        client.list()
        client.summary("alpha")
        client.diff("exp-1")
    # Only one /experiments call: cached list serves both name and id lookups.
    paths = [c["url"].split("/api", 1)[1] for c in calls]
    assert paths == [
        "/experiments",
        "/experiments/exp-1/summary",
        "/experiments/exp-1/diff",
    ]


def test_cache_refresh_forces_new_experiments_fetch(monkeypatch):
    client = ExperimentClient(server="http://server", cache_experiments=True)
    monkeypatch.setenv("ALCHEMY_TOKEN", "tk")
    first = [{"id": "exp-1", "name": "alpha"}]
    second = [{"id": "exp-1", "name": "alpha"}, {"id": "exp-2", "name": "beta"}]
    queue = [first, second]
    calls: list[dict] = []
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen(queue, calls)):
        assert client.list() == first
        assert client.list() == first  # cached
        assert client.list(refresh=True) == second
        assert client.list() == second  # now cached value updated
    assert len(calls) == 2


def test_clear_cache_drops_memo(monkeypatch):
    client = ExperimentClient(server="http://server", cache_experiments=True)
    monkeypatch.setenv("ALCHEMY_TOKEN", "tk")
    experiments = [{"id": "exp-1", "name": "alpha"}]
    queue = [experiments, experiments]
    calls: list[dict] = []
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen(queue, calls)):
        client.list()
        client.clear_cache()
        client.list()
    assert len(calls) == 2


def test_compare_refresh_bypasses_cache(monkeypatch):
    client = ExperimentClient(server="http://server", cache_experiments=True)
    monkeypatch.setenv("ALCHEMY_TOKEN", "tk")
    first = [{"id": "exp-1", "name": "alpha"}]
    second = [
        {"id": "exp-1", "name": "alpha"},
        {"id": "exp-2", "name": "beta"},
    ]
    queue = [first, second, {"experiments": []}]
    calls: list[dict] = []
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen(queue, calls)):
        client.list()  # primes cache with the old payload
        client.compare(["alpha", "beta"], refresh=True)
    # First /experiments primes cache, compare(refresh=True) forces another
    # /experiments fetch, then hits /compare with both ids.
    paths = [c["url"].split("/api", 1)[1] for c in calls]
    assert paths == [
        "/experiments",
        "/experiments",
        "/experiments/compare?ids=exp-1%2Cexp-2",
    ]


def test_list_returns_empty_for_null_body(monkeypatch):
    monkeypatch.setenv("ALCHEMY_TOKEN", "tk")
    client = ExperimentClient(server="http://server")
    queue = [None]
    calls: list[dict] = []
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen(queue, calls)):
        assert client.list() == []


def test_list_passes_filters_as_query_params(monkeypatch):
    client = ExperimentClient(server="http://server")
    _, calls = _run(
        monkeypatch,
        lambda: client.list(family="pretrain", decision="keep", status="running"),
        [[{"id": "exp-1", "name": "alpha"}]],
    )
    assert calls[0]["url"].startswith("http://server/api/experiments?")
    assert "family=pretrain" in calls[0]["url"]
    assert "decision=keep" in calls[0]["url"]
    assert "status=running" in calls[0]["url"]


def test_list_rejects_invalid_decision_or_status(monkeypatch):
    client = ExperimentClient(server="http://server", token="tk")
    with pytest.raises(RuntimeError, match="decision must be one of"):
        client.list(decision="nope")
    with pytest.raises(RuntimeError, match="status must be one of"):
        client.list(status="hot")


def test_resolve_accepts_code_id(monkeypatch):
    client = ExperimentClient(server="http://server")
    result, calls = _run(
        monkeypatch,
        lambda: client.resolve("jema.atari.coverage500.v1"),
        [[{"id": "exp-1", "name": "Atari", "code_id": "jema.atari.coverage500.v1"}]],
    )
    assert result["id"] == "exp-1"
    assert calls[0]["url"] == "http://server/api/experiments"


def test_decide_normalizes_code_first_vocabulary(monkeypatch):
    client = ExperimentClient(server="http://server")
    result, calls = _run(
        monkeypatch,
        lambda: client.decide("alpha", decision="try-more", reason="seed variance high"),
        [[{"id": "exp-1", "name": "alpha"}], {"id": "exp-1", "decision": "try_more"}],
    )
    assert result["decision"] == "try_more"
    assert calls[1]["method"] == "PATCH"
    assert calls[1]["body"] == {"decision": "try_more", "reason": "seed variance high"}


def test_comment_is_alias_for_add_note(monkeypatch):
    client = ExperimentClient(server="http://server")
    _, calls = _run(
        monkeypatch,
        lambda: client.comment("alpha", "needs Freeway coverage", data={"source": "notebook"}),
        [[{"id": "exp-1", "name": "alpha"}], {"id": "evt-1"}],
    )
    assert calls[1]["body"] == {
        "kind": "note",
        "message": "needs Freeway coverage",
        "data": {"source": "notebook"},
    }


def test_list_filtered_results_bypass_cache_writes(monkeypatch):
    client = ExperimentClient(server="http://server", cache_experiments=True)
    monkeypatch.setenv("ALCHEMY_TOKEN", "tk")
    # Filtered list must not populate the resolution cache (otherwise resolve()
    # would later only see the filtered subset).
    queue = [
        [{"id": "exp-1", "name": "alpha"}],         # filtered list
        [{"id": "exp-1", "name": "alpha"},          # full list for resolve
         {"id": "exp-2", "name": "beta"}],
        {"id": "exp-2", "metrics": {}},
    ]
    calls: list[dict] = []
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen(queue, calls)):
        client.list(family="pretrain")
        client.summary("beta")
    # 1 filtered + 1 full-list (for resolve) + 1 summary. The filtered call did
    # not poison the cache.
    assert len(calls) == 3


def test_research_bundle_resolves_and_hits_bundle_endpoint(monkeypatch):
    client = ExperimentClient(server="http://server")
    bundle_payload = {
        "experiment": {"id": "exp-1", "name": "alpha"},
        "summary": {"id": "exp-1"},
        "diff": {"experiment_id": "exp-1"},
        "manifest": {"enabled": False, "content": None, "status": "not_enabled", "error": None},
        "timeline": {"experiment_id": "exp-1", "events": []},
        "decision": {"decision": None, "reason": None, "decided_at": None},
        "artifacts": [],
        "generated_at": "2026-06-02T00:00:00.000Z",
    }
    result, calls = _run(
        monkeypatch,
        lambda: client.research_bundle("alpha"),
        [[{"id": "exp-1", "name": "alpha"}], bundle_payload],
    )
    assert result == bundle_payload
    assert [c["method"] for c in calls] == ["GET", "GET"]
    assert calls[0]["url"] == "http://server/api/experiments"
    assert calls[1]["url"] == "http://server/api/experiments/exp-1/research-bundle"


def test_research_report_sends_get_with_query_params(monkeypatch):
    client = ExperimentClient(server="http://server")
    payload = {
        "filters": {"family": "alpha", "decision": "none", "status": None, "limit": 25},
        "counts": {"total": 0, "by_status": {}, "by_decision": {}},
        "metric": None,
        "leaderboard": [],
        "experiments": [],
        "generated_at": "2026-06-02T00:00:00.000Z",
    }
    result, calls = _run(
        monkeypatch,
        lambda: client.research_report(family="alpha", decision="none", limit=25),
        [payload],
    )
    assert result == payload
    assert len(calls) == 1
    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == (
        "http://server/api/experiments/research-report"
        "?family=alpha&decision=none&limit=25"
    )


def test_research_report_with_no_filters_hits_bare_endpoint(monkeypatch):
    client = ExperimentClient(server="http://server")
    _, calls = _run(monkeypatch, client.research_report, [{"experiments": []}])
    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == "http://server/api/experiments/research-report"


def test_research_report_rejects_invalid_inputs(monkeypatch):
    client = ExperimentClient(server="http://server")
    monkeypatch.setenv("ALCHEMY_TOKEN", "tk")
    with pytest.raises(RuntimeError, match="decision must be one of"):
        client.research_report(decision="ship")
    with pytest.raises(RuntimeError, match="status must be one of"):
        client.research_report(status="nope")
    with pytest.raises(RuntimeError, match="limit must be a positive integer"):
        client.research_report(limit=0)
    with pytest.raises(RuntimeError, match="limit must be a positive integer"):
        client.research_report(limit=-3)


def test_research_report_url_encodes_family_with_spaces(monkeypatch):
    client = ExperimentClient(server="http://server")
    _, calls = _run(
        monkeypatch,
        lambda: client.research_report(family="space family"),
        [{"experiments": []}],
    )
    assert calls[0]["url"] == "http://server/api/experiments/research-report?family=space+family"


def test_research_bundle_refresh_bypasses_cache(monkeypatch):
    client = ExperimentClient(server="http://server", cache_experiments=True)
    monkeypatch.setenv("ALCHEMY_TOKEN", "tk")
    first = [{"id": "exp-1", "name": "alpha"}]
    second = [{"id": "exp-1", "name": "alpha"}, {"id": "exp-2", "name": "beta"}]
    queue = [first, second, {"experiment": {"id": "exp-2"}}]
    calls: list[dict] = []
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen(queue, calls)):
        client.list()  # primes cache with `first`
        client.research_bundle("beta", refresh=True)
    paths = [c["url"].split("/api", 1)[1] for c in calls]
    assert paths == [
        "/experiments",
        "/experiments",
        "/experiments/exp-2/research-bundle",
    ]


def test_timeline_resolves_and_hits_timeline_endpoint(monkeypatch):
    client = ExperimentClient(server="http://server")
    _, calls = _run(
        monkeypatch,
        lambda: client.timeline("alpha"),
        [[{"id": "exp-1", "name": "alpha"}], {"experiment_id": "exp-1", "events": []}],
    )
    assert calls[1]["method"] == "GET"
    assert calls[1]["url"] == "http://server/api/experiments/exp-1/timeline"


def test_fork_plan_returns_dry_run_manifest_with_diff(monkeypatch):
    client = ExperimentClient(server="http://server")
    plan, calls = _run(
        monkeypatch,
        lambda: client.fork_plan(
            "alpha",
            set_overrides={"lr": 0.0003, "use_curiosity": True},
            unset_keys=["warmup"],
            name="alpha-curiosity",
            reason="test curiosity",
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
    # Two GETs only — fork_plan must never POST/PATCH.
    assert [c["method"] for c in calls] == ["GET", "GET"]
    assert plan["kind"] == "fork-plan"
    assert plan["dry_run"] is True
    assert plan["parent"] == {"id": "exp-1", "name": "alpha", "family": "pretrain"}
    assert plan["suggested_name"] == "alpha-curiosity"
    assert plan["reason"] == "test curiosity"
    assert plan["parent_config"] == {"lr": 0.001, "warmup": 100, "seed": 7}
    assert plan["proposed_config"] == {"lr": 0.0003, "seed": 7, "use_curiosity": True}
    assert plan["config_diff"]["lr"] == {"before": 0.001, "after": 0.0003, "op": "set"}
    assert plan["config_diff"]["use_curiosity"] == {"before": None, "after": True, "op": "add"}
    assert plan["config_diff"]["warmup"] == {"before": 100, "after": None, "op": "unset"}


def test_fork_plan_rejects_dotted_keys(monkeypatch):
    client = ExperimentClient(server="http://server", token="tk")
    queue = [
        [{"id": "exp-1", "name": "alpha"}],
        {"id": "exp-1", "name": "alpha", "config": {}},
    ]
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen(queue, [])):
        with pytest.raises(RuntimeError, match="nested keys"):
            client.fork_plan("alpha", set_overrides={"model.lr": 0.1})



def test_fork_plan_rejects_empty_unset_key(monkeypatch):
    client = ExperimentClient(server="http://server", token="tk")
    queue = [
        [{"id": "exp-1", "name": "alpha"}],
        {"id": "exp-1", "name": "alpha", "config": {}},
    ]
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen(queue, [])):
        with pytest.raises(RuntimeError, match="unset key must be non-empty"):
            client.fork_plan("alpha", unset_keys=["  "])


def test_fork_plan_default_suggested_name(monkeypatch):
    client = ExperimentClient(server="http://server")
    plan, _ = _run(
        monkeypatch,
        lambda: client.fork_plan("alpha"),
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"id": "exp-1", "name": "alpha", "config": {"lr": 0.001}},
        ],
    )
    assert plan["suggested_name"] == "alpha-fork"
    assert plan["proposed_config"] == {"lr": 0.001}
    assert plan["config_diff"] == {}


def _sample_report() -> dict:
    return {
        "filters": {"family": "alpha", "decision": "none", "status": None, "limit": 25},
        "generated_at": "2026-06-02T00:00:00.000Z",
        "counts": {
            "total": 3,
            "by_status": {"running": 2, "failed": 1},
            "by_decision": {"keep": 1, "none": 2},
        },
        "metric": {"name": "loss", "direction": "min"},
        "leaderboard": [
            {
                "rank": 1,
                "id": "exp-b",
                "name": "rep-alpha-b",
                "status": "running",
                "decision": "keep",
                "value": 0.1,
                "metric": "loss",
            },
            {
                "rank": 2,
                "id": "exp-a",
                "name": "rep-alpha-a",
                "status": "running",
                "decision": None,
                "value": 0.42,
                "metric": "loss",
            },
        ],
        "experiments": [
            {
                "id": "exp-b",
                "name": "rep-alpha-b",
                "family": "alpha",
                "status": "running",
                "decision": "keep",
                "task_counts": {"running": 1, "completed": 1},
                "primary_metric": {"name": "loss", "value": 0.1},
                "artifact_count": 2,
                "checkpoint_count": 1,
                "recent_events": [
                    {"kind": "artifact", "created_at": "2026-06-01T12:00:00.000Z"},
                    {"kind": "decision", "created_at": "2026-06-02T00:00:00.000Z"},
                ],
            },
            {
                "id": "exp-a",
                "name": "rep-alpha-a",
                "family": "alpha",
                "status": "running",
                "decision": None,
                "task_counts": {"running": 1},
                "primary_metric": None,
                "artifact_count": 0,
                "checkpoint_count": 0,
                "recent_events": [],
            },
        ],
    }


def test_render_research_report_markdown_contains_all_sections():
    md = render_research_report_markdown(_sample_report())
    assert md.startswith("# Experiment Research Report\n")
    assert md.endswith("\n")
    # Filters
    assert "## Filters" in md
    assert "- family: alpha" in md
    assert "- decision: none" in md
    assert "- status: *all*" in md
    assert "- limit: 25" in md
    assert "- generated_at: 2026-06-02T00:00:00.000Z" in md
    # Counts
    assert "## Counts" in md
    assert "- total: 3" in md
    assert "- by_status: failed=1, running=2" in md
    assert "- by_decision: keep=1, none=2" in md
    # Metric
    assert "## Metric" in md
    assert "- name: loss" in md
    assert "- direction: min" in md
    # Leaderboard
    assert "## Leaderboard" in md
    assert "| Rank | Experiment | Status | Decision | Metric | Value |" in md
    assert "| 1 | rep-alpha-b | running | keep | loss | 0.1 |" in md
    assert "| 2 | rep-alpha-a | running | - | loss | 0.42 |" in md
    # Experiments
    assert "## Experiments" in md
    assert "rep-alpha-b" in md
    assert "running=1, completed=1" not in md  # sorted alphabetically below
    assert "completed=1, running=1" in md
    assert "loss=0.1" in md
    assert "artifact@2026-06-01T12:00:00.000Z" in md
    assert "decision@2026-06-02T00:00:00.000Z" in md


def test_render_research_report_markdown_is_deterministic():
    report = _sample_report()
    a = render_research_report_markdown(report)
    b = render_research_report_markdown(report)
    assert a == b


def test_render_research_report_markdown_empty_report():
    empty = {
        "filters": {"family": None, "decision": None, "status": None, "limit": 50},
        "generated_at": "2026-06-02T00:00:00.000Z",
        "counts": {"total": 0, "by_status": {}, "by_decision": {}},
        "metric": None,
        "leaderboard": [],
        "experiments": [],
    }
    md = render_research_report_markdown(empty)
    assert "- family: *all*" in md
    assert "- by_status: _(none)_" in md
    assert "- by_decision: _(none)_" in md
    assert "_No goal metric declared" in md
    assert "_Empty — no experiment" in md
    assert "_No experiments match" in md


def test_render_research_report_markdown_handles_missing_fields():
    md = render_research_report_markdown({})
    assert "# Experiment Research Report" in md
    assert "- total: 0" in md
    assert "_No experiments match" in md


def test_render_research_report_markdown_escapes_pipes_in_names():
    report = {
        "filters": {"family": None, "decision": None, "status": None, "limit": 50},
        "counts": {"total": 1, "by_status": {"running": 1}, "by_decision": {"none": 1}},
        "metric": None,
        "leaderboard": [],
        "experiments": [
            {
                "id": "x",
                "name": "weird|name",
                "family": "fam",
                "status": "running",
                "decision": None,
                "task_counts": {"running": 1},
                "primary_metric": None,
                "artifact_count": 0,
                "checkpoint_count": 0,
                "recent_events": [],
            }
        ],
    }
    md = render_research_report_markdown(report)
    assert "weird\\|name" in md
    assert "weird|name |" not in md  # raw pipe would break the table


def test_render_research_report_markdown_rejects_non_mapping():
    with pytest.raises(TypeError):
        render_research_report_markdown([])  # type: ignore[arg-type]


def test_research_report_markdown_method_issues_one_get(monkeypatch):
    client = ExperimentClient(server="http://server")
    payload = _sample_report()
    result, calls = _run(
        monkeypatch,
        lambda: client.research_report_markdown(family="alpha", decision="none", limit=25),
        [payload],
    )
    assert isinstance(result, str)
    assert result.startswith("# Experiment Research Report\n")
    assert len(calls) == 1
    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == (
        "http://server/api/experiments/research-report"
        "?family=alpha&decision=none&limit=25"
    )


def test_research_report_markdown_method_rejects_non_object_response(monkeypatch):
    client = ExperimentClient(server="http://server")
    monkeypatch.setenv("ALCHEMY_TOKEN", "tk")
    with patch("alchemy_sdk.experiments.urlopen", _patched_urlopen([["not", "an", "object"]], [])):
        with pytest.raises(RuntimeError, match="unexpected research-report response"):
            client.research_report_markdown()


def test_fork_plan_does_not_mutate_parent_config(monkeypatch):
    client = ExperimentClient(server="http://server")
    parent_config = {"layers": [1, 2, 3]}
    plan, _ = _run(
        monkeypatch,
        lambda: client.fork_plan("alpha", set_overrides={"lr": 0.1}),
        [
            [{"id": "exp-1", "name": "alpha"}],
            {"id": "exp-1", "name": "alpha", "config": parent_config},
        ],
    )
    # Mutating the returned proposed_config must not leak back into the
    # server-side parent_config snapshot we just received.
    plan["proposed_config"]["layers"].append(99)
    assert plan["parent_config"]["layers"] == [1, 2, 3]
