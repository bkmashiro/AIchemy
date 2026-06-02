"""Read-only HTTP client for experiment lineage endpoints."""
from __future__ import annotations

import json
import os
from typing import Any, Iterable, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DEFAULT_SERVER = "http://localhost:3002"


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
    ) -> None:
        self.server = _resolve_server(server).rstrip("/")
        self._token = token
        self.timeout = timeout

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

    def list(self) -> list[dict[str, Any]]:
        data = self._get("/experiments")
        # GET /experiments must return a JSON array. Fail loudly if the server
        # returns something else (e.g. an error envelope, a dict) rather than
        # silently coercing to `list(dict.keys())`, which used to mask bad
        # tokens and middleware that returns `{"error": ...}`.
        if data is None:
            return []
        if not isinstance(data, list):
            raise RuntimeError(
                f"unexpected /experiments response shape: expected list, got {type(data).__name__}"
            )
        return data

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

    def resolve(self, ref: str) -> dict[str, Any]:
        return self._resolve_one(self.list(), ref)

    def summary(self, ref: str) -> Any:
        exp = self.resolve(ref)
        return self._get(f"/experiments/{exp['id']}/summary")

    def diff(self, ref: str) -> Any:
        exp = self.resolve(ref)
        return self._get(f"/experiments/{exp['id']}/diff")

    def manifest(self, ref: str) -> Any:
        exp = self.resolve(ref)
        return self._get(f"/experiments/{exp['id']}/manifest")

    def compare(self, refs: Iterable[str]) -> Any:
        refs_list = list(refs)
        if not refs_list:
            raise RuntimeError("compare requires at least one experiment ref")
        experiments = self.list()
        resolved_ids = [self._resolve_one(experiments, ref)["id"] for ref in refs_list]
        query = urlencode({"ids": ",".join(resolved_ids)})
        return self._get(f"/experiments/compare?{query}")
