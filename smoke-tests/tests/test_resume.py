"""Phase 2 — Resume tests: checkpoint creation, resume detection, clean state."""
from __future__ import annotations

import os
import shutil
from uuid import uuid4

from harness.waiter import wait_for_status

SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts"))


def _unique_name(base: str) -> str:
    return f"{base}_{uuid4().hex[:8]}"


class TestResume:

    def test_fresh_run_creates_checkpoint(self, api, stub_default, tmp_path):
        """First run creates a checkpoint file."""
        ckpt_dir = str(tmp_path / "ckpt_fresh")
        name = _unique_name("smoke_resume_fresh")

        task = api.submit_expect(
            f"bash {os.path.join(SCRIPTS, 'checkpoint_resume.sh')}",
            name=name,
            env={"SMOKE_CKPT_DIR": ckpt_dir},
        )
        final = wait_for_status(api, task["id"], {"completed"}, timeout=30)
        assert final["status"] == "completed"
        assert final.get("exit_code") == 0

        # Verify checkpoint file was created
        ckpt_file = os.path.join(ckpt_dir, "checkpoint.json")
        assert os.path.exists(ckpt_file), f"Checkpoint not created at {ckpt_file}"

    def test_resume_detects_checkpoint(self, api, stub_default, tmp_path):
        """Second run detects existing checkpoint and resumes."""
        ckpt_dir = str(tmp_path / "ckpt_resume")
        script = f"bash {os.path.join(SCRIPTS, 'checkpoint_resume.sh')}"

        # First run — create checkpoint
        name1 = _unique_name("smoke_resume_first")
        task1 = api.submit_expect(script, name=name1, env={"SMOKE_CKPT_DIR": ckpt_dir})
        wait_for_status(api, task1["id"], {"completed"}, timeout=30)

        # Second run — should detect checkpoint
        name2 = _unique_name("smoke_resume_second")
        task2 = api.submit_expect(script, name=name2, env={"SMOKE_CKPT_DIR": ckpt_dir})
        final = wait_for_status(api, task2["id"], {"completed"}, timeout=30)
        assert final["status"] == "completed"

        # Check logs for resume message
        logs = api.get_logs(task2["id"])
        log_text = " ".join(str(l) for l in logs)
        assert "resuming from step" in log_text.lower() or "resuming" in log_text.lower(), (
            f"Expected resume message in logs: {log_text[:500]}"
        )

    def test_clean_state_after_delete(self, api, stub_default, tmp_path):
        """After deleting checkpoint, fresh run occurs."""
        ckpt_dir = str(tmp_path / "ckpt_clean")
        script = f"bash {os.path.join(SCRIPTS, 'checkpoint_resume.sh')}"

        # First run — create checkpoint
        name1 = _unique_name("smoke_clean_first")
        task1 = api.submit_expect(script, name=name1, env={"SMOKE_CKPT_DIR": ckpt_dir})
        wait_for_status(api, task1["id"], {"completed"}, timeout=30)

        # Delete checkpoint
        shutil.rmtree(ckpt_dir, ignore_errors=True)

        # Second run — should be a fresh run
        name2 = _unique_name("smoke_clean_second")
        task2 = api.submit_expect(script, name=name2, env={"SMOKE_CKPT_DIR": ckpt_dir})
        final = wait_for_status(api, task2["id"], {"completed"}, timeout=30)
        assert final["status"] == "completed"

        logs = api.get_logs(task2["id"])
        log_text = " ".join(str(l) for l in logs)
        assert "fresh run" in log_text.lower() or "no checkpoint" in log_text.lower(), (
            f"Expected fresh run message in logs: {log_text[:500]}"
        )
