import time
import sys

steps = int(sys.argv[1]) if len(sys.argv) > 1 else 10
for i in range(steps):
    print(f"Training: {i+1}/{steps} loss={1.0/(i+1):.4f}", flush=True)
    time.sleep(0.1)
print("Done!", flush=True)
