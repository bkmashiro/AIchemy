"""Unit tests for alchemy_sdk.client.Alchemy."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from alchemy_sdk import Alchemy
from alchemy_sdk.transport import HttpTransport


def test_constructor_accepts_explicit_server(monkeypatch):
    monkeypatch.setenv("ALCHEMY_TASK_ID", "task-1")
    monkeypatch.delenv("ALCHEMY_STUB_SOCKET", raising=False)
    monkeypatch.delenv("ALCHEMY_SERVER", raising=False)

    al = Alchemy(server="http://alchemy.local")

    assert isinstance(al._transport, HttpTransport)
    assert al._transport._server == "http://alchemy.local"


def test_log_filters_non_numeric_metrics(monkeypatch):
    monkeypatch.setenv("ALCHEMY_TASK_ID", "task-1")
    monkeypatch.delenv("ALCHEMY_STUB_SOCKET", raising=False)
    monkeypatch.delenv("ALCHEMY_SERVER", raising=False)

    with patch("alchemy_sdk.client.make_transport") as make_transport:
        transport = MagicMock()
        make_transport.return_value = transport
        al = Alchemy()
        al.log(step=7, total=10, loss=0.25, metrics={
            "mse": 0.1,
            "count": 2,
            "flag": True,
            "policy": "random",
            "nested": {"bad": 1},
        })

    payload = transport.send.call_args.args[0]
    assert payload["loss"] == 0.25
    assert payload["metrics"] == {"mse": 0.1, "count": 2.0, "flag": 1.0}


def test_result_artifact_reports_path_result_and_schema(monkeypatch):
    monkeypatch.setenv("ALCHEMY_TASK_ID", "task-1")
    monkeypatch.delenv("ALCHEMY_STUB_SOCKET", raising=False)
    monkeypatch.delenv("ALCHEMY_SERVER", raising=False)

    with patch("alchemy_sdk.client.make_transport") as make_transport:
        transport = MagicMock()
        make_transport.return_value = transport
        al = Alchemy()
        al.result_artifact(
            path="/tmp/run/results.json",
            result={"score": 0.7},
            schema={"score": "float"},
        )

    assert transport.send.call_args.args[0] == {
        "type": "result",
        "path": "/tmp/run/results.json",
        "result": {"score": 0.7},
        "schema": {"score": "float"},
    }
