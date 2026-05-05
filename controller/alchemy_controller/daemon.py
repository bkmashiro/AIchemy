"""ControllerDaemon — SLURM proxy that connects to the alchemy server.

Connects to /controller namespace and:
  - Registers itself on connect
  - Reports cluster status every 30s (sinfo + squeue)
  - Handles slurm.submit / slurm.cancel / slurm.status / stub.restart events
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import ssl
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import socketio

log = logging.getLogger(__name__)

STATUS_INTERVAL_S = 30


def _build_ssl_context() -> ssl.SSLContext | bool:
    """Respect SSL_CERT_FILE for A30 nodes."""
    cert_file = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
    if not cert_file:
        return True
    ctx = ssl.create_default_context()
    ctx.load_verify_locations(cert_file)
    return ctx


class ControllerDaemon:
    """Main controller daemon.

    Args:
        server_url: Alchemy server URL.
        token: Auth token.
        ssh_users: dict of {username: {}} for multi-user SLURM support.
    """

    def __init__(
        self,
        server_url: str,
        token: str,
        ssh_users: dict[str, dict] | None = None,
    ) -> None:
        self.server_url = server_url
        self.token = token
        self.ssh_users = ssh_users or {}

        self.sio = socketio.AsyncClient(
            reconnection=True,
            reconnection_attempts=0,  # infinite
            reconnection_delay=1,
            reconnection_delay_max=60,
            logger=False,
            engineio_logger=False,
            ssl_verify=_build_ssl_context(),
        )

        self._connected = False
        self._setup_handlers()

    # ------------------------------------------------------------------ #
    # socket.io handler registration                                       #
    # ------------------------------------------------------------------ #

    def _setup_handlers(self) -> None:
        sio = self.sio

        @sio.event(namespace="/controller")
        async def connect():
            log.info("controller.connect server=%s", self.server_url)
            self._connected = True
            await self._register()

        @sio.event(namespace="/controller")
        async def disconnect():
            log.info("controller.disconnect")
            self._connected = False

        @sio.on("slurm.submit", namespace="/controller")
        async def on_slurm_submit(*args):
            data, ack = _extract(args)
            if data is None:
                if ack:
                    ack({"ok": False, "error": "missing payload"})
                return
            log.info("slurm.submit user=%s partition=%s", data.get("user"), data.get("partition"))
            try:
                result = await self.submit_job(data)
                if ack:
                    ack({"ok": True, **result})
            except Exception as e:
                log.error("slurm.submit error: %s", e)
                if ack:
                    ack({"ok": False, "error": str(e)})

        @sio.on("slurm.cancel", namespace="/controller")
        async def on_slurm_cancel(*args):
            data, ack = _extract(args)
            if data is None:
                if ack:
                    ack({"ok": False, "error": "missing payload"})
                return
            job_id = data.get("job_id")
            user = data.get("user")
            log.info("slurm.cancel job_id=%s user=%s", job_id, user)
            try:
                result = await self.cancel_job(job_id, user=user)
                if ack:
                    ack({"ok": True, **result})
            except Exception as e:
                log.error("slurm.cancel error: %s", e)
                if ack:
                    ack({"ok": False, "error": str(e)})

        @sio.on("slurm.status", namespace="/controller")
        async def on_slurm_status(*args):
            _data, ack = _extract(args)
            log.info("slurm.status: immediate update requested")
            try:
                status = await self.get_cluster_status()
                await self.sio.emit("cluster.status", status, namespace="/controller")
                if ack:
                    ack({"ok": True})
            except Exception as e:
                log.error("slurm.status error: %s", e)
                if ack:
                    ack({"ok": False, "error": str(e)})

        @sio.on("stub.restart", namespace="/controller")
        async def on_stub_restart(*args):
            data, ack = _extract(args)
            if data is None:
                if ack:
                    ack({"ok": False, "error": "missing payload"})
                return
            node = data.get("node")
            user = data.get("user", os.getenv("USER", "ys25"))
            log.info("stub.restart node=%s user=%s", node, user)
            try:
                result = await self._restart_stub(node=node, user=user)
                if ack:
                    ack({"ok": True, **result})
            except Exception as e:
                log.error("stub.restart error: %s", e)
                if ack:
                    ack({"ok": False, "error": str(e)})

    # ------------------------------------------------------------------ #
    # Registration                                                         #
    # ------------------------------------------------------------------ #

    async def _register(self) -> None:
        users = list(self.ssh_users.keys()) or [os.getenv("USER", "ys25")]
        payload = {
            "token": self.token,
            "hostname": _get_hostname(),
            "users": users,
            "capabilities": ["sbatch", "scancel", "squeue", "sinfo"],
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        await self.sio.emit("controller.register", payload, namespace="/controller")
        log.info("controller.register sent users=%s", users)

    # ------------------------------------------------------------------ #
    # SLURM command execution                                              #
    # ------------------------------------------------------------------ #

    async def _run_slurm_cmd(self, cmd: list[str], user: str | None = None) -> str:
        """Run a SLURM command, optionally as a different user via SSH."""
        current_user = os.getenv("USER", "")
        if user and user != current_user:
            full_cmd = ["ssh", f"{user}@localhost", "--"] + cmd
        else:
            full_cmd = cmd

        log.debug("slurm_cmd: %s", " ".join(full_cmd))
        proc = await asyncio.create_subprocess_exec(
            *full_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            err = stderr.decode().strip()
            log.warning("slurm_cmd failed (rc=%d): %s", proc.returncode, err)
        return stdout.decode()

    # ------------------------------------------------------------------ #
    # Cluster status                                                       #
    # ------------------------------------------------------------------ #

    async def get_cluster_status(self) -> dict:
        """Parse sinfo + squeue and return structured cluster status."""
        # Run sinfo and squeue concurrently
        sinfo_task = asyncio.create_task(self._run_slurm_cmd([
            "sinfo", "-o", "%P|%G|%D|%a|%T|%N|%C", "--noheader",
        ]))
        users = ",".join(self.ssh_users.keys()) if self.ssh_users else os.getenv("USER", "ys25")
        squeue_task = asyncio.create_task(self._run_slurm_cmd([
            "squeue", "-u", users,
            "-o", "%i|%P|%j|%T|%M|%D|%R|%u",
            "--noheader",
        ]))

        sinfo_out, squeue_out = await asyncio.gather(sinfo_task, squeue_task)

        partitions = _parse_sinfo(sinfo_out)
        jobs = _parse_squeue(squeue_out)
        queue_analysis = _analyze_queue(partitions, jobs)

        return {
            "partitions": partitions,
            "jobs": jobs,
            "queue_analysis": queue_analysis,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

    # ------------------------------------------------------------------ #
    # Job submission                                                       #
    # ------------------------------------------------------------------ #

    async def submit_job(self, params: dict) -> dict:
        """Generate sbatch script and submit."""
        user = params.get("user", os.getenv("USER", "ys25"))

        # Inject server_url and token if not provided
        if "server_url" not in params:
            params = {**params, "server_url": self.server_url}
        if "token" not in params:
            params = {**params, "token": self.token}

        script = self._generate_sbatch_script(params)
        script_path = f"/tmp/alchemy_sbatch_{uuid4().hex[:8]}.sh"

        try:
            with open(script_path, "w") as f:
                f.write(script)

            result = await self._run_slurm_cmd(["sbatch", script_path], user=user)
            # sbatch output: "Submitted batch job 235166"
            job_id = result.strip().split()[-1] if result.strip() else "unknown"
            log.info("sbatch submitted job_id=%s user=%s partition=%s", job_id, user, params.get("partition"))
            return {"job_id": job_id, "user": user}
        finally:
            try:
                os.unlink(script_path)
            except OSError:
                pass

    def _generate_sbatch_script(self, params: dict) -> str:
        """Generate a standardized sbatch script for alchemy stubs."""
        user = params.get("user", "ys25")
        partition = params["partition"]
        gres = params.get("gres", "gpu:1")
        mem = params.get("mem", "120G")
        time_limit = params.get("time", "24:00:00")
        max_concurrent = params.get("max_concurrent", 5)
        output_dir = params.get("output_dir", f"/vol/bitbucket/{user}/jema/logs")
        server_url = params.get("server_url", "https://alchemy-v2.yuzhes.com")
        token = params.get("token", "alchemy-v2-token")
        env_setup = params.get("env_setup", "")
        tags = params.get("tags", [])

        tags_arg = f"--tags {','.join(tags)}" if tags else ""
        env_setup_arg = f'--env-setup "{env_setup}"' if env_setup else ""

        return f"""#!/bin/bash
#SBATCH --partition={partition}
#SBATCH --gres={gres}
#SBATCH --mem={mem}
#SBATCH --time={time_limit}
#SBATCH --job-name=train_ct
#SBATCH --output={output_dir}/alchemy-{partition}-%j.log

export PATH=/vol/bitbucket/{user}/conda-envs/jema/bin:$PATH
export PYTHONPATH=/vol/bitbucket/{user}/jema:$PYTHONPATH
export TORCH_HOME=/vol/bitbucket/{user}/.cache/torch
export HF_HOME=/vol/bitbucket/{user}/hf
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

cd /vol/bitbucket/{user}/jema

echo "Node: $(hostname) | Date: $(date)"

while true; do
    echo "[$(date)] Starting alchemy stub..."
    python3 -m alchemy_stub \\
        --server {server_url} \\
        --token {token} \\
        --max-concurrent {max_concurrent} \\
        {tags_arg} \\
        {env_setup_arg}
    echo "[$(date)] Stub exited, restarting in 5s..."
    sleep 5
done
"""

    # ------------------------------------------------------------------ #
    # Job cancellation                                                     #
    # ------------------------------------------------------------------ #

    async def cancel_job(self, job_id: str, user: str | None = None) -> dict:
        """Cancel a SLURM job."""
        result = await self._run_slurm_cmd(["scancel", job_id], user=user)
        log.info("scancel job_id=%s result=%s", job_id, result.strip())
        return {"job_id": job_id, "cancelled": True}

    # ------------------------------------------------------------------ #
    # Stub restart                                                         #
    # ------------------------------------------------------------------ #

    async def _restart_stub(self, node: str | None, user: str) -> dict:
        """Kill the alchemy_stub python process on a given node."""
        if not node:
            return {"ok": False, "error": "node required"}
        cmd = ["ssh", f"{user}@{node}", "--", "pkill", "-f", "alchemy_stub"]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
        log.info("stub.restart node=%s user=%s rc=%s", node, user, proc.returncode)
        return {"node": node, "user": user, "signal_sent": True}

    # ------------------------------------------------------------------ #
    # Status reporting loop                                                #
    # ------------------------------------------------------------------ #

    async def _status_loop(self) -> None:
        """Emit cluster.status every STATUS_INTERVAL_S seconds."""
        while True:
            await asyncio.sleep(STATUS_INTERVAL_S)
            if not self._connected:
                continue
            try:
                status = await self.get_cluster_status()
                await self.sio.emit("cluster.status", status, namespace="/controller")
                log.debug(
                    "cluster.status emitted partitions=%d jobs=%d",
                    len(status.get("partitions", [])),
                    len(status.get("jobs", [])),
                )
            except Exception as e:
                log.warning("status_loop error: %s", e)

    # ------------------------------------------------------------------ #
    # Main run                                                             #
    # ------------------------------------------------------------------ #

    async def run(self) -> None:
        asyncio.create_task(self._status_loop())

        log.info("Connecting to %s/controller", self.server_url)
        while True:
            try:
                await self.sio.connect(self.server_url, namespaces=["/controller"])
                await self.sio.wait()
            except socketio.exceptions.ConnectionError as e:
                log.warning("controller.reconnect error=%s", e)
                await asyncio.sleep(5)
            except Exception as e:
                log.error("controller.reconnect error=%s", e)
                await asyncio.sleep(5)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _extract(args: tuple) -> tuple[dict | None, Any]:
    """Extract (payload_dict, ack_callback) from socket.io handler args."""
    data: dict | None = None
    ack = None
    for a in args:
        if isinstance(a, dict) and data is None:
            data = a
        elif isinstance(a, str) and data is None:
            try:
                parsed = json.loads(a)
                if isinstance(parsed, dict):
                    data = parsed
            except (ValueError, TypeError):
                pass
        elif callable(a):
            ack = a
    return data, ack


def _get_hostname() -> str:
    import socket as _socket
    try:
        return _socket.gethostname()
    except Exception:
        return "unknown"


def _parse_sinfo(sinfo_out: str) -> list[dict]:
    """Parse sinfo -o '%P|%G|%D|%a|%T|%N|%C' output into partition dicts.

    %C format: allocated/idle/other/total
    %G format: gpu:N or (null)
    """
    partitions: dict[str, dict] = {}

    for line in sinfo_out.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("|")
        if len(parts) < 7:
            continue

        part_name = parts[0].rstrip("*")
        gres_str = parts[1]
        nodes_count = _safe_int(parts[2])
        available = parts[3].lower() == "up"
        state = parts[4].lower()
        node_list = parts[5]
        cpu_str = parts[6]  # allocated/idle/other/total

        # Extract GPU count per node from gres
        gpus_per_node = 0
        m = re.search(r"gpu:(?:\w+:)?(\d+)", gres_str)
        if m:
            gpus_per_node = int(m.group(1))

        total_gpus = gpus_per_node * nodes_count

        # Count available GPUs: idle nodes × gpus_per_node
        is_idle = "idle" in state or state == "idle"
        available_gpus = gpus_per_node * nodes_count if (is_idle and available) else 0

        if part_name not in partitions:
            partitions[part_name] = {
                "name": part_name,
                "total_gpus": 0,
                "available_gpus": 0,
                "nodes": [],
                "pending_jobs": 0,
            }

        partitions[part_name]["total_gpus"] += total_gpus
        partitions[part_name]["available_gpus"] += available_gpus
        if node_list and node_list != "n/a":
            partitions[part_name]["nodes"].append(node_list)

    return list(partitions.values())


def _parse_squeue(squeue_out: str) -> list[dict]:
    """Parse squeue -o '%i|%P|%j|%T|%M|%D|%R|%u' output into job dicts."""
    jobs = []
    for line in squeue_out.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("|")
        if len(parts) < 8:
            continue
        jobs.append({
            "job_id": parts[0],
            "partition": parts[1],
            "name": parts[2],
            "state": parts[3],
            "time": parts[4],
            "nodes": parts[5],
            "reason": parts[6],
            "user": parts[7],
        })
    return jobs


def _analyze_queue(partitions: list[dict], jobs: list[dict]) -> dict:
    """Analyze pending jobs per partition and estimate wait times."""
    # Count pending jobs per partition
    pending_by_partition: dict[str, int] = {}
    for job in jobs:
        if job["state"] == "PENDING":
            p = job["partition"]
            pending_by_partition[p] = pending_by_partition.get(p, 0) + 1

    analysis: dict[str, dict] = {}
    for part in partitions:
        name = part["name"]
        pending = pending_by_partition.get(name, 0)
        available = part["available_gpus"]

        # Rough wait estimate
        if available > 0:
            estimated_wait = "immediate"
        elif pending == 0:
            estimated_wait = "~soon"
        elif pending <= 5:
            estimated_wait = "~1h"
        elif pending <= 15:
            estimated_wait = "~3h"
        else:
            estimated_wait = "~6h+"

        analysis[name] = {
            "pending_count": pending,
            "estimated_wait": estimated_wait,
            "available_gpus": available,
        }

        # Update partition pending_jobs count
        part["pending_jobs"] = pending

    return analysis


def _safe_int(s: str, default: int = 0) -> int:
    try:
        return int(s)
    except (ValueError, TypeError):
        return default
