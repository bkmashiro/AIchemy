#!/usr/bin/env python3
"""Smoke test: SDK progress reporter.

Uses the alchemy SDK to report progress and metrics.
Requires ALCHEMY_TASK_ID and ALCHEMY_SERVER (or ALCHEMY_STUB_SOCKET) env vars,
set automatically by the stub when dispatching.
"""
import os
import sys
import time

# Add SDK to path if needed
sdk_dir = os.path.join(os.path.dirname(__file__), "..", "..", "sdk")
if os.path.isdir(sdk_dir):
    sys.path.insert(0, sdk_dir)

from alchemy_sdk import Alchemy

al = Alchemy()
total_steps = 10

print(f"[smoke/sdk_reporter] start — reporting {total_steps} steps", flush=True)

for step in range(total_steps):
    loss = 1.0 / (step + 1)
    al.log(step, total_steps, loss=loss, metrics={"reward": step * 0.1})
    print(f"[smoke/sdk_reporter] step {step}/{total_steps} loss={loss:.4f}", flush=True)

    if al.should_stop():
        print("[smoke/sdk_reporter] should_stop=True — exiting early", flush=True)
        al.done(metrics={"early_stop": True})
        sys.exit(0)

    time.sleep(1)

al.done(metrics={"final_loss": 1.0 / total_steps})
print("[smoke/sdk_reporter] done", flush=True)
