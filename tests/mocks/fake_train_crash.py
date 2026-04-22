import time
import sys

for i in range(5):
    print(f"Step {i}", flush=True)
    time.sleep(0.1)
raise RuntimeError("CUDA OOM (fake)")
