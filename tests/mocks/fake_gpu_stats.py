"""Mock nvidia-smi output for testing."""
import sys
import random

# Format: index, name, utilization.gpu, memory.used, memory.total, temperature.gpu
if "--query-gpu" in sys.argv and "--format=csv,noheader,nounits" in sys.argv:
    util = random.randint(40, 95)
    mem_used = random.randint(5000, 20000)
    print(f"0, NVIDIA A40, {util}, {mem_used}, 40960, {random.randint(50, 80)}")
elif "--query-gpu=count" in sys.argv:
    print("1")
else:
    print("GPU 0: NVIDIA A40")
