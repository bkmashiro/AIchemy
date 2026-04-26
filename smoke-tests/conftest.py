"""pytest fixtures for alchemy-v2 smoke tests."""
from __future__ import annotations

import os
import pytest

from harness.server import TestServer
from harness.stub import TestStub
from harness.api import ApiClient

# Resolve scripts dir once
SCRIPTS_DIR = os.environ.get(
    "ALCHEMY_TEST_SCRIPTS_DIR",
    os.path.join(os.path.dirname(__file__), "scripts"),
)
SCRIPTS_DIR = os.path.abspath(SCRIPTS_DIR)


@pytest.fixture(scope="session")
def test_server():
    """Start a test server for the entire pytest session."""
    srv = TestServer()
    srv.start()
    yield srv
    srv.stop()


@pytest.fixture(scope="session")
def api(test_server):
    """API client pointed at the test server."""
    client = ApiClient(test_server.url, test_server.token)
    yield client
    client.close()


@pytest.fixture(scope="session")
def stub_default(test_server, api):
    """One default stub, online for the session."""
    s = TestStub(
        test_server.url,
        test_server.token,
        name="test-stub-default",
        max_concurrent=5,
    )
    s.start()
    s.wait_online(api)
    yield s
    s.stop()


@pytest.fixture
def stub_factory(test_server, api):
    """Factory for creating additional stubs per-test."""
    stubs: list[TestStub] = []

    def _make(
        name: str,
        tags: list[str] | None = None,
        max_concurrent: int = 3,
        default_cwd: str | None = None,
    ) -> TestStub:
        s = TestStub(
            test_server.url,
            test_server.token,
            name=name,
            tags=tags,
            max_concurrent=max_concurrent,
            default_cwd=default_cwd,
        )
        s.start()
        s.wait_online(api)
        stubs.append(s)
        return s

    yield _make

    for s in stubs:
        s.stop()


@pytest.fixture
def tmp_workdir(tmp_path):
    """Unique tmp directory usable as cwd/run_dir for a test."""
    d = tmp_path / "workdir"
    d.mkdir()
    return str(d)


@pytest.fixture(scope="session")
def scripts_dir():
    """Absolute path to the smoke-test scripts directory."""
    return SCRIPTS_DIR
