"""Code-first managed research ledger blocks for SDK experiment files."""
from __future__ import annotations

import copy
import hashlib
import json
from typing import Any, Mapping

START = "# alchemy-ledger: start"
END = "# alchemy-ledger: end"


def _canonical(ledger: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "decisions": list(copy.deepcopy(ledger.get("decisions", []))),
        "notes": list(copy.deepcopy(ledger.get("notes", []))),
        "evidence": list(copy.deepcopy(ledger.get("evidence", []))),
    }


def render_ledger_block(ledger: Mapping[str, Any] | None = None) -> str:
    payload = _canonical(ledger or {})
    body = json.dumps(payload, indent=2, sort_keys=True)
    commented = "\n".join(f"# {line}" for line in body.splitlines())
    return f"{START}\n{commented}\n{END}"


def _block_bounds(text: str) -> tuple[int, int]:
    start = text.find(START)
    if start < 0:
        raise ValueError("alchemy ledger block not found")
    end = text.find(END, start)
    if end < 0:
        raise ValueError("alchemy ledger block end not found")
    return start, end + len(END)


def parse_ledger(text: str) -> dict[str, Any]:
    start, end = _block_bounds(text)
    block = text[start:end].splitlines()[1:-1]
    json_lines: list[str] = []
    for line in block:
        stripped = line.strip()
        if stripped.startswith("#"):
            stripped = stripped[1:]
            if stripped.startswith(" "):
                stripped = stripped[1:]
        json_lines.append(stripped)
    try:
        parsed = json.loads("\n".join(json_lines) or "{}")
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid alchemy ledger JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("alchemy ledger must be a JSON object")
    return _canonical(parsed)


def ledger_hash(ledger: Mapping[str, Any]) -> str:
    payload = json.dumps(_canonical(ledger), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def replace_ledger(text: str, ledger: Mapping[str, Any]) -> str:
    start, end = _block_bounds(text)
    return text[:start] + render_ledger_block(ledger) + text[end:]


def append_decision(
    ledger: Mapping[str, Any],
    *,
    decision_id: str,
    decision: str,
    reason: str | None = None,
    evidence: list[str] | None = None,
) -> dict[str, Any]:
    if not decision_id.strip():
        raise ValueError("decision_id must be non-empty")
    if decision not in {"keep", "try_more", "discard"}:
        raise ValueError("decision must be one of: keep, try_more, discard")
    next_ledger = _canonical(ledger)
    decisions = next_ledger["decisions"]
    if not any(item.get("id") == decision_id for item in decisions if isinstance(item, dict)):
        item: dict[str, Any] = {"id": decision_id, "decision": decision}
        if reason:
            item["reason"] = reason
        if evidence:
            item["evidence"] = list(evidence)
        decisions.append(item)
    evidence_rows = next_ledger["evidence"]
    known_refs = {row.get("ref") for row in evidence_rows if isinstance(row, dict)}
    for ref in evidence or []:
        if ref not in known_refs:
            evidence_rows.append({"ref": ref, "kind": "experiment"})
            known_refs.add(ref)
    return next_ledger


def append_comment(
    ledger: Mapping[str, Any],
    *,
    comment_id: str,
    comment: str,
    evidence: list[str] | None = None,
) -> dict[str, Any]:
    if not comment_id.strip():
        raise ValueError("comment_id must be non-empty")
    if not comment.strip():
        raise ValueError("comment must be non-empty")
    next_ledger = _canonical(ledger)
    notes = next_ledger["notes"]
    if not any(item.get("id") == comment_id for item in notes if isinstance(item, dict)):
        item: dict[str, Any] = {"id": comment_id, "comment": comment}
        if evidence:
            item["evidence"] = list(evidence)
        notes.append(item)
    evidence_rows = next_ledger["evidence"]
    known_refs = {row.get("ref") for row in evidence_rows if isinstance(row, dict)}
    for ref in evidence or []:
        if ref not in known_refs:
            evidence_rows.append({"ref": ref, "kind": "experiment"})
            known_refs.add(ref)
    return next_ledger
