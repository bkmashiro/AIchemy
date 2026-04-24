"""Structured JSON logging to stderr for alchemy-stub.

All stub logs are JSON lines on stderr; stdout is reserved for subprocess output.

Format:
  {"ts": "ISO8601", "level": "info", "event": "...", ...extra_fields}

Usage:
  from .log_setup import setup_logging, jlog
  setup_logging()
  jlog("info", "stub.start", identity="gpu22-2080ti", server="wss://...")
"""
from __future__ import annotations

import json
import logging
import sys
import time
from datetime import datetime, timezone
from typing import Any


class _JsonFormatter(logging.Formatter):
    """Emit each log record as a single JSON line to stderr."""

    def format(self, record: logging.LogRecord) -> str:
        ts = datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat()
        level = record.levelname.lower()
        obj: dict[str, Any] = {
            "ts": ts,
            "level": level,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            obj["exc"] = self.formatException(record.exc_info)
        # Attach any extra fields passed via the `extra` kwarg
        for key, val in record.__dict__.items():
            if key not in logging.LogRecord.__dict__ and not key.startswith("_"):
                obj[key] = val
        return json.dumps(obj, default=str)


def setup_logging(level: int = logging.INFO) -> None:
    """Configure root logger to emit JSON to stderr."""
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(_JsonFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)


def jlog(level: str, event: str, **fields: Any) -> None:
    """Emit a structured log line directly (bypasses Python logging hierarchy).

    Useful for key lifecycle events where structured fields matter.
    level: "debug" | "info" | "warn" | "error"
    """
    ts = datetime.now(timezone.utc).isoformat()
    obj: dict[str, Any] = {"ts": ts, "level": level, "event": event, **fields}
    print(json.dumps(obj, default=str), file=sys.stderr, flush=True)
