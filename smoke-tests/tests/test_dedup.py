"""Phase 2 — Dedup tests: fingerprint dedup, idempotency key, different params bypass."""
from __future__ import annotations

import os
from uuid import uuid4

import httpx

from harness.waiter import wait_for_status

SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts"))


def _unique_name(base: str) -> str:
    return f"{base}_{uuid4().hex[:8]}"


class TestDedup:

    def test_fingerprint_dedup(self, api, stub_default):
        """Submitting identical task twice returns 409 with existing_task_id."""
        # Use a unique script path to ensure unique fingerprint
        script = f"bash {os.path.join(SCRIPTS, 'success_fast.sh')}"
        # Use unique cwd to create a unique fingerprint
        unique_cwd = f"/tmp/dedup_test_{uuid4().hex[:8]}"
        os.makedirs(unique_cwd, exist_ok=True)

        name = _unique_name("smoke_dedup")
        task1 = api.submit_expect(script, name=name, cwd=unique_cwd)

        # Second submission with same fingerprint should be rejected
        name2 = _unique_name("smoke_dedup_dup")
        body = {"script": script, "name": name2, "cwd": unique_cwd}
        client = httpx.Client(
            base_url=api.base_url,
            headers={"Authorization": f"Bearer {api.token}"},
            timeout=30.0,
        )
        r = client.post("/api/tasks", json=body)
        client.close()

        assert r.status_code == 409, f"Expected 409, got {r.status_code}: {r.text}"
        data = r.json()
        assert "existing_task_id" in data

        # Cleanup: wait for first task
        wait_for_status(api, task1["id"], {"completed"}, timeout=30)

        # After cleanup, clean up the temp dir
        import shutil
        shutil.rmtree(unique_cwd, ignore_errors=True)

    def test_different_params_bypass_dedup(self, api, stub_default):
        """Same script with different param_overrides gets different fingerprints."""
        script = f"bash {os.path.join(SCRIPTS, 'success_fast.sh')}"

        name1 = _unique_name("smoke_dedup_params1")
        task1 = api.submit_expect(
            script, name=name1,
            param_overrides={"lr": "0.001", "seed": uuid4().hex[:8]},
        )

        name2 = _unique_name("smoke_dedup_params2")
        task2 = api.submit_expect(
            script, name=name2,
            param_overrides={"lr": "0.01", "seed": uuid4().hex[:8]},
        )

        # Both should be accepted (different fingerprints)
        assert task1["id"] != task2["id"]

        # Wait for both
        wait_for_status(api, task1["id"], {"completed"}, timeout=30)
        wait_for_status(api, task2["id"], {"completed"}, timeout=30)

    def test_idempotency_key(self, api, stub_default):
        """Same idempotency_key returns existing task on second submit."""
        script = f"bash {os.path.join(SCRIPTS, 'success_fast.sh')}"
        idem_key = f"idem_{uuid4().hex}"

        name = _unique_name("smoke_idem")
        task1 = api.submit_expect(
            script, name=name, idempotency_key=idem_key,
            # Unique param so fingerprint doesn't collide with other tests
            param_overrides={"idem_run": uuid4().hex[:8]},
        )

        # Second submit with same key — should return existing task
        body = {
            "script": script,
            "name": _unique_name("smoke_idem2"),
            "idempotency_key": idem_key,
            "param_overrides": {"idem_run": uuid4().hex[:8]},
        }
        client = httpx.Client(
            base_url=api.base_url,
            headers={"Authorization": f"Bearer {api.token}"},
            timeout=30.0,
        )
        r = client.post("/api/tasks", json=body)
        client.close()

        # Should return 200 (not 201) with same task
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
        data = r.json()
        assert data["id"] == task1["id"]

        wait_for_status(api, task1["id"], {"completed"}, timeout=30)
