"""Disk space monitoring."""
import os
import shutil


def get_disk_usage(paths: list[str] | None = None) -> dict:
    """Return disk usage for given paths.

    Returns: {"path": {"total_gb": float, "used_gb": float, "free_gb": float, "pct": float}}
    """
    if paths is None:
        paths = ["/tmp", os.environ.get("HOME", "/")]
    result = {}
    for p in paths:
        try:
            usage = shutil.disk_usage(p)
            result[p] = {
                "total_gb": round(usage.total / 1e9, 1),
                "used_gb": round(usage.used / 1e9, 1),
                "free_gb": round(usage.free / 1e9, 1),
                "pct": round(usage.used / usage.total * 100, 1),
            }
        except Exception:
            pass
    return result


def check_low_disk(paths: list[str] | None = None, threshold_gb: float = 5.0) -> list[dict]:
    """Return list of paths with < threshold_gb free.

    Each entry: {"path": str, "free_gb": float, "pct": float}
    """
    usage = get_disk_usage(paths)
    warnings = []
    for path, stats in usage.items():
        if stats["free_gb"] < threshold_gb:
            warnings.append({"path": path, "free_gb": stats["free_gb"], "pct": stats["pct"]})
    return warnings
