from __future__ import annotations

import json
import sqlite3

from alchemy_sdk.operator_config import resolve_server, resolve_token


def _write_token_db(path, token: str) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.execute("create table tokens (token text not null)")
        connection.execute("insert into tokens(token) values (?)", (token,))
        connection.commit()
    finally:
        connection.close()


def test_operator_config_resolves_server_and_local_state_token(monkeypatch, tmp_path):
    state_db = tmp_path / "state.db"
    config_path = tmp_path / "alch.json"
    _write_token_db(state_db, "local-token")
    config_path.write_text(
        json.dumps({"server": "http://alchemy", "state_db": str(state_db)}),
        encoding="utf-8",
    )
    monkeypatch.setenv("ALCHEMY_CLI_CONFIG", str(config_path))
    monkeypatch.delenv("ALCHEMY_SERVER", raising=False)
    monkeypatch.delenv("ALCHEMY_SERVER_URL", raising=False)
    monkeypatch.delenv("ALCHEMY_TOKEN", raising=False)
    monkeypatch.delenv("ALCHEMY_STATE_DB", raising=False)

    assert resolve_server() == "http://alchemy"
    assert resolve_token() == "local-token"


def test_explicit_and_environment_credentials_take_precedence(monkeypatch, tmp_path):
    config_path = tmp_path / "alch.json"
    config_path.write_text(
        json.dumps({"server": "http://configured"}), encoding="utf-8"
    )
    monkeypatch.setenv("ALCHEMY_CLI_CONFIG", str(config_path))
    monkeypatch.setenv("ALCHEMY_SERVER_URL", "http://environment")
    monkeypatch.setenv("ALCHEMY_TOKEN", "environment-token")

    assert resolve_server("http://explicit") == "http://explicit"
    assert resolve_server() == "http://environment"
    assert resolve_token("explicit-token") == "explicit-token"
    assert resolve_token() == "environment-token"
