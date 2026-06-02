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
COMPARE_MAX_REFS = 6  # server caps `/experiments/compare?ids=...` at 6
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


def short_experiment(exp: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": exp.get("id"),
        "name": exp.get("name"),
        "status": exp.get("status"),
        "family": exp.get("family"),
        "decision": exp.get("decision"),
        "parent_name": exp.get("parent_name"),
        "created_at": exp.get("created_at"),
    }


def find_experiment(client: ApiClient, ref: str) -> dict[str, Any]:
    experiments = client.get("/experiments")
    return resolve_experiment(experiments, ref)


def resolve_experiment(experiments: list[dict[str, Any]], ref: str) -> dict[str, Any]:
    matches = [e for e in experiments if e.get("id") == ref or e.get("name") == ref]
    if not matches:
        raise AlchError(f"experiment not found: {ref}")
    if len(matches) > 1:
        raise AlchError(f"ambiguous experiment ref {ref}: {[e.get('name') for e in matches]}")
    return matches[0]


def parse_data_object(raw: str | None) -> dict[str, Any] | None:
    if raw is None:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AlchError(f"--data must be valid JSON: {exc.msg}") from exc
    if not isinstance(parsed, dict):
        raise AlchError("--data must be a JSON object")
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


def cmd_experiments_fork_plan(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    detail = client.get(f"/experiments/{exp['id']}")
    base_config = detail.get("config") if isinstance(detail, dict) else None
    proposed, diff = apply_overrides(base_config or {}, args.set or [], args.unset or [])
    parent_name = detail.get("name") or exp.get("name")
    suggested_name = args.name or f"{parent_name}-fork"
    manifest = {
        "kind": "fork-plan",
        "dry_run": True,
        "parent": {
            "id": detail.get("id") or exp.get("id"),
            "name": parent_name,
            "family": detail.get("family"),
        },
        "suggested_name": suggested_name,
        "reason": args.reason,
        "parent_config": base_config or {},
        "proposed_config": proposed,
        "config_diff": diff,
    }
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


def cmd_experiments_diff(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    print_json(client.get(f"/experiments/{exp['id']}/diff"))


def cmd_experiments_manifest(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    print_json(client.get(f"/experiments/{exp['id']}/manifest"))


def cmd_experiments_bundle(args: argparse.Namespace, client: ApiClient) -> None:
    exp = find_experiment(client, args.experiment)
    print_json(client.get(f"/experiments/{exp['id']}/research-bundle"))


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
    print_json(client.get(path))


def cmd_experiments_decide(args: argparse.Namespace, client: ApiClient) -> None:
    reason = args.reason_flag or args.reason
    if not reason:
        raise AlchError("decision reason required: pass --reason <text>")
    exp = find_experiment(client, args.experiment)
    body = {"decision": args.decision, "reason": reason}
    print_json(client.patch(f"/experiments/{exp['id']}/decision", body))


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

    stubs = sub.add_parser("stubs", help="list, drain, or restart stubs")
    stubs_sub = stubs.add_subparsers(dest="cmd", required=True)
    p = stubs_sub.add_parser("ls", help="list known stubs"); p.add_argument("--online", action="store_true", help="only include online stubs"); p.set_defaults(func=cmd_stubs_ls)
    p = stubs_sub.add_parser("drain", help="set a stub's max_concurrent to 0"); p.add_argument("stub", help="stub id, name, or hostname"); p.set_defaults(func=cmd_stubs_drain)
    p = stubs_sub.add_parser("undrain", help="restore a stub's max_concurrent"); p.add_argument("stub", help="stub id, name, or hostname"); p.add_argument("--n", type=int, default=1, help="new max_concurrent (default 1)"); p.set_defaults(func=cmd_stubs_undrain)
    p = stubs_sub.add_parser("restart", help="redeploy/restart a managed stub"); p.add_argument("name", help="deploy stub name (matches deploy-config.yaml)"); p.add_argument("--mem", help="optional SLURM mem override"); p.add_argument("--time", help="optional SLURM walltime override"); p.add_argument("--yes", action="store_true", help="confirm: this restarts a real worker"); p.set_defaults(func=cmd_stubs_restart)

    slurm = sub.add_parser("slurm", help="SLURM-specific stub submission")
    slurm_sub = slurm.add_subparsers(dest="cmd", required=True)
    p = slurm_sub.add_parser("submit", help="submit/restart a SLURM stub"); p.add_argument("kind", choices=["a30", "a40", "t4", "slurm-a30", "slurm-a40", "slurm-t4"], help="GPU kind shorthand (a30/a40/t4) or full slurm-* name"); p.add_argument("--count", type=int, default=1, help="number of stubs to submit (default 1)"); p.add_argument("--mem", help="optional SLURM mem override"); p.add_argument("--time", help="optional SLURM walltime override"); p.add_argument("--yes", action="store_true", help="required when --count > 1"); p.set_defaults(func=cmd_slurm_submit)

    tasks = sub.add_parser("tasks", help="list, inspect, cancel, move, or resubmit tasks")
    tasks_sub = tasks.add_subparsers(dest="cmd", required=True)
    p = tasks_sub.add_parser("ls", help="list recent tasks (short form)"); p.add_argument("--status", help="filter by status (pending/running/...)"); p.add_argument("--active", action="store_true", help="filter to active statuses (pending/assigned/running/paused/blocked)"); p.add_argument("--stub", help="only tasks bound to this stub"); p.add_argument("--limit", type=int, default=50, help="max tasks to return (default 50)"); p.set_defaults(func=cmd_tasks_ls)
    p = tasks_sub.add_parser("get", help="fetch a single task"); p.add_argument("task", help="task id"); p.add_argument("--short", action="store_true", help="trim to the short summary form"); p.set_defaults(func=cmd_tasks_get)
    p = tasks_sub.add_parser("cancel", help="cancel a task"); p.add_argument("task", help="task id"); p.add_argument("--yes", action="store_true", help="required for running/assigned tasks"); p.set_defaults(func=cmd_tasks_cancel)
    p = tasks_sub.add_parser("move", help="resubmit a task targeting a new stub or tag set"); p.add_argument("task", help="task id"); p.add_argument("--to-stub", help="target stub id/name/hostname (exclusive with --to-tags)"); p.add_argument("--to-tags", help="comma-separated target_tags (exclusive with --to-stub)"); p.add_argument("--name", help="override display name of the new task"); p.add_argument("--yes", action="store_true", help="required when cancelling a running/assigned task"); p.set_defaults(func=cmd_tasks_move)
    p = tasks_sub.add_parser("resubmit", help="clone a task as a new submission"); p.add_argument("task", help="task id to clone"); p.add_argument("--resume", action="store_true", help="append --resume to raw_args"); p.add_argument("--to-stub", help="retarget to a specific stub"); p.add_argument("--to-tags", help="retarget to comma-separated tags"); p.add_argument("--name", help="override display name"); p.add_argument("--wait", action="store_true", help="block until task is accepted"); p.add_argument("--wait-timeout", type=int, default=15, help="accept-wait timeout seconds (default 15)"); p.set_defaults(func=cmd_tasks_resubmit)

    exps = sub.add_parser(
        "experiments",
        help="inspect and annotate experiments (lineage, decisions, notes)",
        description=EXPERIMENTS_DESCRIPTION,
    )
    exps_sub = exps.add_subparsers(dest="cmd", required=True)
    p = exps_sub.add_parser("ls", help="list experiments (optionally filtered)", description="List experiments with optional server-side filters.")
    p.add_argument("--family", help="filter by experiment family name")
    p.add_argument("--decision", choices=["keep", "drop", "rerun", "fork", "none"], help="filter by decision (use 'none' for undecided)")
    p.add_argument("--status", choices=["running", "passed", "partial", "failed"], help="filter by rollup status")
    p.set_defaults(func=cmd_experiments_ls)

    p = exps_sub.add_parser("show", help="fetch full detail for one experiment", description="Resolve <experiment> (name or id) and print the full detail document.")
    p.add_argument("experiment", help="experiment name or id")
    p.set_defaults(func=cmd_experiments_show)

    p = exps_sub.add_parser("timeline", help="read the append-only event timeline", description="Print the experiment's append-only event log: notes, decisions, artifacts, and synthesized task lifecycle events.")
    p.add_argument("experiment", help="experiment name or id")
    p.set_defaults(func=cmd_experiments_timeline)

    p = exps_sub.add_parser("note", help="append a free-form research note", description="Append a note event to the experiment timeline. Read-only metadata — does not touch scheduler state. Actor is derived server-side from the token.")
    p.add_argument("experiment", help="experiment name or id")
    p.add_argument("message", help="note text")
    p.add_argument("--task", help="optionally attach the note to a specific task id")
    p.add_argument("--data", help="optional JSON object payload (e.g. metric snapshot)")
    p.set_defaults(func=cmd_experiments_note)

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
        "decide",
        help="set or update a decision (keep/drop/rerun/fork)",
        description="Set the experiment decision via PATCH /experiments/<id>/decision. A reason is required (positional or --reason). Actor is derived server-side from the token.",
    )
    p.add_argument("experiment", help="experiment name or id")
    p.add_argument("decision", choices=["keep", "drop", "rerun", "fork"], help="decision verdict")
    p.add_argument("reason", nargs="?", help="rationale (positional). Alternative: --reason TEXT")
    p.add_argument("--reason", dest="reason_flag", help="rationale (flag form, takes precedence over positional)")
    p.set_defaults(func=cmd_experiments_decide)

    p = exps_sub.add_parser("tree", help="print the lineage forest", description="GET /experiments/tree — full lineage forest via frozen parent_id edges.")
    p.set_defaults(func=cmd_experiments_tree)

    p = exps_sub.add_parser("compare", help="multi-experiment summary/diff (cap 6)", description="GET /experiments/compare?ids=... Order of refs is preserved. Server caps at 6 experiments.")
    p.add_argument("experiments", nargs="+", help="experiment names or ids (up to 6, no duplicates)")
    p.set_defaults(func=cmd_experiments_compare)

    p = exps_sub.add_parser("summary", help="rollups and best metrics for one experiment")
    p.add_argument("experiment", help="experiment name or id")
    p.set_defaults(func=cmd_experiments_summary)

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
        client = build_client(args)
        args.func(args, client)
        return 0
    except AlchError as exc:
        print(f"alch: error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
