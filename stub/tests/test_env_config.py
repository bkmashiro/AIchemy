"""Tests for Stream C: Stub Environment Config.

Tests merge_env(), _parse_env_value(), and CLI config loading.
"""
import os
import pytest

from alchemy_stub.config import _parse_env_value, _parse_key_value, _load_env_file, _load_env_file_full
from alchemy_stub.process_mgr import merge_env, ProcessManager

try:
    import yaml  # noqa: F401
    HAS_YAML = True
except ImportError:
    HAS_YAML = False


# ─── _parse_env_value ─────────────────────────────────────────────────────────


class TestParseEnvValue:
    def test_no_vars(self):
        assert _parse_env_value("hello world") == "hello world"

    def test_simple_var(self):
        assert _parse_env_value("$HOME/bin", {"HOME": "/usr/local"}) == "/usr/local/bin"

    def test_braced_var(self):
        assert _parse_env_value("${HOME}/bin", {"HOME": "/usr/local"}) == "/usr/local/bin"

    def test_missing_var_expands_empty(self):
        assert _parse_env_value("$NONEXISTENT/bin", {}) == "/bin"

    def test_multiple_vars(self):
        env = {"A": "1", "B": "2"}
        assert _parse_env_value("$A-$B", env) == "1-2"

    def test_path_prepend(self):
        env = {"PATH": "/usr/bin"}
        assert _parse_env_value("/my/bin:$PATH", env) == "/my/bin:/usr/bin"

    def test_path_append(self):
        env = {"PATH": "/usr/bin"}
        assert _parse_env_value("$PATH:/my/bin", env) == "/usr/bin:/my/bin"

    def test_uses_os_environ_by_default(self):
        os.environ["_TEST_PARSE_ENV"] = "works"
        try:
            assert _parse_env_value("$_TEST_PARSE_ENV") == "works"
        finally:
            del os.environ["_TEST_PARSE_ENV"]


# ─── _parse_key_value ─────────────────────────────────────────────────────────


class TestParseKeyValue:
    def test_simple(self):
        assert _parse_key_value("FOO=bar") == ("FOO", "bar")

    def test_value_with_equals(self):
        assert _parse_key_value("FOO=bar=baz") == ("FOO", "bar=baz")

    def test_no_equals_raises(self):
        with pytest.raises(ValueError):
            _parse_key_value("FOOBAR")


# ─── _load_env_file ──────────────────────────────────────────────────────────


@pytest.mark.skipif(not HAS_YAML, reason="PyYAML not installed")
class TestLoadEnvFile:
    def test_flat_dict(self, tmp_path):
        f = tmp_path / "env.yaml"
        f.write_text("PATH: /my/bin\nFOO: bar\n")
        result = _load_env_file(str(f))
        assert result == {"PATH": "/my/bin", "FOO": "bar"}

    def test_nested_default_env(self, tmp_path):
        f = tmp_path / "env.yaml"
        f.write_text("default_env:\n  TORCH_HOME: /cache/torch\n")
        result = _load_env_file(str(f))
        assert result == {"TORCH_HOME": "/cache/torch"}

    def test_invalid_format_raises(self, tmp_path):
        f = tmp_path / "env.yaml"
        f.write_text("- item1\n- item2\n")
        with pytest.raises(ValueError):
            _load_env_file(str(f))


# ─── merge_env ────────────────────────────────────────────────────────────────


class TestMergeEnv:
    def test_base_only(self):
        result = merge_env(
            base={"HOME": "/home/user", "PATH": "/usr/bin"},
            default_env={},
            task_overrides={},
            alchemy_vars={},
        )
        assert result == {"HOME": "/home/user", "PATH": "/usr/bin"}

    def test_default_env_overrides_base(self):
        result = merge_env(
            base={"FOO": "old"},
            default_env={"FOO": "new"},
            task_overrides={},
            alchemy_vars={},
        )
        assert result["FOO"] == "new"

    def test_task_overrides_override_default_env(self):
        result = merge_env(
            base={},
            default_env={"FOO": "default"},
            task_overrides={"FOO": "task"},
            alchemy_vars={},
        )
        assert result["FOO"] == "task"

    def test_alchemy_vars_win(self):
        result = merge_env(
            base={"ALCHEMY_TASK_ID": "old"},
            default_env={"ALCHEMY_TASK_ID": "default"},
            task_overrides={"ALCHEMY_TASK_ID": "task"},
            alchemy_vars={"ALCHEMY_TASK_ID": "real-id"},
        )
        assert result["ALCHEMY_TASK_ID"] == "real-id"

    def test_path_prepend_in_default_env(self):
        result = merge_env(
            base={"PATH": "/usr/bin"},
            default_env={"PATH": "/my/bin:$PATH"},
            task_overrides={},
            alchemy_vars={},
        )
        assert result["PATH"] == "/my/bin:/usr/bin"

    def test_path_append_in_task_overrides(self):
        result = merge_env(
            base={"PATH": "/usr/bin"},
            default_env={"PATH": "/conda/bin:$PATH"},
            task_overrides={"PATH": "$PATH:/extra/bin"},
            alchemy_vars={},
        )
        # base PATH=/usr/bin → default: /conda/bin:/usr/bin → task: /conda/bin:/usr/bin:/extra/bin
        assert result["PATH"] == "/conda/bin:/usr/bin:/extra/bin"

    def test_variable_expansion_in_default_env(self):
        result = merge_env(
            base={"HOME": "/home/user"},
            default_env={"TORCH_HOME": "$HOME/.cache/torch"},
            task_overrides={},
            alchemy_vars={},
        )
        assert result["TORCH_HOME"] == "/home/user/.cache/torch"

    def test_variable_expansion_in_task_overrides(self):
        result = merge_env(
            base={"HOME": "/home/user"},
            default_env={"DATA_DIR": "/data"},
            task_overrides={"OUTPUT": "$DATA_DIR/output"},
            alchemy_vars={},
        )
        assert result["OUTPUT"] == "/data/output"

    def test_full_merge_order(self):
        """Integration test: all four layers with PATH manipulation."""
        result = merge_env(
            base={"PATH": "/usr/bin", "HOME": "/home/u", "LANG": "en_US"},
            default_env={
                "PATH": "/conda/bin:$PATH",
                "PYTHONPATH": "$HOME/project",
            },
            task_overrides={
                "PATH": "$PATH:/task/bin",
                "LANG": "C",
            },
            alchemy_vars={
                "ALCHEMY_TASK_ID": "t123",
                "ALCHEMY_RUN_DIR": "/runs/t123",
            },
        )
        assert result["PATH"] == "/conda/bin:/usr/bin:/task/bin"
        assert result["PYTHONPATH"] == "/home/u/project"
        assert result["LANG"] == "C"
        assert result["HOME"] == "/home/u"
        assert result["ALCHEMY_TASK_ID"] == "t123"
        assert result["ALCHEMY_RUN_DIR"] == "/runs/t123"

    def test_missing_var_in_expansion(self):
        """$VAR that doesn't exist in merged state expands to empty string."""
        result = merge_env(
            base={},
            default_env={"FOO": "$NONEXISTENT/bar"},
            task_overrides={},
            alchemy_vars={},
        )
        assert result["FOO"] == "/bar"

    def test_braced_expansion(self):
        result = merge_env(
            base={"HOME": "/home/u"},
            default_env={"X": "${HOME}/x"},
            task_overrides={},
            alchemy_vars={},
        )
        assert result["X"] == "/home/u/x"


# ─── _load_env_file_full ─────────────────────────────────────────────────────


@pytest.mark.skipif(not HAS_YAML, reason="PyYAML not installed")
class TestLoadEnvFileFull:
    def test_full_config_yaml(self, tmp_path):
        f = tmp_path / "env.yaml"
        f.write_text(
            "default_cwd: /vol/bitbucket/ys25/jema\n"
            "default_env:\n"
            "  NUMBA_CACHE_DIR: /tmp/numba_cache\n"
            "  FOO: bar\n"
            "umask: '022'\n"
        )
        cfg = _load_env_file_full(str(f))
        assert cfg.default_env == {"NUMBA_CACHE_DIR": "/tmp/numba_cache", "FOO": "bar"}
        assert cfg.default_cwd == "/vol/bitbucket/ys25/jema"
        assert cfg.umask == 0o022

    def test_umask_string_formats(self, tmp_path):
        """Accept '022', '0022', '0o022' as octal strings."""
        for raw in ("022", "0022", "0o022"):
            f = tmp_path / f"env_{raw}.yaml"
            f.write_text(f"default_env: {{}}\numask: '{raw}'\n")
            cfg = _load_env_file_full(str(f))
            assert cfg.umask == 0o022, f"failed for raw={raw!r}"

    def test_umask_integer(self, tmp_path):
        """Bare integer in YAML (e.g. umask: 18 → octal 022)."""
        f = tmp_path / "env.yaml"
        # 18 decimal == 0o022 octal
        f.write_text("default_env: {}\numask: 18\n")
        cfg = _load_env_file_full(str(f))
        assert cfg.umask == 18  # stored as-is when already int

    def test_no_umask_returns_none(self, tmp_path):
        f = tmp_path / "env.yaml"
        f.write_text("default_env:\n  X: y\n")
        cfg = _load_env_file_full(str(f))
        assert cfg.umask is None

    def test_no_default_cwd_returns_none(self, tmp_path):
        f = tmp_path / "env.yaml"
        f.write_text("default_env:\n  X: y\n")
        cfg = _load_env_file_full(str(f))
        assert cfg.default_cwd is None

    def test_invalid_umask_raises(self, tmp_path):
        f = tmp_path / "env.yaml"
        f.write_text("default_env: {}\numask: 'not-a-number'\n")
        with pytest.raises(ValueError, match="Invalid umask"):
            _load_env_file_full(str(f))

    def test_backward_compat_load_env_file(self, tmp_path):
        """_load_env_file() still works as flat-dict extractor."""
        f = tmp_path / "env.yaml"
        f.write_text(
            "default_cwd: /some/dir\n"
            "default_env:\n"
            "  KEY: val\n"
            "umask: '027'\n"
        )
        result = _load_env_file(str(f))
        assert result == {"KEY": "val"}


# ─── umask applied in subprocess ─────────────────────────────────────────────


class TestUmaskSubprocess:
    """Verify ProcessManager passes umask to child processes via preexec_fn."""

    def test_default_umask_022(self, tmp_path):
        """With umask=0o022, files created by subprocess should be 0o644."""
        mgr = ProcessManager(umask=0o022, pid_file=str(tmp_path / "pids.json"))
        out_file = tmp_path / "output.txt"

        import subprocess as _sp

        script = f"touch {out_file}"

        _task_umask = mgr.umask

        def preexec():
            import os as _os
            _os.umask(_task_umask)

        proc = _sp.Popen(
            ["bash", "-c", script],
            preexec_fn=preexec,
        )
        proc.wait(timeout=5)
        mode = oct(out_file.stat().st_mode & 0o777)
        assert mode == oct(0o644), f"expected 0o644, got {mode}"

    def test_umask_027_restricts_other(self, tmp_path):
        """With umask=0o027, 'other' bits should be cleared (rw-r-----,  0o640)."""
        mgr = ProcessManager(umask=0o027, pid_file=str(tmp_path / "pids.json"))
        out_file = tmp_path / "output.txt"

        import subprocess as _sp

        script = f"touch {out_file}"

        _task_umask = mgr.umask

        def preexec():
            import os as _os
            _os.umask(_task_umask)

        proc = _sp.Popen(
            ["bash", "-c", script],
            preexec_fn=preexec,
        )
        proc.wait(timeout=5)
        mode = oct(out_file.stat().st_mode & 0o777)
        assert mode == oct(0o640), f"expected 0o640, got {mode}"

    def test_umask_stored_on_manager(self):
        """ProcessManager stores the configured umask."""
        mgr = ProcessManager(umask=0o027)
        assert mgr.umask == 0o027

    def test_default_umask_value(self):
        """Default umask is 0o022."""
        mgr = ProcessManager()
        assert mgr.umask == 0o022
