"""Discover available Python environments (conda/mamba/venv)."""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

# Hardcoded mamba root — NFS-shared across cluster
MAMBA_ROOT = Path("/vol/bitbucket/ys25/mamba")


def _micromamba_activate(env_path: str) -> str:
    """Build activation command for micromamba env."""
    mm = MAMBA_ROOT / "bin" / "micromamba"
    return f'eval "$({mm} shell hook -s bash)" && micromamba activate {env_path}'


def discover_python_envs() -> list[dict]:
    """Return list of {name, type, path, activate} for available Python envs."""
    envs: list[dict] = []
    seen_paths: set[str] = set()

    # 1. conda / mamba envs via CLI
    for tool in ("mamba", "conda"):
        tool_path = shutil.which(tool)
        if not tool_path:
            continue
        try:
            result = subprocess.run(
                [tool, "env", "list", "--json"],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0:
                import json
                data = json.loads(result.stdout)
                for env_path in data.get("envs", []):
                    if env_path in seen_paths:
                        continue
                    seen_paths.add(env_path)
                    name = os.path.basename(env_path)
                    if env_path == data.get("envs", [""])[0]:
                        name = "base"
                    envs.append({
                        "name": name, "type": tool, "path": env_path,
                        "activate": _micromamba_activate(env_path),
                    })
                break
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue

    # 2. Scan conda env directories directly (NFS-shared)
    conda_env_dirs = [
        Path("/vol/bitbucket/ys25/conda-envs"),
        MAMBA_ROOT / "envs",
    ]
    for env_dir in conda_env_dirs:
        if not env_dir.is_dir():
            continue
        for sub in sorted(env_dir.iterdir()):
            if sub.is_dir() and (sub / "bin" / "python").exists():
                p = str(sub)
                if p not in seen_paths:
                    seen_paths.add(p)
                    envs.append({
                        "name": sub.name, "type": "conda", "path": p,
                        "activate": _micromamba_activate(p),
                    })

    # 3. Mamba base env
    if (MAMBA_ROOT / "bin" / "python").exists():
        p = str(MAMBA_ROOT)
        if p not in seen_paths:
            seen_paths.add(p)
            envs.append({
                "name": "base", "type": "mamba", "path": p,
                "activate": _micromamba_activate(p),
            })

    # 4. Common venv locations
    home = Path.home()
    venv_search = [
        home / "venv",
        home / ".venv",
        home / "envs",
        home / ".envs",
        home / "alchemy-v2" / "venv",
    ]
    for venv_dir in venv_search:
        if not venv_dir.exists():
            continue
        if (venv_dir / "bin" / "activate").exists():
            p = str(venv_dir)
            if p not in seen_paths:
                seen_paths.add(p)
                envs.append({
                    "name": venv_dir.name, "type": "venv", "path": p,
                    "activate": f"source {p}/bin/activate",
                })
        elif venv_dir.is_dir():
            for sub in sorted(venv_dir.iterdir()):
                if sub.is_dir() and (sub / "bin" / "activate").exists():
                    p = str(sub)
                    if p not in seen_paths:
                        seen_paths.add(p)
                        envs.append({
                            "name": sub.name, "type": "venv", "path": p,
                            "activate": f"source {p}/bin/activate",
                        })

    return envs
