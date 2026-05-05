"""Structured JSONL report writer + summary table printer."""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class TestResult:
    scenario: str
    passed: bool
    task_id: str | None = None
    expected_status: str = ""
    actual_status: str = ""
    expected_exit_code: int | None = None
    actual_exit_code: int | None = None
    duration_s: float = 0.0
    error: str | None = None
    log_snippet: str = ""


class ReportWriter:
    """Writes JSONL results and prints a summary table."""

    def __init__(self, output_dir: str | None = None):
        self.output_dir = output_dir or os.environ.get(
            "ALCHEMY_TEST_REPORT_DIR", "/tmp/alchemy_test_results"
        )
        os.makedirs(self.output_dir, exist_ok=True)
        self.jsonl_path = os.path.join(self.output_dir, "results.jsonl")
        self.results: list[TestResult] = []

    def record(self, result: TestResult) -> None:
        self.results.append(result)
        with open(self.jsonl_path, "a") as f:
            entry = {
                "ts": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
                "level": "info" if result.passed else "error",
                "component": "assertion",
                "event": "assertion.pass" if result.passed else "assertion.fail",
                "task_id": result.task_id,
                "detail": asdict(result),
            }
            f.write(json.dumps(entry) + "\n")

    def finalize(self) -> int:
        """Print summary table and return 0 if all passed, 1 otherwise."""
        passed = sum(1 for r in self.results if r.passed)
        total = len(self.results)

        # Header
        header = f"{'Scenario':<40} {'Status':<8} {'Exit Code':<16} {'Time':<8}"
        sep = "-" * len(header)
        lines = [sep, header, sep]

        for r in self.results:
            status = "PASS" if r.passed else "FAIL"
            ec = ""
            if r.actual_exit_code is not None:
                if r.expected_exit_code is not None:
                    ec = f"{r.actual_exit_code} (exp: {r.expected_exit_code})"
                else:
                    ec = str(r.actual_exit_code)
            elif r.expected_exit_code is not None:
                ec = f"? (exp: {r.expected_exit_code})"
            time_str = f"{r.duration_s:.1f}s"
            lines.append(f"{r.scenario:<40} {status:<8} {ec:<16} {time_str:<8}")

        lines.append(sep)
        lines.append(f"TOTAL: {passed}/{total} passed")
        lines.append(sep)

        summary = "\n".join(lines)
        print(summary)

        # Write to file
        summary_path = os.path.join(self.output_dir, "summary.txt")
        with open(summary_path, "w") as f:
            f.write(summary + "\n")

        return 0 if passed == total else 1
