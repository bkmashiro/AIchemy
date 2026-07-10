"""Experiment DAG definition, config management, and lineage."""
from __future__ import annotations

import copy
import itertools
import json
import os
import subprocess
from dataclasses import dataclass, field
from importlib import metadata as importlib_metadata
from typing import Any, Mapping, Optional

from .submission_lint import lint_task_specs
from .operator_config import resolve_server


@dataclass
class TaskNode:
    """A node in the experiment DAG. Created by Experiment.task()."""
    ref: str
    _spec: dict[str, Any] = field(repr=False)
    task_id: Optional[str] = None  # populated after submit

    def __repr__(self) -> str:
        status = f" id={self.task_id}" if self.task_id else ""
        return f"TaskNode({self.ref!r}{status})"


@dataclass(frozen=True)
class RuntimeProfile:
    """Reusable, non-secret execution defaults shared by an experiment's tasks."""

    name: str
    cwd: Optional[str] = None
    python_env: Optional[str] = None
    env_setup: Optional[str] = None
    env: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not self.name.strip():
            raise ValueError("runtime profile name must be a non-empty string")
        for field_name in ("cwd", "python_env", "env_setup"):
            value = getattr(self, field_name)
            if value is not None and (not isinstance(value, str) or not value.strip()):
                raise ValueError(f"runtime profile {field_name} must be a non-empty string")
        for key, value in self.env.items():
            if not isinstance(key, str) or not key:
                raise ValueError("runtime profile env keys must be non-empty strings")
            if not isinstance(value, str):
                raise ValueError("runtime profile env values must be strings")

    def to_spec(self) -> dict[str, Any]:
        spec: dict[str, Any] = {"name": self.name.strip()}
        if self.cwd is not None:
            spec["cwd"] = self.cwd
        if self.python_env is not None:
            spec["python_env"] = self.python_env
        if self.env_setup is not None:
            spec["env_setup"] = self.env_setup
        if self.env:
            spec["env"] = copy.deepcopy(dict(self.env))
        return spec


@dataclass
class ExperimentResult:
    experiment_id: str
    task_refs: dict[str, str]
    already_exists: bool
    url: str
    submission_warnings: list[dict[str, Any]] = field(default_factory=list)


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


def _validate_non_empty_path(value: str, field: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty path")


def _sdk_version() -> str:
    try:
        return importlib_metadata.version("alchemy-sdk")
    except importlib_metadata.PackageNotFoundError:
        return "unknown"


def _git_commit() -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=os.getcwd(),
            check=True,
            capture_output=True,
            text=True,
        )
    except Exception:
        return "unknown"
    return result.stdout.strip() or "unknown"


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
        name: Optional[str] = None,
        *,
        code_id: Optional[str] = None,
        description: str = "",
        server: Optional[str] = None,
        family: Optional[str] = None,
        hypothesis: Optional[str] = None,
        expected_outcome: Optional[str] = None,
        fork_reason: Optional[str] = None,
    ) -> None:
        if name is None or not isinstance(name, str) or not name.strip():
            raise ValueError("name must be a non-empty string")
        if code_id is not None and (not isinstance(code_id, str) or not code_id.strip()):
            raise ValueError("code_id must be a non-empty string")
        self.name = name
        self.code_id = code_id.strip() if code_id is not None else None
        self.description = description
        self._server = resolve_server(server)
        self._tasks: list[TaskNode] = []
        self._refs: set[str] = set()
        self._experiment_id: Optional[str] = None

        # Config + lineage
        self.config: dict[str, Any] = {}
        self.family = family
        self.hypothesis = hypothesis
        self.expected_outcome = expected_outcome
        self.fork_reason = fork_reason
        self._parent_name: Optional[str] = None
        self._parent_config: Optional[dict[str, Any]] = None  # snapshot for diff
        self._storage: dict[str, str] = {}
        self._runtime: Optional[RuntimeProfile] = None
        self._param_space: dict[str, list[Any]] = {}
        self._decision_policy: dict[str, Any] = {}

    def storage(self, *, root: str, artifact_root: Optional[str] = None) -> "Experiment":
        """Declare experiment storage roots in the SDK-authored spec."""
        _validate_non_empty_path(root, "storage root")
        storage = {"root": root}
        if artifact_root is not None:
            _validate_non_empty_path(artifact_root, "artifact_root")
            storage["artifact_root"] = artifact_root
        self._storage = copy.deepcopy(storage)
        return self

    def runtime(self, profile: RuntimeProfile) -> "Experiment":
        """Apply one reusable execution profile to every task in this experiment."""
        if not isinstance(profile, RuntimeProfile):
            raise TypeError("runtime profile must be a RuntimeProfile")
        self._runtime = copy.deepcopy(profile)
        return self

    def base_config(self, config: Mapping[str, Any]) -> "Experiment":
        """Set the SDK-authored base config snapshot for all tasks."""
        if not isinstance(config, Mapping):
            raise ValueError("base_config must be a mapping")
        self.config = copy.deepcopy(dict(config))
        return self

    def params(self, **space: list[Any] | tuple[Any, ...]) -> "Experiment":
        """Declare an ordered hyperparameter space for SDK-owned grid expansion."""
        copied: dict[str, list[Any]] = {}
        for key, values in space.items():
            if not isinstance(values, (list, tuple)):
                raise ValueError(f"param {key!r} must be a list or tuple")
            if not values:
                raise ValueError(f"param {key!r} must be non-empty")
            copied[key] = list(copy.deepcopy(values))
        self._param_space = copied
        return self

    def decision_policy(
        self,
        *,
        primary_metric: str,
        direction: str,
        keep_if: Optional[str] = None,
        try_more_if: Optional[str] = None,
        discard_if: Optional[str] = None,
        min_seeds: Optional[int] = None,
    ) -> "Experiment":
        """Declare how humans/agents should judge this experiment after results land."""
        if not primary_metric or not isinstance(primary_metric, str):
            raise ValueError("decision_policy primary_metric must be a non-empty string")
        if direction not in {"min", "max"}:
            raise ValueError("decision_policy direction must be 'min' or 'max'")
        policy: dict[str, Any] = {"primary_metric": primary_metric, "direction": direction}
        if keep_if:        policy["keep_if"] = keep_if
        if try_more_if:    policy["try_more_if"] = try_more_if
        if discard_if:     policy["discard_if"] = discard_if
        if min_seeds is not None:
            if min_seeds < 1:
                raise ValueError("decision_policy min_seeds must be >= 1")
            policy["min_seeds"] = min_seeds
        self._decision_policy = copy.deepcopy(policy)
        return self

    def _param_points(self) -> list[dict[str, Any]]:
        if not self._param_space:
            return []
        keys = list(self._param_space.keys())
        return [
            dict(zip(keys, values, strict=True))
            for values in itertools.product(*(self._param_space[key] for key in keys))
        ]

    def _task_specs(self) -> list[dict[str, Any]]:
        points = self._param_points()
        specs: list[dict[str, Any]] = []
        seen_refs: set[str] = set()
        for task in self._tasks:
            template = task._spec["ref"]
            if not self._param_space or ("{" not in template and "}" not in template):
                spec = copy.deepcopy(task._spec)
                rendered_refs = [spec]
            else:
                rendered_refs = []
                for point in points:
                    try:
                        rendered_ref = template.format(**point)
                    except KeyError as exc:
                        missing = exc.args[0]
                        raise ValueError(
                            f"Task ref template {template!r} uses unknown template key {missing!r}"
                        ) from exc
                    spec = copy.deepcopy(task._spec)
                    spec["ref"] = rendered_ref
                    spec["ref_template"] = template
                    spec["param_point"] = copy.deepcopy(point)
                    rendered_refs.append(spec)

            for spec in rendered_refs:
                if self._runtime is not None:
                    runtime = self._runtime.to_spec()
                    for field_name in ("cwd", "python_env", "env_setup"):
                        if field_name not in spec and field_name in runtime:
                            spec[field_name] = runtime[field_name]
                    runtime_env = runtime.get("env", {})
                    if runtime_env:
                        spec["env"] = {**runtime_env, **spec.get("env", {})}
                point = spec.get("param_point")
                rendered_deps: list[str] = []
                for dep_ref in spec.get("depends_on", []):
                    if "{" in dep_ref or "}" in dep_ref:
                        if point is None:
                            raise ValueError(
                                f"Global task {spec['ref']!r} cannot depend on expanded task {dep_ref!r} "
                                "without an explicit dependency policy"
                            )
                        try:
                            dep_ref = dep_ref.format(**point)
                        except KeyError as exc:
                            missing = exc.args[0]
                            raise ValueError(
                                f"Dependency template {dep_ref!r} uses unknown template key {missing!r}"
                            ) from exc
                    rendered_deps.append(dep_ref)
                if rendered_deps:
                    spec["depends_on"] = rendered_deps
                if spec.get("config_mode") == "yaml_file":
                    spec["resolved_config"] = self._resolved_config_for_spec(spec)

                ref = spec["ref"]
                if ref in seen_refs:
                    raise ValueError(f"Duplicate rendered task ref: {ref!r}")
                seen_refs.add(ref)
                specs.append(spec)

        rendered_refs = {spec["ref"] for spec in specs}
        for spec in specs:
            for dep_ref in spec.get("depends_on", []):
                if dep_ref not in rendered_refs:
                    raise ValueError(f"Task {spec['ref']!r} depends on unknown rendered ref {dep_ref!r}")
        return specs

    def to_spec(self) -> dict[str, Any]:
        """Return a defensive snapshot of the SDK-authored experiment spec."""
        spec: dict[str, Any] = {
            "name": self.name,
            "description": self.description,
            "metadata": {
                "sdk_version": _sdk_version(),
                "git_commit": _git_commit(),
                "cwd": os.getcwd(),
            },
            "tasks": self._task_specs(),
        }
        if self.code_id is not None:
            spec["code_id"] = self.code_id
        if self.family is not None:
            spec["family"] = self.family
        if self.hypothesis is not None:
            spec["hypothesis"] = self.hypothesis
        if self.expected_outcome is not None:
            spec["expected_outcome"] = self.expected_outcome
        if self._storage:
            spec["storage"] = copy.deepcopy(self._storage)
        if self._runtime is not None:
            spec["runtime"] = self._runtime.to_spec()
        if self._param_space:
            spec["param_space"] = copy.deepcopy(self._param_space)
            spec["param_points"] = copy.deepcopy(self._param_points())
        if self._decision_policy:
            spec["decision_policy"] = copy.deepcopy(self._decision_policy)
        if self.config:
            spec["config"] = copy.deepcopy(self.config)
        return spec

    def dry_run(self) -> dict[str, Any]:
        """Validate locally and return the SDK-authored spec without network I/O."""
        self._validate_dag()
        spec = self.to_spec()
        self._validate_decision_policy(spec)
        spec["warnings"] = self._preflight_warnings(spec)
        return spec

    @staticmethod
    def _normalize_metric_schema(metrics: Optional[dict[str, str]]) -> dict[str, str]:
        if not metrics:
            return {}
        allowed = {"min", "max", "latest"}
        normalized: dict[str, str] = {}
        for name, direction in metrics.items():
            if not name or not isinstance(name, str):
                raise ValueError("metric name must be a non-empty string")
            if direction not in allowed:
                raise ValueError("metric direction must be one of: min, max, latest")
            normalized[name] = direction
        return copy.deepcopy(normalized)

    def task(
        self,
        ref: str,
        *,
        script: str,
        argv: Optional[list[str]] = None,
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
        target_stub_id: Optional[str] = None,
        max_retries: int = 0,
        priority: int = 5,
        outputs: Optional[list[str]] = None,
        config_mode: Optional[str] = None,
        config_overrides: Optional[dict[str, Any]] = None,
        metrics: Optional[dict[str, str]] = None,
    ) -> TaskNode:
        if ref in self._refs:
            raise ValueError(f"Duplicate task ref: {ref!r}")
        if config_mode is not None and config_mode != "yaml_file":
            raise ValueError("config_mode must be 'yaml_file' when set")
        metric_schema = self._normalize_metric_schema(metrics)
        self._refs.add(ref)

        spec: dict[str, Any] = {"ref": ref, "script": script}
        if argv:               spec["argv"] = argv
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
        if target_stub_id:     spec["target_stub_id"] = target_stub_id
        if max_retries:        spec["max_retries"] = max_retries
        if priority != 5:      spec["priority"] = priority
        if outputs:            spec["outputs"] = outputs
        if config_mode:        spec["config_mode"] = config_mode
        if config_overrides:   spec["config_overrides"] = config_overrides
        if metric_schema:      spec["metric_schema"] = metric_schema

        node = TaskNode(ref=ref, _spec=spec)
        self._tasks.append(node)
        return node

    def fork(self, name: str, *, description: str = "", reason: str = "") -> "Experiment":
        """Create a child experiment by deep-copying config and task structure."""
        child = Experiment(
            name,
            description=description,
            server=self._server,
            code_id=None,
            family=self.family,
            fork_reason=reason or None,
        )
        child.config = copy.deepcopy(self.config)
        child._runtime = copy.deepcopy(self._runtime)
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

        # Resolve per-task configs before submission. Use expanded task specs so SDK grids
        # submit the same canonical tasks shown by to_spec()/dry_run().
        specs = []
        for spec in self._task_specs():
            spec = copy.deepcopy(spec)
            if self.config:
                resolved = copy.deepcopy(self.config)
                for dotpath, value in spec.get("config_overrides", {}).items():
                    _set_nested(resolved, dotpath, value)
                spec["resolved_config"] = resolved
            specs.append(spec)
        submit_spec = self.to_spec()
        submit_spec["warnings"] = self._preflight_warnings({**submit_spec, "tasks": specs})
        self._validate_decision_policy({**submit_spec, "tasks": specs})

        result = submit_experiment(
            server=self._server,
            name=self.name,
            description=self.description,
            task_specs=specs,
            force=force,
            code_id=self.code_id,
            config=self.config if self.config else None,
            config_diff=self._compute_config_diff(),
            storage=copy.deepcopy(self._storage) if self._storage else None,
            sdk_spec=submit_spec,
            parent_name=self._parent_name,
            family=self.family,
            hypothesis=self.hypothesis,
            expected_outcome=self.expected_outcome,
            fork_reason=self.fork_reason,
        )

        # Backfill task_ids
        self._experiment_id = result.experiment_id
        for t in self._tasks:
            t.task_id = result.task_refs.get(t.ref)

        return result

    def _preflight_warnings(self, spec: Mapping[str, Any]) -> list[dict[str, Any]]:
        warnings: list[dict[str, Any]] = []
        has_storage_root = bool(spec.get("storage", {}).get("root"))

        if spec.get("param_space") and not has_storage_root:
            warnings.append(
                {
                    "code": "grid_without_storage_root",
                    "message": "Grid experiment has no explicit experiment storage root",
                }
            )

        if not has_storage_root:
            for task in spec.get("tasks", []):
                ref = task.get("ref", "<unknown>")
                for field in ("cwd", "run_dir", "output_dir"):
                    value = task.get(field)
                    if isinstance(value, str) and "/vol/bitbucket" in value:
                        warnings.append(
                            {
                                "code": "bitbucket_storage_without_root",
                                "message": f"Task {ref!r} references /vol/bitbucket without explicit experiment storage root",
                                "ref": ref,
                                "field": field,
                                "path": value,
                            }
                        )
                for path in task.get("outputs", []) or []:
                    if isinstance(path, str) and "/vol/bitbucket" in path:
                        warnings.append(
                            {
                                "code": "bitbucket_storage_without_root",
                                "message": f"Task {ref!r} references /vol/bitbucket without explicit experiment storage root",
                                "ref": ref,
                                "field": "outputs",
                                "path": path,
                            }
                        )
        warnings.extend(lint_task_specs(list(spec.get("tasks", []))))
        return warnings

    def status(self) -> "ExperimentStatus":
        if not self._experiment_id:
            raise RuntimeError("Experiment not yet submitted")
        from .submit import get_experiment_status
        return get_experiment_status(self._server, self._experiment_id)

    # ── Config resolution ──

    def _resolved_config_for_spec(self, spec: Mapping[str, Any]) -> dict[str, Any]:
        """Merge experiment config + task-level config_overrides for a task spec."""
        config = copy.deepcopy(self.config)
        overrides = spec.get("config_overrides", {})
        for dotpath, value in overrides.items():
            _set_nested(config, dotpath, value)
        return config

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

    def _validate_decision_policy(self, spec: Mapping[str, Any]) -> None:
        policy = spec.get("decision_policy")
        if not policy:
            return
        primary_metric = policy.get("primary_metric")
        declared_metrics = {
            metric
            for task in spec.get("tasks", [])
            for metric in (task.get("metric_schema") or {}).keys()
        }
        if primary_metric not in declared_metrics:
            raise ValueError(
                f"decision_policy primary_metric {primary_metric!r} is not declared in any task metric schema"
            )

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
