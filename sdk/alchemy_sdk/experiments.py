"""HTTP client for experiment lineage endpoints."""
from __future__ import annotations

import copy
import json
import math
import os
from typing import Any, Iterable, Mapping, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DEFAULT_SERVER = "http://localhost:3002"
DECISION_CHOICES = ("keep", "drop", "rerun", "fork", "none")
DECISION_WRITE_CHOICES = ("keep", "drop", "rerun", "fork")
STATUS_CHOICES = ("running", "passed", "partial", "failed")
ARTIFACT_TYPES = ("checkpoint", "tensorboard", "log", "file", "metrics")


def _resolve_server(server: Optional[str]) -> str:
    return (
        server
        or os.environ.get("ALCHEMY_SERVER")
        or os.environ.get("ALCHEMY_SERVER_URL")
        or DEFAULT_SERVER
    )


def _resolve_token(token: Optional[str]) -> Optional[str]:
    return token or os.environ.get("ALCHEMY_TOKEN")


def _validate_event_message(value: Any, field: str = "message") -> None:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"{field} must be a non-empty string")
    if len(value) > 4096:
        raise RuntimeError(f"{field} too long")


def _copy_event_data(data: Optional[Mapping[str, Any]], *, label: str) -> dict[str, Any]:
    if data is None:
        return {}
    if not isinstance(data, Mapping):
        raise RuntimeError(f"{label} data must be a mapping, got {type(data).__name__}")
    copied = dict(data)
    if "artifact_type" in copied and copied["artifact_type"] is not None:
        if copied["artifact_type"] not in ARTIFACT_TYPES:
            raise RuntimeError(
                f"artifact_type must be one of {list(ARTIFACT_TYPES)}, got {copied['artifact_type']!r}"
            )
    if "step" in copied and copied["step"] is not None:
        _validate_artifact_step(copied["step"])
    return copied


def _validate_artifact_step(step: Any) -> None:
    is_number = isinstance(step, (int, float)) and not isinstance(step, bool)
    if not is_number or not math.isfinite(float(step)):
        raise RuntimeError("artifact step must be a finite number")


class ExperimentClient:
    """Thin client for experiment lineage endpoints.

    Read helpers return raw decoded JSON (dict/list) and only perform GETs.
    Explicit mutators (`add_note`, `decide`, `add_artifact`, `add_checkpoint`)
    write to server state and are named accordingly. Name-or-id refs are
    resolved against ``GET /api/experiments`` before detail requests.
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

    def _request(self, path: str, method: str, body: Optional[Any] = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
        }
        if data is not None:
            headers["Content-Type"] = "application/json"

        req = Request(
            f"{self.server}/api{path}",
            data=data,
            method=method,
            headers=headers,
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

    def _get(self, path: str) -> Any:
        return self._request(path, method="GET")

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

    def _get_allow_http_error(self, path: str) -> Any:
        """Like :meth:`_get`, but lets ``HTTPError`` propagate.

        This is intentionally narrow in scope: only callers that need to branch
        on non-200 HTTP status codes (recommendation endpoint probing/fallback)
        should use it. Regular call sites should keep using :meth:`_get` so
        they get the same error shape as existing users expect.
        """
        req = Request(
            f"{self.server}/api{path}",
            method="GET",
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/json",
            },
        )
        with urlopen(req, timeout=self.timeout) as resp:  # noqa: S310
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else None

    def recommend(self, ref: str, *, refresh: bool = False) -> Any:
        """Get a recommendation for a single experiment.

        The canonical route is ``/experiments/<id>/recommendation``. If that
        endpoint is missing (HTTP 404), this method falls back to
        ``/experiments/<id>/summary`` and returns ``summary["recommendation"]``.
        """
        exp = self.resolve(ref, refresh=refresh)
        exp_id = exp["id"]
        try:
            return self._get_allow_http_error(f"/experiments/{exp_id}/recommendation")
        except HTTPError as exc:
            if exc.code != 404:
                body = exc.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"HTTP {exc.code} on /experiments/{exp_id}/recommendation: {body}") from exc
            summary = self._get(f"/experiments/{exp_id}/summary")
            if not isinstance(summary, dict):
                raise RuntimeError(
                    f"unexpected /experiments/{exp_id}/summary response shape: expected object"
                )
            if "recommendation" not in summary:
                raise RuntimeError(
                    "summary response is missing required field: recommendation"
                )
            return summary["recommendation"]

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

    def add_note(
        self,
        ref: str,
        message: str,
        *,
        task_id: Optional[str] = None,
        data: Optional[Mapping[str, Any]] = None,
        refresh: bool = False,
    ) -> Any:
        """POST /api/experiments/<id>/events with kind note.

        Mutates server state by creating a new note event on the experiment.
        Use this helper when caller intent is explicitly to write a note.
        """
        _validate_event_message(message)
        if data is not None and not isinstance(data, Mapping):
            raise RuntimeError(f"note data must be a mapping, got {type(data).__name__}")
        exp = self.resolve(ref, refresh=refresh)
        body: dict[str, Any] = {"kind": "note", "message": message}
        if task_id is not None:
            body["task_id"] = task_id
        if data is not None:
            body["data"] = dict(data)
        return self._request(f"/experiments/{exp['id']}/events", method="POST", body=body)

    def decide(
        self,
        ref: str,
        decision: str,
        reason: str,
        *,
        refresh: bool = False,
    ) -> Any:
        """PATCH /api/experiments/<id>/decision.

        Mutates server state by setting experiment decision and reason.
        """
        if decision not in DECISION_WRITE_CHOICES:
            raise RuntimeError(
                f"decision must be one of {list(DECISION_WRITE_CHOICES)}, got {decision!r}"
            )
        _validate_event_message(reason, "reason")

        exp = self.resolve(ref, refresh=refresh)
        body = {"decision": decision, "reason": reason}
        return self._request(f"/experiments/{exp['id']}/decision", method="PATCH", body=body)

    def add_artifact(
        self,
        ref: str,
        locator: str,
        *,
        artifact_type: Optional[str] = None,
        name: Optional[str] = None,
        task_id: Optional[str] = None,
        step: Optional[Any] = None,
        data: Optional[Mapping[str, Any]] = None,
        message: Optional[str] = None,
        refresh: bool = False,
    ) -> Any:
        """POST /api/experiments/<id>/events with kind artifact.

        Builds the payload used by ``alch experiments artifact`` and posts to the
        same endpoint. Locator is mapped to ``data.path`` unless it looks like URI.
        Extra data is merged first and can be overridden by locator/type/name/step.
        """
        if not locator or not locator.strip():
            raise RuntimeError("artifact locator must be a non-empty path or URI")

        payload_data = _copy_event_data(data, label="artifact")

        if artifact_type is not None and artifact_type not in ARTIFACT_TYPES:
            raise RuntimeError(
                f"artifact_type must be one of {list(ARTIFACT_TYPES)}, got {artifact_type!r}"
            )

        if "://" in locator:
            payload_data["uri"] = locator
        else:
            payload_data["path"] = locator
        if artifact_type is not None:
            payload_data["artifact_type"] = artifact_type
        if name is not None:
            payload_data["name"] = name
        if step is not None:
            _validate_artifact_step(step)
            payload_data["step"] = step
        if message is not None:
            _validate_event_message(message)

        exp = self.resolve(ref, refresh=refresh)
        return self._request(
            f"/experiments/{exp['id']}/events",
            method="POST",
            body={
                "kind": "artifact",
                "message": (f"Artifact: {name or locator}" if message is None else message),
                "data": payload_data,
                **({"task_id": task_id} if task_id is not None else {}),
            },
        )

    def add_checkpoint(
        self,
        ref: str,
        locator: str,
        *,
        name: Optional[str] = None,
        task_id: Optional[str] = None,
        step: Optional[Any] = None,
        data: Optional[Mapping[str, Any]] = None,
        message: Optional[str] = None,
        refresh: bool = False,
    ) -> Any:
        """POST /api/experiments/<id>/events with kind checkpoint.

        Same payload shape as ``add_artifact`` but default type/message are
        checkpoint-specific.
        """
        if not locator or not locator.strip():
            raise RuntimeError("artifact locator must be a non-empty path or URI")

        payload_data = _copy_event_data(data, label="artifact")

        if "://" in locator:
            payload_data["uri"] = locator
        else:
            payload_data["path"] = locator
        payload_data["artifact_type"] = "checkpoint"
        if name is not None:
            payload_data["name"] = name
        if step is not None:
            _validate_artifact_step(step)
            payload_data["step"] = step
        if message is not None:
            _validate_event_message(message)

        exp = self.resolve(ref, refresh=refresh)
        return self._request(
            f"/experiments/{exp['id']}/events",
            method="POST",
            body={
                "kind": "checkpoint",
                "message": (f"Checkpoint: {name or locator}" if message is None else message),
                "data": payload_data,
                **({"task_id": task_id} if task_id is not None else {}),
            },
        )

    def research_report_markdown(
        self,
        *,
        family: Optional[str] = None,
        decision: Optional[str] = None,
        status: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> str:
        """Fetch the research report and render it as Markdown.

        Convenience wrapper around :meth:`research_report` plus
        :func:`render_research_report_markdown`. One GET request total —
        the rendering is local and side-effect-free.
        """
        report = self.research_report(
            family=family, decision=decision, status=status, limit=limit
        )
        if not isinstance(report, Mapping):
            raise RuntimeError(
                "unexpected research-report response shape: expected object, "
                f"got {type(report).__name__}"
            )
        return render_research_report_markdown(report)

    def research_report(
        self,
        *,
        family: Optional[str] = None,
        decision: Optional[str] = None,
        status: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Any:
        """GET /api/experiments/research-report.

        Read-only family/decision/status rollup. Returns the report payload
        (filters, counts, metric, leaderboard, experiments). Pass
        ``decision="none"`` to select undecided experiments. ``limit`` is
        clamped server-side (default 50, cap 200).
        """
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
        if limit is not None:
            if not isinstance(limit, int) or limit <= 0:
                raise RuntimeError(f"limit must be a positive integer, got {limit!r}")
            params["limit"] = str(limit)
        path = "/experiments/research-report"
        if params:
            path += f"?{urlencode(params)}"
        return self._get(path)

    def research_bundle(self, ref: str, *, refresh: bool = False) -> Any:
        """GET /api/experiments/<id>/research-bundle.

        One-shot read-only export of decision-relevant context: experiment
        detail, summary, config diff, manifest (best-effort), full timeline,
        decision, and artifacts. Intended for notebook handoff or batch
        export, not for replacing W&B-style streaming.
        """
        exp = self.resolve(ref, refresh=refresh)
        return self._get(f"/experiments/{exp['id']}/research-bundle")

    def research_bundle_markdown(self, ref: str, *, refresh: bool = False) -> str:
        """Fetch the research bundle and render it as Markdown.

        Convenience wrapper around :meth:`research_bundle` plus
        :func:`render_research_bundle_markdown`. One GET request total — the
        rendering is local and side-effect-free.
        """
        bundle = self.research_bundle(ref, refresh=refresh)
        if not isinstance(bundle, Mapping):
            raise RuntimeError(
                "unexpected research-bundle response shape: expected object, "
                f"got {type(bundle).__name__}"
            )
        return render_research_bundle_markdown(bundle)

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

    def replication_plan(
        self,
        ref: str,
        *,
        set_overrides: Optional[Mapping[str, Any]] = None,
        unset: Iterable[str] = (),
        reason: Optional[str] = None,
        name: Optional[str] = None,
    ) -> dict[str, Any]:
        """Build a local replication manifest without submitting anything.

        Mirrors ``fork_plan`` exactly, but uses a ``replication`` naming scheme
        for downstream tooling. This method performs only GET requests.
        """
        exp = self.resolve(ref)
        detail = self._get(f"/experiments/{exp['id']}")
        base_config = detail.get("config") if isinstance(detail, dict) else None
        proposed, diff = _apply_flat_overrides(
            base_config or {}, set_overrides or {}, list(unset)
        )
        parent_name = detail.get("name") or exp.get("name")
        return {
            "kind": "replication-plan",
            "dry_run": True,
            "parent": {
                "id": detail.get("id") or exp.get("id"),
                "name": parent_name,
                "family": detail.get("family"),
            },
            "suggested_name": name or f"{parent_name}-replication",
            "reason": reason or "",
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


def _md_escape_cell(value: Any) -> str:
    """Format a value safely for inclusion in a Markdown table cell."""
    if value is None:
        return "-"
    text = str(value)
    # Pipes break table layout; newlines collapse rows. Escape both.
    return text.replace("\\", "\\\\").replace("|", "\\|").replace("\n", " ").replace("\r", " ")


def _md_format_number(value: Any) -> str:
    """Format a metric value compactly without losing precision unexpectedly."""
    if value is None:
        return "-"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value:  # NaN
            return "NaN"
        if value in (float("inf"), float("-inf")):
            return "inf" if value > 0 else "-inf"
        # 6 significant digits, trim trailing zeros.
        text = f"{value:.6g}"
        return text
    return str(value)


def _md_format_counts(counts: Mapping[str, Any]) -> str:
    if not counts:
        return "_(none)_"
    return ", ".join(f"{k}={counts[k]}" for k in sorted(counts.keys()))


def _md_format_task_counts(task_counts: Any) -> str:
    if not isinstance(task_counts, Mapping) or not task_counts:
        return "-"
    return ", ".join(f"{k}={task_counts[k]}" for k in sorted(task_counts.keys()))


def _md_format_primary_metric(primary_metric: Any) -> str:
    if not isinstance(primary_metric, Mapping):
        return "-"
    name = primary_metric.get("metric") or primary_metric.get("name")
    value = primary_metric.get("best") if "best" in primary_metric else primary_metric.get("value")
    if name is None and value is None:
        return "-"
    if name is None:
        return _md_format_number(value)
    return f"{name}={_md_format_number(value)}"


def _md_format_recent_events(events: Any) -> str:
    if not isinstance(events, list) or not events:
        return "-"
    parts: list[str] = []
    for evt in events:
        if not isinstance(evt, Mapping):
            continue
        kind = evt.get("kind") or evt.get("type") or "event"
        ts = evt.get("created_at") or evt.get("at") or evt.get("ts")
        if ts:
            parts.append(f"{kind}@{ts}")
        else:
            parts.append(str(kind))
    if not parts:
        return "-"
    return "; ".join(parts)


def _md_filter_value(value: Any) -> str:
    if value is None or value == "":
        return "*all*"
    return str(value)


def _bundle_get(mapping: Mapping[str, Any], *keys: str) -> Any:
    value: Any = mapping
    for key in keys:
        if not isinstance(value, Mapping):
            return None
        value = value.get(key)
    return value


def _bundle_locator(artifact: Mapping[str, Any]) -> str:
    data = artifact.get("data") if isinstance(artifact.get("data"), Mapping) else {}
    if not isinstance(data, Mapping):
        return "-"
    return (
        data.get("uri")
        or data.get("path")
        or data.get("locator")
        or data.get("source")
        or "-"
    )


def _md_format_mapping_entries(mapping: Mapping[str, Any] | Any) -> str:
    if not isinstance(mapping, Mapping) or not mapping:
        return "-"
    return ", ".join(
        f"{_md_escape_cell(k)}={_md_format_number(v)}" for k, v in sorted(mapping.items(), key=lambda item: str(item[0]))
    )


def _md_pick_first_dict(*candidates: Any) -> dict[str, Any] | None:
    for candidate in candidates:
        if isinstance(candidate, Mapping) and candidate:
            return dict(candidate)
    return None


def _safe_recent_events(events: Any, limit: int = 8) -> list[dict[str, Any]]:
    if not isinstance(events, list):
        return []
    selected: list[dict[str, Any]] = []
    for event in events[:limit]:
        if not isinstance(event, Mapping):
            continue
        selected.append(dict(event))
    return selected


def render_research_bundle_markdown(bundle: Mapping[str, Any]) -> str:
    """Render a research-bundle payload as Markdown.

    Pure formatter — no I/O, no network. The output is deterministic given
    the input (no clock reads, no random ordering).
    """
    if not isinstance(bundle, Mapping):
        raise TypeError(
            f"render_research_bundle_markdown expects a mapping, got {type(bundle).__name__}"
        )

    experiment = bundle.get("experiment") if isinstance(bundle.get("experiment"), Mapping) else {}
    summary = bundle.get("summary") if isinstance(bundle.get("summary"), Mapping) else {}
    decision = bundle.get("decision") if isinstance(bundle.get("decision"), Mapping) else {}
    diff = bundle.get("diff") if isinstance(bundle.get("diff"), Mapping) else {}
    manifest = bundle.get("manifest") if isinstance(bundle.get("manifest"), Mapping) else {}
    timeline = bundle.get("timeline") if isinstance(bundle.get("timeline"), Mapping) else {}
    artifacts = bundle.get("artifacts") if isinstance(bundle.get("artifacts"), list) else []

    exp_name = experiment.get("name") or experiment.get("id") or "(unnamed)"
    exp_id = experiment.get("id")
    family = experiment.get("family")
    status = experiment.get("status")
    title = f"{exp_name} ({exp_id})" if exp_id else exp_name
    if title == "(unnamed)" and not exp_id:
        title = "unknown"

    lines: list[str] = [f"# Research Bundle: {title}"]
    lines.append("")
    lines.append("## Experiment")
    lines.append(f"- id: {_md_escape_cell(exp_id or '-')}")
    lines.append(f"- family: {_md_escape_cell(family or '-')}")
    lines.append(f"- status: {_md_escape_cell(status or '-')}")
    lines.append(f"- generated_at: {_md_escape_cell(bundle.get('generated_at') or '-')}")
    lines.append("")

    lines.append("## Decision")
    if decision:
        lines.append(f"- decision: {_md_escape_cell(decision.get('decision') or '-')}")
        lines.append(f"- reason: {_md_escape_cell(decision.get('reason') or '-')}")
        if decision.get("decided_at"):
            lines.append(f"- decided_at: {_md_escape_cell(decision.get('decided_at'))}")
    else:
        lines.append("- no decision recorded")
    lines.append("")

    recommendation = _bundle_get(summary, "recommendation") if isinstance(summary, Mapping) else None
    lines.append("## Recommendation")
    if isinstance(recommendation, Mapping):
        recommendation_rows = [
            "action",
            "verdict",
            "reason",
            "metric",
            "value",
            "baseline_value",
            "delta",
            "direction",
            "evidence_quality",
            "evidence_reason",
            "sample_count",
            "comparable_count",
            "baseline_source",
        ]
        has_any = False
        for key in recommendation_rows:
            if recommendation.get(key) is None:
                continue
            has_any = True
            lines.append(f"- {key}: {_md_escape_cell(_md_format_number(recommendation.get(key)))}")
        if not has_any:
            lines.append("- no recommendation details available")
    else:
        lines.append("- no recommendation available")
    lines.append("")

    lines.append("## Metrics")
    primary_metric = _bundle_get(summary, "primary_metric")
    if isinstance(primary_metric, Mapping):
        lines.append(f"- primary metric: {_md_escape_cell(_md_format_primary_metric(primary_metric))}")
    elif isinstance(summary.get("metric"), Mapping):
        lines.append(f"- primary metric: {_md_escape_cell(_md_format_primary_metric(summary['metric']))}")
    else:
        lines.append("- primary metric: -")

    best_metrics = _bundle_get(summary, "best_metrics")
    if isinstance(best_metrics, Mapping) and best_metrics:
        lines.append(f"- best metrics: {_md_format_mapping_entries(best_metrics)}")
    elif isinstance(best_metrics, (list, tuple)) and best_metrics:
        lines.append(
            "- best metrics: "
            + _md_format_mapping_entries({str(i): v for i, v in enumerate(best_metrics)})
        )
    else:
        lines.append("- best metrics: -")

    validation = _bundle_get(summary, "validation")
    if isinstance(validation, Mapping) and validation:
        lines.append(f"- validation: {_md_format_mapping_entries(validation)}")
    elif validation is not None:
        lines.append(f"- validation: {_md_escape_cell(validation)}")
    else:
        lines.append("- validation: -")
    lines.append("")

    lines.append("## Config diff summary")
    config_diff = _md_pick_first_dict(
        _bundle_get(diff, "config_diff_summary"),
        _bundle_get(diff, "config_change_summary"),
        _bundle_get(summary, "diff_summary"),
        _bundle_get(summary, "config_diff"),
        _bundle_get(summary, "config_diff_summary"),
        _bundle_get(manifest, "config_diff"),
    )
    if config_diff:
        has_table = False
        for key, value in sorted(config_diff.items(), key=lambda item: str(item[0])):
            if isinstance(value, Mapping):
                before = _md_format_number(value.get("before"))
                after = _md_format_number(value.get("after"))
                op = _md_format_number(value.get("op"))
                if not has_table:
                    lines.append("| Key | Before | After | Op |")
                    lines.append("|-----|--------|-------|----|")
                    has_table = True
                lines.append(f"| {_md_escape_cell(key)} | {before} | {after} | {op} |")
            else:
                if not has_table:
                    lines.append("| Key | Value |")
                    lines.append("|-----|-------|")
                    has_table = True
                lines.append(f"| {_md_escape_cell(key)} | {_md_format_number(value)} |")
        if not has_table:
            lines.append("- no config diff entries")
    else:
        lines.append("- no config diff summary")
    lines.append("")

    lines.append("## Artifacts")
    if artifacts:
        lines.append("| Kind | Name | Locator | Step |")
        lines.append("|------|------|---------|------|")
        for artifact in artifacts:
            if not isinstance(artifact, Mapping):
                continue
            artifact_kind = _md_escape_cell(artifact.get("kind") or "artifact")
            data = artifact.get("data") if isinstance(artifact.get("data"), Mapping) else {}
            locator = _md_escape_cell(_bundle_locator(artifact))
            name = _md_escape_cell(
                (data.get("name") if isinstance(data, Mapping) else None)
                or artifact.get("name")
                or "-"
            )
            step = _md_format_number((data.get("step") if isinstance(data, Mapping) else None))
            lines.append(f"| {artifact_kind} | {name} | {locator} | {step} |")
    else:
        lines.append("- no artifacts")
    lines.append("")

    lines.append("## Recent timeline events")
    recent_events = _safe_recent_events(_bundle_get(timeline, "events"), limit=8)
    if not recent_events:
        lines.append("- no timeline events")
    else:
        for event in recent_events:
            kind = event.get("kind") or event.get("type") or "event"
            ts = event.get("created_at") or event.get("timestamp") or event.get("ts")
            msg = event.get("message")
            if ts:
                if msg is not None:
                    lines.append(f"- {ts}: {_md_escape_cell(kind)} — {_md_escape_cell(msg)}")
                else:
                    lines.append(f"- {ts}: {_md_escape_cell(kind)}")
            elif msg is not None:
                lines.append(f"- {_md_escape_cell(kind)} — {_md_escape_cell(msg)}")
            else:
                lines.append(f"- {_md_escape_cell(kind)}")

    return "\n".join(lines).rstrip() + "\n"


def render_research_report_markdown(report: Mapping[str, Any]) -> str:
    """Render a research-report JSON payload as Markdown.

    Pure formatter — no I/O, no network. The output is deterministic given
    the input (no clock reads, no random ordering). Designed for handing
    family-level experiment status off into Discord, notes, or PR
    descriptions without paging through the live dashboard.
    """
    if not isinstance(report, Mapping):
        raise TypeError(
            f"render_research_report_markdown expects a mapping, got {type(report).__name__}"
        )

    lines: list[str] = ["# Experiment Research Report", ""]

    filters = report.get("filters") if isinstance(report.get("filters"), Mapping) else {}
    lines.append("## Filters")
    lines.append("")
    lines.append(f"- family: {_md_filter_value(filters.get('family'))}")
    lines.append(f"- decision: {_md_filter_value(filters.get('decision'))}")
    lines.append(f"- status: {_md_filter_value(filters.get('status'))}")
    limit = filters.get("limit")
    lines.append(f"- limit: {limit if limit is not None else '*default*'}")
    generated_at = report.get("generated_at")
    if generated_at:
        lines.append(f"- generated_at: {generated_at}")
    lines.append("")

    counts = report.get("counts") if isinstance(report.get("counts"), Mapping) else {}
    by_status = counts.get("by_status") if isinstance(counts.get("by_status"), Mapping) else {}
    by_decision = counts.get("by_decision") if isinstance(counts.get("by_decision"), Mapping) else {}
    lines.append("## Counts")
    lines.append("")
    lines.append(f"- total: {counts.get('total', 0)}")
    lines.append(f"- by_status: {_md_format_counts(by_status)}")
    lines.append(f"- by_decision: {_md_format_counts(by_decision)}")
    lines.append("")

    lines.append("## Metric")
    lines.append("")
    metric = report.get("metric")
    if isinstance(metric, Mapping) and metric.get("name"):
        lines.append(f"- name: {metric.get('name')}")
        lines.append(f"- direction: {metric.get('direction') or '-'}")
    else:
        lines.append("_No goal metric declared by any experiment in this slice._")
    lines.append("")

    lines.append("## Leaderboard")
    lines.append("")
    leaderboard = report.get("leaderboard") if isinstance(report.get("leaderboard"), list) else []
    if leaderboard:
        lines.append("| Rank | Experiment | Status | Decision | Metric | Value |")
        lines.append("|------|------------|--------|----------|--------|-------|")
        for row in leaderboard:
            if not isinstance(row, Mapping):
                continue
            lines.append(
                "| {rank} | {name} | {status} | {decision} | {metric} | {value} |".format(
                    rank=_md_escape_cell(row.get("rank")),
                    name=_md_escape_cell(row.get("name") or row.get("id")),
                    status=_md_escape_cell(row.get("status")),
                    decision=_md_escape_cell(row.get("decision")),
                    metric=_md_escape_cell(row.get("metric")),
                    value=_md_escape_cell(_md_format_number(row.get("value"))),
                )
            )
    else:
        lines.append("_Empty — no experiment in this slice has a numeric goal-metric value yet._")
    lines.append("")

    lines.append("## Experiments")
    lines.append("")
    experiments = report.get("experiments") if isinstance(report.get("experiments"), list) else []
    if experiments:
        lines.append(
            "| Name | Family | Status | Decision | Task counts | Primary metric "
            "| Artifacts | Checkpoints | Recent events |"
        )
        lines.append(
            "|------|--------|--------|----------|-------------|----------------"
            "|-----------|-------------|---------------|"
        )
        for exp in experiments:
            if not isinstance(exp, Mapping):
                continue
            lines.append(
                "| {name} | {family} | {status} | {decision} | {tasks} | {metric} "
                "| {artifacts} | {checkpoints} | {events} |".format(
                    name=_md_escape_cell(exp.get("name") or exp.get("id")),
                    family=_md_escape_cell(exp.get("family")),
                    status=_md_escape_cell(exp.get("status")),
                    decision=_md_escape_cell(exp.get("decision")),
                    tasks=_md_escape_cell(_md_format_task_counts(exp.get("task_counts"))),
                    metric=_md_escape_cell(_md_format_primary_metric(exp.get("primary_metric"))),
                    artifacts=_md_escape_cell(exp.get("artifact_count", 0)),
                    checkpoints=_md_escape_cell(exp.get("checkpoint_count", 0)),
                    events=_md_escape_cell(_md_format_recent_events(exp.get("recent_events"))),
                )
            )
    else:
        lines.append("_No experiments match the current filters._")
    lines.append("")

    return "\n".join(lines).rstrip() + "\n"


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
                f"experiment plan overrides do not support nested keys; got {key!r}"
            )
        if not key:
            raise RuntimeError("experiment plan override key must be non-empty")
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
            raise RuntimeError("experiment plan unset key must be non-empty")
        if "." in key:
            raise RuntimeError(
                f"experiment plan overrides do not support nested keys; got {key!r}"
            )
        if key in proposed:
            diff[key] = {"before": base.get(key), "after": None, "op": "unset"}
            proposed.pop(key, None)
    return proposed, diff
