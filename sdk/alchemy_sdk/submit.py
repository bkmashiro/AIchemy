"""HTTP submission for experiments."""
from __future__ import annotations

import http.client
import json
import socket
import urllib.error
import urllib.request
from typing import Any, Optional

from .experiment import ExperimentResult, ExperimentStatus, TaskStatusDetail
from .operator_config import resolve_token


def _close_response(response: Any) -> None:
    """Close urllib responses while tolerating lightweight test doubles."""
    close = getattr(response, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            pass


class ExperimentSubmissionError(RuntimeError):
    """A diagnosable submission failure; remains RuntimeError-compatible."""

    def __init__(
        self,
        message: str,
        *,
        code: str,
        status: Optional[int] = None,
        idempotency_key: Optional[str] = None,
        outcome: str = "unknown",
        response_body: str = "",
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.idempotency_key = idempotency_key
        self.request_key = idempotency_key
        self.outcome = outcome
        self.response_body = response_body


def submit_experiment(
    server: str,
    name: str,
    description: str,
    task_specs: list[dict[str, Any]],
    force: bool = False,
    code_id: Optional[str] = None,
    config: Optional[dict[str, Any]] = None,
    config_diff: Optional[dict[str, Any]] = None,
    storage: Optional[dict[str, Any]] = None,
    sdk_spec: Optional[dict[str, Any]] = None,
    parent_name: Optional[str] = None,
    family: Optional[str] = None,
    hypothesis: Optional[str] = None,
    expected_outcome: Optional[str] = None,
    fork_reason: Optional[str] = None,
    idempotency_key: Optional[str] = None,
) -> ExperimentResult:
    if idempotency_key is not None and (not isinstance(idempotency_key, str) or not idempotency_key.strip()):
        raise ExperimentSubmissionError(
            "idempotency_key must be a non-empty string",
            code="invalid_idempotency_key",
            idempotency_key=idempotency_key if isinstance(idempotency_key, str) else None,
            outcome="not_submitted",
        )
    url = f"{server.rstrip('/')}/api/experiments"
    payload: dict[str, Any] = {
        "name": name,
        "description": description,
        "task_specs": task_specs,
        "force": force,
    }

    # Config + lineage fields (only include when set)
    if code_id is not None:
        payload["code_id"] = code_id
    if config is not None:
        payload["config"] = config
    if config_diff is not None:
        payload["config_diff"] = config_diff
    if storage is not None:
        payload["storage"] = storage
    if sdk_spec is not None:
        payload["sdk_spec"] = sdk_spec
    if parent_name is not None:
        payload["parent_name"] = parent_name
    if family is not None:
        payload["family"] = family
    if hypothesis is not None:
        payload["hypothesis"] = hypothesis
    if expected_outcome is not None:
        payload["expected_outcome"] = expected_outcome
    if fork_reason is not None:
        payload["fork_reason"] = fork_reason
    if idempotency_key is not None:
        payload["idempotency_key"] = idempotency_key.strip()

    try:
        body = json.dumps(payload).encode()
    except (TypeError, ValueError) as exc:
        raise ExperimentSubmissionError(
            f"Invalid experiment submission payload: {exc}",
            code="invalid_payload",
            idempotency_key=idempotency_key,
            outcome="not_submitted",
        ) from exc
    headers = {"Content-Type": "application/json"}
    token = resolve_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=body, headers=headers)

    try:
        resp = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as e:
        outcome = "rejected" if 400 <= e.code < 500 else "unknown"
        error_body = ""
        try:
            error_body = e.read().decode(errors="replace")
            parsed_error = json.loads(error_body)
            if not isinstance(parsed_error, dict):
                parsed_error = {}
        except (ValueError, TypeError, OSError, http.client.HTTPException):
            parsed_error = {}
        finally:
            _close_response(e)
        conflict = e.code == 409 and "idempotency" in str(parsed_error.get("error", "")).lower()
        code = "idempotency_conflict" if conflict else str(parsed_error.get("code") or f"http_{e.code}")
        raise ExperimentSubmissionError(
            f"Experiment submission failed ({e.code}): {error_body}",
            code=code,
            status=e.code,
            idempotency_key=idempotency_key,
            outcome=outcome,
            response_body=error_body,
        ) from e
    except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as e:
        raise ExperimentSubmissionError(
            f"Experiment submission outcome is unknown: {e}",
            code="network_error",
            idempotency_key=idempotency_key,
            outcome="unknown",
        ) from e

    try:
        try:
            response_body = resp.read()
        except (OSError, http.client.HTTPException, TimeoutError, socket.timeout) as e:
            raise ExperimentSubmissionError(
                f"Experiment submission response could not be read: {e}",
                code="invalid_response",
                status=getattr(resp, "status", None),
                idempotency_key=idempotency_key,
                outcome="unknown",
            ) from e
    finally:
        _close_response(resp)

    try:
        data = json.loads(response_body)
        if not isinstance(data, dict):
            raise ValueError("response must be a JSON object")
        experiment_id = data.get("id", data.get("experiment_id"))
        if not isinstance(experiment_id, str) or not experiment_id.strip():
            raise ValueError("response must include a non-empty experiment id")
    except (ValueError, TypeError) as e:
        raise ExperimentSubmissionError(
            f"Experiment submission response is invalid: {e}",
            code="invalid_response",
            status=getattr(resp, "status", None),
            idempotency_key=idempotency_key,
            outcome="unknown",
        ) from e
    already_exists = resp.status == 200
    dashboard_url = f"{server.rstrip('/')}/experiments/{experiment_id}"

    return ExperimentResult(
        experiment_id=experiment_id,
        task_refs=data.get("task_refs", {}),
        already_exists=already_exists,
        url=dashboard_url,
        submission_warnings=data.get("submission_warnings", []),
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
