import time
import signal
import sys

signal.signal(signal.SIGTERM, lambda s, f: (print("Got SIGTERM, exiting", flush=True), sys.exit(0)))

duration = int(sys.argv[1]) if len(sys.argv) > 1 else 60
start = time.time()
while time.time() - start < duration:
    elapsed = time.time() - start
    print(f"Running... {elapsed:.0f}s/{duration}s", flush=True)
    time.sleep(1)
print("Completed", flush=True)
