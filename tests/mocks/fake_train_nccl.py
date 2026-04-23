"""Fake training script that simulates NCCL error."""
import time
import sys

for i in range(3):
    print(f"Step {i}: syncing gradients...", flush=True)
    time.sleep(0.1)

print("RuntimeError: NCCL error in: /pytorch/torch/lib/c10d/ProcessGroupNCCL.cpp:123, unhandled system error", flush=True)
sys.exit(1)
