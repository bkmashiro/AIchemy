"""Fake training script that uses the Alchemy SDK."""
import sys
import os
import time

# Add sdk to path if needed
sdk_path = os.environ.get("ALCHEMY_SDK_PATH", "")
if sdk_path:
    sys.path.insert(0, sdk_path)

from alchemy_sdk import Alchemy

steps = int(sys.argv[1]) if len(sys.argv) > 1 else 20
server = os.environ.get("ALCHEMY_SERVER", "http://localhost:3001")

with Alchemy(server=server) as al:
    for i in range(steps):
        loss = 1.0 / (i + 1)
        print(f"Training: {i+1}/{steps} loss={loss:.4f}", flush=True)
        al.log(step=i + 1, total=steps, loss=loss)
        time.sleep(0.1)

print("Done!", flush=True)
