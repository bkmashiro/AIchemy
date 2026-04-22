"""CLI args and env configuration for the stub daemon."""
import argparse
import os
import socket


def parse_args():
    parser = argparse.ArgumentParser(description="Alchemy v2 Stub Daemon")
    parser.add_argument("--server", required=True, help="Server URL (e.g. http://localhost:3001)")
    parser.add_argument("--token", required=True, help="Auth token")
    parser.add_argument(
        "--env-setup",
        default=os.environ.get("ALCHEMY_ENV_SETUP", ""),
        help="Shell commands to run before each task (stub-level default)",
    )
    parser.add_argument(
        "--max-concurrent",
        type=int,
        default=int(os.environ.get("ALCHEMY_MAX_CONCURRENT", "3")),
        help="Maximum concurrent tasks",
    )
    parser.add_argument(
        "--idle-timeout",
        type=int,
        default=int(os.environ.get("ALCHEMY_IDLE_TIMEOUT", "600")),
        help="Exit after N seconds idle (no tasks). 0 = never.",
    )
    parser.add_argument(
        "--hostname",
        default=os.environ.get("HOSTNAME", socket.gethostname()),
        help="Hostname to report",
    )
    parser.add_argument(
        "--pid-file",
        default=os.environ.get("ALCHEMY_PID_FILE", "/tmp/alchemy_stub_tasks.json"),
        help="PID file for task re-attach on restart",
    )
    return parser.parse_args()


class Config:
    def __init__(self):
        args = parse_args()
        self.server: str = args.server.rstrip("/")
        self.token: str = args.token
        self.env_setup: str = args.env_setup
        self.max_concurrent: int = args.max_concurrent
        self.idle_timeout: int = args.idle_timeout
        self.hostname: str = args.hostname
        self.pid_file: str = args.pid_file

        # SLURM env
        self.slurm_job_id: str | None = os.environ.get("SLURM_JOB_ID")
        self.slurm_partition: str | None = os.environ.get("SLURM_JOB_PARTITION")
        self.slurm_node: str | None = os.environ.get("SLURMD_NODENAME")
