"""Shared operator configuration and credential discovery for the SDK."""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Optional

DEFAULT_SERVER = "http://localhost:3002"


def config_path() -> Path:
    override = os.environ.get("ALCHEMY_CLI_CONFIG")
    if override:
        return Path(override).expanduser()
    base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "alchemy" / "alch.json"


def load_operator_config() -> dict[str, Any]:
    path = config_path()
    if not path.exists():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"invalid Alchemy operator config {path}: {exc}") from exc
    if not isinstance(loaded, dict):
        raise RuntimeError(
            f"invalid Alchemy operator config {path}: expected JSON object"
        )
    return loaded


def resolve_server(explicit: Optional[str] = None) -> str:
    config = load_operator_config()
    return str(
        explicit
        or os.environ.get("ALCHEMY_SERVER")
        or os.environ.get("ALCHEMY_SERVER_URL")
        or config.get("server")
        or DEFAULT_SERVER
    )


def _read_local_token(db_path: str) -> Optional[str]:
    path = Path(db_path).expanduser()
    if not path.is_file():
        return None
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            row = connection.execute("select token from tokens limit 1").fetchone()
        finally:
            connection.close()
    except sqlite3.Error as exc:
        raise RuntimeError(
            f"cannot read Alchemy operator credential from {path}: {exc}"
        ) from exc
    return str(row[0]) if row and row[0] else None


def resolve_token(explicit: Optional[str] = None) -> Optional[str]:
    if explicit:
        return explicit
    token = os.environ.get("ALCHEMY_TOKEN")
    if token:
        return token
    config = load_operator_config()
    state_db = os.environ.get("ALCHEMY_STATE_DB") or config.get("state_db")
    if not state_db:
        return None
    return _read_local_token(str(state_db))
