from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from alchemy_sdk.experiments import ExperimentClient


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
        calls.append({
            "method": req.method,
            "url": req.full_url,
            "auth": req.headers.get("Authorization"),
            "timeout": timeout,
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
