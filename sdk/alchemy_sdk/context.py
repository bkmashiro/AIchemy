"""TrainingContext — AOP training runtime."""
from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Iterator, Optional

if TYPE_CHECKING:
    from .client import Alchemy


class TrainingContext:
    """
    Framework-managed training context.  Injected into @al.managed() functions.

    Gives training code:
      - params: dict from ALCHEMY_PARAMS (immutable, defensive copy)
      - run_dir: from ALCHEMY_RUN_DIR env var (server is single source of truth)
      - checkpoint_dir: run_dir / "checkpoints"
      - is_resume: True if an existing checkpoint was found
      - Path helpers: sub_dir(), artifact_dir()
      - Checkpoint lifecycle: latest_checkpoint(), save_checkpoint()
      - Training loop: steps()
      - Signal proxies: should_eval(), should_checkpoint(), should_stop()
      - Reports: log(), log_eval()
    """

    def __init__(
        self,
        al: "Alchemy",
        total_steps: int = 0,
        eval_every: int = 0,
        checkpoint_every: int = 0,
    ) -> None:
        self._al = al
        self._total_steps = total_steps
        self._eval_every = eval_every
        self._checkpoint_every = checkpoint_every
        self._current_step: int = 0
        self._hooks: dict[str, list[Callable[["TrainingContext", int], None]]] = {
            "on_step_start": [],
            "on_step_end": [],
            "on_eval": [],
            "on_checkpoint": [],
        }

        # --- Immutable params (defensive copy) ---
        self._params: dict[str, Any] = al.params()

        # --- run_dir: always from ALCHEMY_RUN_DIR (server-authoritative) ---
        self._run_dir = self._resolve_run_dir()
        self._checkpoint_dir = self._run_dir / "checkpoints"

        # is_resume is set by preflight after scanning checkpoint_dir
        self.is_resume: bool = False

    # ------------------------------------------------------------------
    # Pure reads
    # ------------------------------------------------------------------

    @property
    def params(self) -> dict[str, Any]:
        """Immutable parameter dict from ALCHEMY_PARAMS. Returns defensive copy."""
        return dict(self._params)

    @property
    def run_dir(self) -> Path:
        return self._run_dir

    @property
    def checkpoint_dir(self) -> Path:
        return self._checkpoint_dir

    # ------------------------------------------------------------------
    # run_dir resolution
    # ------------------------------------------------------------------

    def _resolve_run_dir(self) -> Path:
        """
        Server is the single source of truth for run_dir.
        SDK reads ALCHEMY_RUN_DIR env var — set by stub at task launch.

        Under alchemy (managed): ALCHEMY_RUN_DIR must exist. Missing = crash.
        Standalone (noop): fallback to cwd/runs/{fingerprint[:12]}.
        """
        env_run_dir = os.environ.get("ALCHEMY_RUN_DIR")
        if env_run_dir:
            return Path(env_run_dir)

        if self._al._managed:
            raise RuntimeError(
                "ALCHEMY_RUN_DIR not set. Under alchemy management, "
                "run_dir must be provided by the server via stub. "
                "This is a bug in stub/server — not a user error."
            )

        # No-op mode: compute a local fallback deterministically
        fingerprint = self._compute_fingerprint()
        return Path.cwd() / "runs" / fingerprint[:12]

    def _compute_fingerprint(self) -> str:
        """
        Compute a fingerprint from ALCHEMY_PARAMS for no-op fallback naming.
        Falls back to a fixed tag if params are empty.
        """
        import hashlib
        import json as _json

        params_raw = os.environ.get("ALCHEMY_PARAMS", "{}")
        try:
            params_dict = _json.loads(params_raw)
        except Exception:
            params_dict = {}

        stable = _json.dumps(params_dict, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(stable.encode()).hexdigest()
        return digest

    # ------------------------------------------------------------------
    # Path allocation helpers (SPEC: sub_dir, artifact_dir)
    # ------------------------------------------------------------------

    def sub_dir(self, name: str) -> Path:
        """
        Return run_dir / name.  Auto-creates directory with umask 002.
        Idempotent.
        """
        path = self._run_dir / name
        _makedirs_002(path)
        return path

    def artifact_dir(self, name: str) -> Path:
        """Return run_dir / artifacts / name.  Auto-creates directory."""
        path = self._run_dir / "artifacts" / name
        _makedirs_002(path)
        return path

    # ------------------------------------------------------------------
    # Checkpoint lifecycle
    # ------------------------------------------------------------------

    def latest_checkpoint(self) -> Optional[Path]:
        """
        Scan checkpoint_dir for .pt files. Return the latest by mtime, or None.
        """
        if not self._checkpoint_dir.exists():
            return None
        pts: list[tuple[float, Path]] = []
        for p in self._checkpoint_dir.glob("*.pt"):
            try:
                pts.append((p.stat().st_mtime, p))
            except OSError:
                continue
        pts.sort(key=lambda item: item[0])
        return pts[-1][1] if pts else None

    def save_checkpoint(self, state_dict: Any, name: str = "latest") -> Path:
        """
        torch.save(state_dict, checkpoint_dir/name.pt) atomically, then notify stub.

        Requires torch to be installed.  If not, raises ImportError.
        Same name = overwrite (atomic via tmp + rename).
        """
        try:
            import torch  # type: ignore
        except ImportError as exc:
            raise ImportError(
                "torch is required for TrainingContext.save_checkpoint(). "
                "Install PyTorch or use al.checkpoint(path) for manual saves."
            ) from exc

        _makedirs_002(self._checkpoint_dir)
        path = self._checkpoint_dir / f"{name}.pt"

        # Write atomically via tmp file + rename
        tmp = path.with_suffix(".tmp")
        try:
            torch.save(state_dict, tmp)
            tmp.replace(path)
        except Exception:
            try:
                tmp.unlink(missing_ok=True)
            finally:
                pass
            raise

        # Notify stub
        self._al.checkpoint(str(path))
        return path

    # ------------------------------------------------------------------
    # Training loop iterator
    # ------------------------------------------------------------------

    def on(self, event: str, fn: Callable[["TrainingContext", int], None]) -> "TrainingContext":
        """Register a lifecycle hook. Returns self for chaining."""
        if event not in self._hooks:
            raise ValueError(f"Unknown hook event: {event}")
        self._hooks[event].append(fn)
        return self

    def _fire(self, event: str, step: int) -> None:
        for fn in list(self._hooks.get(event, [])):
            fn(self, step)

    def steps(self, start: int = 0) -> Iterator[int]:
        """
        Yield step indices [start, total_steps).
        Automatically calls al.log() at each step (throttled internally).
        Breaks on should_stop().
        """
        self._current_step = start
        total = self._total_steps or 0

        while True:
            step = self._current_step
            if total and step >= total:
                break
            if self._al.should_stop():
                break

            self._fire("on_step_start", step)
            if self.should_eval():
                self._fire("on_eval", step)
            if self.should_checkpoint():
                self._fire("on_checkpoint", step)

            yield step

            self._fire("on_step_end", step)

            # Auto-report progress after each step
            self._al.log(step=self._current_step, total=total)

            self._current_step += 1

    # ------------------------------------------------------------------
    # Signal proxies
    # ------------------------------------------------------------------

    def should_eval(self) -> bool:
        """True if step % eval_every == 0 or server requested eval."""
        step_trigger = (
            self._eval_every > 0
            and self._current_step > 0
            and self._current_step % self._eval_every == 0
        )
        return bool(step_trigger or (self._al.should_eval() is True))

    def should_checkpoint(self) -> bool:
        """True if step % checkpoint_every == 0 or server requested checkpoint."""
        step_trigger = (
            self._checkpoint_every > 0
            and self._current_step > 0
            and self._current_step % self._checkpoint_every == 0
        )
        return bool(step_trigger or (self._al.should_checkpoint() is True))

    def should_stop(self) -> bool:
        """True if server/stub requested graceful stop."""
        return self._al.should_stop()

    # ------------------------------------------------------------------
    # Report helpers
    # ------------------------------------------------------------------

    def log(self, **metrics: Any) -> None:
        """
        Report arbitrary metrics.  Maps to al.log() with current step.
        loss= kwarg forwarded as the loss field.
        """
        loss = metrics.pop("loss", None)
        self._al.log(
            step=self._current_step,
            total=self._total_steps or 0,
            loss=loss,
            metrics=metrics if metrics else None,
        )

    def log_eval(self, metrics: dict[str, Any]) -> None:
        """Report evaluation metrics."""
        self._al.log_eval(metrics)

    def write_result(
        self,
        result: dict[str, Any],
        path: str | Path = "results.json",
        *,
        schema: Optional[dict[str, type | str]] = None,
    ) -> Path:
        """Write a typed result artifact as JSON under run_dir, atomically."""
        if schema:
            self._validate_result_schema(result, schema)
        output_path = self._resolve_result_path(path)
        _makedirs_002(output_path.parent)

        tmp_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=output_path.parent,
                prefix=f".{output_path.name}.",
                suffix=".tmp",
                delete=False,
            ) as f:
                tmp_name = f.name
                json.dump(result, f, sort_keys=True)
                f.write("\n")
                f.flush()
                os.fsync(f.fileno())
            Path(tmp_name).replace(output_path)
        except Exception:
            if tmp_name is not None:
                try:
                    Path(tmp_name).unlink(missing_ok=True)
                except Exception:
                    pass
            raise
        return output_path

    def _resolve_result_path(self, path: str | Path) -> Path:
        candidate = Path(path)
        if not candidate.is_absolute():
            candidate = self._run_dir / candidate

        run_dir = self._run_dir.resolve(strict=False)
        resolved = candidate.resolve(strict=False)
        if not resolved.is_relative_to(run_dir):
            raise ValueError("result path must stay under run_dir")
        return candidate

    def _validate_result_schema(self, result: dict[str, Any], schema: dict[str, type | str]) -> None:
        for dotpath, expected in schema.items():
            value = self._get_result_dotpath(result, dotpath)
            expected_type = _schema_type(expected)
            if expected_type in (int, float) and isinstance(value, bool):
                raise TypeError(f"Result key {dotpath} expected {expected_type.__name__}, got bool")
            if expected_type is float:
                if not isinstance(value, (int, float)):
                    raise TypeError(f"Result key {dotpath} expected float, got {type(value).__name__}")
                continue
            if not isinstance(value, expected_type):
                raise TypeError(
                    f"Result key {dotpath} expected {expected_type.__name__}, got {type(value).__name__}"
                )

    @staticmethod
    def _get_result_dotpath(result: dict[str, Any], dotpath: str) -> Any:
        current: Any = result
        for part in dotpath.split("."):
            if not isinstance(current, dict) or part not in current:
                raise ValueError(f"Missing result key: {dotpath}")
            current = current[part]
        return current


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_UMASK_LOCK = threading.Lock()

_SCHEMA_TYPES: dict[str, type] = {
    "bool": bool,
    "dict": dict,
    "float": float,
    "int": int,
    "list": list,
    "str": str,
}


def _schema_type(expected: type | str) -> type:
    if isinstance(expected, type):
        return expected
    try:
        return _SCHEMA_TYPES[expected]
    except KeyError as exc:
        raise ValueError(f"Unknown result schema type: {expected!r}") from exc


def _makedirs_002(path: Path) -> None:
    """Create directories with umask 002 (group-writable)."""
    with _UMASK_LOCK:
        old_umask = os.umask(0o002)
        try:
            path.mkdir(parents=True, exist_ok=True)
        finally:
            os.umask(old_umask)
