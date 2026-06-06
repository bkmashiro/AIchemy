"""Unit tests for task preflight checks."""
from __future__ import annotations

import pytest

from alchemy_stub.preflight import run_preflight


@pytest.mark.asyncio
async def test_run_dir_parent_is_created_when_missing(tmp_path):
    run_dir = tmp_path / "runs" / "task-1"

    result = await run_preflight(
        task={
            "task_id": "task-1",
            "command": "echo ok",
            "run_dir": str(run_dir),
            "fingerprint": "abc123",
        },
        stub_id="stub-1",
        stub_default_cwd=str(tmp_path),
        server_url="http://127.0.0.1:9",
        token="token",
    )

    assert result.ok
    assert (run_dir / ".alchemy_owner").exists()


@pytest.mark.asyncio
async def test_run_dir_parent_unwritable_fails(tmp_path):
    parent_file = tmp_path / "runs"
    parent_file.write_text("not a directory")

    result = await run_preflight(
        task={
            "task_id": "task-1",
            "command": "echo ok",
            "run_dir": str(parent_file / "task-1"),
            "fingerprint": "abc123",
        },
        stub_id="stub-1",
        stub_default_cwd=str(tmp_path),
        server_url="http://127.0.0.1:9",
        token="token",
    )

    assert not result.ok
    assert "run_dir parent not writable" in "; ".join(result.errors)
