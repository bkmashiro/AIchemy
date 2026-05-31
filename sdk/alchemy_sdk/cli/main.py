from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
import uuid
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DEFAULT_SERVER = "http://localhost:3002"
ACTIVE_STATUSES = {"pending", "assigned", "running", "paused", "blocked"}
DANGEROUS_STATUSES = {"running", "assigned"}
TASK_FIELDS = [
    "script", "args", "raw_args", "name", "cwd", "env_setup", "env", "env_overrides",
    "requirements", "priority", "max_retries", "param_overrides", "target_tags",
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

    def post(self, path: str, body: dict[str, Any] | None = None) -> Any:
        return self.request("POST", path, body or {})

    def patch(self, path: str, body: dict[str, Any]) -> Any:
        return self.request("PATCH", path, body)


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
    server = args.server or os.environ.get("ALCHEMY_SERVER_URL") or DEFAULT_SERVER
    token = args.token or os.environ.get("ALCHEMY_TOKEN")
    if not token and args.local:
        token = read_local_token(args.state_db or os.environ.get("ALCHEMY_STATE_DB") or "state.db")
    if not token:
        raise AlchError("missing token: set ALCHEMY_TOKEN or pass --local [--state-db state.db]")
    return ApiClient(server, token, timeout=args.timeout)


def print_json(data: Any) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True))


def short_task(task: dict[str, Any]) -> dict[str, Any]:
    return {
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


def cmd_stubs_drain(args: argparse.Namespace, client: ApiClient) -> None:
    stub = find_stub(client, args.stub)
    result = client.patch(f"/stubs/{stub['id']}", {"max_concurrent": 0})
    print_json({"ok": True, "stub": result.get("stub", {}).get("name"), "max_concurrent": 0})


def cmd_stubs_undrain(args: argparse.Namespace, client: ApiClient) -> None:
    stub = find_stub(client, args.stub)
    result = client.patch(f"/stubs/{stub['id']}", {"max_concurrent": args.n})
    print_json({"ok": True, "stub": result.get("stub", {}).get("name"), "max_concurrent": args.n})


def cmd_stubs_restart(args: argparse.Namespace, client: ApiClient) -> None:
    if not args.yes:
        raise AlchError("stubs restart submits/restarts a real worker; pass --yes")
    body: dict[str, Any] = {}
    if args.mem:
        body["mem"] = args.mem
    if args.time:
        body["time"] = args.time
    print_json(client.post(f"/deploy/stubs/{args.name}/restart", body))


def cmd_slurm_submit(args: argparse.Namespace, client: ApiClient) -> None:
    if args.count != 1 and not args.yes:
        raise AlchError("submitting multiple SLURM stubs requires --yes")
    target = args.kind if args.kind.startswith("slurm-") else f"slurm-{args.kind}"
    results = []
    for _ in range(args.count):
        body: dict[str, Any] = {}
        if args.mem:
            body["mem"] = args.mem
        if args.time:
            body["time"] = args.time
        results.append(client.post(f"/deploy/stubs/{target}/restart", body))
    print_json(results[0] if args.count == 1 else results)


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


def cmd_tasks_get(args: argparse.Namespace, client: ApiClient) -> None:
    task = client.get(f"/tasks/{args.task}")
    print_json(short_task(task) if args.short else task)


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


def add_global(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--server", help=f"Alchemy server URL (default {DEFAULT_SERVER})")
    parser.add_argument("--token", help=argparse.SUPPRESS)
    parser.add_argument("--local", action="store_true", help="read token from local SQLite state db")
    parser.add_argument("--state-db", help="SQLite state db path for --local")
    parser.add_argument("--timeout", type=float, default=20.0)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="alch", description="Alchemy v2 operator CLI")
    add_global(parser)
    sub = parser.add_subparsers(dest="group", required=True)

    stubs = sub.add_parser("stubs")
    stubs_sub = stubs.add_subparsers(dest="cmd", required=True)
    p = stubs_sub.add_parser("ls"); p.add_argument("--online", action="store_true"); p.set_defaults(func=cmd_stubs_ls)
    p = stubs_sub.add_parser("drain"); p.add_argument("stub"); p.set_defaults(func=cmd_stubs_drain)
    p = stubs_sub.add_parser("undrain"); p.add_argument("stub"); p.add_argument("--n", type=int, default=1); p.set_defaults(func=cmd_stubs_undrain)
    p = stubs_sub.add_parser("restart"); p.add_argument("name"); p.add_argument("--mem"); p.add_argument("--time"); p.add_argument("--yes", action="store_true"); p.set_defaults(func=cmd_stubs_restart)

    slurm = sub.add_parser("slurm")
    slurm_sub = slurm.add_subparsers(dest="cmd", required=True)
    p = slurm_sub.add_parser("submit"); p.add_argument("kind", choices=["a30", "a40", "t4", "slurm-a30", "slurm-a40", "slurm-t4"]); p.add_argument("--count", type=int, default=1); p.add_argument("--mem"); p.add_argument("--time"); p.add_argument("--yes", action="store_true"); p.set_defaults(func=cmd_slurm_submit)

    tasks = sub.add_parser("tasks")
    tasks_sub = tasks.add_subparsers(dest="cmd", required=True)
    p = tasks_sub.add_parser("ls"); p.add_argument("--status"); p.add_argument("--active", action="store_true"); p.add_argument("--stub"); p.add_argument("--limit", type=int, default=50); p.set_defaults(func=cmd_tasks_ls)
    p = tasks_sub.add_parser("get"); p.add_argument("task"); p.add_argument("--short", action="store_true"); p.set_defaults(func=cmd_tasks_get)
    p = tasks_sub.add_parser("cancel"); p.add_argument("task"); p.add_argument("--yes", action="store_true"); p.set_defaults(func=cmd_tasks_cancel)
    p = tasks_sub.add_parser("move"); p.add_argument("task"); p.add_argument("--to-stub"); p.add_argument("--to-tags"); p.add_argument("--name"); p.add_argument("--yes", action="store_true"); p.set_defaults(func=cmd_tasks_move)
    p = tasks_sub.add_parser("resubmit"); p.add_argument("task"); p.add_argument("--resume", action="store_true"); p.add_argument("--to-stub"); p.add_argument("--to-tags"); p.add_argument("--name"); p.add_argument("--wait", action="store_true"); p.add_argument("--wait-timeout", type=int, default=15); p.set_defaults(func=cmd_tasks_resubmit)

    p = sub.add_parser("verify"); p.add_argument("--task"); p.add_argument("--stub"); p.add_argument("--expect-status", default="running"); p.set_defaults(func=cmd_verify)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        client = build_client(args)
        args.func(args, client)
        return 0
    except AlchError as exc:
        print(f"alch: error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
