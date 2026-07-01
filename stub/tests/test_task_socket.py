from __future__ import annotations

import pytest

from alchemy_stub.task_socket import TaskSocket


@pytest.mark.asyncio
async def test_task_socket_routes_result_messages():
    calls = []

    async def on_result(task_id, path, result, schema):
        calls.append((task_id, path, result, schema))

    socket = TaskSocket(task_id="task-1", pid=1234, on_result=on_result)

    await socket._handle_message(
        '{"type":"result","path":"/runs/task-1/results.json","result":{"score":0.7},"schema":{"score":"float"}}'
    )

    assert calls == [
        (
            "task-1",
            "/runs/task-1/results.json",
            {"score": 0.7},
            {"score": "float"},
        )
    ]
