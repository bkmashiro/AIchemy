"""Unit tests for task preflight checks."""
from __future__ import annotations

import shlex
import subprocess

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
async def test_run_dir_nested_parent_is_created_when_missing(tmp_path):
    run_dir = tmp_path / "runs" / "2026" / "06" / "task-1"

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
    assert run_dir.exists()
    assert run_dir.is_dir()
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


@pytest.mark.asyncio
async def test_output_preflight_does_not_create_missing_parent(tmp_path):
    output = tmp_path / "reserved" / "result.json"

    result = await run_preflight(
        task={
            "task_id": "task-1",
            "command": "echo ok",
            "outputs": [str(output)],
        },
        stub_id="stub-1",
        stub_default_cwd=str(tmp_path),
        server_url="http://127.0.0.1:9",
        token="token",
    )

    assert result.ok
    assert not output.parent.exists()

    guard = subprocess.run(
        ["/bin/bash", "-lc", f"set -euo pipefail; test ! -e {shlex.quote(str(output.parent))}"],
        check=False,
    )
    assert guard.returncode == 0


@pytest.mark.asyncio
async def test_output_preflight_accepts_existing_empty_parent(tmp_path):
    output = tmp_path / "reserved" / "result.json"
    output.parent.mkdir()

    result = await run_preflight(
        task={
            "task_id": "task-1",
            "command": "echo ok",
            "outputs": [str(output)],
        },
        stub_id="stub-1",
        stub_default_cwd=str(tmp_path),
        server_url="http://127.0.0.1:9",
        token="token",
    )

    assert result.ok
    assert list(output.parent.iterdir()) == []


@pytest.mark.asyncio
async def test_output_preflight_rejects_unwritable_existing_parent(tmp_path):
    output = tmp_path / "read-only" / "result.json"
    output.parent.mkdir()
    output.parent.chmod(0o555)
    try:
        result = await run_preflight(
            task={
                "task_id": "task-1",
                "command": "echo ok",
                "outputs": [str(output)],
            },
            stub_id="stub-1",
            stub_default_cwd=str(tmp_path),
            server_url="http://127.0.0.1:9",
            token="token",
        )
    finally:
        output.parent.chmod(0o755)

    assert not result.ok
    assert "Output path ancestor not writable" in "; ".join(result.errors)
