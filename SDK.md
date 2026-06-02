# Alchemy SDK

Python SDK for training scripts running under Alchemy v2.

## Installation

```bash
pip install -e sdk/
```

## Quick Start

```python
import alchemy_sdk as al_module
al = al_module.Alchemy()

for step in range(total_steps):
    loss = train_step()
    al.log(step, total_steps, loss=loss)
    if al.should_stop():
        al.checkpoint("/path/to/ckpt")
        break

al.done()
```

## API Reference

### `al.log(step, total, loss=None, metrics=None)`

Report training progress. Throttled to at most one call per 10 seconds.

```python
al.log(step, total_steps, loss=0.423, metrics={"acc": 0.91, "lr": 1e-4})
```

### `al.log_eval(metrics)`

Report evaluation results immediately (not throttled).

```python
al.log_eval({"val_loss": 0.38, "val_acc": 0.93})
```

### `al.checkpoint(path)`

Declare that a checkpoint has been saved. Does **not** save — caller saves first.

```python
torch.save(state, path)
al.checkpoint(path)
```

### `al.notify(msg, level="info")`

Send a tiered notification.

| Level      | Destination                              |
|------------|------------------------------------------|
| `debug`    | log buffer only                          |
| `info`     | log buffer + web frontend                |
| `warning`  | + Discord (yellow)                       |
| `critical` | + Discord (red + @mention)               |

```python
al.notify("OOM risk detected, reducing batch size", level="warning")
al.notify("NaN loss — aborting", level="critical")
```

### `al.should_stop()`

Returns `True` if SIGTERM was received (SLURM preemption, server kill, manual signal).
Check this in your training loop and save a checkpoint before exiting.

```python
if al.should_stop():
    al.checkpoint(ckpt_path)
    break
```

### `al.done()`

Signal training is complete. Call once at the end of training.

```python
al.done()
```

Also works as a context manager — `done()` is called automatically on exit:

```python
with Alchemy() as al:
    for step in range(total):
        ...
```

## Environment Variables

| Variable            | Description                                      |
|---------------------|--------------------------------------------------|
| `ALCHEMY_TASK_ID`   | Task UUID assigned by stub (enables managed mode)|
| `ALCHEMY_STUB_SOCKET` | Path to Unix socket (preferred transport)      |
| `ALCHEMY_SERVER`    | HTTP server base URL (fallback)                  |
| `ALCHEMY_PARAMS`    | JSON-encoded hyperparameter dict                 |
| `ALCHEMY_RUN_DIR`   | Working directory for this run                   |

When `ALCHEMY_TASK_ID` is absent, all methods are no-ops — safe for local runs.

## Params

```python
lr = al.param("lr")           # crashes if missing (managed mode)
lr = al.param("lr", 1e-3)     # default allowed in standalone mode
params = al.params()           # full dict
```

## Read-only Experiment Lineage

The SDK also ships a thin, **read-only** HTTP client for inspecting
experiment lineage from notebooks and scripts. It hits the same `/api/...`
endpoints as the web dashboard and the `alch` CLI, and it never mutates
scheduler / runtime / stub state — no decisions, no notes, no submissions.

```python
from alchemy_sdk import ExperimentClient

# Auth is resolved in this order:
#   1. token=... constructor arg (explicit wins)
#   2. ALCHEMY_TOKEN env var
# Server URL: server=... → ALCHEMY_SERVER → ALCHEMY_SERVER_URL → http://localhost:3002
ec = ExperimentClient(server="https://alchemy.example.com", token="...")

ec.list()                          # GET /api/experiments → list[dict]
ec.tree()                          # GET /api/experiments/tree → forest
ec.resolve("my-experiment")        # name-or-id → single experiment dict
ec.summary("my-experiment")        # GET /api/experiments/<id>/summary
ec.diff("my-experiment")           # GET /api/experiments/<id>/diff
ec.manifest("my-experiment")       # GET /api/experiments/<id>/manifest
ec.compare(["alpha", "beta-2"])    # GET /api/experiments/compare?ids=...
```

Notes:

- All methods return raw decoded JSON (`dict` / `list`) — no dataclass wrapping.
- `list()` raises if the server returns a non-list body (typically an error
  envelope from an auth or middleware failure) instead of silently degrading.
- `resolve()` and `compare()` accept either UUIDs or experiment names. Names
  must be unambiguous; duplicates raise `RuntimeError`.
- HTTP errors raise `RuntimeError` with the status code and response body
  included so you can see exactly what the server said.
- The companion CLI (`alch experiments tree|summary|diff|manifest|compare`)
  uses the same endpoints and is also read-only by design.

### Operator CLI: read-only experiment commands

```bash
alch experiments ls                        # list all experiments
alch experiments show <name-or-id>         # full detail dict
alch experiments tree                      # whole forest as JSON
alch experiments summary <name-or-id>      # rollups, best metrics
alch experiments diff <name-or-id>         # parameter / config diff vs parent
alch experiments manifest <name-or-id>     # reproducibility manifest
alch experiments compare <ref> <ref> ...   # multi-experiment compare
alch experiments timeline <name-or-id>     # event timeline
```

These are safe to run during live training: they only issue `GET` requests
against the Alchemy server. The mutating siblings (`note`, `decide`) require
explicit arguments and are intentionally separate.
