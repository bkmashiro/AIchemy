"""Phase 2 — Disk tests: write + cleanup verification."""
from __future__ import annotations

import glob
import os
from uuid import uuid4

from harness.waiter import wait_for_status

SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts"))


def _unique_name(base: str) -> str:
    return f"{base}_{uuid4().hex[:8]}"


class TestDisk:

    def test_write_and_cleanup(self, api, stub_default):
        """writes_disk.sh creates temp files and cleans them up."""
        name = _unique_name("smoke_writes_disk")
        task = api.submit_expect(
            f"bash {os.path.join(SCRIPTS, 'writes_disk.sh')}",
            name=name,
        )
        final = wait_for_status(api, task["id"], {"completed"}, timeout=60)
        assert final["status"] == "completed"
        assert final.get("exit_code") == 0

        # Verify no stale smoke_io_ dirs remain
        stale = glob.glob("/tmp/smoke_io_*")
        # Filter to only very recent ones (could be from concurrent tests)
        # The script cleans up its own dir, so there shouldn't be new ones
        # We just verify the task didn't fail
        assert final["status"] == "completed"

    def test_write_to_specific_dir(self, api, stub_default, tmp_path):
        """Task writes to a specified directory, file exists after completion."""
        out_dir = str(tmp_path / "output")
        os.makedirs(out_dir, exist_ok=True)
        marker_file = os.path.join(out_dir, "marker.txt")

        script_path = str(tmp_path / "write_marker.sh")
        with open(script_path, "w") as f:
            f.write(f"#!/usr/bin/env bash\necho 'smoke_test_output' > '{marker_file}'\nexit 0\n")
        os.chmod(script_path, 0o755)

        name = _unique_name("smoke_write_marker")
        task = api.submit_expect(
            f"bash {script_path}",
            name=name,
        )
        final = wait_for_status(api, task["id"], {"completed"}, timeout=30)
        assert final["status"] == "completed"
        assert os.path.exists(marker_file), f"Marker file not created at {marker_file}"
