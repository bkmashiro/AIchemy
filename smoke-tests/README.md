# Alchemy v2 Smoke Tests

End-to-end task simulation suite. Exercises the full scheduler pipeline without real training jobs.

## Quick start

```bash
# Submit all smoke tasks
cd /workspace/extra/projects/alchemy-v2/smoke-tests
./run_smoke.sh

# Submit a subset by name filter
./run_smoke.sh fast
./run_smoke.sh fail
```

Environment overrides:

```bash
ALCHEMY_SERVER=http://my-server:3002 ALCHEMY_TOKEN=my-token ./run_smoke.sh
```

## Task inventory

| Name | Script | Tags | Expected outcome |
|---|---|---|---|
| `smoke_success_fast` | `success_fast.sh` | smoke, fast | exits 0 in ~3s |
| `smoke_success_slow` | `success_slow.sh` | smoke, slow | exits 0 in ~30s |
| `smoke_fail_exit1` | `fail_exit1.sh` | smoke, fail | exits 1 after 2s |
| `smoke_fail_oom` | `fail_oom.py` | smoke, fail, oom | killed by OOM |
| `smoke_writes_disk` | `writes_disk.sh` | smoke, io | writes 50MB, cleans up |
| `smoke_checkpoint_resume` | `checkpoint_resume.sh` | smoke, resume | writes checkpoint; re-run resumes |
| `smoke_gpu_required` | `gpu_required.py` | smoke, gpu | checks nvidia-smi, runs matmul |
| `smoke_long_running` | `long_running.sh` | smoke, long | runs 5min, periodic stdout |
| `smoke_signal_handler` | `signal_handler.sh` | smoke, signal | SIGTERM → graceful exit |
| `smoke_multi_tag` | `multi_tag.sh` | smoke, a40, high-mem, priority | tag routing test |

## checkpoint_resume notes

The checkpoint file is stored in `$SMOKE_CKPT_DIR` (default `/tmp/smoke_checkpoint`).
Submit the task twice to test the resume path, or clear the dir to reset.

## gpu_required notes

Gracefully skips the pytorch matmul if `nvidia-smi` is absent or torch is not installed.
Always exits 0 in non-GPU environments — it's a capability probe, not a hard requirement.

## Dependencies

- `curl`, `jq` — required for `run_smoke.sh`
- `python3` stdlib — `fail_oom.py`, `gpu_required.py` (torch optional)
- `dd`, `mktemp` — standard coreutils, present on all Linux nodes
