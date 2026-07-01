"""Small-file RPC over the existing stub Socket.IO control channel."""
from __future__ import annotations

import base64
import hashlib
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .config import Config

_MAX_READ_BYTES = 1024 * 1024


def _request_id(data: dict[str, Any]) -> str:
    return str(data.get("request_id") or "")


def _safe_root(config: "Config") -> Path:
    return Path(config.default_output_dir or config.default_cwd or ".").expanduser().resolve()


def _resolve_relative(path: Any, root: Path) -> Path | str:
    if not isinstance(path, str) or not path:
        return "path_required"
    if path.startswith("/") or "\x00" in path:
        return "path_escape"
    target = (root / path).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        return "path_escape"
    return target


def _entry(path: Path) -> dict[str, Any]:
    if path.is_dir():
        return {"name": path.name, "type": "dir", "size": 0}
    return {"name": path.name, "type": "file", "size": path.stat().st_size}


async def handle_file_request(data: dict[str, Any], config: "Config") -> dict[str, Any]:
    request_id = _request_id(data)
    op = data.get("op")
    root = _safe_root(config)
    resolved = _resolve_relative(data.get("path"), root)
    if isinstance(resolved, str):
        return {"ok": False, "request_id": request_id, "error": resolved}
    rel_path = str(data.get("path"))

    if op not in {"stat", "list", "read"}:
        return {"ok": False, "request_id": request_id, "error": "invalid_op"}
    if not resolved.exists():
        return {"ok": False, "request_id": request_id, "error": "not_found"}

    if op == "stat":
        stat = resolved.stat()
        return {
            "ok": True,
            "request_id": request_id,
            "op": "stat",
            "path": rel_path,
            "type": "dir" if resolved.is_dir() else "file",
            "size": stat.st_size if resolved.is_file() else 0,
            "mtime": stat.st_mtime,
        }

    if op == "list":
        if not resolved.is_dir():
            return {"ok": False, "request_id": request_id, "error": "not_dir"}
        entries = [_entry(child) for child in sorted(resolved.iterdir(), key=lambda p: p.name)]
        return {"ok": True, "request_id": request_id, "op": "list", "path": rel_path, "entries": entries}

    if not resolved.is_file():
        return {"ok": False, "request_id": request_id, "error": "not_file"}
    max_bytes = min(max(int(data.get("max_bytes") or 64 * 1024), 1), _MAX_READ_BYTES)
    raw = resolved.read_bytes()
    truncated = len(raw) > max_bytes
    body = raw[:max_bytes]
    return {
        "ok": True,
        "request_id": request_id,
        "op": "read",
        "path": rel_path,
        "size": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "content_b64": base64.b64encode(body).decode("ascii"),
        "truncated": truncated,
    }
