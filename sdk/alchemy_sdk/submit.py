"""HTTP submission for experiments."""
from __future__ import annotations

import json
import urllib.request
import urllib.error
from typing import Any, Optional

from .experiment import ExperimentResult, ExperimentStatus, TaskStatusDetail


def submit_experiment(
    server: str,
    name: str,
    description: str,
    task_specs: list[dict[str, Any]],
    force: bool = False,
    config: Optional[dict[str, Any]] = None,
    config_diff: Optional[dict[str, Any]] = None,
    parent_name: Optional[str] = None,
) -> ExperimentResult:
    url = f"{server.rstrip('/')}/api/experiments"
    payload: dict[str, Any] = {
        "name": name,
        "description": description,
        "task_specs": task_specs,
        "force": force,
    }

    # Config + lineage fields (only include when set)
    if config is not None:
        payload["config"] = config
    if config_diff is not None:
        payload["config_diff"] = config_diff
    if parent_name is not None:
        payload["parent_name"] = parent_name

    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})

    try:
        resp = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as e:
        error_body = e.read().decode(errors="replace")
        raise RuntimeError(f"Experiment submission failed ({e.code}): {error_body}") from e

    data = json.loads(resp.read())
    already_exists = resp.status == 200
    dashboard_url = f"{server.rstrip('/')}/experiments/{data.get('id', data.get('experiment_id', ''))}"

    return ExperimentResult(
        experiment_id=data.get("id", data.get("experiment_id", "")),
        task_refs=data.get("task_refs", {}),
        already_exists=already_exists,
        url=dashboard_url,
    )


def get_experiment_status(server: str, experiment_id: str) -> ExperimentStatus:
    url = f"{server.rstrip('/')}/api/experiments/{experiment_id}"
    req = urllib.request.Request(url)

    try:
        resp = urllib.request.urlopen(req, timeout=15)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Failed to get experiment status ({e.code})") from e

    data = json.loads(resp.read())
    tasks = {}
    for ref, task_id in data.get("task_refs", {}).items():
        task_data = data.get("tasks", {}).get(task_id, {})
        tasks[ref] = TaskStatusDetail(
            ref=ref,
            task_id=task_id,
            status=task_data.get("status", "unknown"),
            exit_code=task_data.get("exit_code"),
            exports=task_data.get("exports"),
        )

    return ExperimentStatus(
        experiment_id=data["id"],
        name=data["name"],
        status=data["status"],
        tasks=tasks,
    )
