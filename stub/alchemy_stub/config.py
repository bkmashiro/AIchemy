"""Configuration dataclass for alchemy-stub daemon."""
import argparse
import hashlib
import os
import re
import socket
from dataclasses import dataclass, field
from typing import Any


def _compute_identity_hash(hostname: str, gpu_name: str, gpu_count: int, default_cwd: str, slurm_job_id: str | None = None) -> str:
    """Compute stable stub identity hash.

    Formula: sha256(hostname|gpu.name|gpu.count|defaultCwd|slurmJobId)[:12]

    IMPORTANT: This must match the server's computeStubId in
    server/src/socket/stub.ts. If you change this, update both sides.
    """
    raw = f"{hostname}|{gpu_name}|{gpu_count}|{default_cwd}|{slurm_job_id or ''}"
    return hashlib.sha256(raw.encode()).hexdigest()[:12]


def _parse_env_value(value: str, env: dict[str, str] | None = None) -> str:
    """Expand $VAR references in a value using the given env (or os.environ).

    Supports:
      - Simple: $VAR or ${VAR}
      - PATH-like append/prepend: value starts with $KEY: or ends with :$KEY
    """
    source = env if env is not None else dict(os.environ)

    def _replace(m: re.Match) -> str:
        name = m.group(1) or m.group(2)
        return source.get(name, "")

    return re.sub(r"\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)", _replace, value)


def _load_env_file(path: str) -> dict[str, str]:
    """Load default_env from a YAML file. Returns flat dict."""
    import yaml  # lazy import — only needed if --default-env-file is used

    with open(path) as f:
        data = yaml.safe_load(f)

    if not isinstance(data, dict):
        raise ValueError(f"default-env-file must be a YAML mapping, got {type(data).__name__}")

    # Accept nested under 'default_env' key, or top-level if all keys look like env vars
    if "default_env" in data:
        env_dict = data["default_env"]
        if not isinstance(env_dict, dict):
            raise ValueError("default_env key must be a mapping")
    else:
        # Validate that all keys look like env var names (uppercase, digits, underscores)
        _ENV_KEY_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")
        bad_keys = [k for k in data if not _ENV_KEY_RE.match(str(k))]
        if bad_keys:
            raise ValueError(
                f"No 'default_env' key found and file contains non-env-var keys: {bad_keys}. "
                f"Wrap env vars under a 'default_env' key, or ensure all keys are UPPER_CASE."
            )
        env_dict = data

    return {str(k): str(v) for k, v in env_dict.items()}


def _parse_key_value(s: str) -> tuple[str, str]:
    """Parse 'KEY=VALUE' string. Raises ValueError if malformed."""
    if "=" not in s:
        raise ValueError(f"Expected KEY=VALUE, got: {s!r}")
    k, v = s.split("=", 1)
    return k.strip(), v.strip()


@dataclass
class Config:
    server: str
    token: str
    max_concurrent: int
    env_setup: str  # deprecated, kept for backward compat
    default_cwd: str
    idle_timeout: int  # seconds; 0 = infinite
    tags: list[str] = field(default_factory=list)
    default_env: dict[str, str] = field(default_factory=dict)

    hostname: str = field(default_factory=socket.gethostname)
    gpu_indices: str = ""  # e.g. "0,1" — used for identity hash

    # SLURM
    slurm_job_id: str | None = None
    slurm_partition: str | None = None
    slurm_node: str | None = None

    @property
    def identity_hash(self) -> str:
        """Local identity hash for PID files, lock files, log dirs.

        Uses gpu_indices (CUDA_VISIBLE_DEVICES) since GPU info from
        nvidia-smi isn't available yet at Config construction time.
        This is NOT the server stub_id — use compute_stub_id() for that.
        """
        raw = f"{self.hostname}|{self.gpu_indices}|{self.default_cwd}|{self.slurm_job_id or ''}"
        return hashlib.sha256(raw.encode()).hexdigest()[:12]

    def compute_stub_id(self, gpu_name: str, gpu_count: int) -> str:
        """Compute the server-compatible stub ID.

        Must match server's computeStubId in server/src/socket/stub.ts.
        Call this after GPU info is available (from GpuMonitor).
        """
        return _compute_identity_hash(self.hostname, gpu_name, gpu_count, self.default_cwd, self.slurm_job_id)

    @property
    def stub_type(self) -> str:
        return "slurm" if self.slurm_job_id else "workstation"


# Default idle timeout for SLURM mode (10 minutes) when user doesn't specify.
_SLURM_DEFAULT_IDLE_TIMEOUT = 600


def parse_args() -> Config:
    parser = argparse.ArgumentParser(
        description="Alchemy v2.1 Stub Daemon",
        prog="python -m alchemy_stub",
    )
    parser.add_argument("--server", required=True, help="Server WebSocket URL")
    parser.add_argument("--token", required=True, help="Auth token")
    parser.add_argument(
        "--max-concurrent",
        type=int,
        default=int(os.environ.get("ALCHEMY_MAX_CONCURRENT", "3")),
        help="Maximum concurrent tasks (server authoritative after first connect)",
    )
    parser.add_argument(
        "--env-setup",
        default=os.environ.get("ALCHEMY_ENV_SETUP", ""),
        help="Shell commands run before each task (stub-level default)",
    )
    parser.add_argument(
        "--default-cwd",
        default=os.environ.get("ALCHEMY_DEFAULT_CWD", ""),
        help="Default working directory for tasks",
    )
    parser.add_argument(
        "--idle-timeout",
        type=int,
        default=None,
        help=(
            "Exit after N seconds with no running tasks. "
            "Default: 600 in SLURM mode, 0 (never) in workstation mode."
        ),
    )
    parser.add_argument(
        "--gpu-indices",
        default=os.environ.get("CUDA_VISIBLE_DEVICES", ""),
        help="GPU indices (used for identity hash). Defaults to CUDA_VISIBLE_DEVICES.",
    )
    parser.add_argument(
        "--tags",
        default=os.environ.get("ALCHEMY_TAGS", ""),
        help="Comma-separated tags for task routing (e.g. a40-cluster,ys25)",
    )
    parser.add_argument(
        "--default-env",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="Default env var for tasks (repeatable). Supports $VAR expansion.",
    )
    parser.add_argument(
        "--default-env-file",
        default=None,
        metavar="PATH",
        help="YAML file with default_env mapping for tasks.",
    )

    args = parser.parse_args()

    slurm_job_id = os.environ.get("SLURM_JOB_ID")

    # Resolve idle_timeout: explicit flag > env var > SLURM default > 0
    if args.idle_timeout is not None:
        idle_timeout = args.idle_timeout
    else:
        env_val = os.environ.get("ALCHEMY_IDLE_TIMEOUT")
        if env_val is not None:
            idle_timeout = int(env_val)
        elif slurm_job_id:
            idle_timeout = _SLURM_DEFAULT_IDLE_TIMEOUT
        else:
            idle_timeout = 0

    tags: list[str] = [t.strip() for t in args.tags.split(",") if t.strip()] if args.tags else []

    # Build default_env: file first, then CLI overrides, expand $VAR references
    default_env: dict[str, str] = {}
    if args.default_env_file:
        default_env.update(_load_env_file(args.default_env_file))
    for entry in args.default_env:
        k, v = _parse_key_value(entry)
        default_env[k] = v
    # Expand variable references against current process env
    default_env = {k: _parse_env_value(v) for k, v in default_env.items()}

    return Config(
        server=args.server.rstrip("/"),
        token=args.token,
        max_concurrent=args.max_concurrent,
        env_setup=args.env_setup,
        default_cwd=args.default_cwd or os.getcwd(),
        idle_timeout=idle_timeout,
        tags=tags,
        default_env=default_env,
        hostname=socket.gethostname(),
        gpu_indices=args.gpu_indices,
        slurm_job_id=slurm_job_id,
        slurm_partition=os.environ.get("SLURM_JOB_PARTITION"),
        slurm_node=os.environ.get("SLURMD_NODENAME"),
    )
