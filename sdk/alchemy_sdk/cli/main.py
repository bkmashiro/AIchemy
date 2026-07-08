from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import sqlite3
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DEFAULT_SERVER = "http://localhost:3002"
ACTIVE_STATUSES = {"pending", "assigned", "running", "paused", "blocked"}
TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
DANGEROUS_STATUSES = {"running", "assigned"}
COMPARE_MAX_REFS = 6  # server caps `/experiments/compare?ids=...` at 6
TASK_FIELDS = [
    "script", "argv", "args", "raw_args", "name", "cwd", "env_setup", "env", "env_overrides",
    "requirements", "priority", "max_retries", "param_overrides", "target_tags", "target_stub_id",
    "python_env", "submitted_by", "depends_on", "ref", "args_template", "experiment_id",
    "outputs", "auto_retry_on",
]


class AlchError(RuntimeError):
    pass


class ApiClient:
    def __init__(self, server: str, token: str, timeout: float = 20.0):
        self.server = server.rstrip("/")
        self.token = token
        self.timeout = timeout

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = Request(
            f"{self.server}/api{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urlopen(req, timeout=self.timeout) as resp:  # noqa: S310 - operator-supplied URL
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                detail = json.loads(raw)
            except json.JSONDecodeError:
                detail = raw
            raise AlchError(f"HTTP {exc.code}: {detail}") from exc
        except URLError as exc:
            raise AlchError(f"request failed: {exc.reason}") from exc

    def get(self, path: str) -> Any:
        return self.request("GET", path)

    def raw_get(self, path: str) -> Any:
        req = Request(f"{self.server}{path}", method="GET")
        try:
            with urlopen(req, timeout=self.timeout) as resp:  # noqa: S310 - operator-supplied URL
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                detail = json.loads(raw)
            except json.JSONDecodeError:
                detail = raw
            raise AlchError(f"HTTP {exc.code}: {detail}") from exc
        except URLError as exc:
            raise AlchError(f"request failed: {exc.reason}") from exc

    def post(self, path: str, body: dict[str, Any] | None = None) -> Any:
        return self.request("POST", path, body or {})

    def patch(self, path: str, body: dict[str, Any]) -> Any:
        return self.request("PATCH", path, body)

    def delete(self, path: str) -> Any:
        return self.request("DELETE", path)


def config_path() -> Path:
    override = os.environ.get("ALCHEMY_CLI_CONFIG")
    if override:
        return Path(override).expanduser()
    base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "alchemy" / "alch.json"


def load_config() -> dict[str, Any]:
    path = config_path()
    if not path.exists():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise AlchError(f"invalid config file {path}: {exc.msg}") from exc
    if not isinstance(loaded, dict):
        raise AlchError(f"invalid config file {path}: expected JSON object")
    return loaded


def save_config(config: dict[str, Any]) -> Path:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def cmd_config_set(args: argparse.Namespace) -> None:
    config = load_config()
    if args.server:
        config["server"] = args.server.rstrip("/")
    if args.stub_server_url:
        config["stub_server_url"] = args.stub_server_url.rstrip("/")
    if args.state_db:
        config["state_db"] = str(Path(args.state_db).expanduser())
    if args.timeout is not None:
        config["timeout"] = args.timeout
    path = save_config(config)
    print_json({
        "ok": True,
        "path": str(path),
        "server": config.get("server"),
        "stub_server_url": config.get("stub_server_url"),
        "state_db": config.get("state_db"),
    })


def cmd_config_show(_args: argparse.Namespace) -> None:
    config = load_config()
    print_json({"path": str(config_path()), **config})


def read_local_token(db_path: str) -> str:
    con = sqlite3.connect(db_path)
    try:
        row = con.execute("select token from tokens limit 1").fetchone()
    finally:
        con.close()
    if not row or not row[0]:
        raise AlchError(f"no token found in {db_path}")
    return str(row[0])


def build_client(args: argparse.Namespace) -> ApiClient:
    config = load_config()
    server = args.server or os.environ.get("ALCHEMY_SERVER_URL") or config.get("server") or DEFAULT_SERVER
    token = args.token or os.environ.get("ALCHEMY_TOKEN")
    state_db = args.state_db or os.environ.get("ALCHEMY_STATE_DB") or config.get("state_db")
    if not token and (args.local or state_db):
        token = read_local_token(state_db or "state.db")
    if not token:
        raise AlchError("missing token: run `alch config set --state-db /path/to/state.db`, set ALCHEMY_TOKEN, or pass --local [--state-db state.db]")
    timeout = args.timeout if args.timeout != 20.0 else float(config.get("timeout", args.timeout))
    return ApiClient(str(server), token, timeout=timeout)


def print_json(data: Any) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True))


def _summarize_inbox_payload(payload: dict[str, Any]) -> None:
    actor = str(payload.get("actor") or "akashi")
    items = payload.get("items")
    if not isinstance(items, list):
        items = []
    summary = payload.get("summary")
    if not isinstance(summary, dict):
        summary = {}

    print(f"Inbox for actor: {actor}")
    if payload.get("generated_at"):
        print(f"Generated: {payload['generated_at']}")
    if summary:
        print("Summary:")
        for name in sorted(summary):
            print(f"  {name}: {summary[name]}")
    else:
        print("Summary: empty")

    print(f"Items ({len(items)}):")
    for item in items:
        if not isinstance(item, dict):
            continue
        seq = item.get("seq")
        status = str(item.get("status") or "")
        buckets = ",".join(item.get("buckets") or [])
        name = item.get("name")
        task_id = item.get("task_id")
        action = item.get("suggested_next_action")
        print(f"  {seq}\t{status}\t{buckets}\t{name}\t{task_id}\t{action}")

        commands = item.get("commands")
        if isinstance(commands, list) and len(commands) <= 2 and all(isinstance(cmd, str) for cmd in commands):
            total_len = sum(len(cmd) for cmd in commands)
            if total_len <= 120:
                print(f"    commands: {', '.join(commands)}")


def short_task(task: dict[str, Any]) -> dict[str, Any]:
    out = {
        "seq": task.get("seq"),
        "id": task.get("id"),
        "name": task.get("display_name") or task.get("name"),
        "status": task.get("status"),
        "stub_id": task.get("stub_id"),
        "stub_name": task.get("stub_name"),
        "started_at": task.get("started_at"),
        "pid": task.get("pid"),
        "run_dir": task.get("run_dir"),
    }
    if task.get("submission_warnings"):
        out["submission_warnings"] = task.get("submission_warnings")
    return out


def short_experiment(exp: dict[str, Any]) -> dict[str, Any]:
    out = {
        "id": exp.get("id"),
        "name": exp.get("name"),
        "status": exp.get("status"),
        "family": exp.get("family"),
        "decision": exp.get("decision"),
        "parent_name": exp.get("parent_name"),
        "created_at": exp.get("created_at"),
    }
    if exp.get("submission_warnings"):
        out["submission_warnings"] = exp.get("submission_warnings")
    return out


def find_experiment(client: ApiClient, ref: str) -> dict[str, Any]:
    experiments = client.get("/experiments")
    return resolve_experiment(experiments, ref)


def resolve_experiment(experiments: list[dict[str, Any]], ref: str) -> dict[str, Any]:
    matches = [e for e in experiments if e.get("id") == ref or e.get("name") == ref or e.get("code_id") == ref]
    if not matches:
        raise AlchError(f"experiment not found: {ref}")
    if len(matches) > 1:
        labels = [e.get("code_id") or e.get("name") or e.get("id") for e in matches]
        raise AlchError(f"ambiguous experiment ref {ref}: {labels}")
    return matches[0]


def parse_data_object(raw: str | None) -> dict[str, Any] | None:
    return parse_json_object(raw, "--data")


def parse_json_object(raw: str | None, flag: str) -> dict[str, Any] | None:
    if raw is None:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AlchError(f"{flag} must be valid JSON: {exc.msg}") from exc
    if not isinstance(parsed, dict):
        raise AlchError(f"{flag} must be a JSON object")
    return parsed


def find_stub(client: ApiClient, ref: str) -> dict[str, Any]:
    stubs = client.get("/stubs")
    matches = [s for s in stubs if s.get("id") == ref or s.get("name") == ref or s.get("hostname") == ref]
    if not matches:
        raise AlchError(f"stub not found: {ref}")
    if len(matches) > 1:
        raise AlchError(f"ambiguous stub ref {ref}: {[s.get('name') for s in matches]}")
    return matches[0]


def cmd_stubs_ls(args: argparse.Namespace, client: ApiClient) -> None:
    stubs = client.get("/stubs")
    if args.online:
        stubs = [s for s in stubs if s.get("status") == "online"]
    rows = [
        {
            "id": s.get("id"),
            "name": s.get("name"),
            "status": s.get("status"),
            "max_concurrent": s.get("max_concurrent"),
            "tasks": len(s.get("tasks") or []),
            "tags": s.get("tags"),
            "last_seen": s.get("last_seen"),
        }
        for s in stubs
    ]
    print_json(rows)


def stub_matches_wait_filter(stub: dict[str, Any], ref: str | None, tags: list[str]) -> bool:
    if stub.get("status") != "online":
        return False
    if ref and not (stub.get("id") == ref or stub.get("name") == ref or stub.get("hostname") == ref):
        return False
    stub_tags = set(stub.get("tags") or [])
    return all(tag in stub_tags for tag in tags)


def cmd_stubs_wait(args: argparse.Namespace, client: ApiClient) -> int:
    if args.timeout < 0:
        raise AlchError("timeout must be non-negative")
    if args.interval <= 0:
        raise AlchError("interval must be greater than 0")

    tags = list(args.tag or [])
    deadline = time.monotonic() + float(args.timeout)
    while True:
        if time.monotonic() > deadline:
            print_json({"ok": False, "error": "timeout", "tags": tags, "timeout": float(args.timeout)})
            return 1
        matches = [
            stub
            for stub in client.get("/stubs")
            if stub_matches_wait_filter(stub, args.stub, tags)
        ]
        if matches:
            print_json({"ok": True, "stub": matches[0]})
            return 0
        time.sleep(float(args.interval))


def cmd_stubs_drain(args: argparse.Namespace, client: ApiClient) -> None:
    stub = find_stub(client, args.stub)
    result = client.patch(f"/stubs/{stub['id']}", {"max_concurrent": 0})
    print_json({"ok": True, "stub": result.get("stub", {}).get("name"), "max_concurrent": 0})


def cmd_stubs_undrain(args: argparse.Namespace, client: ApiClient) -> None:
    stub = find_stub(client, args.stub)
    result = client.patch(f"/stubs/{stub['id']}", {"max_concurrent": args.n})
    print_json({"ok": True, "stub": result.get("stub", {}).get("name"), "max_concurrent": args.n})


def cmd_stubs_exec(args: argparse.Namespace, client: ApiClient) -> int:
    stub = find_stub(client, args.stub)
    command = args.command[0].strip() if len(args.command) == 1 else shlex.join(args.command).strip()
    if not command:
        raise AlchError("command required")

    timeout_ms = int(float(args.command_timeout) * 1000)
    if timeout_ms <= 0:
        raise AlchError("timeout must be greater than 0")

    result = client.post(
        f"/stubs/{stub['id']}/exec2",
        {"command": command, "timeout": timeout_ms},
    )

    stdout = result.get("stdout", "")
    stderr = result.get("stderr", "")
    if stdout:
        sys.stdout.write(str(stdout))
    if stderr:
        sys.stderr.write(str(stderr))

    try:
        exit_code = int(result.get("exit_code", 0))
    except (TypeError, ValueError):
        exit_code = 0
    if exit_code < 0:
        return 1
    if exit_code > 255:
        return 255
    return exit_code


def deploy_connection_body(args: argparse.Namespace, client: ApiClient) -> dict[str, Any]:
    config = load_config()
    server_url = (
        getattr(args, "stub_server_url", None)
        or os.environ.get("ALCHEMY_STUB_SERVER_URL")
        or config.get("stub_server_url")
        or client.server
    )
    return {"server_url": str(server_url).rstrip("/"), "token": client.token}


def summarize_deploy_result(result: dict[str, Any], *, target: str, body: dict[str, Any]) -> dict[str, Any]:
    server_url = str(body.get("server_url") or "").rstrip("/")
    out = {
        **result,
        "target": result.get("target") or target,
        "stub_server_url": server_url,
        "default_output_dir": body.get("default_output_dir"),
        "wait_command": f"alch stubs wait --tag {target.replace('slurm-', '')} --tag slurm --timeout 300 --interval 5",
        "verify_commands": [
            "alch stubs ls --online",
            "alch tasks ls --status running --limit 10",
        ],
    }
    if server_url.startswith("http://localhost") or server_url.startswith("http://127.0.0.1"):
        out["warning"] = "stub_server_url is localhost; remote SLURM nodes usually cannot connect. Set `alch config set --stub-server-url <public-url>` or pass --stub-server-url."
    return out


def cmd_stubs_restart(args: argparse.Namespace, client: ApiClient) -> None:
    if not args.yes:
        raise AlchError("stubs restart submits/restarts a real worker; pass --yes")
    body: dict[str, Any] = deploy_connection_body(args, client)
    if args.mem:
        body["mem"] = args.mem
    if args.time:
        body["time"] = args.time
    if args.idle_timeout is not None:
        body["idle_timeout"] = args.idle_timeout
    if getattr(args, "default_output_dir", None):
        body["default_output_dir"] = args.default_output_dir
    print_json(summarize_deploy_result(client.post(f"/deploy/stubs/{args.name}/restart", body), target=args.name, body=body))


def cmd_stubs_canary(args: argparse.Namespace, client: ApiClient) -> None:
    if not args.yes:
        raise AlchError("stubs canary submits a real worker; pass --yes")
    target = args.kind if args.kind.startswith("slurm-") else f"slurm-{args.kind}"
    body: dict[str, Any] = deploy_connection_body(args, client)
    if args.mem:
        body["mem"] = args.mem
    if args.time:
        body["time"] = args.time
    if args.idle_timeout is not None:
        body["idle_timeout"] = args.idle_timeout
    if getattr(args, "default_output_dir", None):
        body["default_output_dir"] = args.default_output_dir
    print_json(summarize_deploy_result(client.post(f"/deploy/stubs/{target}", body), target=target, body=body))


def cmd_slurm_submit(args: argparse.Namespace, client: ApiClient) -> None:
    if args.count != 1 and not args.yes:
        raise AlchError("submitting multiple SLURM stubs requires --yes")
    target = args.kind if args.kind.startswith("slurm-") else f"slurm-{args.kind}"
    results = []
    for _ in range(args.count):
        body: dict[str, Any] = deploy_connection_body(args, client)
        if args.mem:
            body["mem"] = args.mem
        if args.time:
            body["time"] = args.time
        if args.idle_timeout is not None:
            body["idle_timeout"] = args.idle_timeout
        if getattr(args, "default_output_dir", None):
            body["default_output_dir"] = args.default_output_dir
        results.append(summarize_deploy_result(client.post(f"/deploy/stubs/{target}/restart", body), target=target, body=body))
    print_json(results[0] if args.count == 1 else results)


def cmd_webhooks_ls(args: argparse.Namespace, client: ApiClient) -> None:
    print_json(client.get("/webhooks"))


def parse_webhook_events(raw: str) -> list[str]:
    return [event.strip() for event in raw.split(",") if event.strip()]


def cmd_webhooks_add(args: argparse.Namespace, client: ApiClient) -> None:
    body: dict[str, Any] = {
        "name": args.name,
        "url": args.url,
        "events": parse_webhook_events(args.events),
        "enabled": not args.disabled,
    }
    if args.secret:
        body["secret"] = args.secret
    print_json(client.post("/webhooks", body))


def cmd_webhooks_delete(args: argparse.Namespace, client: ApiClient) -> None:
    print_json(client.delete(f"/webhooks/{args.subscription}"))


def cmd_webhooks_test(args: argparse.Namespace, client: ApiClient) -> None:
    body: dict[str, Any] = {}
    if args.event:
        body["event"] = args.event
    if args.payload:
        body.update(json.loads(args.payload))
    print_json(client.post(f"/webhooks/{args.subscription}/test", body))


def cmd_webhooks_deliveries(args: argparse.Namespace, client: ApiClient) -> None:
    print_json(client.get(f"/webhooks/{args.subscription}/deliveries?{urlencode({'limit': args.limit})}"))


def cmd_doctor(_args: argparse.Namespace, client: ApiClient) -> None:
    health = client.raw_get("/health")
    stubs = client.get("/stubs")
    task_triage = build_task_top_payload(client, active_limit=50, failed_limit=5)
    webhooks = client.get("/webhooks")
    counts = {
        "online_stubs": sum(1 for stub in stubs if stub.get("status") == "online"),
        "active_tasks": task_triage["counts"]["active"],
        "running_tasks": task_triage["counts"]["running"],
        "blocked_tasks": task_triage["counts"]["blocked"],
        "webhooks": len(webhooks),
        "enabled_webhooks": sum(1 for webhook in webhooks if webhook.get("enabled", True)),
    }
    checks = [
        {"name": "server", "ok": bool(isinstance(health, dict) and health.get("ok", True))},
        {"name": "stubs", "ok": counts["online_stubs"] > 0},
        {"name": "tasks", "ok": True},
        {"name": "webhooks", "ok": True},
    ]
    print_json({
        "ok": all(check["ok"] for check in checks),
        "server": client.server,
        "health": health,
        "counts": counts,
        "task_triage": task_triage,
        "checks": checks,
    })


def cmd_tasks_ls(args: argparse.Namespace, client: ApiClient) -> None:
    params: dict[str, Any] = {"limit": args.limit, "logs": "false", "sort": "seq", "order": "desc"}
    if args.status:
        params["status"] = args.status
    if args.active:
        params["status_group"] = "active"
    data = client.get(f"/tasks?{urlencode(params)}")
    tasks = data.get("tasks", [])
    if args.stub:
        stub = find_stub(client, args.stub)
        tasks = [t for t in tasks if t.get("stub_id") == stub["id"] or t.get("target_stub_id") == stub["id"]]
    print_json([short_task(t) for t in tasks])


def cmd_tasks_inbox(args: argparse.Namespace, client: ApiClient) -> None:
    params: dict[str, Any] = {"actor": args.actor, "limit": args.limit}
    if args.bucket:
        params["bucket"] = args.bucket
    payload = client.get(f"/tasks/inbox?{urlencode(params)}")
    if args.json:
        print_json(payload)
        return
    if isinstance(payload, dict):
        _summarize_inbox_payload(payload)
        return
    print_json(payload)


def _task_mark_body(actor: str, *, pinned: bool | None = None, watched: bool | None = None, note: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"actor": actor}
    if pinned is not None:
        body["pinned"] = pinned
    if watched is not None:
        body["watched"] = watched
    if note is not None:
        body["note"] = note
    return body


def cmd_tasks_mark_read(args: argparse.Namespace, client: ApiClient) -> None:
    print_json(client.post(f"/tasks/{args.task}/read", {"actor": args.actor}))


def cmd_tasks_mark_ack(args: argparse.Namespace, client: ApiClient) -> None:
    print_json(client.post(f"/tasks/{args.task}/ack", {"actor": args.actor}))


def cmd_tasks_pin(args: argparse.Namespace, client: ApiClient) -> None:
    print_json(client.post(f"/tasks/{args.task}/pin", _task_mark_body(args.actor, pinned=True, note=args.note)))


def cmd_tasks_unpin(args: argparse.Namespace, client: ApiClient) -> None:
    print_json(client.post(f"/tasks/{args.task}/pin", _task_mark_body(args.actor, pinned=False)))


def cmd_tasks_watch(args: argparse.Namespace, client: ApiClient) -> None:
    print_json(client.post(f"/tasks/{args.task}/watch", _task_mark_body(args.actor, watched=True, note=args.note)))


def cmd_tasks_unwatch(args: argparse.Namespace, client: ApiClient) -> None:
    print_json(client.post(f"/tasks/{args.task}/watch", _task_mark_body(args.actor, watched=False)))


def task_reason(task: dict[str, Any]) -> str | None:
    for key in ("error_message", "death_cause", "reason"):
        value = task.get(key)
        if value:
            return str(value)
    exit_code = task.get("exit_code")
    if exit_code is not None:
        return f"exit_code={exit_code}"
    return None


def task_failure(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "exit_code": task.get("exit_code"),
        "death_cause": task.get("death_cause"),
        "error_message": task.get("error_message"),
    }


def task_target(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "target_stub_id": task.get("target_stub_id"),
        "target_tags": task.get("target_tags"),
    }


def task_commands(task: dict[str, Any]) -> list[str]:
    task_id = task.get("id")
    if not task_id:
        return []
    commands = [f"alch tasks get {task_id}", f"alch tasks logs {task_id} --tail 200"]
    run_dir = task.get("run_dir")
    if run_dir:
        commands.append(f"ls -la {run_dir}")
    return commands


def task_diagnosis(task: dict[str, Any]) -> dict[str, str] | None:
    status = str(task.get("status") or "")
    error = str(task.get("error_message") or "")
    death_cause = task.get("death_cause")
    exit_code = task.get("exit_code")
    if status == "blocked" and error.lower().startswith("dependency "):
        return {
            "kind": "dependency_failed",
            "detail": error,
            "next": "inspect the failed dependency, then resubmit or cancel this blocked task",
        }
    if status == "blocked":
        return {
            "kind": "blocked",
            "detail": task_reason(task) or "task is blocked",
            "next": "inspect task details and unblock the dependency or cancel/resubmit",
        }
    if status == "pending" and task.get("target_stub_id"):
        return {
            "kind": "waiting_for_target_stub",
            "detail": f"target_stub_id={task.get('target_stub_id')}",
            "next": "bring that stub online or move the task to a live stub",
        }
    if status == "pending" and task.get("target_tags"):
        return {
            "kind": "waiting_for_matching_stub",
            "detail": f"target_tags={','.join(str(tag) for tag in task.get('target_tags') or [])}",
            "next": "start a matching stub or move the task to a live stub",
        }
    if status == "pending":
        return {
            "kind": "queued",
            "detail": "task is pending without an explicit target",
            "next": "check online stubs and queue capacity",
        }
    if status == "failed" and (death_cause == "oom" or exit_code == 137):
        return {
            "kind": "oom",
            "detail": f"exit_code={exit_code} death_cause={death_cause}",
            "next": "reduce memory use or resubmit on a larger-memory stub",
        }
    if status == "failed" and (death_cause == "killed" or exit_code in {-15, 143}):
        return {
            "kind": "terminated",
            "detail": f"exit_code={exit_code} death_cause={death_cause}",
            "next": "check SLURM walltime/preemption, then resume if the run supports it",
        }
    if status == "failed":
        return {
            "kind": str(death_cause or "failed"),
            "detail": task_reason(task) or "task failed",
            "next": "inspect logs, fix the root cause, then resubmit if appropriate",
        }
    return None


def recommendation_commands(task: dict[str, Any]) -> list[str]:
    task_id = task.get("id")
    if not task_id:
        return []
    return [f"alch tasks get {task_id}", f"alch tasks logs {task_id} --tail 200"]


def build_task_repair_recommendation(task: dict[str, Any]) -> dict[str, Any] | None:
    task_id = task.get("id")
    if not task_id:
        return None

    status = str(task.get("status") or "")
    diagnosis = task_diagnosis(task)

    if status == "blocked" and diagnosis and diagnosis.get("kind") == "dependency_failed":
        commands = recommendation_commands(task)
        return {
            "task_id": task_id,
            "status": status,
            "action": "inspect_dependency",
            "detail": diagnosis["detail"],
            "commands": commands + [
                f"alch tasks cancel {task_id}",
                f"alch tasks resubmit {task_id}",
            ],
        }

    if status == "pending" and task.get("target_stub_id"):
        target_stub = str(task.get("target_stub_id"))
        commands = recommendation_commands(task)
        return {
            "task_id": task_id,
            "status": status,
            "action": "move_to_live_stub_or_start_stub",
            "detail": {"target_stub_id": target_stub},
            "commands": commands + [f"alch tasks move {task_id} --to-stub {target_stub}"],
        }

    if status == "pending" and task.get("target_tags"):
        tags = [str(tag) for tag in task.get("target_tags") or []]
        if tags:
            commands = recommendation_commands(task)
            return {
                "task_id": task_id,
                "status": status,
                "action": "start_matching_stub_or_move",
                "detail": {"target_tags": tags},
                "commands": commands + [f"alch tasks move {task_id} --to-tags {','.join(tags)}"],
            }

    return None


def top_task(task: dict[str, Any]) -> dict[str, Any]:
    row = short_task(task)
    row["target"] = task_target(task)
    reason = task_reason(task)
    if reason:
        row["reason"] = reason
    diagnosis = task_diagnosis(task)
    if diagnosis:
        row["diagnosis"] = diagnosis
    commands = task_commands(task)
    if commands:
        row["commands"] = commands
    if task.get("status") in TERMINAL_STATUSES or task.get("exit_code") is not None or task.get("death_cause") or task.get("error_message"):
        row["failure"] = task_failure(task)
    return row


def build_task_top_payload(
    client: ApiClient,
    *,
    active_limit: int,
    failed_limit: int,
) -> dict[str, Any]:
    active_params = {
        "limit": active_limit,
        "logs": "false",
        "sort": "seq",
        "order": "desc",
        "status_group": "active",
    }
    failed_params = {
        "limit": failed_limit,
        "logs": "false",
        "sort": "seq",
        "order": "desc",
        "status": "failed",
    }
    active_payload = client.get(f"/tasks?{urlencode(active_params)}")
    failed_payload = client.get(f"/tasks?{urlencode(failed_params)}")
    active_tasks = active_payload.get("tasks", []) if isinstance(active_payload, dict) else []
    failed_tasks = failed_payload.get("tasks", []) if isinstance(failed_payload, dict) else []

    by_status = {status: [task for task in active_tasks if task.get("status") == status] for status in ACTIVE_STATUSES}
    return {
        "counts": {
            "active": len(active_tasks),
            "running": len(by_status["running"]),
            "blocked": len(by_status["blocked"]),
            "pending": len(by_status["pending"]),
            "assigned": len(by_status["assigned"]),
            "paused": len(by_status["paused"]),
            "failed_recent": len(failed_tasks),
        },
        "running": [top_task(task) for task in by_status["running"]],
        "blocked": [top_task(task) for task in by_status["blocked"]],
        "pending": [top_task(task) for task in by_status["pending"]],
        "assigned": [top_task(task) for task in by_status["assigned"]],
        "paused": [top_task(task) for task in by_status["paused"]],
        "failed_recent": [top_task(task) for task in failed_tasks],
    }


def build_task_repair_payload(client: ApiClient, *, active_limit: int) -> dict[str, Any]:
    active_params = {
        "limit": active_limit,
        "logs": "false",
        "sort": "seq",
        "order": "desc",
        "status_group": "active",
    }
    active_payload = client.get(f"/tasks?{urlencode(active_params)}")
    active_tasks = active_payload.get("tasks", []) if isinstance(active_payload, dict) else []
    return {
        "ok": True,
        "dry_run": True,
        "recommendations": [
            recommendation
            for task in active_tasks
            if (recommendation := build_task_repair_recommendation(task)) is not None
        ],
    }


def cmd_tasks_top(args: argparse.Namespace, client: ApiClient) -> None:
    print_json(build_task_top_payload(client, active_limit=args.limit, failed_limit=args.failed_limit))


def cmd_tasks_repair(args: argparse.Namespace, client: ApiClient) -> None:
    print_json(build_task_repair_payload(client, active_limit=args.limit))


def cmd_tasks_get(args: argparse.Namespace, client: ApiClient) -> None:
    task = client.get(f"/tasks/{args.task}")
    print_json(short_task(task) if args.short else task)


def cmd_tasks_wait(args: argparse.Namespace, client: ApiClient) -> int:
    deadline = None if args.timeout is None else time.monotonic() + args.timeout
    last_task: dict[str, Any] | None = None
    while True:
        task = client.get(f"/tasks/{args.task}")
        last_task = task if isinstance(task, dict) else {"id": args.task, "status": "unknown"}
        status = str(last_task.get("status") or "")
        if status in TERMINAL_STATUSES:
            print_json(short_task(last_task) if args.short else last_task)
            return 0 if status == "completed" else 1
        if deadline is not None and time.monotonic() >= deadline:
            print(f"alch: timed out waiting for task {args.task}", file=sys.stderr)
            if args.print_last and last_task is not None:
                print_json(short_task(last_task) if args.short else last_task)
            return 124
        if args.status:
            print(f"{last_task.get('id', args.task)} {status}", file=sys.stderr)
        time.sleep(max(args.interval, 0.0))


def cmd_tasks_cancel(args: argparse.Namespace, client: ApiClient) -> None:
    task = client.get(f"/tasks/{args.task}")
    if task.get("status") in DANGEROUS_STATUSES and not args.yes:
        raise AlchError(f"task is {task.get('status')}; cancelling will trigger kill chain. pass --yes")
    result = client.patch(f"/tasks/{args.task}", {"status": "cancelled"})
    print_json(short_task(result))


def cmd_tasks_move(args: argparse.Namespace, client: ApiClient) -> None:
    if bool(args.to_stub) == bool(args.to_tags):
        raise AlchError("pass exactly one of --to-stub or --to-tags")
    if args.to_tags:
        tags = [t.strip() for t in args.to_tags.split(",") if t.strip()]
        print_json(short_task(client.post(f"/tasks/{args.task}/reschedule", {"target_tags": tags})))
        return
    task = client.get(f"/tasks/{args.task}")
    if task.get("status") in DANGEROUS_STATUSES and not args.yes:
        raise AlchError(f"task is {task.get('status')}; moving by stub cancels/resubmits. pass --yes")
    stub = find_stub(client, args.to_stub)
    if task.get("status") in ACTIVE_STATUSES:
        client.patch(f"/tasks/{args.task}", {"status": "cancelled"})
    body = clone_task_body(task)
    body["target_stub_id"] = stub["id"]
    body.pop("target_tags", None)
    body["name"] = args.name or f"{task.get('display_name') or task.get('name')}_moved"
    body["idempotency_key"] = f"move:{args.task}:{stub['id']}:{uuid.uuid4()}"
    print_json(short_task(client.post("/tasks", body)))


def clone_task_body(task: dict[str, Any]) -> dict[str, Any]:
    body = {k: task[k] for k in TASK_FIELDS if k in task and task[k] is not None}
    body.pop("depends_on", None)
    body.pop("run_dir", None)
    return body


def add_resume(raw_args: Any) -> str:
    raw = str(raw_args or "").strip()
    if "--resume" in raw.split():
        return raw
    return f"{raw} --resume".strip()


def cmd_tasks_resubmit(args: argparse.Namespace, client: ApiClient) -> None:
    task = client.get(f"/tasks/{args.task}")
    body = clone_task_body(task)
    if args.resume:
        body["raw_args"] = add_resume(body.get("raw_args"))
    if args.to_stub:
        body["target_stub_id"] = find_stub(client, args.to_stub)["id"]
        body.pop("target_tags", None)
    if args.to_tags:
        body["target_tags"] = [t.strip() for t in args.to_tags.split(",") if t.strip()]
        body.pop("target_stub_id", None)
    body["name"] = args.name or f"{task.get('display_name') or task.get('name')}_resubmit"
    body["idempotency_key"] = f"resubmit:{args.task}:{uuid.uuid4()}"
    path = "/tasks"
    if args.wait:
        path += f"?{urlencode({'wait': 'true', 'wait_timeout': args.wait_timeout})}"
    print_json(short_task(client.post(path, body)))


def build_task_spec_patch(sets: list[str]) -> dict[str, Any]:
    if not sets:
        raise AlchError("pass at least one --set KEY=VALUE")
    body: dict[str, Any] = {}
    for raw in sets:
        key, value = parse_set_pair(raw)
        body[key] = value
    return body


def cmd_tasks_update(args: argparse.Namespace, client: ApiClient) -> None:
    body = build_task_spec_patch(args.set)
    print_json(short_task(client.patch(f"/tasks/{args.task}", body)))


def cmd_tasks_replace(args: argparse.Namespace, client: ApiClient) -> None:
    body = {"overrides": build_task_spec_patch(args.set), "cancel_old": bool(args.cancel_old)}
    print_json(client.post(f"/tasks/{args.task}/replace", body))


def cmd_tasks_logs(args: argparse.Namespace, client: ApiClient) -> None:
    task = client.get(f"/tasks/{args.task}")
    logs = task.get("log_buffer") or task.get("logs") or []
    if isinstance(logs, str):
        lines = logs.splitlines()
    else:
        lines = [str(line) for line in logs]
    for line in lines[-args.tail:]:
        print(line)


def cmd_tasks_metrics(args: argparse.Namespace, client: ApiClient) -> None:
    task = client.get(f"/tasks/{args.task}")
    print_json({
        "metrics": task.get("metrics") or {},
        "metrics_buffer": task.get("metrics_buffer") or [],
    })


def task_matches_kind(task: dict[str, Any], kind: str) -> bool:
    script = str(task.get("script") or "").lower()
    name = str(task.get("name") or task.get("display_name") or "").lower()
    raw_args = str(task.get("raw_args") or "").lower()
    if kind in {"all", "any"}:
        return True
    if kind == "nethack-pretrain":
        return (
            script.endswith("train_pretrain_nethack.py")
            or "nethack_pretrain" in name
            or name.startswith("pretrain_nh")
            or ("train_pretrain_nethack.py" in raw_args)
        )
    if kind == "jema-pretrain":
        return "pretrain" in f"{script} {name}" and "jema" in f"{script} {name}"
    return kind.lower() in f"{script} {name} {raw_args}"


def normalize_raw_args(raw: Any) -> str:
    try:
        parts = shlex.split(str(raw or ""))
    except ValueError:
        parts = str(raw or "").split()
    return " ".join(p for p in parts if p != "--resume")


def normalize_task_name(name: Any) -> str:
    text = str(name or "")
    return re.sub(r"_resume(?:_[a-z0-9-]+)?$", "", text)


def task_intent_key(task: dict[str, Any]) -> tuple[str, str, str | None]:
    raw = normalize_raw_args(task.get("raw_args"))
    if not raw and task.get("args") is not None:
        raw = normalize_raw_args(task.get("args"))
    if not raw:
        raw = normalize_task_name(task.get("name") or task.get("display_name") or "")
    return (
        str(task.get("script") or ""),
        raw,
        str(task.get("cwd")) if task.get("cwd") else None,
    )


def fetch_tasks(client: ApiClient, *, status_group: str, limit: int) -> list[dict[str, Any]]:
    params = {"limit": limit, "logs": "false", "sort": "seq", "order": "desc", "status_group": status_group}
    data = client.get(f"/tasks?{urlencode(params)}")
    return list(data.get("tasks") or [])


def is_resume_task(task: dict[str, Any]) -> bool:
    raw = str(task.get("raw_args") or "")
    name = str(task.get("name") or task.get("display_name") or "").lower()
    return "--resume" in raw.split() or "_resume" in name or name.endswith("resume")


def find_lost_tasks(client: ApiClient, kind: str, limit: int) -> list[dict[str, Any]]:
    terminal = fetch_tasks(client, status_group="terminal", limit=limit)
    active = fetch_tasks(client, status_group="active", limit=limit)
    successor_keys = {task_intent_key(t) for t in active if is_resume_task(t)}
    successor_keys |= {
        task_intent_key(t)
        for t in terminal
        if t.get("status") == "completed" and is_resume_task(t)
    }
    candidates = [
        t for t in terminal
        if t.get("status") != "completed"
        and task_matches_kind(t, kind)
        and task_intent_key(t) not in successor_keys
    ]
    # Keep one newest failed/cancelled task per stable intent.
    newest: dict[tuple[str, str, str | None], dict[str, Any]] = {}
    for task in candidates:
        key = task_intent_key(task)
        if key not in newest or (task.get("seq") or 0) > (newest[key].get("seq") or 0):
            newest[key] = task
    return sorted(newest.values(), key=lambda t: t.get("seq") or 0, reverse=True)


def cmd_tasks_lost(args: argparse.Namespace, client: ApiClient) -> None:
    print_json([short_task(t) | {"script": t.get("script"), "raw_args": t.get("raw_args")} for t in find_lost_tasks(client, args.kind, args.limit)])


def build_resume_body(task: dict[str, Any], *, stub_id: str | None, tags: list[str] | None) -> dict[str, Any]:
    body = clone_task_body(task)
    body["raw_args"] = add_resume(body.get("raw_args"))
    if stub_id:
        body["target_stub_id"] = stub_id
        body.pop("target_tags", None)
    if tags:
        body["target_tags"] = tags
        body.pop("target_stub_id", None)
    body["name"] = f"{task.get('display_name') or task.get('name') or task.get('id')}_resume"
    body["idempotency_key"] = f"resume-lost:{task.get('id')}:{uuid.uuid4()}"
    return body


def cmd_tasks_resume_lost(args: argparse.Namespace, client: ApiClient) -> None:
    if not args.dry_run and not args.yes:
        raise AlchError("resume-lost submits tasks; pass --dry-run or --yes")
    lost = find_lost_tasks(client, args.kind, args.limit)
    stub_id = find_stub(client, args.to_stub)["id"] if args.to_stub else None
    tags = [t.strip() for t in args.to_tags.split(",") if t.strip()] if args.to_tags else None
    if stub_id and tags:
        raise AlchError("pass at most one of --to-stub or --to-tags")
    plans = [{"source": short_task(task), "body": build_resume_body(task, stub_id=stub_id, tags=tags)} for task in lost]
    if args.dry_run:
        print_json(plans)
        return
    created = [short_task(client.post("/tasks", plan["body"])) for plan in plans]
    print_json(created)


def cmd_verify(args: argparse.Namespace, client: ApiClient) -> None:
    ok = True
    out: dict[str, Any] = {"ok": True}
    if args.task:
        task = client.get(f"/tasks/{args.task}")
        task_ok = task.get("status") == args.expect_status
        ok = ok and task_ok
        out["task"] = short_task(task) | {"ok": task_ok}
    if args.stub:
        stub = find_stub(client, args.stub)
        stub_ok = stub.get("status") == "online"
        ok = ok and stub_ok
        out["stub"] = {"id": stub.get("id"), "name": stub.get("name"), "status": stub.get("status"), "ok": stub_ok}
    out["ok"] = ok
    print_json(out)
    if not ok:
        raise SystemExit(2)


def render_experiment_scaffold(*, code_id: str, name: str, family: str | None = None) -> str:
    from alchemy_sdk.ledger import render_ledger_block

    family_arg = f", family={json.dumps(family)}" if family else ""
    ledger = render_ledger_block()
    return f'''from alchemy_sdk import Experiment


exp = Experiment(code_id={json.dumps(code_id)}, name={json.dumps(name)}{family_arg})

{ledger}

# Replace this starter task with real business logic.
exp.task("train", script="train.py")


if __name__ == "__main__":
    exp.submit()
'''


def cmd_experiments_scaffold(args: argparse.Namespace) -> int:
    if not args.code_id.strip():
        raise AlchError("--code-id must be non-empty")
    if not args.name.strip():
        raise AlchError("--name must be non-empty")
    output = Path(args.output)
    if output.exists() and not args.force:
        raise AlchError(f"output exists: {output} (pass --force to overwrite)")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render_experiment_scaffold(code_id=args.code_id.strip(), name=args.name.strip(), family=args.family), encoding="utf-8")
    print_json({"path": str(output), "code_id": args.code_id.strip(), "name": args.name.strip()})
    return 0


def cmd_experiments_inject_ledger(args: argparse.Namespace) -> int:
    from alchemy_sdk.experiments import normalize_decision
    from alchemy_sdk.ledger import append_comment, append_decision, ledger_hash, parse_ledger, replace_ledger

    path = Path(args.file)
    text = path.read_text(encoding="utf-8")
    ledger = parse_ledger(text)
    evidence = list(args.evidence or [])
    decision_mode = bool(args.decision_id or args.decision)
    comment_mode = bool(args.comment_id or args.comment)
    if decision_mode == comment_mode:
        raise AlchError("pass exactly one of --decision-id/--decision or --comment-id/--comment")
    if decision_mode and not (args.decision_id and args.decision):
        raise AlchError("decision ledger entries require --decision-id and --decision")
    if comment_mode and not (args.comment_id and args.comment):
        raise AlchError("comment ledger entries require --comment-id and --comment")
    if args.decision_id:
        updated = append_decision(
            ledger,
            decision_id=args.decision_id,
            decision=normalize_decision(args.decision),
            reason=args.reason,
            evidence=evidence,
        )
    else:
        updated = append_comment(
            ledger,
            comment_id=args.comment_id,
            comment=args.comment,
            evidence=evidence,
        )
    path.write_text(replace_ledger(text, updated), encoding="utf-8")
    print_json({"path": str(path), "ledger_hash": ledger_hash(updated), "decisions": len(updated["decisions"])})
    return 0


def cmd_experiments_sync_ledger(args: argparse.Namespace, client: ApiClient) -> None:
    from alchemy_sdk.ledger import ledger_hash, parse_ledger

    path = Path(args.file)
    ledger = parse_ledger(path.read_text(encoding="utf-8"))
    exp = find_experiment(client, args.experiment)
    timeline = client.get(f"/experiments/{exp['id']}/timeline")
    events = timeline.get("events", []) if isinstance(timeline, dict) else []
    existing = {
        (event.get("kind"), event.get("data", {}).get("source_id"))
        for event in events
        if event.get("data", {}).get("source") == "code-ledger"
    }
    created: list[dict[str, Any]] = []

    def content_hash(entry: dict[str, Any]) -> str:
        payload = json.dumps(entry, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    for decision in ledger.get("decisions", []):
        if not isinstance(decision, dict):
            continue
        source_id = decision.get("id")
        verdict = decision.get("decision")
        if not source_id or ("decision", source_id) in existing:
            continue
        reason = decision.get("reason")
        message = f"{verdict}: {reason}" if reason else str(verdict)
        data = {"source": "code-ledger", "source_id": source_id, "content_hash": content_hash(decision), "decision": verdict}
        if reason:
            data["reason"] = reason
        if decision.get("evidence"):
            data["evidence"] = decision.get("evidence")
        created.append(client.post(f"/experiments/{exp['id']}/events", {"kind": "decision", "message": message, "data": data}))
    for note in ledger.get("notes", []):
        if not isinstance(note, dict):
            continue
        source_id = note.get("id")
        comment = note.get("comment")
        if not source_id or not comment or ("note", source_id) in existing:
            continue
        data = {"source": "code-ledger", "source_id": source_id, "content_hash": content_hash(note)}
        if note.get("evidence"):
            data["evidence"] = note.get("evidence")
        created.append(client.post(f"/experiments/{exp['id']}/events", {"kind": "note", "message": str(comment), "data": data}))
    print_json({"experiment_id": exp["id"], "ledger_hash": ledger_hash(ledger), "created": len(created), "events": created})


def cmd_experiments_ls(args: argparse.Namespace, client: ApiClient) -> None:
    params: dict[str, Any] = {}
    if args.family:
        params["family"] = args.family
    if args.decision:
        params["decision"] = args.decision
    if args.status:
        params["status"] = args.status
    path = "/experiments"
    if params:
        path += f"?{urlencode(params)}"
    experiments = client.get(path)
    print_json([short_experiment(e) for e in experiments])


def cmd_experiments_show(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    print_json(client.get(f"/experiments/{exp['id']}"))


def cmd_experiments_inspect(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    detail = client.get(f"/experiments/{exp['id']}")
    sdk_spec = detail.get("sdk_spec") if isinstance(detail, dict) else None
    if sdk_spec:
        print_json({"experiment_id": exp["id"], "name": detail.get("name"), "sdk_spec": sdk_spec})
    else:
        print_json({"experiment_id": exp["id"], "name": detail.get("name"), "warning": "legacy experiment has no sdk_spec", "detail": detail})


def cmd_experiments_series(args: argparse.Namespace, client: ApiClient) -> None:
    print_json(client.get(f"/experiments/series/{args.family}/summary"))


def cmd_experiments_curves(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    task_refs = exp.get("task_refs") or {}
    task_specs = exp.get("task_specs") or []
    specs_by_ref = {spec.get("ref"): spec for spec in task_specs if isinstance(spec, dict) and spec.get("ref")}
    curves: dict[str, Any] = {}
    for task_ref, task_id in task_refs.items():
        spec = specs_by_ref.get(task_ref, {})
        payload = client.get(f"/tasks/{task_id}/metrics")
        metrics_buffer = payload.get("metrics_buffer") if isinstance(payload, dict) else None
        if isinstance(metrics_buffer, dict):
            selected = dict(metrics_buffer)
            if args.metric:
                selected = {args.metric: selected.get(args.metric, [])}
        else:
            selected = {"legacy": payload.get("points", []) if isinstance(payload, dict) else []}
        curves[task_ref] = {"task_id": task_id, "params": dict(spec.get("param_point") or {}), "metrics": selected}
    print_json({"experiment_id": exp["id"], "source": "ring_buffer", "curves": curves})


def cmd_experiments_timeline(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    print_json(client.get(f"/experiments/{exp['id']}/timeline"))


def cmd_experiments_note(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    body: dict[str, Any] = {"kind": "note", "message": args.message}
    if args.task:
        body["task_id"] = args.task
    data = parse_data_object(args.data)
    if data is not None:
        body["data"] = data
    print_json(client.post(f"/experiments/{exp['id']}/events", body))


def experiment_metadata_payload(args: argparse.Namespace) -> dict[str, Any]:
    body: dict[str, Any] = {}
    for attr in [
        "description", "family", "parent_id", "parent_name", "hypothesis",
        "expected_outcome", "fork_reason", "goal_metric", "goal_direction",
    ]:
        value = getattr(args, attr, None)
        if value is not None:
            body[attr] = value
    for attr, flag in [("config", "--config"), ("config_diff", "--config-diff"), ("criteria", "--criteria")]:
        parsed = parse_json_object(getattr(args, attr, None), flag)
        if parsed is not None:
            body[attr] = parsed
    return body


def cmd_experiments_adopt(args: argparse.Namespace, client: ApiClient) -> None:
    body = experiment_metadata_payload(args)
    body["name"] = args.name
    body["task_ids"] = list(args.task)
    if not args.yes:
        print_json({"dry_run": True, "write": False, "method": "POST", "path": "/experiments/adopt", "payload": body})
        return
    print_json(client.post("/experiments/adopt", body))


def cmd_experiments_adopt_task(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    body = {"task_ids": list(args.task), "mode": args.mode}
    path = f"/experiments/{exp['id']}/tasks/adopt"
    if not args.yes:
        print_json({"dry_run": True, "write": False, "method": "POST", "path": path, "payload": body})
        return
    print_json(client.post(path, body))


def cmd_experiments_patch(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    body = experiment_metadata_payload(args)
    if not body:
        raise AlchError("no metadata fields provided")
    path = f"/experiments/{exp['id']}"
    if not args.yes:
        print_json({"dry_run": True, "write": False, "method": "PATCH", "path": path, "payload": body})
        return
    print_json(client.patch(path, body))


ARTIFACT_TYPES = {"checkpoint", "tensorboard", "log", "file", "metrics"}


def build_artifact_body(kind: str, locator: str, *, artifact_type: str | None,
                       name: str | None, task: str | None, step: float | None,
                       raw_data: str | None, default_message: str) -> dict[str, Any]:
    if not locator or not locator.strip():
        raise AlchError(f"{kind} requires a non-empty path or URI")
    data: dict[str, Any] = {}
    extra = parse_data_object(raw_data)
    if extra is not None:
        data.update(extra)
    is_uri = "://" in locator
    data["uri" if is_uri else "path"] = locator
    if artifact_type:
        if artifact_type not in ARTIFACT_TYPES:
            raise AlchError(f"--type must be one of {sorted(ARTIFACT_TYPES)}")
        data["artifact_type"] = artifact_type
    elif kind == "checkpoint":
        data.setdefault("artifact_type", "checkpoint")
    if name:
        data["name"] = name
    if step is not None:
        data["step"] = step
    body: dict[str, Any] = {"kind": kind, "message": default_message, "data": data}
    if task:
        body["task_id"] = task
    return body


def cmd_experiments_artifact(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    label = args.name or args.location
    body = build_artifact_body(
        "artifact", args.location,
        artifact_type=args.type, name=args.name, task=args.task, step=args.step,
        raw_data=args.data, default_message=f"Artifact: {label}",
    )
    print_json(client.post(f"/experiments/{exp['id']}/events", body))


def cmd_experiments_checkpoint(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    label = args.name or args.location
    body = build_artifact_body(
        "checkpoint", args.location,
        artifact_type=None, name=args.name, task=args.task, step=args.step,
        raw_data=args.data, default_message=f"Checkpoint: {label}",
    )
    print_json(client.post(f"/experiments/{exp['id']}/events", body))


def parse_set_pair(raw: str) -> tuple[str, Any]:
    if "=" not in raw:
        raise AlchError(f"--set expects key=value (json-encoded value), got {raw!r}")
    key, _, value = raw.partition("=")
    key = key.strip()
    if not key:
        raise AlchError("--set key must be non-empty")
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        parsed = value  # fall back to literal string
    return key, parsed


def apply_overrides(config: Any, sets: list[str], unsets: list[str]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Returns (proposed_config, diff). Operates on top-level keys only.

    Nested keys are not supported here — the existing SDK fork helper deep-copies
    configs but exposes no dotted-path setter, so we keep the surface flat.
    """
    base: dict[str, Any] = dict(config) if isinstance(config, dict) else {}
    proposed: dict[str, Any] = dict(base)
    diff: dict[str, Any] = {}
    for raw in sets:
        key, value = parse_set_pair(raw)
        if "." in key:
            raise AlchError(f"--set does not support nested keys; got {key!r}")
        before = base.get(key, None) if key in base else "__unset__"
        proposed[key] = value
        diff[key] = {
            "before": None if before == "__unset__" else before,
            "after": value,
            "op": "set" if key in base else "add",
        }
    for key in unsets:
        key = key.strip()
        if not key:
            raise AlchError("--unset key must be non-empty")
        if "." in key:
            raise AlchError(f"--unset does not support nested keys; got {key!r}")
        if key in proposed:
            diff[key] = {"before": base.get(key), "after": None, "op": "unset"}
            proposed.pop(key, None)
    return proposed, diff


def build_fork_plan_manifest(
    *,
    exp: dict[str, Any],
    detail: dict[str, Any],
    sets: list[str],
    unsets: list[str],
    name: str | None,
    reason: str,
    suffix: str,
    kind: str,
) -> dict[str, Any]:
    base_config = detail.get("config") if isinstance(detail, dict) else None
    proposed, diff = apply_overrides(base_config or {}, sets, unsets)
    parent_name = detail.get("name") or exp.get("name")
    return {
        "kind": kind,
        "dry_run": True,
        "parent": {
            "id": detail.get("id") or exp.get("id"),
            "name": parent_name,
            "family": detail.get("family"),
        },
        "suggested_name": name or f"{parent_name}-{suffix}",
        "reason": reason,
        "parent_config": base_config or {},
        "proposed_config": proposed,
        "config_diff": diff,
    }


def cmd_experiments_fork_plan(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    detail = client.get(f"/experiments/{exp['id']}")
    manifest = build_fork_plan_manifest(
        exp=exp,
        detail=detail,
        sets=args.set or [],
        unsets=args.unset or [],
        name=args.name,
        reason=args.reason,
        suffix="fork",
        kind="fork-plan",
    )
    print_json(manifest)


def cmd_experiments_replication_plan(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    detail = client.get(f"/experiments/{exp['id']}")
    manifest = build_fork_plan_manifest(
        exp=exp,
        detail=detail,
        sets=args.set or [],
        unsets=args.unset or [],
        name=args.name,
        reason=args.reason,
        suffix="replication",
        kind="replication-plan",
    )
    print_json(manifest)


def cmd_experiments_tree(args: argparse.Namespace, client: ApiClient) -> None:
    print_json(client.get("/experiments/tree"))


def cmd_experiments_compare(args: argparse.Namespace, client: ApiClient) -> None:
    refs: list[str] = list(args.experiments)
    seen: set[str] = set()
    duplicates: list[str] = []
    for ref in refs:
        if ref in seen:
            duplicates.append(ref)
        else:
            seen.add(ref)
    if duplicates:
        raise AlchError(
            f"duplicate compare refs (pass each experiment once): {sorted(set(duplicates))}"
        )
    if len(refs) > COMPARE_MAX_REFS:
        raise AlchError(
            f"compare accepts at most {COMPARE_MAX_REFS} experiments; got {len(refs)}"
        )
    experiments = client.get("/experiments")
    resolved = [resolve_experiment(experiments, ref) for ref in refs]
    # Resolved IDs may still collide if two distinct refs (e.g. a name and its
    # UUID) point at the same record. Detect that explicitly — the server would
    # otherwise return a degenerate one-row compare table.
    resolved_ids = [e["id"] for e in resolved]
    if len(set(resolved_ids)) != len(resolved_ids):
        raise AlchError(
            f"compare refs resolve to the same experiment: {refs} → {resolved_ids}"
        )
    print_json(client.get(f"/experiments/compare?{urlencode({'ids': ','.join(resolved_ids)})}"))


def cmd_experiments_summary(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    print_json(client.get(f"/experiments/{exp['id']}/summary"))


def cmd_experiments_recommend(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    path = f"/experiments/{exp['id']}/recommendation"
    try:
        recommendation = client.get(path)
    except AlchError as exc:
        cause = exc.__cause__
        if not isinstance(cause, HTTPError) or cause.code != 404:
            raise
        summary = client.get(f"/experiments/{exp['id']}/summary")
        if not isinstance(summary, dict) or "recommendation" not in summary:
            raise AlchError("experiment summary is missing recommendation")
        recommendation = summary["recommendation"]
    if getattr(args, "markdown", False):
        rendered = json.dumps(recommendation, ensure_ascii=False, indent=2)
        print(f"```json\n{rendered}\n```")
    else:
        print_json(recommendation)


def cmd_experiments_diff(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    print_json(client.get(f"/experiments/{exp['id']}/diff"))


def cmd_experiments_manifest(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    print_json(client.get(f"/experiments/{exp['id']}/manifest"))


def cmd_experiments_bundle(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    payload = client.get(f"/experiments/{exp['id']}/research-bundle")
    fmt = getattr(args, "format", "json") or "json"
    if fmt == "markdown":
        # Import locally to keep the CLI's top-level import surface unchanged.
        from alchemy_sdk.experiments import render_research_bundle_markdown

        if not isinstance(payload, dict):
            raise AlchError(
                "unexpected research-bundle response: expected a JSON object, "
                f"got {type(payload).__name__}"
            )
        rendered = render_research_bundle_markdown(payload)
    else:
        rendered = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)

    output = getattr(args, "output", None)
    if output:
        with open(output, "w", encoding="utf-8") as fh:
            fh.write(rendered)
            if not rendered.endswith("\n"):
                fh.write("\n")
        print(f"wrote {fmt} bundle to {output}", file=sys.stderr)
    else:
        print(rendered)


def cmd_experiments_report(args: argparse.Namespace, client: ApiClient) -> None:
    params: dict[str, Any] = {}
    if args.family:
        params["family"] = args.family
    if args.decision:
        params["decision"] = args.decision
    if args.status:
        params["status"] = args.status
    if args.limit is not None:
        if args.limit <= 0:
            raise AlchError("--limit must be a positive integer")
        params["limit"] = str(args.limit)
    path = "/experiments/research-report"
    if params:
        path += f"?{urlencode(params)}"
    payload = client.get(path)

    fmt = getattr(args, "format", "json") or "json"
    if fmt == "markdown":
        # Import locally to keep the CLI's top-level import surface unchanged.
        from alchemy_sdk.experiments import render_research_report_markdown

        if not isinstance(payload, dict):
            raise AlchError(
                "unexpected research-report response: expected a JSON object, "
                f"got {type(payload).__name__}"
            )
        rendered = render_research_report_markdown(payload)
    else:
        rendered = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)

    output = getattr(args, "output", None)
    if output:
        with open(output, "w", encoding="utf-8") as fh:
            fh.write(rendered)
            if not rendered.endswith("\n"):
                fh.write("\n")
        print(f"wrote {fmt} report to {output}", file=sys.stderr)
    else:
        print(rendered)


def cmd_experiments_decide(args: argparse.Namespace, client: ApiClient) -> None:
    from alchemy_sdk.experiments import normalize_decision

    reason = args.reason_flag or args.reason
    if not reason:
        raise AlchError("decision reason required: pass --reason <text>")
    exp = find_experiment(client, args.experiment)
    body = {"decision": normalize_decision(args.decision), "reason": reason}
    print_json(client.patch(f"/experiments/{exp['id']}/decision", body))


def cmd_experiments_series_decision(args: argparse.Namespace, client: ApiClient) -> None:
    from alchemy_sdk.experiments import normalize_decision

    reason = args.reason_flag or args.reason
    if not reason:
        raise AlchError("series decision reason required: pass --reason <text>")
    body = {"kind": "decision", "decision": normalize_decision(args.decision), "reason": reason}
    print_json(client.post(f"/experiments/series/{args.family}/events", body))


def cmd_experiments_series_comment(args: argparse.Namespace, client: ApiClient) -> None:
    body = {"kind": "note", "message": args.message}
    print_json(client.post(f"/experiments/series/{args.family}/events", body))


def add_global(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--server", help=f"Alchemy server URL (default {DEFAULT_SERVER})")
    parser.add_argument("--token", help=argparse.SUPPRESS)
    parser.add_argument("--local", action="store_true", help="read token from local SQLite state db")
    parser.add_argument("--state-db", help="SQLite state db path for --local")
    parser.add_argument("--timeout", type=float, default=20.0)


EXPERIMENTS_DESCRIPTION = (
    "Inspect and annotate experiments. Read commands (ls/show/timeline/tree/"
    "summary/diff/manifest/compare/fork-plan/bundle) issue only GET requests "
    "and never reschedule tasks. The mutating commands (note/artifact/"
    "checkpoint/decide) append metadata or set the decision via the server "
    "API; they also never reschedule tasks. Actor is derived server-side "
    "from the auth token — the CLI does not send actor."
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="alch",
        description="Alchemy v2 operator CLI for stubs, tasks, and experiments.",
    )
    add_global(parser)
    sub = parser.add_subparsers(dest="group", required=True)

    config = sub.add_parser("config", help="persist default server/state-db for this operator")
    config_sub = config.add_subparsers(dest="cmd", required=True)
    p = config_sub.add_parser("set", help="save default server/stub-server/state-db; token is not stored")
    p.add_argument("--server", help=f"default Alchemy server URL (default {DEFAULT_SERVER})")
    p.add_argument("--stub-server-url", help="default public URL remote stubs should connect to")
    p.add_argument("--state-db", help="SQLite state db to read the operator token from automatically")
    p.add_argument("--timeout", type=float, default=None, help="default request timeout")
    p.set_defaults(func=cmd_config_set, no_client=True)
    p = config_sub.add_parser("show", help="show persisted CLI config (never prints tokens)")
    p.set_defaults(func=cmd_config_show, no_client=True)

    p = sub.add_parser("doctor", help="read-only health summary for server, stubs, tasks, and webhooks")
    p.set_defaults(func=cmd_doctor)

    stubs = sub.add_parser("stubs", help="list, drain, or restart stubs")
    stubs_sub = stubs.add_subparsers(dest="cmd", required=True)
    p = stubs_sub.add_parser("ls", help="list known stubs"); p.add_argument("--online", action="store_true", help="only include online stubs"); p.set_defaults(func=cmd_stubs_ls)
    p = stubs_sub.add_parser("wait", help="wait until an online stub matches optional ref/tags"); p.add_argument("stub", nargs="?", help="optional stub id, name, or hostname"); p.add_argument("--tag", action="append", default=[], help="required tag; repeat for multiple tags"); p.add_argument("--timeout", type=float, default=300.0, help="seconds to wait before returning 1 (default 300)"); p.add_argument("--interval", type=float, default=5.0, help="poll interval in seconds (default 5)"); p.set_defaults(func=cmd_stubs_wait)
    p = stubs_sub.add_parser("drain", help="set a stub's max_concurrent to 0"); p.add_argument("stub", help="stub id, name, or hostname"); p.set_defaults(func=cmd_stubs_drain)
    p = stubs_sub.add_parser("undrain", help="restore a stub's max_concurrent"); p.add_argument("stub", help="stub id, name, or hostname"); p.add_argument("--n", type=int, default=1, help="new max_concurrent (default 1)"); p.set_defaults(func=cmd_stubs_undrain)
    p = stubs_sub.add_parser("restart", help="redeploy/restart a managed stub"); p.add_argument("name", help="deploy stub name (matches deploy-config.yaml)"); p.add_argument("--mem", help="optional SLURM mem override"); p.add_argument("--time", help="optional SLURM walltime override"); p.add_argument("--idle-timeout", type=int, default=None, help="stub idle timeout in seconds (SLURM default 600; 0 disables)"); p.add_argument("--default-output-dir", help="base directory for server-computed task run_dir paths"); p.add_argument("--stub-server-url", help="server URL that the remote stub should connect to (defaults to REST server)"); p.add_argument("--yes", action="store_true", help="confirm: this restarts a real worker"); p.set_defaults(func=cmd_stubs_restart)
    p = stubs_sub.add_parser("exec", help="run a shell command on a stub"); p.add_argument("stub", help="stub id, name, or hostname"); p.add_argument("command", nargs="+", help="command to run (e.g. alch stubs exec worker -- ls -la)"); p.add_argument("--timeout", dest="command_timeout", type=float, default=30.0, help="command timeout in seconds (float supported; passed to server as milliseconds)"); p.set_defaults(func=cmd_stubs_exec)
    p = stubs_sub.add_parser("canary", help="deploy one managed SLURM stub canary with code sync"); p.add_argument("kind", choices=["a30", "a40", "t4", "slurm-a30", "slurm-a40", "slurm-t4"], help="GPU kind shorthand or full slurm-* name"); p.add_argument("--mem", help="optional SLURM mem override"); p.add_argument("--time", help="optional SLURM walltime override"); p.add_argument("--idle-timeout", type=int, default=None, help="stub idle timeout in seconds (SLURM default 600; 0 disables)"); p.add_argument("--default-output-dir", help="base directory for server-computed task run_dir paths"); p.add_argument("--stub-server-url", help="server URL that the remote stub should connect to (e.g. public tunnel)"); p.add_argument("--yes", action="store_true", help="confirm: this submits a real worker"); p.set_defaults(func=cmd_stubs_canary)

    webhooks = sub.add_parser("webhooks", help="manage outbound webhook subscriptions")
    wh_sub = webhooks.add_subparsers(dest="cmd", required=True)
    p = wh_sub.add_parser("ls", help="list webhook subscriptions"); p.set_defaults(func=cmd_webhooks_ls)
    p = wh_sub.add_parser("add", help="create a webhook subscription"); p.add_argument("name", help="subscription name"); p.add_argument("url", help="destination http(s) URL"); p.add_argument("--events", default="task.failed,task.completed", help="comma-separated events (default task.failed,task.completed)"); p.add_argument("--secret", help="HMAC secret for outgoing signatures"); p.add_argument("--disabled", action="store_true", help="create disabled"); p.set_defaults(func=cmd_webhooks_add)
    p = wh_sub.add_parser("delete", aliases=["rm"], help="delete a webhook subscription"); p.add_argument("subscription", help="subscription id or name"); p.set_defaults(func=cmd_webhooks_delete)
    p = wh_sub.add_parser("test", help="send a test delivery"); p.add_argument("subscription", help="subscription id or name"); p.add_argument("--event", choices=["task.completed", "task.failed", "task.cancelled", "task.terminal"], help="event to send"); p.add_argument("--payload", help="JSON object merged into the test body"); p.set_defaults(func=cmd_webhooks_test)
    p = wh_sub.add_parser("deliveries", help="list recent webhook delivery attempts"); p.add_argument("subscription", help="subscription id or name"); p.add_argument("--limit", type=int, default=20, help="max deliveries to return (default 20)"); p.set_defaults(func=cmd_webhooks_deliveries)

    slurm = sub.add_parser("slurm", help="SLURM-specific stub submission")
    slurm_sub = slurm.add_subparsers(dest="cmd", required=True)
    p = slurm_sub.add_parser("submit", help="submit/restart a SLURM stub"); p.add_argument("kind", choices=["a30", "a40", "t4", "slurm-a30", "slurm-a40", "slurm-t4"], help="GPU kind shorthand (a30/a40/t4) or full slurm-* name"); p.add_argument("--count", type=int, default=1, help="number of stubs to submit (default 1)"); p.add_argument("--mem", help="optional SLURM mem override"); p.add_argument("--time", help="optional SLURM walltime override"); p.add_argument("--idle-timeout", type=int, default=None, help="stub idle timeout in seconds (SLURM default 600; 0 disables)"); p.add_argument("--default-output-dir", help="base directory for server-computed task run_dir paths"); p.add_argument("--stub-server-url", help="server URL that the remote stub should connect to (e.g. public tunnel)"); p.add_argument("--yes", action="store_true", help="required when --count > 1"); p.set_defaults(func=cmd_slurm_submit)

    tasks = sub.add_parser("tasks", help="list, inspect, cancel, move, or resubmit tasks")
    tasks_sub = tasks.add_subparsers(dest="cmd", required=True)
    p = tasks_sub.add_parser("ls", help="list recent tasks (short form)"); p.add_argument("--status", help="filter by status (pending/running/...)"); p.add_argument("--active", action="store_true", help="filter to active statuses (pending/assigned/running/paused/blocked)"); p.add_argument("--stub", help="only tasks bound to this stub"); p.add_argument("--limit", type=int, default=50, help="max tasks to return (default 50)"); p.set_defaults(func=cmd_tasks_ls)
    p = tasks_sub.add_parser("inbox", help="fetch actor-scoped inbox items")
    p.add_argument("--actor", default="akashi", help="actor to scope marks (default akashi)")
    p.add_argument("--limit", type=int, default=50, help="max items to return (default 50)")
    p.add_argument("--bucket", help="filter by inbox bucket")
    p.add_argument("--json", action="store_true", help="print raw JSON inbox payload")
    p.set_defaults(func=cmd_tasks_inbox)
    p = tasks_sub.add_parser("mark-read", help="mark a task as read for an actor")
    p.add_argument("task", help="task id")
    p.add_argument("--actor", default="akashi", help="actor to apply mark (default akashi)")
    p.set_defaults(func=cmd_tasks_mark_read)
    p = tasks_sub.add_parser("ack", help="acknowledge a task for an actor")
    p.add_argument("task", help="task id")
    p.add_argument("--actor", default="akashi", help="actor to apply mark (default akashi)")
    p.set_defaults(func=cmd_tasks_mark_ack)
    p = tasks_sub.add_parser("pin", help="pin a task for follow-up")
    p.add_argument("task", help="task id")
    p.add_argument("--actor", default="akashi", help="actor to apply mark (default akashi)")
    p.add_argument("--note", help="optional note")
    p.set_defaults(func=cmd_tasks_pin)
    p = tasks_sub.add_parser("unpin", help="unpin a task")
    p.add_argument("task", help="task id")
    p.add_argument("--actor", default="akashi", help="actor to apply mark (default akashi)")
    p.set_defaults(func=cmd_tasks_unpin)
    p = tasks_sub.add_parser("watch", help="watch a task for follow-up")
    p.add_argument("task", help="task id")
    p.add_argument("--actor", default="akashi", help="actor to apply mark (default akashi)")
    p.add_argument("--note", help="optional note")
    p.set_defaults(func=cmd_tasks_watch)
    p = tasks_sub.add_parser("unwatch", help="unwatch a task")
    p.add_argument("task", help="task id")
    p.add_argument("--actor", default="akashi", help="actor to apply mark (default akashi)")
    p.set_defaults(func=cmd_tasks_unwatch)
    p = tasks_sub.add_parser("top", help="summarize active tasks and recent failures"); p.add_argument("--limit", type=int, default=50, help="active tasks to inspect (default 50)"); p.add_argument("--failed-limit", type=int, default=10, help="recent failed tasks to include (default 10)"); p.set_defaults(func=cmd_tasks_top)
    p = tasks_sub.add_parser("repair", help="dry-run recommendations for risky active tasks"); p.add_argument("--limit", type=int, default=50, help="active tasks to inspect (default 50)"); p.set_defaults(func=cmd_tasks_repair)
    p = tasks_sub.add_parser("get", help="fetch a single task"); p.add_argument("task", help="task id"); p.add_argument("--short", action="store_true", help="trim to the short summary form"); p.set_defaults(func=cmd_tasks_get)
    p = tasks_sub.add_parser("wait", help="poll until a task reaches completed/failed/cancelled"); p.add_argument("task", help="task id"); p.add_argument("--interval", type=float, default=5.0, help="poll interval seconds (default 5)"); p.add_argument("--timeout", type=float, default=None, help="max seconds to wait; omit to wait forever"); p.add_argument("--status", action="store_true", help="print each observed non-terminal status to stderr"); p.add_argument("--short", action="store_true", help="trim final task to short summary form"); p.add_argument("--print-last", action="store_true", help="print last observed task JSON on timeout"); p.set_defaults(func=cmd_tasks_wait)
    p = tasks_sub.add_parser("cancel", help="cancel a task"); p.add_argument("task", help="task id"); p.add_argument("--yes", action="store_true", help="required for running/assigned tasks"); p.set_defaults(func=cmd_tasks_cancel)
    p = tasks_sub.add_parser("move", help="resubmit a task targeting a new stub or tag set"); p.add_argument("task", help="task id"); p.add_argument("--to-stub", help="target stub id/name/hostname (exclusive with --to-tags)"); p.add_argument("--to-tags", help="comma-separated target_tags (exclusive with --to-stub)"); p.add_argument("--name", help="override display name of the new task"); p.add_argument("--yes", action="store_true", help="required when cancelling a running/assigned task"); p.set_defaults(func=cmd_tasks_move)
    p = tasks_sub.add_parser("resubmit", help="clone a task as a new submission"); p.add_argument("task", help="task id to clone"); p.add_argument("--resume", action="store_true", help="append --resume to raw_args"); p.add_argument("--to-stub", help="retarget to a specific stub"); p.add_argument("--to-tags", help="retarget to comma-separated tags"); p.add_argument("--name", help="override display name"); p.add_argument("--wait", action="store_true", help="block until task is accepted"); p.add_argument("--wait-timeout", type=int, default=15, help="accept-wait timeout seconds (default 15)"); p.set_defaults(func=cmd_tasks_resubmit)
    p = tasks_sub.add_parser("update", help="patch a pending/blocked task spec in place"); p.add_argument("task", help="task id to patch"); p.add_argument("--set", action="append", default=[], metavar="KEY=VALUE", help="spec field override; JSON values accepted; repeatable"); p.set_defaults(func=cmd_tasks_update)
    p = tasks_sub.add_parser("replace", help="create a replacement attempt and rewire blocked downstream deps"); p.add_argument("task", help="task id to replace"); p.add_argument("--set", action="append", default=[], metavar="KEY=VALUE", help="replacement spec override; JSON values accepted; repeatable"); p.add_argument("--cancel-old", action="store_true", help="cancel/stop the superseded task attempt"); p.set_defaults(func=cmd_tasks_replace)
    p = tasks_sub.add_parser("logs", help="print recent log_buffer lines for a task"); p.add_argument("task", help="task id"); p.add_argument("--tail", type=int, default=80, help="number of log lines to print (default 80)"); p.set_defaults(func=cmd_tasks_logs)
    p = tasks_sub.add_parser("metrics", help="print task metrics and metrics_buffer"); p.add_argument("task", help="task id"); p.set_defaults(func=cmd_tasks_metrics)
    p = tasks_sub.add_parser("lost", help="find terminal pretrain tasks without active/completed resume successors"); p.add_argument("--kind", default="nethack-pretrain", help="intent filter (default nethack-pretrain; use all for everything)"); p.add_argument("--limit", type=int, default=500, help="tasks to inspect per status group (default 500)"); p.set_defaults(func=cmd_tasks_lost)
    p = tasks_sub.add_parser("resume-lost", help="resubmit lost tasks with --resume; dry-run by default unless --yes"); p.add_argument("--kind", default="nethack-pretrain", help="intent filter (default nethack-pretrain)"); p.add_argument("--limit", type=int, default=500, help="tasks to inspect per status group (default 500)"); p.add_argument("--to-stub", help="target stub id/name/hostname"); p.add_argument("--to-tags", help="comma-separated target tags"); p.add_argument("--dry-run", action="store_true", help="print planned submissions without POSTing"); p.add_argument("--yes", action="store_true", help="confirm: submit the planned resume tasks"); p.set_defaults(func=cmd_tasks_resume_lost)

    exps = sub.add_parser(
        "experiments",
        help="inspect and annotate experiments (lineage, decisions, notes)",
        description=EXPERIMENTS_DESCRIPTION,
    )
    exps_sub = exps.add_subparsers(dest="cmd", required=True)
    p = exps_sub.add_parser("scaffold", help="write a code-first SDK experiment skeleton")
    p.add_argument("--code-id", required=True, help="stable human-authored experiment code id, e.g. jema.atari.coverage500.v1")
    p.add_argument("--name", required=True, help="human display name")
    p.add_argument("--family", help="experiment series/family")
    p.add_argument("--output", required=True, help="Python file to create")
    p.add_argument("--force", action="store_true", help="overwrite output if it already exists")
    p.set_defaults(func=cmd_experiments_scaffold, no_client=True)

    p = exps_sub.add_parser("inject-ledger", help="idempotently update a code-first managed ledger block")
    p.add_argument("file", help="Python experiment file containing an alchemy-ledger block")
    p.add_argument("--decision-id", help="stable decision id inside this file")
    p.add_argument("--decision", choices=["keep", "try_more", "try-more", "discard", "drop", "rerun", "fork"])
    p.add_argument("--reason", help="decision rationale")
    p.add_argument("--comment-id", help="stable comment id inside this file")
    p.add_argument("--comment", help="neutral comment text")
    p.add_argument("--evidence", action="append", help="experiment code_id or artifact ref backing the entry; repeatable")
    p.set_defaults(func=cmd_experiments_inject_ledger, no_client=True)

    p = exps_sub.add_parser("sync-ledger", help="sync missing code-ledger decisions to the experiment timeline")
    p.add_argument("file", help="Python experiment file containing an alchemy-ledger block")
    p.add_argument("experiment", help="experiment id, name, or code_id")
    p.set_defaults(func=cmd_experiments_sync_ledger)

    p = exps_sub.add_parser("ls", help="list experiments (optionally filtered)", description="List experiments with optional server-side filters.")
    p.add_argument("--family", help="filter by experiment family name")
    p.add_argument("--decision", choices=["keep", "try_more", "discard", "drop", "rerun", "fork", "none"], help="filter by decision (use 'none' for undecided)")
    p.add_argument("--status", choices=["running", "passed", "partial", "failed"], help="filter by rollup status")
    p.set_defaults(func=cmd_experiments_ls)

    p = exps_sub.add_parser("show", help="fetch full detail for one experiment", description="Resolve <experiment> (name, id, or code_id) and print the full detail document.")
    p.add_argument("experiment", help="experiment name, id, or code_id")
    p.set_defaults(func=cmd_experiments_show)

    p = exps_sub.add_parser("inspect", help="show SDK spec for one experiment")
    p.add_argument("experiment", help="experiment name, id, or code_id")
    p.set_defaults(func=cmd_experiments_inspect)

    p = exps_sub.add_parser("series", help="show experiment family/series summary")
    p.add_argument("family", help="experiment family/series")
    p.set_defaults(func=cmd_experiments_series)

    p = exps_sub.add_parser("curves", help="fetch experiment metric curves from task metric endpoints")
    p.add_argument("experiment", help="experiment name, id, or code_id")
    p.add_argument("--metric", help="only include one metric name")
    p.set_defaults(func=cmd_experiments_curves)

    p = exps_sub.add_parser("timeline", help="read the append-only event timeline", description="Print the experiment's append-only event log: notes, decisions, artifacts, and synthesized task lifecycle events.")
    p.add_argument("experiment", help="experiment name or id")
    p.set_defaults(func=cmd_experiments_timeline)

    p = exps_sub.add_parser("note", help="append a free-form research note", description="Append a note event to the experiment timeline. Read-only metadata — does not touch scheduler state. Actor is derived server-side from the token.")
    p.add_argument("experiment", help="experiment name or id")
    p.add_argument("message", help="note text")
    p.add_argument("--task", help="optionally attach the note to a specific task id")
    p.add_argument("--data", help="optional JSON object payload (e.g. metric snapshot)")
    p.set_defaults(func=cmd_experiments_note)

    p = exps_sub.add_parser("comment", help="alias for note using code-first vocabulary", description="Append a neutral comment event. Alias for `experiments note`.")
    p.add_argument("experiment", help="experiment name, id, or code_id")
    p.add_argument("message", help="comment text")
    p.add_argument("--task", help="optionally attach the comment to a specific task id")
    p.add_argument("--data", help="optional JSON object payload")
    p.set_defaults(func=cmd_experiments_note)

    def add_experiment_metadata_flags(parser: argparse.ArgumentParser) -> None:
        parser.add_argument("--description")
        parser.add_argument("--family")
        parser.add_argument("--parent-id")
        parser.add_argument("--parent-name")
        parser.add_argument("--hypothesis")
        parser.add_argument("--expected-outcome")
        parser.add_argument("--fork-reason")
        parser.add_argument("--goal-metric")
        parser.add_argument("--goal-direction", choices=["min", "max"])
        parser.add_argument("--config", help="JSON object")
        parser.add_argument("--config-diff", help="JSON object")
        parser.add_argument("--criteria", help="JSON object")

    p = exps_sub.add_parser("adopt", help="create a retroactive experiment from existing tasks", description="Dry-run by default. With --yes, POST /experiments/adopt and attach existing tasks without rescheduling or changing runtime state.")
    p.add_argument("--name", required=True, help="new experiment name")
    p.add_argument("--task", action="append", required=True, help="task id to adopt; repeatable")
    add_experiment_metadata_flags(p)
    p.add_argument("--yes", action="store_true", help="confirm write")
    p.set_defaults(func=cmd_experiments_adopt)

    p = exps_sub.add_parser("adopt-task", help="attach existing tasks to an experiment", description="Dry-run by default. With --yes, POST /experiments/<id>/tasks/adopt. attach rejects tasks owned by another experiment; move rebinds them.")
    p.add_argument("experiment", help="experiment name or id")
    p.add_argument("--task", action="append", required=True, help="task id to attach; repeatable")
    p.add_argument("--mode", choices=["attach", "move"], default="attach")
    p.add_argument("--yes", action="store_true", help="confirm write")
    p.set_defaults(func=cmd_experiments_adopt_task)

    p = exps_sub.add_parser("patch", help="update experiment research metadata", description="Dry-run by default. With --yes, PATCH /experiments/<id>. Runtime/scheduler fields are not touched.")
    p.add_argument("experiment", help="experiment name or id")
    add_experiment_metadata_flags(p)
    p.add_argument("--yes", action="store_true", help="confirm write")
    p.set_defaults(func=cmd_experiments_patch)

    p = exps_sub.add_parser(
        "artifact",
        help="record an artifact (checkpoint/tensorboard/log/file/metrics)",
        description="Append an artifact event. URI vs path is auto-detected (`scheme://...` becomes `uri`, otherwise `path`). Metadata only — Alchemy does not move or upload the file.",
    )
    p.add_argument("experiment", help="experiment name or id")
    p.add_argument("location", help="filesystem path or URI (s3://, gs://, http(s)://)")
    p.add_argument("--type", choices=sorted(ARTIFACT_TYPES), help="artifact kind (checkpoint/tensorboard/log/file/metrics)")
    p.add_argument("--name", help="short label for the artifact")
    p.add_argument("--task", help="task id this artifact belongs to")
    p.add_argument("--step", type=float, help="training step the artifact corresponds to")
    p.add_argument("--data", help="extra JSON object merged into data payload")
    p.set_defaults(func=cmd_experiments_artifact)

    p = exps_sub.add_parser("checkpoint", help="shorthand for `artifact --type checkpoint`", description="Append a checkpoint artifact event. Equivalent to `artifact --type checkpoint`.")
    p.add_argument("experiment", help="experiment name or id")
    p.add_argument("location", help="checkpoint path or URI")
    p.add_argument("--name", help="short label, e.g. 'best' or 'step-10000'")
    p.add_argument("--task", help="task id the checkpoint came from")
    p.add_argument("--step", type=float, help="training step")
    p.add_argument("--data", help="extra JSON object merged into data payload")
    p.set_defaults(func=cmd_experiments_checkpoint)

    p = exps_sub.add_parser(
        "fork-plan",
        help="dry-run a fork: print proposed config + diff without submitting",
        description=(
            "Compute a fork manifest locally. Does NOT submit a fork or create "
            "any work — only fetches the parent and prints the proposed config "
            "and diff so you can review before piping into a Python "
            "Experiment().fork(...).submit(). Top-level keys only; nested "
            "(dotted) keys are rejected."
        ),
    )
    p.add_argument("experiment", help="parent experiment name or id")
    p.add_argument("--set", action="append", default=[], metavar="KEY=VALUE", help="override (JSON-encoded value if possible, else string). Repeatable. Flat keys only.")
    p.add_argument("--unset", action="append", default=[], metavar="KEY", help="remove a top-level key. Repeatable. Top-level keys only.")
    p.add_argument("--name", help="suggested child experiment name (default <parent>-fork)")
    p.add_argument("--reason", default="", help="fork rationale to include in the dry-run manifest")
    p.set_defaults(func=cmd_experiments_fork_plan)

    p = exps_sub.add_parser(
        "replication-plan",
        help="dry-run a replication: print proposed config + diff without submitting",
        description=(
            "Compute a replication manifest locally. Does NOT submit a fork or "
            "create any work — only fetches the parent and prints the proposed "
            "config and diff so you can review before using it in research "
            "notes. Top-level keys only; nested (dotted) keys are rejected."
        ),
    )
    p.add_argument("experiment", help="parent experiment name or id")
    p.add_argument("--set", action="append", default=[], metavar="KEY=VALUE", help="override (JSON-encoded value if possible, else string). Repeatable. Flat keys only.")
    p.add_argument("--unset", action="append", default=[], metavar="KEY", help="remove a top-level key. Repeatable. Top-level keys only.")
    p.add_argument("--name", help="suggested child experiment name (default <parent>-replication)")
    p.add_argument("--reason", default="", help="replication rationale to include in the dry-run manifest")
    p.set_defaults(func=cmd_experiments_replication_plan)

    p = exps_sub.add_parser(
        "decide",
        help="set or update a decision (keep/drop/rerun/fork)",
        description="Set the experiment decision via PATCH /experiments/<id>/decision. A reason is required (positional or --reason). Actor is derived server-side from the token.",
    )
    p.add_argument("experiment", help="experiment name or id")
    p.add_argument("decision", choices=["keep", "try_more", "try-more", "discard", "drop", "rerun", "fork"], help="decision verdict")
    p.add_argument("reason", nargs="?", help="rationale (positional). Alternative: --reason TEXT")
    p.add_argument("--reason", dest="reason_flag", help="rationale (flag form, takes precedence over positional)")
    p.set_defaults(func=cmd_experiments_decide)

    p = exps_sub.add_parser(
        "series-decision",
        help="append a series-scoped decision to every experiment in a family",
        description="POST /experiments/series/<family>/events with kind=decision. Appends metadata only; does not reschedule tasks.",
    )
    p.add_argument("family", help="experiment family/series")
    p.add_argument("decision", choices=["keep", "try_more", "try-more", "discard", "drop", "rerun", "fork"], help="decision verdict")
    p.add_argument("reason", nargs="?", help="rationale (positional). Alternative: --reason TEXT")
    p.add_argument("--reason", dest="reason_flag", help="rationale (flag form, takes precedence over positional)")
    p.set_defaults(func=cmd_experiments_series_decision)

    p = exps_sub.add_parser(
        "series-comment",
        help="append a series-scoped comment to every experiment in a family",
        description="POST /experiments/series/<family>/events with kind=note. Appends metadata only; does not reschedule tasks.",
    )
    p.add_argument("family", help="experiment family/series")
    p.add_argument("message", help="comment text")
    p.set_defaults(func=cmd_experiments_series_comment)

    p = exps_sub.add_parser("tree", help="print the lineage forest", description="GET /experiments/tree — full lineage forest via frozen parent_id edges.")
    p.set_defaults(func=cmd_experiments_tree)

    p = exps_sub.add_parser("compare", help="multi-experiment summary/diff (cap 6)", description="GET /experiments/compare?ids=... Order of refs is preserved. Server caps at 6 experiments.")
    p.add_argument("experiments", nargs="+", help="experiment names or ids (up to 6, no duplicates)")
    p.set_defaults(func=cmd_experiments_compare)

    p = exps_sub.add_parser("summary", help="rollups and best metrics for one experiment")
    p.add_argument("experiment", help="experiment name or id")
    p.set_defaults(func=cmd_experiments_summary)

    p = exps_sub.add_parser(
        "recommend",
        help="fetch a recommendation for one experiment",
        description=(
            "Resolve <experiment> (name or id) and fetch recommendation data. "
            "By default the command calls /experiments/<id>/recommendation; "
            "if that endpoint returns 404, it falls back to "
            "/experiments/<id>/summary and uses the recommendation key."
        ),
    )
    p.add_argument("experiment", help="experiment name or id")
    p.add_argument("--markdown", action="store_true", help="print recommendation payload as markdown JSON code block")
    p.set_defaults(func=cmd_experiments_recommend)

    p = exps_sub.add_parser("diff", help="config diff against parent experiment")
    p.add_argument("experiment", help="experiment name or id")
    p.set_defaults(func=cmd_experiments_diff)

    p = exps_sub.add_parser("manifest", help="reproducibility manifest (git, env, task specs)")
    p.add_argument("experiment", help="experiment name or id")
    p.set_defaults(func=cmd_experiments_manifest)

    p = exps_sub.add_parser(
        "bundle",
        help="read-only research bundle (detail + summary + diff + manifest + timeline + decision + artifacts)",
        description=(
            "GET /experiments/<id>/research-bundle — one-shot read-only export "
            "of decision-relevant context for an experiment. Intended for "
            "research handoff, notebooks, or batch export; does not replace "
            "streaming dashboards. Issues only GET requests."
        ),
    )
    p.add_argument("experiment", help="experiment name or id")
    p.add_argument(
        "--format",
        choices=["json", "markdown"],
        default="json",
        help="output format (default: json). Use 'markdown' for a human handoff.",
    )
    p.add_argument(
        "--output",
        help="optional local file path to write the rendered bundle to (stdout otherwise)",
    )
    p.set_defaults(func=cmd_experiments_bundle)

    p = exps_sub.add_parser(
        "report",
        help="read-only family/decision/status rollup (leaderboard + briefs)",
        description=(
            "GET /experiments/research-report — filtered family/decision/status "
            "rollup. Issues only one GET request: counts, leaderboard by primary "
            "metric, per-experiment briefs (decision, task counts, recent events, "
            "artifact/checkpoint counts). Read-only; never reschedules or writes "
            "events. Pass --decision none to select undecided experiments. "
            "--limit defaults to 50 server-side and is capped at 200."
        ),
    )
    p.add_argument("--family", help="filter by experiment family name")
    p.add_argument(
        "--decision",
        choices=["keep", "drop", "rerun", "fork", "none"],
        help="filter by decision (use 'none' for undecided)",
    )
    p.add_argument(
        "--status",
        choices=["running", "passed", "partial", "failed"],
        help="filter by rollup status",
    )
    p.add_argument("--limit", type=int, default=None, help="cap experiments returned (default 50, max 200)")
    p.add_argument(
        "--format",
        choices=["json", "markdown"],
        default="json",
        help="output format (default: json). Use 'markdown' for a human handoff.",
    )
    p.add_argument(
        "--output",
        help="optional local file path to write the rendered report to (stdout otherwise)",
    )
    p.set_defaults(func=cmd_experiments_report)

    p = sub.add_parser("verify", help="poll task/stub state and assert expectations")
    p.add_argument("--task", help="task id to check")
    p.add_argument("--stub", help="stub id/name/hostname expected to be online")
    p.add_argument("--expect-status", default="running", help="expected task status (default 'running')")
    p.set_defaults(func=cmd_verify)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if getattr(args, "no_client", False):
            args.func(args)
        else:
            client = build_client(args)
            result = args.func(args, client)
            if isinstance(result, int):
                return result
        return 0
    except AlchError as exc:
        print(f"alch: error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
