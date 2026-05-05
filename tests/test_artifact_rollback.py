"""Tests for Spec 2: Artifact Rollback on Failure.

Covers:
- _rollback_outputs: deletes files modified after task start, skips pre-existing ones
- _verify_outputs: warns (via log) when declared outputs are missing after success
- ProcessManager.start() accepts and stores the outputs list
- ProcessManager._check_completions() calls rollback on failure and verify on success
"""
from __future__ import annotations

import asyncio
import os
import time
import tempfile
import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from alchemy_stub.process_mgr import (
    ProcessInfo,
    ProcessManager,
    _rollback_outputs,
    _verify_outputs,
)


# ─── Unit tests for _rollback_outputs ────────────────────────────────────────


def test_rollback_deletes_file_created_after_start(tmp_path):
    """File created after task start should be deleted on failure."""
    output_file = tmp_path / "result.pt"
    task_start = time.time() - 1  # 1 second ago

    output_file.write_bytes(b"data")
    # mtime is now (after start) — should be deleted
    assert output_file.exists()

    _rollback_outputs("task-1", [str(output_file)], task_start)

    assert not output_file.exists()


def test_rollback_skips_file_existing_before_start(tmp_path):
    """File that pre-dates task start should NOT be deleted."""
    output_file = tmp_path / "preexisting.pt"
    output_file.write_bytes(b"old data")

    # Backdate mtime to before task start
    past = time.time() - 100
    os.utime(str(output_file), (past, past))
    task_start = time.time() - 50  # start 50s ago, file is 100s old

    _rollback_outputs("task-1", [str(output_file)], task_start)

    # File should still exist (pre-existing)
    assert output_file.exists()


def test_rollback_skips_nonexistent_file(tmp_path):
    """Non-existent file should not cause an error."""
    missing = str(tmp_path / "does_not_exist.pt")
    task_start = time.time() - 1

    # Should not raise
    _rollback_outputs("task-1", [missing], task_start)


def test_rollback_empty_outputs_is_noop():
    """Empty outputs list — no error, no file system access."""
    _rollback_outputs("task-1", [], time.time())


def test_rollback_logs_deletion(tmp_path, caplog):
    output_file = tmp_path / "result.pt"
    output_file.write_bytes(b"x")
    task_start = time.time() - 1

    with caplog.at_level(logging.INFO, logger="alchemy_stub.process_mgr"):
        _rollback_outputs("task-1", [str(output_file)], task_start)

    assert any("rollback" in r.message and "deleted" in r.message for r in caplog.records)


def test_rollback_handles_multiple_outputs(tmp_path):
    """Multiple outputs — each handled independently."""
    f1 = tmp_path / "out1.pt"
    f2 = tmp_path / "out2.pt"
    f3 = tmp_path / "out3.pt"  # pre-existing

    f1.write_bytes(b"a")
    f2.write_bytes(b"b")
    f3.write_bytes(b"old")

    task_start = time.time() - 1
    past = time.time() - 100
    os.utime(str(f3), (past, past))

    _rollback_outputs("task-1", [str(f1), str(f2), str(f3)], task_start)

    assert not f1.exists()
    assert not f2.exists()
    assert f3.exists()  # pre-existing, untouched


# ─── Unit tests for _verify_outputs ──────────────────────────────────────────


def test_verify_warns_on_missing_output(tmp_path, caplog):
    missing = str(tmp_path / "missing.pt")

    with caplog.at_level(logging.WARNING, logger="alchemy_stub.process_mgr"):
        _verify_outputs("task-1", [missing])

    assert any("missing" in r.message for r in caplog.records)


def test_verify_no_warning_when_output_present(tmp_path, caplog):
    output_file = tmp_path / "result.pt"
    output_file.write_bytes(b"ok")

    with caplog.at_level(logging.WARNING, logger="alchemy_stub.process_mgr"):
        _verify_outputs("task-1", [str(output_file)])

    assert not any("missing" in r.message for r in caplog.records)


def test_verify_empty_outputs_is_noop():
    _verify_outputs("task-1", [])


# ─── ProcessInfo stores outputs and start_time ────────────────────────────────


def test_process_info_stores_outputs():
    outputs = ["/tmp/out1.pt", "/tmp/out2.pt"]
    t = time.time()
    info = ProcessInfo(task_id="t1", pid=1234, outputs=outputs, start_time=t)
    assert info.outputs == outputs
    assert info.start_time == t


def test_process_info_defaults_empty_outputs():
    info = ProcessInfo(task_id="t1", pid=1234)
    assert info.outputs == []
    assert info.start_time > 0


# ─── ProcessManager integration: rollback called on failure ──────────────────


@pytest.fixture
def mgr(tmp_path):
    return ProcessManager(
        max_concurrent=2,
        pid_file=str(tmp_path / "tasks.json"),
    )


def test_process_mgr_rollback_on_failure(tmp_path, mgr):
    """On task failure, output files created after start are deleted."""
    output_file = tmp_path / "out.pt"
    failed_calls = []

    async def on_failed(task_id, exit_code, error, death_cause="code_error", has_checkpoint=False):
        failed_calls.append(task_id)

    mgr.on_failed = on_failed
    mgr.on_completed = AsyncMock()

    task_start = time.time() - 1
    info = ProcessInfo(
        task_id="task-fail",
        pid=99999,
        outputs=[str(output_file)],
        start_time=task_start,
    )
    output_file.write_bytes(b"partial data")  # created "after" start

    mgr._procs["task-fail"] = info

    async def _run():
        with patch.object(info, "poll", return_value=1):
            await mgr._check_completions()

    asyncio.run(_run())

    assert "task-fail" in failed_calls
    assert not output_file.exists(), "Output file should be deleted on failure"


def test_process_mgr_verify_on_success(tmp_path, mgr, caplog):
    """On task success, missing declared outputs trigger a warning."""
    missing_output = str(tmp_path / "missing.pt")  # does not exist
    completed_calls = []

    async def on_completed(task_id, exit_code, death_cause="success", has_checkpoint=False):
        completed_calls.append(task_id)

    mgr.on_completed = on_completed
    mgr.on_failed = AsyncMock()

    info = ProcessInfo(
        task_id="task-ok",
        pid=99999,
        outputs=[missing_output],
        start_time=time.time() - 1,
    )
    mgr._procs["task-ok"] = info

    async def _run():
        with patch.object(info, "poll", return_value=0):
            await mgr._check_completions()

    with caplog.at_level(logging.WARNING, logger="alchemy_stub.process_mgr"):
        asyncio.run(_run())

    assert "task-ok" in completed_calls
    assert any("missing" in r.message for r in caplog.records)


def test_process_mgr_no_rollback_on_success(tmp_path, mgr):
    """On task success, output files are NOT deleted."""
    output_file = tmp_path / "out.pt"
    output_file.write_bytes(b"result")

    mgr.on_completed = AsyncMock()
    mgr.on_failed = AsyncMock()

    info = ProcessInfo(
        task_id="task-ok2",
        pid=99999,
        outputs=[str(output_file)],
        start_time=time.time() - 1,
    )
    mgr._procs["task-ok2"] = info

    async def _run():
        with patch.object(info, "poll", return_value=0):
            await mgr._check_completions()

    asyncio.run(_run())

    assert output_file.exists(), "Output file should NOT be deleted on success"
