"""ApiClient — thin httpx wrapper for alchemy-v2 REST API."""
from __future__ import annotations

from typing import Any

import httpx


class ApiClient:
    """Synchronous HTTP client for the alchemy-v2 REST API."""

    def __init__(self, base_url: str, token: str, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self._client = httpx.Client(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=timeout,
        )

    # ── Health ────────────────────────────────────────────────────────

    def health(self) -> dict[str, Any]:
        r = self._client.get("/api/health")
        r.raise_for_status()
        return r.json()

    # ── Tasks ─────────────────────────────────────────────────────────

    def submit(self, script: str, **kwargs: Any) -> tuple[dict[str, Any], int]:
        """POST /api/tasks. Returns (response_dict, status_code)."""
        body = {"script": script, **kwargs}
        r = self._client.post("/api/tasks", json=body)
        return r.json(), r.status_code

    def submit_expect(self, script: str, expected_status: int = 201, **kwargs: Any) -> dict[str, Any]:
        """Submit and assert expected HTTP status. Returns task/error dict."""
        body = {"script": script, **kwargs}
        r = self._client.post("/api/tasks", json=body)
        assert r.status_code == expected_status, (
            f"Expected {expected_status}, got {r.status_code}: {r.text}"
        )
        return r.json()

    def get_task(self, task_id: str) -> dict[str, Any]:
        r = self._client.get(f"/api/tasks/{task_id}")
        r.raise_for_status()
        return r.json()

    def list_tasks(
        self,
        status: str | None = None,
        page: int = 1,
        limit: int = 50,
        logs: bool = False,
    ) -> dict[str, Any]:
        """GET /api/tasks with optional filters. Returns {tasks, total, page, limit}."""
        params: dict[str, Any] = {"page": page, "limit": limit}
        if status:
            params["status"] = status
        if logs:
            params["logs"] = "true"
        r = self._client.get("/api/tasks", params=params)
        r.raise_for_status()
        return r.json()

    def patch_task(self, task_id: str, **kwargs: Any) -> dict[str, Any]:
        """PATCH /api/tasks/:id."""
        r = self._client.patch(f"/api/tasks/{task_id}", json=kwargs)
        r.raise_for_status()
        return r.json()

    def kill_task(self, task_id: str) -> dict[str, Any]:
        """Convenience: PATCH status=killed."""
        return self.patch_task(task_id, status="killed")

    def batch(self, action: str, task_ids: list[str]) -> dict[str, Any]:
        """POST /api/tasks/batch."""
        r = self._client.post("/api/tasks/batch", json={"action": action, "task_ids": task_ids})
        r.raise_for_status()
        return r.json()

    # ── Stubs ─────────────────────────────────────────────────────────

    def list_stubs(self) -> list[dict[str, Any]]:
        r = self._client.get("/api/stubs")
        r.raise_for_status()
        return r.json()

    def get_stub(self, stub_id: str) -> dict[str, Any]:
        r = self._client.get(f"/api/stubs/{stub_id}")
        r.raise_for_status()
        return r.json()

    # ── Logs ──────────────────────────────────────────────────────────

    def get_logs(self, task_id: str) -> list[str]:
        """Get task log_buffer by fetching full task with logs."""
        r = self._client.get(f"/api/tasks/{task_id}")
        r.raise_for_status()
        data = r.json()
        return data.get("log_buffer", [])

    # ── Cleanup ───────────────────────────────────────────────────────

    def cleanup(self, older_than_hours: int = 1) -> dict[str, Any]:
        r = self._client.post("/api/cleanup", json={"older_than_hours": older_than_hours})
        r.raise_for_status()
        return r.json()

    def close(self) -> None:
        self._client.close()
