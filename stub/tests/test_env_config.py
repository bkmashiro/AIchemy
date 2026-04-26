"""Tests for Stream C: Stub Environment Config.

Tests merge_env(), _parse_env_value(), and CLI config loading.
"""
import os
import pytest

from alchemy_stub.config import _parse_env_value, _parse_key_value, _load_env_file
from alchemy_stub.process_mgr import merge_env

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
