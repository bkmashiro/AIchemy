"""Configuration dataclass for alchemy-stub daemon."""
import argparse
import hashlib
import os
import socket
from dataclasses import dataclass, field


def _compute_identity_hash(hostname: str, gpu_indices: str, default_cwd: str, slurm_job_id: str | None = None) -> str:
    """sha256(hostname + gpu_indices + default_cwd [+ slurm_job_id])[:12]"""
    raw = hostname + gpu_indices + default_cwd
    if slurm_job_id:
        raw += slurm_job_id
    return hashlib.sha256(raw.encode()).hexdigest()[:12]


@dataclass
class Config:
    server: str
    token: str
    max_concurrent: int
    env_setup: str
    default_cwd: str
    idle_timeout: int  # seconds; 0 = infinite
    tags: list[str] = field(default_factory=list)

    hostname: str = field(default_factory=socket.gethostname)
    gpu_indices: str = ""  # e.g. "0,1" — used for identity hash

    # SLURM
    slurm_job_id: str | None = None
    slurm_partition: str | None = None
    slurm_node: str | None = None

    @property
    def identity_hash(self) -> str:
        return _compute_identity_hash(self.hostname, self.gpu_indices, self.default_cwd, self.slurm_job_id)

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

    return Config(
        server=args.server.rstrip("/"),
        token=args.token,
        max_concurrent=args.max_concurrent,
        env_setup=args.env_setup,
        default_cwd=args.default_cwd or os.getcwd(),
        idle_timeout=idle_timeout,
        tags=tags,
        hostname=socket.gethostname(),
        gpu_indices=args.gpu_indices,
        slurm_job_id=slurm_job_id,
        slurm_partition=os.environ.get("SLURM_JOB_PARTITION"),
        slurm_node=os.environ.get("SLURMD_NODENAME"),
    )
