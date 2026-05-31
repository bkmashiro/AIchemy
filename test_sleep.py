"""Simple test script: sleep and print."""
import time
import os

print(f"Task started on {os.uname().nodename}")
print(f"PID: {os.getpid()}")
print(f"CWD: {os.getcwd()}")
print(f"ALCHEMY_TASK_ID: {os.environ.get('ALCHEMY_TASK_ID', 'N/A')}")

for i in range(5):
    print(f"Step {i+1}/5 ...")
    time.sleep(2)

print("Done!")
