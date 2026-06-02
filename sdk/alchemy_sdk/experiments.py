"""Read-only HTTP client for experiment lineage endpoints."""
from __future__ import annotations

import copy
import json
import os
from typing import Any, Iterable, Mapping, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DEFAULT_SERVER = "http://localhost:3002"
DECISION_CHOICES = ("keep", "drop", "rerun", "fork", "none")
STATUS_CHOICES = ("running", "passed", "partial", "failed")


def _resolve_server(server: Optional[str]) -> str:
    return (
        server
        or os.environ.get("ALCHEMY_SERVER")
        or os.environ.get("ALCHEMY_SERVER_URL")
        or DEFAULT_SERVER
    )


def _resolve_token(token: Optional[str]) -> Optional[str]:
    return token or os.environ.get("ALCHEMY_TOKEN")


class ExperimentClient:
    """Thin read-only client for experiment lineage endpoints.

    Returns raw decoded JSON (dict/list) — no dataclass wrapping. Resolves
    name-or-id refs against ``GET /api/experiments`` before issuing detail
    requests.
    """

    def __init__(
        self,
        server: Optional[str] = None,
        token: Optional[str] = None,
        timeout: float = 20.0,
        cache_experiments: bool = False,
    ) -> None:
        self.server = _resolve_server(server).rstrip("/")
        self._token = token
        self.timeout = timeout
        # Opt-in per-client cache for `GET /experiments`. The same payload is
        # the source for every name-or-id resolution (`summary`, `diff`,
        # `manifest`, `compare`), so callers that fan out across many refs in
        # a script/notebook can flip this on to avoid N+1 round-trips. Default
        # stays off to preserve the existing "always reflects server state"
        # contract — flipping on without explicit caller intent would silently
        # surprise long-running scripts.
        self._cache_experiments = bool(cache_experiments)
        self._experiments_cache: Optional[list[dict[str, Any]]] = None

    @property
    def token(self) -> str:
        token = _resolve_token(self._token)
        if not token:
            raise RuntimeError(
                "missing Alchemy token: set ALCHEMY_TOKEN or pass token=... to ExperimentClient"
            )
        return token

    def _get(self, path: str) -> Any:
        req = Request(
            f"{self.server}/api{path}",
            method="GET",
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/json",
            },
        )
        try:
            with urlopen(req, timeout=self.timeout) as resp:  # noqa: S310
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code} on {path}: {body}") from exc
        except URLError as exc:
            raise RuntimeError(f"request to {path} failed: {exc.reason}") from exc

    def list(
        self,
        *,
        family: Optional[str] = None,
        decision: Optional[str] = None,
        status: Optional[str] = None,
        refresh: bool = False,
    ) -> list[dict[str, Any]]:
        # When `cache_experiments=True`, we keep the last successful unfiltered
        # list in `self._experiments_cache` and return it on subsequent calls
        # until `refresh=True` is passed or `clear_cache()` is called. The
        # cache is *only* used when no server-side filter is requested — the
        # cached payload is the canonical "all experiments" set that the
        # resolve / compare paths depend on, and we don't want filtered
        # responses leaking back into name-or-id resolution.
        params: dict[str, str] = {}
        if family is not None:
            params["family"] = family
        if decision is not None:
            if decision not in DECISION_CHOICES:
                raise RuntimeError(
                    f"decision must be one of {list(DECISION_CHOICES)}, got {decision!r}"
                )
            params["decision"] = decision
        if status is not None:
            if status not in STATUS_CHOICES:
                raise RuntimeError(
                    f"status must be one of {list(STATUS_CHOICES)}, got {status!r}"
                )
            params["status"] = status

        if (
            not params
            and self._cache_experiments
            and not refresh
            and self._experiments_cache is not None
        ):
            return self._experiments_cache

        path = "/experiments"
        if params:
            path += f"?{urlencode(params)}"
        data = self._get(path)
        # GET /experiments must return a JSON array. Fail loudly if the server
        # returns something else (e.g. an error envelope, a dict) rather than
        # silently coercing to `list(dict.keys())`, which used to mask bad
        # tokens and middleware that returns `{"error": ...}`.
        if data is None:
            result: list[dict[str, Any]] = []
        elif not isinstance(data, list):
            raise RuntimeError(
                f"unexpected /experiments response shape: expected list, got {type(data).__name__}"
            )
        else:
            result = data

        if self._cache_experiments and not params:
            self._experiments_cache = result
        return result

    def clear_cache(self) -> None:
        """Drop the cached experiment list. No-op when caching is disabled."""
        self._experiments_cache = None

    def tree(self) -> Any:
        return self._get("/experiments/tree")

    def _resolve_one(
        self, experiments: list[dict[str, Any]], ref: str
    ) -> dict[str, Any]:
        matches = [
            e for e in experiments if e.get("id") == ref or e.get("name") == ref
        ]
        if not matches:
            raise RuntimeError(f"experiment not found: {ref}")
        if len(matches) > 1:
            names = [e.get("name") for e in matches]
            raise RuntimeError(f"ambiguous experiment ref {ref!r}: {names}")
        return matches[0]

    def resolve(self, ref: str, *, refresh: bool = False) -> dict[str, Any]:
        return self._resolve_one(self.list(refresh=refresh), ref)

    def summary(self, ref: str, *, refresh: bool = False) -> Any:
        exp = self.resolve(ref, refresh=refresh)
        return self._get(f"/experiments/{exp['id']}/summary")

    def diff(self, ref: str, *, refresh: bool = False) -> Any:
        exp = self.resolve(ref, refresh=refresh)
        return self._get(f"/experiments/{exp['id']}/diff")

    def manifest(self, ref: str, *, refresh: bool = False) -> Any:
        exp = self.resolve(ref, refresh=refresh)
        return self._get(f"/experiments/{exp['id']}/manifest")

    def timeline(self, ref: str, *, refresh: bool = False) -> Any:
        """GET /api/experiments/<id>/timeline.

        Returns the append-only event log (notes, decisions, artifacts,
        synthesized task lifecycle events). Read-only; no events are written.
        """
        exp = self.resolve(ref, refresh=refresh)
        return self._get(f"/experiments/{exp['id']}/timeline")

    def fork_plan(
        self,
        ref: str,
        *,
        set_overrides: Optional[Mapping[str, Any]] = None,
        unset_keys: Iterable[str] = (),
        name: Optional[str] = None,
        reason: str = "",
        refresh: bool = False,
    ) -> dict[str, Any]:
        """Build a local fork manifest without submitting anything.

        Mirrors ``alch experiments fork-plan``: fetches the parent experiment,
        applies flat top-level overrides, and returns a dict describing the
        proposed config + diff. Nothing is sent to the server beyond the two
        read requests used to fetch parent state.

        Top-level keys only — nested (dotted) keys are rejected to match the
        CLI's current contract.
        """
        exp = self.resolve(ref, refresh=refresh)
        detail = self._get(f"/experiments/{exp['id']}")
        base_config = detail.get("config") if isinstance(detail, dict) else None
        proposed, diff = _apply_flat_overrides(
            base_config or {}, set_overrides or {}, list(unset_keys)
        )
        parent_name = detail.get("name") or exp.get("name")
        return {
            "kind": "fork-plan",
            "dry_run": True,
            "parent": {
                "id": detail.get("id") or exp.get("id"),
                "name": parent_name,
                "family": detail.get("family"),
            },
            "suggested_name": name or f"{parent_name}-fork",
            "reason": reason,
            "parent_config": base_config or {},
            "proposed_config": proposed,
            "config_diff": diff,
        }

    def compare(self, refs: Iterable[str], *, refresh: bool = False) -> Any:
        refs_list = list(refs)
        if not refs_list:
            raise RuntimeError("compare requires at least one experiment ref")
        experiments = self.list(refresh=refresh)
        resolved_ids = [self._resolve_one(experiments, ref)["id"] for ref in refs_list]
        query = urlencode({"ids": ",".join(resolved_ids)})
        return self._get(f"/experiments/compare?{query}")


def _apply_flat_overrides(
    config: Any,
    sets: Mapping[str, Any],
    unsets: list[str],
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    base: dict[str, Any] = copy.deepcopy(config) if isinstance(config, dict) else {}
    proposed: dict[str, Any] = dict(base)
    diff: dict[str, dict[str, Any]] = {}
    for key, value in sets.items():
        if "." in key:
            raise RuntimeError(
                f"fork_plan does not support nested keys; got {key!r}"
            )
        if not key:
            raise RuntimeError("fork_plan override key must be non-empty")
        before_known = key in base
        diff[key] = {
            "before": base.get(key) if before_known else None,
            "after": value,
            "op": "set" if before_known else "add",
        }
        proposed[key] = value
    for key in unsets:
        key = key.strip()
        if not key:
            raise RuntimeError("fork_plan unset key must be non-empty")
        if "." in key:
            raise RuntimeError(
                f"fork_plan does not support nested keys; got {key!r}"
            )
        if key in proposed:
            diff[key] = {"before": base.get(key), "after": None, "op": "unset"}
            proposed.pop(key, None)
    return proposed, diff
