"""OOM and failure reason classification."""
import re


class FailureReason:
    OOM = "oom"
    CUDA_ERROR = "cuda_error"
    PYTHON_ERROR = "python_error"
    TIMEOUT = "timeout"
    SIGTERM = "sigterm"
    SIGKILL = "sigkill"
    UNKNOWN = "unknown"


def classify_failure(exit_code: int, last_lines: list[str]) -> dict:
    """Classify task failure from exit code and last N log lines.

    Returns: {"reason": str, "detail": str}
    """
    # Check exit code first
    if exit_code in (-9, 137):  # SIGKILL / OOM killer
        return {"reason": FailureReason.OOM, "detail": "Killed by OOM killer (exit 137)"}
    if exit_code in (-15, 143):  # SIGTERM
        return {"reason": FailureReason.SIGTERM, "detail": "Terminated by SIGTERM"}

    # Scan last lines for patterns
    text = "\n".join(last_lines[-50:])

    if re.search(r"CUDA out of memory|OutOfMemoryError|torch\.cuda\.OutOfMemoryError", text):
        return {"reason": FailureReason.OOM, "detail": "CUDA out of memory"}

    if re.search(r"CUDA error|NCCL error|cudaErrorNoDevice", text):
        detail_match = re.search(
            r"(CUDA error.*|NCCL error.*|RuntimeError:.*cuda.*)", text, re.IGNORECASE
        )
        detail = detail_match.group(1)[:200] if detail_match else "CUDA error"
        return {"reason": FailureReason.CUDA_ERROR, "detail": detail}

    if re.search(r"Traceback \(most recent call last\)", text):
        lines = text.strip().split("\n")
        last_exc = lines[-1] if lines else "Unknown Python error"
        return {"reason": FailureReason.PYTHON_ERROR, "detail": last_exc[:200]}

    return {"reason": FailureReason.UNKNOWN, "detail": f"Exit code {exit_code}"}
