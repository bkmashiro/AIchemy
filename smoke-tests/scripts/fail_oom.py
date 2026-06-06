#!/usr/bin/env python3
# smoke: fail_oom — deterministic OOM-style failure without exhausting CI memory.
import sys

print("[smoke/fail_oom] simulated OOM failure", flush=True)
sys.exit(137)
