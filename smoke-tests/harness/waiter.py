"""Poll helpers for waiting on task status transitions."""
from __future__ import annotations

import time
from typing import Any

from .api import ApiClient

TERMINAL_STATUSES = {"completed", "failed", "killed", "lost"}


def wait_for_status(
    api: ApiClient,
    task_id: str,
    target_statuses: set[str] | list[str],
    timeout: float = 60.0,
    poll_interval: float = 1.0,
) -> dict[str, Any]:
    """Poll task until status is in target_statuses. Returns final task dict."""
    targets = set(target_statuses)
    deadline = time.monotonic() + timeout
    last_task: dict[str, Any] = {}
    while time.monotonic() < deadline:
        task = api.get_task(task_id)
        last_task = task
        if task["status"] in targets:
            return task
        # If task hit a terminal status we weren't waiting for, fail fast
        if task["status"] in TERMINAL_STATUSES and task["status"] not in targets:
            raise AssertionError(
                f"Task {task_id} reached unexpected terminal status '{task['status']}' "
                f"(expected one of {targets})"
            )
        time.sleep(poll_interval)
    raise TimeoutError(
        f"Task {task_id} did not reach {targets} within {timeout}s. "
        f"Last status: {last_task.get('status', 'unknown')}"
    )


def wait_all_terminal(
    api: ApiClient,
    task_ids: list[str],
    timeout: float = 120.0,
    poll_interval: float = 2.0,
) -> list[dict[str, Any]]:
    """Wait until all tasks reach a terminal status. Returns list of final task dicts."""
    deadline = time.monotonic() + timeout
    results: dict[str, dict[str, Any]] = {}
    remaining = set(task_ids)
    while remaining and time.monotonic() < deadline:
        for tid in list(remaining):
            task = api.get_task(tid)
            results[tid] = task
            if task["status"] in TERMINAL_STATUSES:
                remaining.discard(tid)
        if remaining:
            time.sleep(poll_interval)
    if remaining:
        statuses = {tid: results.get(tid, {}).get("status", "?") for tid in remaining}
        raise TimeoutError(
            f"{len(remaining)} tasks did not finish within {timeout}s: {statuses}"
        )
    return [results[tid] for tid in task_ids]
