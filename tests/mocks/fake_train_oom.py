"""Fake training script that simulates CUDA OOM."""
import time
import sys

for i in range(3):
    print(f"Step {i}: allocating tensors...", flush=True)
    time.sleep(0.1)

print("Traceback (most recent call last):", flush=True)
print('  File "train.py", line 42, in <module>', flush=True)
print("    model = model.cuda()", flush=True)
print("torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB", flush=True)
sys.exit(1)
