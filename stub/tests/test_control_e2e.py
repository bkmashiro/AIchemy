"""Cross-package control round trip over the real SDK and task Unix sockets."""
import asyncio
import os
import sys
import time
from pathlib import Path

import pytest

SDK = Path(__file__).resolve().parents[2] / "sdk"
sys.path.insert(0, str(SDK))
from alchemy_sdk.transport import UnixSocketTransport  # noqa: E402
from alchemy_stub import task_socket as task_socket_module  # noqa: E402
from alchemy_stub.task_socket import TaskSocket  # noqa: E402


async def wait_until(predicate, timeout=2.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("timed out waiting for socket control event")


@pytest.mark.asyncio
async def test_real_sdk_task_socket_control_round_trip_and_late_connect(tmp_path, monkeypatch):
    socket_dir = Path(os.environ.get("TMPDIR", str(tmp_path))) / f"control-{os.getpid()}"
    socket_dir.mkdir(exist_ok=True)
    monkeypatch.setattr(task_socket_module, "SOCKET_DIR", str(socket_dir))
    received, completed, saved = [], [], []
    completion_attempts = 0

    async def on_received(task_id, request_id, signal):
        received.append((request_id, signal))

    async def on_completed(task_id, request_id, path):
        nonlocal completion_attempts
        completion_attempts += 1
        if completion_attempts == 1:
            raise ConnectionError("simulate lost server completion ACK")
        completed.append((request_id, path))

    async def on_checkpoint(task_id, path, request_id=None):
        saved.append((path, request_id))

    server = TaskSocket(
        f"c{os.getpid()}", 123, on_checkpoint=on_checkpoint,
        on_control_received=on_received, on_control_completed=on_completed,
    )
    await server.start()
    client = None
    try:
        # Signal before SDK connects: TaskSocket retains the request for late connect.
        assert await server.send_control("should_checkpoint", "ckpt-42")
        client = UnixSocketTransport(str(socket_dir / f"alchemy_task_c{os.getpid()}.sock"), f"c{os.getpid()}")
        await wait_until(lambda: client.should_checkpoint())
        assert client.should_checkpoint() is False
        await wait_until(lambda: received.count(("ckpt-42", "should_checkpoint")) >= 1)
        checkpoint_id = client.checkpoint_request_id()
        client.remember_checkpoint("ckpt-42", "/runs/step-42.pt")
        client.send({"type": "checkpoint", "request_id": checkpoint_id, "path": "/runs/step-42.pt"})
        await wait_until(lambda: completed == [("ckpt-42", "/runs/step-42.pt")], timeout=6)
        assert saved == [("/runs/step-42.pt", "ckpt-42"), ("/runs/step-42.pt", "ckpt-42")]

        # Retrying the same ID neither creates a second delivery nor another save.
        assert await server.send_control("should_checkpoint", "ckpt-42")
        assert client.should_checkpoint() is False
        assert len(saved) == 2
        await server._handle_message('{"type":"checkpoint","request_id":"ckpt-42","path":"/runs/step-42.pt"}')
        await server._handle_message('{"type":"checkpoint","request_id":"unknown","path":"/runs/bogus.pt"}')
        assert len(saved) == 2

        # Stop remains a level-triggered intent, with one SDK receipt notification.
        assert await server.send_control("should_stop", "stop-9")
        await wait_until(lambda: client.should_stop())
        assert client.should_stop() is True
        await wait_until(lambda: ("stop-9", "should_stop") in received)
    finally:
        if client:
            client.close()
        await server.stop()
        socket_dir.rmdir()
