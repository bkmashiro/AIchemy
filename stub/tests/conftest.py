"""Shared test fixtures."""
import os
import sys
import tempfile

import pytest

# Ensure the stub package is importable when running from the stub directory
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


@pytest.fixture
def tmp_log_dir(tmp_path):
    """Temporary log directory."""
    log_dir = tmp_path / "alchemy_task_logs"
    log_dir.mkdir()
    return log_dir
