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
