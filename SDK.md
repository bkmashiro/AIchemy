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
