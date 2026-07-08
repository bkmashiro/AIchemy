"""Submission-time defensive checks for task specs.

These checks are intentionally conservative: they warn about common ways a task can
look runnable while still stealing queue time or failing only after a stub starts it.
"""
from __future__ import annotations

import re
import shlex
from collections import defaultdict
from typing import Any, Mapping

OUTPUT_FLAGS = {
    "--output",
    "--out",
    "--output-path",
    "--output_path",
    "--output-dir",
    "--output_dir",
    "--result",
    "--result-path",
    "--result_path",
    "--save",
    "--save-path",
    "--save_path",
    "--logdir",
    "--log-dir",
    "--log_dir",
}

_URI_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://")


def lint_task_specs(task_specs: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Return warning dictionaries for a batch of materialized task specs."""
    warnings: list[dict[str, Any]] = []
    output_refs: dict[str, list[str]] = defaultdict(list)

    for index, spec in enumerate(task_specs):
        ref = str(spec.get("ref") or spec.get("name") or f"task-{index + 1}")
        warnings.extend(_lint_single_task(spec, ref))
        for output in set(_extract_output_paths(spec)):
            if _is_collision_prone_relative_path(output):
                output_refs[output].append(ref)

    for output, refs in sorted(output_refs.items()):
        if len(refs) > 1:
            warnings.append(
                {
                    "code": "duplicate_relative_output",
                    "severity": "warning",
                    "message": (
                        f"Multiple tasks write the same relative output {output!r}; "
                        "make it unique per ref/seed or explicitly write under ALCHEMY_RUN_DIR"
                    ),
                    "path": output,
                    "refs": refs,
                }
            )
    return warnings


def _lint_single_task(spec: Mapping[str, Any], ref: str) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    script = str(spec.get("script") or "")
    has_runtime_env = bool(spec.get("python_env") or spec.get("env_setup"))
    env = _merged_env(spec)

    if (
        script.endswith(".py")
        and script.startswith("/vol/bitbucket/")
        and not has_runtime_env
        and not _env_has_pythonpath(env)
    ):
        warnings.append(
            {
                "code": "python_script_uses_default_python",
                "severity": "warning",
                "message": (
                    f"Task {ref!r} is a cluster .py script that will be launched with plain `python`; "
                    "cluster default Python often lacks project deps/torch. Prefer script=<absolute python> "
                    "and put the .py path in argv/raw_args, or set python_env/env_setup/PYTHONPATH."
                ),
                "ref": ref,
                "field": "script",
                "script": script,
            }
        )

    if _explicit_high_priority(spec) and not spec.get("target_stub_id") and not spec.get("target_tags"):
        warnings.append(
            {
                "code": "high_priority_unrouted",
                "severity": "warning",
                "message": (
                    f"Task {ref!r} sets high priority without target routing; priority sorts descending, "
                    "so this can jump older queue work. Lower priority or set target_stub_id/target_tags."
                ),
                "ref": ref,
                "field": "priority",
                "priority": spec.get("priority"),
            }
        )

    return warnings


def _explicit_high_priority(spec: Mapping[str, Any]) -> bool:
    if "priority" not in spec:
        return False
    try:
        return int(spec["priority"]) >= 5
    except (TypeError, ValueError):
        return False


def _merged_env(spec: Mapping[str, Any]) -> dict[str, Any]:
    env: dict[str, Any] = {}
    for field in ("env", "env_overrides"):
        value = spec.get(field)
        if isinstance(value, Mapping):
            env.update(value)
    return env


def _env_has_pythonpath(env: Mapping[str, Any]) -> bool:
    value = env.get("PYTHONPATH")
    return isinstance(value, str) and bool(value.strip())


def _extract_output_paths(spec: Mapping[str, Any]) -> list[str]:
    paths: list[str] = []
    outputs = spec.get("outputs")
    if isinstance(outputs, list):
        paths.extend(str(p) for p in outputs if isinstance(p, str) and p.strip())

    args = spec.get("args")
    if isinstance(args, Mapping):
        for key, value in args.items():
            if str(key) in OUTPUT_FLAGS and value is not None:
                paths.append(str(value))
    elif isinstance(args, str):
        paths.extend(_extract_flag_values(args))

    raw_args = spec.get("raw_args")
    if isinstance(raw_args, str):
        paths.extend(_extract_flag_values(raw_args))
    return paths


def _extract_flag_values(text: str) -> list[str]:
    try:
        tokens = shlex.split(text)
    except ValueError:
        tokens = text.split()
    out: list[str] = []
    for idx, token in enumerate(tokens):
        if token in OUTPUT_FLAGS and idx + 1 < len(tokens):
            out.append(tokens[idx + 1])
            continue
        for flag in OUTPUT_FLAGS:
            prefix = f"{flag}="
            if token.startswith(prefix) and len(token) > len(prefix):
                out.append(token[len(prefix):])
                break
    return out


def _is_collision_prone_relative_path(path: str) -> bool:
    if not path or path.startswith("/") or _URI_RE.match(path):
        return False
    if "$ALCHEMY_RUN_DIR" in path or "${ALCHEMY_RUN_DIR}" in path:
        return False
    if "{" in path or "}" in path:
        return False
    return True
