"""Entry point for alchemy-controller.

Usage:
    python -m alchemy_controller \
        --server https://alchemy-v2.yuzhes.com \
        --token alchemy-v2-token \
        --users ys25,hw2025
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from .daemon import ControllerDaemon


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Alchemy SLURM controller daemon",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--server",
        default="https://alchemy-v2.yuzhes.com",
        help="Alchemy server URL",
    )
    parser.add_argument(
        "--token",
        default="alchemy-v2-token",
        help="Auth token",
    )
    parser.add_argument(
        "--users",
        default="",
        help="Comma-separated list of SLURM users to manage (e.g. ys25,hw2025)",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Log level",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )

    users = [u.strip() for u in args.users.split(",") if u.strip()]
    ssh_users = {u: {} for u in users}

    daemon = ControllerDaemon(
        server_url=args.server,
        token=args.token,
        ssh_users=ssh_users,
    )
    asyncio.run(daemon.run())


if __name__ == "__main__":
    main()
