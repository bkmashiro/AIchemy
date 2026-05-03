"""Experiment DAG definition, config management, and lineage."""
from __future__ import annotations

import copy
import json
import os
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class TaskNode:
    """A node in the experiment DAG. Created by Experiment.task()."""
    ref: str
    _spec: dict[str, Any] = field(repr=False)
    task_id: Optional[str] = None  # populated after submit

    def __repr__(self) -> str:
        status = f" id={self.task_id}" if self.task_id else ""
        return f"TaskNode({self.ref!r}{status})"


@dataclass
class ExperimentResult:
    experiment_id: str
    task_refs: dict[str, str]
    already_exists: bool
    url: str


@dataclass
class TaskStatusDetail:
    ref: str
    task_id: str
    status: str
    exit_code: Optional[int] = None
    exports: Optional[dict[str, Any]] = None


@dataclass
class ExperimentStatus:
    experiment_id: str
    name: str
    status: str
    tasks: dict[str, TaskStatusDetail]


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _deep_diff(old: dict, new: dict, prefix: str = "") -> dict:
    """Recursive diff. Returns {dotpath: {old, new}} for changed/added/removed keys."""
    changes: dict[str, Any] = {}
    all_keys = set(old.keys()) | set(new.keys())
    for key in sorted(all_keys):
        path = f"{prefix}.{key}" if prefix else key
        if key not in old:
            changes[path] = {"old": None, "new": new[key]}
        elif key not in new:
            changes[path] = {"old": old[key], "new": None}
        elif isinstance(old[key], dict) and isinstance(new[key], dict):
            changes.update(_deep_diff(old[key], new[key], path))
        elif old[key] != new[key]:
            changes[path] = {"old": old[key], "new": new[key]}
    return changes


def _set_nested(d: dict, path: str, value: Any) -> None:
    """Set a value in a nested dict using dot-separated path."""
    keys = path.split(".")
    for k in keys[:-1]:
        d = d.setdefault(k, {})
    d[keys[-1]] = value


# ─── Experiment ──────────────────────────────────────────────────────────────

class Experiment:
    """
    Define a DAG of tasks with optional config and lineage tracking.

    Usage:
        exp = Experiment("my_experiment")
        exp.config = {"train": {"lr": 1e-4, "batch_size": 64}}
        a = exp.task("train", script="train.py")
        b = exp.task("eval", script="eval.py", depends_on=[a])
        exp.submit()
    """

    def __init__(
        self,
        name: str,
        *,
        description: str = "",
        server: Optional[str] = None,
    ) -> None:
        self.name = name
        self.description = description
        self._server = server or os.environ.get("ALCHEMY_SERVER") or self._read_config_server()
        self._tasks: list[TaskNode] = []
        self._refs: set[str] = set()
        self._experiment_id: Optional[str] = None

        # Config + lineage
        self.config: dict[str, Any] = {}
        self._parent_name: Optional[str] = None
        self._parent_config: Optional[dict[str, Any]] = None  # snapshot for diff

    def task(
        self,
        ref: str,
        *,
        script: str,
        args: Optional[dict[str, str]] = None,
        raw_args: Optional[str] = None,
        args_template: Optional[dict[str, str]] = None,
        depends_on: Optional[list[TaskNode]] = None,
        cwd: Optional[str] = None,
        python_env: Optional[str] = None,
        env_setup: Optional[str] = None,
        env: Optional[dict[str, str]] = None,
        env_overrides: Optional[dict[str, str]] = None,
        requirements: Optional[dict] = None,
        target_tags: Optional[list[str]] = None,
        max_retries: int = 0,
        priority: int = 5,
        outputs: Optional[list[str]] = None,
        config_overrides: Optional[dict[str, Any]] = None,
    ) -> TaskNode:
        if ref in self._refs:
            raise ValueError(f"Duplicate task ref: {ref!r}")
        self._refs.add(ref)

        spec: dict[str, Any] = {"ref": ref, "script": script}
        if args:               spec["args"] = args
        if raw_args:           spec["raw_args"] = raw_args
        if args_template:      spec["args_template"] = args_template
        if depends_on:         spec["depends_on"] = [t.ref for t in depends_on]
        if cwd:                spec["cwd"] = cwd
        if python_env:         spec["python_env"] = python_env
        if env_setup:          spec["env_setup"] = env_setup
        if env:                spec["env"] = env
        if env_overrides:      spec["env_overrides"] = env_overrides
        if requirements:       spec["requirements"] = requirements
        if target_tags:        spec["target_tags"] = target_tags
        if max_retries:        spec["max_retries"] = max_retries
        if priority != 5:      spec["priority"] = priority
        if outputs:            spec["outputs"] = outputs
        if config_overrides:   spec["config_overrides"] = config_overrides

        node = TaskNode(ref=ref, _spec=spec)
        self._tasks.append(node)
        return node

    def fork(self, name: str, *, description: str = "") -> "Experiment":
        """Create a child experiment by deep-copying config and task structure."""
        child = Experiment(name, description=description, server=self._server)
        child.config = copy.deepcopy(self.config)
        child._parent_name = self.name
        child._parent_config = copy.deepcopy(self.config)
        # Copy task DAG structure (without task_ids)
        for t in self._tasks:
            child._tasks.append(TaskNode(ref=t.ref, _spec=copy.deepcopy(t._spec)))
            child._refs.add(t.ref)
        return child

    def submit(self, *, dry_run: bool = False, force: bool = False) -> ExperimentResult:
        """Submit the experiment to the server."""
        self._validate_dag()

        if dry_run:
            self._print_dag()
            return ExperimentResult(
                experiment_id="dry-run",
                task_refs={t.ref: "dry-run" for t in self._tasks},
                already_exists=False,
                url="",
            )

        from .submit import submit_experiment

        # Resolve per-task configs before submission
        specs = []
        for t in self._tasks:
            spec = dict(t._spec)
            if self.config:
                resolved = self._resolve_task_config(t)
                spec["resolved_config"] = resolved
            specs.append(spec)

        result = submit_experiment(
            server=self._server,
            name=self.name,
            description=self.description,
            task_specs=specs,
            force=force,
            config=self.config if self.config else None,
            config_diff=self._compute_config_diff(),
            parent_name=self._parent_name,
        )

        # Backfill task_ids
        self._experiment_id = result.experiment_id
        for t in self._tasks:
            t.task_id = result.task_refs.get(t.ref)

        return result

    def status(self) -> "ExperimentStatus":
        if not self._experiment_id:
            raise RuntimeError("Experiment not yet submitted")
        from .submit import get_experiment_status
        return get_experiment_status(self._server, self._experiment_id)

    # ── Config resolution ──

    def _resolve_task_config(self, task: TaskNode) -> dict[str, Any]:
        """Merge experiment config + task-level config_overrides."""
        config = copy.deepcopy(self.config)
        overrides = task._spec.get("config_overrides", {})
        for dotpath, value in overrides.items():
            _set_nested(config, dotpath, value)
        return config

    def _compute_config_diff(self) -> Optional[dict]:
        """Compute diff against parent config. Returns None if no parent."""
        if not self._parent_config:
            return None
        return _deep_diff(self._parent_config, self.config) or None

    # ── Validation ──

    def _validate_dag(self) -> None:
        if not self._tasks:
            raise ValueError("Experiment has no tasks")

        adj: dict[str, list[str]] = {t.ref: [] for t in self._tasks}
        for t in self._tasks:
            for dep_ref in t._spec.get("depends_on", []):
                if dep_ref not in adj:
                    raise ValueError(f"Task {t.ref!r} depends on unknown ref {dep_ref!r}")
                adj[dep_ref].append(t.ref)

        visited: set[str] = set()
        in_stack: set[str] = set()

        def dfs(node: str) -> None:
            visited.add(node)
            in_stack.add(node)
            for child in adj[node]:
                if child in in_stack:
                    raise ValueError(f"Cyclic dependency detected involving {child!r}")
                if child not in visited:
                    dfs(child)
            in_stack.discard(node)

        for ref in adj:
            if ref not in visited:
                dfs(ref)

    def _print_dag(self) -> None:
        print(f"Experiment: {self.name}")
        if self.config:
            print(f"Config keys: {list(self.config.keys())}")
        if self._parent_name:
            diff = self._compute_config_diff()
            print(f"Parent: {self._parent_name}")
            if diff:
                print(f"Config diff: {json.dumps(diff, indent=2, default=str)}")
        print(f"Tasks ({len(self._tasks)}):")
        for t in self._tasks:
            deps = t._spec.get("depends_on", [])
            dep_str = f" <- [{', '.join(deps)}]" if deps else ""
            overrides = t._spec.get("config_overrides", {})
            ov_str = f" overrides={overrides}" if overrides else ""
            print(f"  {t.ref}: {t._spec['script']}{dep_str}{ov_str}")

    @staticmethod
    def _read_config_server() -> str:
        """Read server URL from ~/.alchemy/config.yaml."""
        config_path = os.path.expanduser("~/.alchemy/config.yaml")
        if os.path.exists(config_path):
            try:
                import yaml  # type: ignore
                with open(config_path) as f:
                    cfg = yaml.safe_load(f)
                return cfg.get("server", "")
            except Exception:
                pass
        return ""
