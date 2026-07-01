import base64
import hashlib

import pytest

from alchemy_stub.file_rpc import handle_file_request


class DummyConfig:
    def __init__(self, cwd):
        self.default_cwd = str(cwd)
        self.default_output_dir = None


@pytest.mark.asyncio
async def test_file_rpc_reads_small_relative_file(tmp_path):
    (tmp_path / "runs").mkdir()
    payload = b'{"score":0.9}\n'
    target = tmp_path / "runs" / "result.json"
    target.write_bytes(payload)

    result = await handle_file_request({"request_id": "file-1", "op": "read", "path": "runs/result.json", "max_bytes": 4096}, DummyConfig(tmp_path))

    assert result == {
        "ok": True,
        "request_id": "file-1",
        "op": "read",
        "path": "runs/result.json",
        "size": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "content_b64": base64.b64encode(payload).decode("ascii"),
        "truncated": False,
    }


@pytest.mark.asyncio
async def test_file_rpc_rejects_path_escape(tmp_path):
    result = await handle_file_request({"request_id": "file-2", "op": "read", "path": "../secret.txt"}, DummyConfig(tmp_path))

    assert result == {"ok": False, "request_id": "file-2", "error": "path_escape"}


@pytest.mark.asyncio
async def test_file_rpc_lists_relative_directory(tmp_path):
    (tmp_path / "runs").mkdir()
    (tmp_path / "runs" / "a.json").write_text("{}")
    (tmp_path / "runs" / "subdir").mkdir()

    result = await handle_file_request({"request_id": "file-3", "op": "list", "path": "runs"}, DummyConfig(tmp_path))

    assert result["ok"] is True
    assert result["entries"] == [
        {"name": "a.json", "type": "file", "size": 2},
        {"name": "subdir", "type": "dir", "size": 0},
    ]
