"""Warm worker process — long-lived Python process that accepts tasks via Unix socket.

Each warm worker:
- Pre-imports heavy packages on startup (torch, numpy, etc.)
- Listens on /tmp/alchemy_warm_{worker_id}.sock
- Receives JSON task payloads, executes them via runpy.run_path()
- Cleans up between tasks (gc, torch cache) — keeps all imports for reuse
- Exits cleanly on SIGTERM after finishing current task

Usage:
    python -m alchemy_stub.warm_worker --id <worker_id>
    python -m alchemy_stub.warm_worker --id <worker_id> --preload torch,numpy
"""
from __future__ import annotations

import argparse
import gc
import json
import logging
import os
import runpy
import signal
import socket
import struct
import sys
import traceback
import time
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

_SOCK_DIR = "/tmp"
_LOG_DIR_DEFAULT = os.path.join(os.path.expanduser("~"), ".alchemy", "task_logs")

# Length-prefix protocol: 4-byte big-endian uint32 followed by UTF-8 JSON
_HDR_FMT = ">I"
_HDR_SIZE = 4


def _log_dir() -> str:
    d = os.environ.get("ALCHEMY_LOG_DIR", _LOG_DIR_DEFAULT)
    os.makedirs(d, exist_ok=True)
    return d


def _log_path(task_id: str) -> str:
    return os.path.join(_log_dir(), f"{task_id}.log")


def worker_socket_path(worker_id: str) -> str:
    return os.path.join(_SOCK_DIR, f"alchemy_warm_{worker_id}.sock")


def _send_msg(conn: socket.socket, payload: dict) -> None:
    """Send a length-prefixed JSON message."""
    data = json.dumps(payload).encode("utf-8")
    header = struct.pack(_HDR_FMT, len(data))
    conn.sendall(header + data)


def _recv_msg(conn: socket.socket) -> dict | None:
    """Receive a length-prefixed JSON message. Returns None on EOF."""
    try:
        header = _recv_exactly(conn, _HDR_SIZE)
        if header is None:
            return None
        length = struct.unpack(_HDR_FMT, header)[0]
        if length == 0:
            return {}
        body = _recv_exactly(conn, length)
        if body is None:
            return None
        return json.loads(body.decode("utf-8"))
    except (OSError, json.JSONDecodeError, struct.error):
        return None


def _recv_exactly(conn: socket.socket, n: int) -> bytes | None:
    """Read exactly n bytes. Returns None on EOF."""
    buf = b""
    while len(buf) < n:
        try:
            chunk = conn.recv(n - len(buf))
        except OSError:
            return None
        if not chunk:
            return None
        buf += chunk
    return buf


def _preload_packages(packages: list[str]) -> None:
    """Import packages silently; skip if not installed."""
    for pkg in packages:
        try:
            __import__(pkg)
            log.debug("Preloaded: %s", pkg)
        except ImportError:
            log.debug("Preload skip (not installed): %s", pkg)
        except Exception as e:
            log.debug("Preload skip (%s): %s", pkg, e)


def _snapshot_modules() -> set[str]:
    """Return current set of module names (for cleanup after task)."""
    return set(sys.modules.keys())


def _restore_modules(snapshot: set[str]) -> None:
    """Remove modules that were added since snapshot was taken."""
    current = set(sys.modules.keys())
    added = current - snapshot
    for mod in added:
        sys.modules.pop(mod, None)


class _LogCapture:
    """Context manager: redirect stdout/stderr to task log file."""

    def __init__(self, task_id: str) -> None:
        self.log_path = _log_path(task_id)
        self._log_file = None
        self._orig_stdout = None
        self._orig_stderr = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.log_path), exist_ok=True)
        self._log_file = open(self.log_path, "w", buffering=1)
        self._orig_stdout = sys.stdout
        self._orig_stderr = sys.stderr
        sys.stdout = self._log_file
        sys.stderr = self._log_file
        return self

    def __exit__(self, *_):
        sys.stdout = self._orig_stdout
        sys.stderr = self._orig_stderr
        if self._log_file:
            try:
                self._log_file.flush()
                self._log_file.close()
            except Exception:
                pass
            self._log_file = None


def _run_task(payload: dict) -> dict:
    """Execute a single task payload. Returns result dict."""
    task_id: str = payload["task_id"]
    script: str = payload["script"]
    cwd: str | None = payload.get("cwd")
    env: dict[str, str] = payload.get("env") or {}
    params: dict | None = payload.get("params")
    run_dir: str | None = payload.get("run_dir")
    config_path: str | None = payload.get("config_path")
    stub_socket: str = payload.get("stub_socket", "")

    # --- Save state for cleanup ---
    orig_cwd = os.getcwd()
    orig_argv = list(sys.argv)
    orig_env = dict(os.environ)

    # --- Set ALCHEMY_* env vars ---
    os.environ["ALCHEMY_TASK_ID"] = task_id
    if stub_socket:
        os.environ["ALCHEMY_STUB_SOCKET"] = stub_socket
    if params is not None:
        os.environ["ALCHEMY_PARAMS"] = json.dumps(params)
    elif "ALCHEMY_PARAMS" in os.environ:
        del os.environ["ALCHEMY_PARAMS"]
    if run_dir:
        os.environ["ALCHEMY_RUN_DIR"] = run_dir
    elif "ALCHEMY_RUN_DIR" in os.environ:
        del os.environ["ALCHEMY_RUN_DIR"]
    if config_path:
        os.environ["ALCHEMY_CONFIG"] = config_path
    elif "ALCHEMY_CONFIG" in os.environ:
        del os.environ["ALCHEMY_CONFIG"]

    # Apply task env overrides
    for k, v in env.items():
        os.environ[k] = v

    # --- Change cwd ---
    if cwd:
        try:
            os.chdir(cwd)
        except Exception as e:
            return {"task_id": task_id, "exit_code": 1, "error": f"chdir failed: {e}"}

    # --- Reset sys.argv ---
    sys.argv = [script]

    exit_code = 0
    error_msg = None

    try:
        with _LogCapture(task_id):
            try:
                runpy.run_path(script, run_name="__main__")
            except SystemExit as e:
                ec = e.code
                if ec is None:
                    exit_code = 0
                elif isinstance(ec, int):
                    exit_code = ec
                else:
                    # SystemExit with non-int message → treat as error
                    exit_code = 1
                    error_msg = str(ec)
            except Exception:
                exit_code = 1
                error_msg = traceback.format_exc()
    except Exception as capture_err:
        exit_code = 1
        error_msg = f"Log capture error: {capture_err}"
    finally:
        # --- Cleanup ---
        # 1. gc + torch cache
        try:
            gc.collect()
        except Exception:
            pass
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

        # 2. Keep all imported modules — they accumulate across tasks for faster startup

        # 3. Restore argv, cwd, env
        sys.argv = orig_argv
        try:
            os.chdir(orig_cwd)
        except Exception:
            pass
        # Restore env: remove added keys, restore modified ones
        try:
            current_keys = set(os.environ.keys())
            for k in current_keys - set(orig_env.keys()):
                try:
                    del os.environ[k]
                except KeyError:
                    pass
            for k, v in orig_env.items():
                os.environ[k] = v
        except Exception:
            pass

    return {"task_id": task_id, "exit_code": exit_code, "error": error_msg}


class WarmWorker:
    """Long-running warm worker that serves tasks over Unix socket."""

    def __init__(self, worker_id: str, preload: list[str]) -> None:
        self.worker_id = worker_id
        self.preload = preload
        self.sock_path = worker_socket_path(worker_id)
        self._shutdown = False

    def _handle_sigterm(self, signum, frame) -> None:
        """Set shutdown flag — worker finishes current task then exits."""
        log.info("WarmWorker %s: SIGTERM received, will exit after current task", self.worker_id)
        self._shutdown = True

    def run(self) -> None:
        """Main loop: accept connections, process tasks."""
        signal.signal(signal.SIGTERM, self._handle_sigterm)
        signal.signal(signal.SIGINT, self._handle_sigterm)

        # Pre-import heavy packages
        log.info("WarmWorker %s: preloading %s", self.worker_id, self.preload)
        _preload_packages(self.preload)
        log.info("WarmWorker %s: ready, listening on %s", self.worker_id, self.sock_path)

        # Remove stale socket file if it exists
        try:
            os.unlink(self.sock_path)
        except FileNotFoundError:
            pass

        server_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            server_sock.bind(self.sock_path)
            server_sock.listen(8)
            server_sock.settimeout(2.0)  # poll for shutdown flag

            while not self._shutdown:
                try:
                    conn, _ = server_sock.accept()
                except socket.timeout:
                    continue
                except OSError as e:
                    if self._shutdown:
                        break
                    log.error("WarmWorker %s: accept error: %s", self.worker_id, e)
                    break

                try:
                    self._handle_connection(conn)
                except Exception as e:
                    log.error("WarmWorker %s: connection error: %s", self.worker_id, e)
                finally:
                    try:
                        conn.close()
                    except Exception:
                        pass

                if self._shutdown:
                    break

        finally:
            try:
                server_sock.close()
            except Exception:
                pass
            try:
                os.unlink(self.sock_path)
            except FileNotFoundError:
                pass
            log.info("WarmWorker %s: exited", self.worker_id)

    def _handle_connection(self, conn: socket.socket) -> None:
        """Handle one client connection (one ping or one task)."""
        msg = _recv_msg(conn)
        if msg is None:
            return

        msg_type = msg.get("type", "task")

        if msg_type == "ping":
            _send_msg(conn, {"type": "pong", "worker_id": self.worker_id})
            return

        if msg_type == "shutdown":
            self._shutdown = True
            _send_msg(conn, {"type": "ok"})
            return

        # Default: task execution
        task_id = msg.get("task_id", "unknown")
        log.info("WarmWorker %s: running task %s", self.worker_id, task_id)

        try:
            result = _run_task(msg)
        except Exception as e:
            log.error("WarmWorker %s: unhandled error in task %s: %s", self.worker_id, task_id, e)
            result = {
                "task_id": task_id,
                "exit_code": 1,
                "error": traceback.format_exc(),
            }

        log.info(
            "WarmWorker %s: task %s done (exit_code=%d)",
            self.worker_id, task_id, result.get("exit_code", -1),
        )
        _send_msg(conn, result)


def main() -> None:
    parser = argparse.ArgumentParser(description="Alchemy warm worker process")
    parser.add_argument("--id", required=True, help="Worker ID (unique within stub)")
    parser.add_argument(
        "--preload",
        default="torch,numpy",
        help="Comma-separated list of packages to preload (default: torch,numpy)",
    )
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] warm_worker %(message)s",
        stream=sys.stderr,
    )

    preload = [p.strip() for p in args.preload.split(",") if p.strip()]
    worker = WarmWorker(worker_id=args.id, preload=preload)
    worker.run()


if __name__ == "__main__":
    main()
