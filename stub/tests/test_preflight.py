"""Unit tests for task preflight checks."""
from __future__ import annotations

import asyncio
import multiprocessing
import shlex
import subprocess

import pytest

from alchemy_stub.preflight import run_preflight


def _preflight_process(run_dir, task_id, start, results):
    start.wait()
    result = asyncio.run(run_preflight(
        task={"task_id": task_id, "command": "echo ok", "run_dir": run_dir, "fingerprint": "same"},
        stub_id=f"stub-{task_id}",
        stub_default_cwd="/",
        server_url="http://127.0.0.1:9",
        token="token",
    ))
    results.put((task_id, result.ok, result.errors))


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


@pytest.mark.asyncio
async def test_same_owner_can_reclaim_existing_run_dir(tmp_path):
    run_dir = tmp_path / "runs" / "task-1"
    task = {"task_id": "task-1", "command": "echo ok", "run_dir": str(run_dir), "fingerprint": "fp"}
    args = dict(stub_id="stub-1", stub_default_cwd=str(tmp_path), server_url="http://127.0.0.1:9", token="token")

    assert (await run_preflight(task=task, **args)).ok
    assert (await run_preflight(task=task, **args)).ok


@pytest.mark.asyncio
async def test_other_owner_cannot_claim_existing_run_dir(tmp_path):
    run_dir = tmp_path / "runs" / "task-1"
    args = dict(stub_id="stub-1", stub_default_cwd=str(tmp_path), server_url="http://127.0.0.1:9", token="token")
    owner = {"task_id": "task-1", "command": "echo ok", "run_dir": str(run_dir), "fingerprint": "same-fp"}
    contender = {**owner, "task_id": "task-2"}

    assert (await run_preflight(task=owner, **args)).ok
    result = await run_preflight(task=contender, **args)
    assert not result.ok
    assert "claimed by task task-1" in "; ".join(result.errors)
    assert '"task_id": "task-1"' in (run_dir / ".alchemy_owner").read_text()


@pytest.mark.parametrize(
    "contender_stub,contender_fingerprint",
    [("stub-2", "same-fp"), ("stub-1", "different-fp")],
)
@pytest.mark.asyncio
async def test_same_task_id_with_different_owner_identity_is_rejected(
    tmp_path, contender_stub, contender_fingerprint
):
    run_dir = tmp_path / "runs" / "shared"
    owner_task = {"task_id": "task-shared", "command": "echo ok", "run_dir": str(run_dir), "fingerprint": "same-fp"}
    args = dict(stub_default_cwd=str(tmp_path), server_url="http://127.0.0.1:9", token="token")

    assert (await run_preflight(task=owner_task, stub_id="stub-1", **args)).ok
    contender = {**owner_task, "fingerprint": contender_fingerprint}
    result = await run_preflight(task=contender, stub_id=contender_stub, **args)

    assert not result.ok
    assert "run_dir already claimed" in "; ".join(result.errors)
    assert '"stub_id": "stub-1"' in (run_dir / ".alchemy_owner").read_text()


@pytest.mark.asyncio
async def test_run_dir_without_fingerprint_is_claimed_by_task_and_stub(tmp_path):
    run_dir = tmp_path / "runs" / "legacy"
    task = {"task_id": "task-legacy", "command": "echo ok", "run_dir": str(run_dir)}
    args = dict(stub_default_cwd=str(tmp_path), server_url="http://127.0.0.1:9", token="token")

    assert (await run_preflight(task=task, stub_id="stub-1", **args)).ok
    assert (await run_preflight(task=task, stub_id="stub-1", **args)).ok
    result = await run_preflight(task=task, stub_id="stub-2", **args)

    assert not result.ok
    assert '"stub_id": "stub-1"' in (run_dir / ".alchemy_owner").read_text()


@pytest.mark.asyncio
async def test_legacy_owner_without_fingerprint_remains_protected(tmp_path):
    run_dir = tmp_path / "runs" / "legacy-marker"
    run_dir.mkdir(parents=True)
    (run_dir / ".alchemy_owner").write_text('{"task_id":"task-legacy","stub_id":"stub-1"}')
    task = {"task_id": "task-legacy", "command": "echo ok", "run_dir": str(run_dir)}

    result = await run_preflight(
        task=task, stub_id="stub-1", stub_default_cwd=str(tmp_path),
        server_url="http://127.0.0.1:9", token="token",
    )

    assert not result.ok
    assert "already claimed by task task-legacy" in "; ".join(result.errors)


def test_two_processes_competing_for_run_dir_have_one_winner(tmp_path):
    run_dir = str(tmp_path / "shared" / "run")
    context = multiprocessing.get_context("spawn")
    start = context.Event()
    results = context.Queue()
    processes = [
        context.Process(target=_preflight_process, args=(run_dir, f"task-{index}", start, results))
        for index in range(2)
    ]
    for process in processes:
        process.start()
    start.set()
    outcomes = [results.get(timeout=20) for _ in processes]
    for process in processes:
        process.join(timeout=20)
        assert process.exitcode == 0

    assert sum(ok for _, ok, _ in outcomes) == 1
    winner = next(task_id for task_id, ok, _ in outcomes if ok)
    assert '"task_id": "' + winner + '"' in (tmp_path / "shared" / "run" / ".alchemy_owner").read_text()
