"""Main stub daemon loop."""
import asyncio
import json
import os
import subprocess
import time
from datetime import datetime, timezone
from typing import Any

import socketio

from .config import Config
from .gpu_monitor import GpuMonitor
from .process_mgr import ProcessManager


class StubDaemon:
    def __init__(self, config: Config):
        self.config = config
        self.gpu_monitor = GpuMonitor()
        self.stub_id: str | None = None
        self.registered = False
        self.last_task_time = time.time()
        self.pong_received = False
        self.missed_pongs = 0

        self.sio = socketio.AsyncClient(
            reconnection=True,
            reconnection_attempts=0,  # infinite
            reconnection_delay=1,
            reconnection_delay_max=60,
            logger=False,
            engineio_logger=False,
        )

        self.process_mgr = ProcessManager(
            max_concurrent=config.max_concurrent,
            env_setup=config.env_setup,
            pid_file=config.pid_file,
            on_started=self._on_task_started,
            on_log=self._on_task_log,
            on_completed=self._on_task_completed,
            on_failed=self._on_task_failed,
        )

        self._setup_handlers()

    def _setup_handlers(self):
        sio = self.sio

        @sio.event(namespace="/stubs")
        async def connect():
            print("[daemon] Connected to server")
            await self._register()

        @sio.event(namespace="/stubs")
        async def disconnect():
            print("[daemon] Disconnected from server")
            self.registered = False

        @sio.event(namespace="/stubs")
        async def registered(data: dict):
            self.stub_id = data["stub_id"]
            self.registered = True
            print(f"[daemon] Registered as {self.stub_id}")

        @sio.event(namespace="/stubs")
        async def pong(data: dict):
            self.pong_received = True
            self.missed_pongs = 0

        @sio.on("task.run", namespace="/stubs")
        async def on_task_run(data: dict):
            task_id = data["task_id"]
            command = data["command"]
            cwd = data.get("cwd")
            env = data.get("env") or {}
            env_setup = data.get("env_setup") or ""
            param_overrides = data.get("param_overrides")
            base_config = data.get("base_config")

            # Mode B: ALCHEMY_PARAMS always injected via env (set by server)
            # Mode C: generate config file from base YAML + overrides
            if base_config and param_overrides:
                config_path = self._generate_config(task_id, base_config, param_overrides, cwd)
                command = command.replace("{generated_config_path}", config_path)

            print(f"[daemon] Starting task {task_id}: {command!r}")
            self.last_task_time = time.time()

            if self.process_mgr.is_running(task_id):
                print(f"[daemon] Task {task_id} already running, ignoring")
                return

            try:
                pid = self.process_mgr.start(task_id, command, cwd, env, env_setup)
                await self.sio.emit(
                    "task.started",
                    {"task_id": task_id, "pid": pid},
                    namespace="/stubs",
                )
            except Exception as e:
                await self.sio.emit(
                    "task.failed",
                    {"task_id": task_id, "exit_code": -1, "error": str(e)},
                    namespace="/stubs",
                )

        @sio.on("task.kill", namespace="/stubs")
        async def on_task_kill(data: dict):
            task_id = data["task_id"]
            sig = data.get("signal", "SIGTERM")
            print(f"[daemon] Killing task {task_id} with {sig}")
            self.process_mgr.kill(task_id, sig)

        @sio.on("task.pause", namespace="/stubs")
        async def on_task_pause(data: dict):
            task_id = data["task_id"]
            print(f"[daemon] Pausing task {task_id}")
            self.process_mgr.pause(task_id)

        @sio.on("task.resume", namespace="/stubs")
        async def on_task_resume(data: dict):
            task_id = data["task_id"]
            print(f"[daemon] Resuming task {task_id}")
            self.process_mgr.resume(task_id)

        @sio.on("config.update", namespace="/stubs")
        async def on_config_update(data: dict):
            if "max_concurrent" in data:
                self.process_mgr.max_concurrent = data["max_concurrent"]
                print(f"[daemon] Updated max_concurrent to {data['max_concurrent']}")

        @sio.on("shell.exec", namespace="/stubs")
        async def on_shell_exec(data: dict):
            exec_id = data["id"]
            command = data["command"]
            timeout = data.get("timeout", 30)
            print(f"[daemon] Shell exec: {command!r}")
            try:
                result = await asyncio.wait_for(
                    asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: subprocess.run(
                            command,
                            shell=True,
                            capture_output=True,
                            text=True,
                            timeout=timeout,
                        ),
                    ),
                    timeout=timeout + 2,
                )
                await self.sio.emit(
                    "shell.result",
                    {
                        "id": exec_id,
                        "stdout": result.stdout,
                        "stderr": result.stderr,
                        "exit_code": result.returncode,
                        "timed_out": False,
                    },
                    namespace="/stubs",
                )
            except (asyncio.TimeoutError, subprocess.TimeoutExpired):
                await self.sio.emit(
                    "shell.result",
                    {
                        "id": exec_id,
                        "stdout": "",
                        "stderr": "Timed out",
                        "exit_code": -1,
                        "timed_out": True,
                    },
                    namespace="/stubs",
                )
            except Exception as e:
                await self.sio.emit(
                    "shell.result",
                    {
                        "id": exec_id,
                        "stdout": "",
                        "stderr": str(e),
                        "exit_code": -1,
                        "timed_out": False,
                    },
                    namespace="/stubs",
                )

    async def _register(self):
        gpu_info = self.gpu_monitor.get_gpu_info()
        payload: dict[str, Any] = {
            "hostname": self.config.hostname,
            "gpu": gpu_info,
            "max_concurrent": self.config.max_concurrent,
            "token": self.config.token,
        }
        if self.config.slurm_job_id:
            payload["slurm_job_id"] = self.config.slurm_job_id
            payload["type"] = "slurm"
            slurm_info = self._get_slurm_info()
            if slurm_info:
                payload["slurm"] = slurm_info
                payload["remaining_walltime_s"] = slurm_info.get("walltime_remaining_s")
        else:
            payload["type"] = "workstation"

        await self.sio.emit("register", payload, namespace="/stubs")

    def _get_slurm_info(self) -> dict | None:
        """Get SLURM job info including walltime."""
        job_id = self.config.slurm_job_id
        if not job_id:
            return None
        try:
            result = subprocess.run(
                ["scontrol", "show", "job", job_id],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode != 0:
                return None
            info: dict[str, Any] = {
                "job_id": job_id,
                "partition": self.config.slurm_partition or "unknown",
                "node": self.config.slurm_node or "unknown",
                "walltime_remaining_s": 0,
            }
            # Parse TimeLimit and StartTime
            output = result.stdout
            import re
            tl_match = re.search(r"TimeLimit=(\d+):(\d+):(\d+)", output)
            st_match = re.search(r"StartTime=(\S+)", output)
            if tl_match and st_match:
                tl_h, tl_m, tl_s = int(tl_match.group(1)), int(tl_match.group(2)), int(tl_match.group(3))
                walltime_s = tl_h * 3600 + tl_m * 60 + tl_s
                from datetime import datetime
                start_str = st_match.group(1)
                try:
                    start = datetime.fromisoformat(start_str.replace("T", " "))
                    elapsed = (datetime.now() - start).total_seconds()
                    remaining = max(0, walltime_s - elapsed)
                    info["walltime_remaining_s"] = int(remaining)
                except Exception:
                    pass
            return info
        except Exception:
            return None

    def _generate_config(self, task_id: str, base_config: str, overrides: dict, cwd: str | None) -> str:
        """Mode C: merge base YAML with param overrides, write temp config file."""
        import yaml

        base = yaml.safe_load(base_config) or {}
        # Deep merge overrides into base
        for k, v in overrides.items():
            base[k] = v

        config_dir = os.path.join(cwd or ".", ".aichemy_configs")
        os.makedirs(config_dir, exist_ok=True)
        config_path = os.path.join(config_dir, f"{task_id}.yaml")
        with open(config_path, "w") as f:
            yaml.dump(base, f, default_flow_style=False)
        print(f"[daemon] Generated config: {config_path}")
        return config_path

    async def _on_task_started(self, task_id: str, pid: int):
        if self.registered:
            await self.sio.emit(
                "task.started",
                {"task_id": task_id, "pid": pid},
                namespace="/stubs",
            )

    async def _on_task_log(self, task_id: str, lines: list[str]):
        if self.registered and lines:
            await self.sio.emit(
                "task.log",
                {"task_id": task_id, "lines": lines},
                namespace="/stubs",
            )

    async def _on_task_completed(self, task_id: str, exit_code: int):
        self.last_task_time = time.time()
        if self.registered:
            await self.sio.emit(
                "task.completed",
                {"task_id": task_id, "exit_code": exit_code},
                namespace="/stubs",
            )

    async def _on_task_failed(self, task_id: str, exit_code: int, error: str):
        self.last_task_time = time.time()
        if self.registered:
            await self.sio.emit(
                "task.failed",
                {"task_id": task_id, "exit_code": exit_code, "error": error},
                namespace="/stubs",
            )

    async def _heartbeat_loop(self):
        while True:
            await asyncio.sleep(30)
            if not self.registered:
                continue
            try:
                payload: dict[str, Any] = {"timestamp": datetime.now(timezone.utc).isoformat()}

                # GPU stats
                gpu_stats = self.gpu_monitor.query()
                await self.sio.emit("gpu_stats", gpu_stats, namespace="/stubs")

                # Walltime
                if self.config.slurm_job_id:
                    slurm_info = self._get_slurm_info()
                    if slurm_info:
                        payload["remaining_walltime_s"] = slurm_info.get("walltime_remaining_s", 0)

                self.pong_received = False
                await self.sio.emit("heartbeat", payload, namespace="/stubs")

                # Wait a bit for pong
                await asyncio.sleep(5)
                if not self.pong_received:
                    self.missed_pongs += 1
                    print(f"[daemon] Missed pong #{self.missed_pongs}")
                    if self.missed_pongs >= 3:
                        print("[daemon] 3 missed pongs, reconnecting")
                        self.missed_pongs = 0
                        await self.sio.disconnect()

            except Exception as e:
                print(f"[daemon] Heartbeat error: {e}")

    async def _idle_check_loop(self):
        if self.config.idle_timeout <= 0:
            return
        while True:
            await asyncio.sleep(30)
            if self.process_mgr.running_count() == 0:
                idle_s = time.time() - self.last_task_time
                if idle_s >= self.config.idle_timeout:
                    print(f"[daemon] Idle timeout ({idle_s:.0f}s), exiting")
                    os._exit(0)

    async def run(self):
        # Try to re-attach surviving tasks
        reattached = self.process_mgr.load_and_reattach()
        if reattached:
            print(f"[daemon] Re-attached {len(reattached)} tasks")

        # Start process monitoring
        self.process_mgr.start_monitoring()

        # Start background loops
        asyncio.create_task(self._heartbeat_loop())
        asyncio.create_task(self._idle_check_loop())

        # Connect and run forever
        server_url = self.config.server
        while True:
            try:
                print(f"[daemon] Connecting to {server_url}")
                await self.sio.connect(server_url, namespaces=["/stubs"])
                await self.sio.wait()
            except Exception as e:
                print(f"[daemon] Connection error: {e}")
                await asyncio.sleep(5)
