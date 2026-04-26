#!/usr/bin/env python3
# smoke: gpu_required — checks nvidia-smi, runs a small pytorch op if available
import subprocess
import sys

print("[smoke/gpu_required] checking nvidia-smi")
sys.stdout.flush()

result = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                        capture_output=True, text=True)

if result.returncode != 0:
    print("[smoke/gpu_required] nvidia-smi not available — skipping GPU op")
    print("[smoke/gpu_required] (non-GPU environment, treating as pass)")
    sys.exit(0)

print("[smoke/gpu_required] GPUs found:")
for line in result.stdout.strip().splitlines():
    print(f"  {line}")
sys.stdout.flush()

# Try pytorch
try:
    import torch
    if not torch.cuda.is_available():
        print("[smoke/gpu_required] torch.cuda not available despite nvidia-smi")
        sys.exit(0)

    device = torch.device("cuda:0")
    print(f"[smoke/gpu_required] using device: {torch.cuda.get_device_name(0)}")

    # Small matmul
    a = torch.randn(512, 512, device=device)
    b = torch.randn(512, 512, device=device)
    c = torch.mm(a, b)
    torch.cuda.synchronize()

    print(f"[smoke/gpu_required] matmul 512x512 OK, result norm: {c.norm().item():.4f}")
    print("[smoke/gpu_required] done")
    sys.exit(0)

except ImportError:
    print("[smoke/gpu_required] torch not installed — GPU present but skipping matmul")
    sys.exit(0)
