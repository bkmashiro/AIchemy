#!/usr/bin/env python3
# smoke: fail_oom — allocates memory until OOM-killed
import sys
import time

print("[smoke/fail_oom] start — allocating memory")
sys.stdout.flush()

chunks = []
chunk_mb = 256  # MB per allocation step
try:
    i = 0
    while True:
        i += 1
        chunk = bytearray(chunk_mb * 1024 * 1024)
        chunks.append(chunk)
        total_mb = i * chunk_mb
        print(f"[smoke/fail_oom] allocated {total_mb} MB total", flush=True)
        time.sleep(0.1)
except MemoryError:
    print("[smoke/fail_oom] MemoryError raised (not OOM-killed)", flush=True)
    sys.exit(1)
