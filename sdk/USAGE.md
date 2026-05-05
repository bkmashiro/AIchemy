# Alchemy SDK v2.1 — Usage Guide

Python SDK for integrating training scripts with the Alchemy task management system.

---

## Table of Contents

1. [Installation](#installation)
2. [Quick Start](#quick-start)
3. [Basic Usage](#basic-usage)
4. [Parameters](#parameters)
5. [Lifecycle & Phases](#lifecycle--phases)
6. [Notifications](#notifications)
7. [Managed Mode](#managed-mode)
8. [ManagedTraining Base Class](#managedtraining-base-class)
9. [Framework Callbacks](#framework-callbacks)
10. [Environment Variables](#environment-variables)
11. [Local Development (Noop Mode)](#local-development-noop-mode)
12. [Complete Examples](#complete-examples)

---

## Installation

```bash
# Basic install (no extra dependencies)
pip install -e /path/to/alchemy-v2/sdk

# With HTTP transport support
pip install -e /path/to/alchemy-v2/sdk[http]

# With torch checkpoint support (for managed mode save_checkpoint)
pip install -e /path/to/alchemy-v2/sdk[torch]

# Everything
pip install -e /path/to/alchemy-v2/sdk[all]
```

The SDK has **zero hard dependencies**. `requests` and `torch` are imported lazily and only needed for specific features.

---

## Quick Start

```python
from alchemy_sdk import Alchemy

al = Alchemy()
lr = al.param("lr", default=3e-4)

for step in range(10000):
    loss = train_step(lr)
    al.log(step, total=10000, loss=loss)
    if al.should_stop():
        break

al.done()
```

That's it. When run locally without Alchemy, everything works silently (noop mode). When launched by an Alchemy stub, progress and metrics are reported automatically.

---

## Basic Usage

### Creating the client

```python
from alchemy_sdk import Alchemy

al = Alchemy()
```

The client auto-configures from environment variables. No arguments needed.

### Logging progress

```python
al.log(step=100, total=10000, loss=0.42)
al.log(step=100, total=10000, loss=0.42, metrics={"accuracy": 0.85, "lr": 1e-4})
```

`log()` is **throttled to once per 10 seconds**. Call it every step without worry — excess calls are silently dropped.

### Reporting evaluation metrics

```python
al.log_eval({"val_loss": 0.38, "val_accuracy": 0.87})
```

`log_eval()` is **not throttled** — it sends immediately. It also auto-exports each metric as `eval_{key}` for downstream DAG tasks.

### Reporting config

```python
al.log_config({"model": "resnet50", "batch_size": 256, "lr": 3e-4})
```

### Declaring checkpoints

```python
torch.save(model.state_dict(), "/path/to/checkpoint.pt")
al.checkpoint("/path/to/checkpoint.pt")
```

`checkpoint()` does **not** save the file — it tells Alchemy where you saved it. You handle the actual save.

### Exporting values for DAG tasks

```python
al.export("best_val_loss", 0.38)
al.export("output_model_path", "/data/runs/run_42/best_model.pt")
```

Downstream tasks in an Alchemy DAG pipeline can consume these exported key-value pairs.

### Signaling completion

```python
al.done()
al.done(metrics={"final_loss": 0.12, "total_epochs": 50})
```

### Context manager

```python
with Alchemy() as al:
    for step in range(total):
        loss = train_step()
        al.log(step, total, loss=loss)
    # al.done() called automatically on clean exit
    # crash → sends critical notification automatically
```

---

## Parameters

Alchemy injects hyperparameters via the `ALCHEMY_PARAMS` environment variable (JSON string). The SDK provides two accessors:

### `al.params()` — get all parameters

```python
p = al.params()  # returns dict
lr = p["lr"]
hidden = p["hidden_dim"]
```

### `al.param(key, default=...)` — get a single parameter

```python
lr = al.param("lr", default=3e-4)
hidden = al.param("hidden_dim", default=256)
```

**Strict mode (managed):** When running under Alchemy (`ALCHEMY_TASK_ID` is set), `default` is **forbidden**. A missing parameter raises `KeyError` immediately. This prevents silent typos like `al.param("seeed", default=42)` from producing wrong experiments.

**Standalone mode:** Defaults work normally for local development convenience.

---

## Lifecycle & Phases

### `al.set_phase(phase)`

Tell Alchemy what your training script is doing right now. The server uses this for scheduling decisions — for example, it won't preempt during a checkpoint save.

Valid phases: `"warmup"`, `"training"`, `"eval"`, `"checkpoint"`, `"cooldown"`.

```python
al.set_phase("eval")
run_evaluation()
al.set_phase("training")
```

### `al.phase(phase)` — context manager

Cleaner syntax for temporary phase switches. Automatically restores the previous phase on exit:

```python
with al.phase("eval"):
    run_evaluation()

with al.phase("checkpoint"):
    save_model()
```

### `al.should_stop()`

Returns `True` if SIGTERM was received (SLURM preemption, manual kill, server-initiated stop). Check this in your training loop to exit gracefully:

```python
for step in range(total_steps):
    if al.should_stop():
        save_checkpoint()
        break
    train_step()
```

The SDK installs a SIGTERM handler automatically and chains with any existing handler.

---

## Notifications

```python
al.notify("Starting evaluation on test set", level="info")
al.notify("GPU temperature above 85C", level="warning")
al.notify("Training diverged, loss=NaN", level="critical")
```

Notification levels:

| Level | Behavior |
|---|---|
| `"debug"` | Stored in task log only |
| `"info"` | Stored + shown in web frontend |
| `"warning"` | Stored + frontend + Discord notification |
| `"critical"` | Stored + frontend + Discord mention |

---

## Managed Mode

The `@al.managed()` decorator wraps your training function with a `TrainingContext` that handles the training loop, checkpointing, evaluation scheduling, and preflight checks.

```python
from alchemy_sdk import Alchemy

al = Alchemy()

@al.managed(total_steps=500_000, eval_every=10_000, checkpoint_every=50_000)
def train(ctx):
    model = build_model(ctx.params)

    if ctx.is_resume:
        ckpt = ctx.latest_checkpoint()
        model.load_state_dict(torch.load(ckpt))

    for step in ctx.steps():
        loss = model.train_step()
        ctx.log(loss=loss)

train()
```

### Decorator arguments

| Argument | Type | Description |
|---|---|---|
| `total_steps` | `int` | Total number of training steps. 0 = infinite. |
| `eval_every` | `int` | Fire `on_eval` hooks every N steps. 0 = never. |
| `checkpoint_every` | `int` | Fire `on_checkpoint` hooks every N steps. 0 = never. |
| `reads` | `list[str]` | Paths that must exist and be readable (preflight check). |
| `writes` | `list[str]` | Paths that must be writable (preflight check). |

### TrainingContext API

#### Properties

- **`ctx.params`** — `dict[str, Any]` — Immutable copy of `ALCHEMY_PARAMS`.
- **`ctx.run_dir`** — `Path` — Working directory for this run. From `ALCHEMY_RUN_DIR` env var (server-authoritative). In noop mode, falls back to `./runs/{hash}`.
- **`ctx.checkpoint_dir`** — `Path` — `run_dir / "checkpoints"`.
- **`ctx.is_resume`** — `bool` — `True` if an existing checkpoint was found during preflight.

#### `ctx.steps(start=0)`

Iterator that yields step indices from `start` to `total_steps`. Handles everything automatically:

- Calls `al.log()` after each step (throttled internally)
- Fires `on_eval` / `on_checkpoint` hooks at the right intervals
- Breaks when `should_stop()` returns `True` (SIGTERM)

```python
for step in ctx.steps():
    loss = model.train_step()
    ctx.log(loss=loss)
```

To resume from a checkpoint at step 50000:

```python
for step in ctx.steps(start=50000):
    ...
```

#### `ctx.save_checkpoint(state_dict, name="latest")`

Atomically saves a PyTorch checkpoint via `torch.save()` and notifies Alchemy:

```python
ctx.save_checkpoint({
    "model": model.state_dict(),
    "optimizer": optimizer.state_dict(),
    "step": step,
})
```

The file is written to `checkpoint_dir/{name}.pt`. Atomic write via temp file + rename prevents corruption. Requires `torch`.

#### `ctx.latest_checkpoint()`

Returns the `Path` to the most recent `.pt` file in `checkpoint_dir` (by mtime), or `None`.

```python
ckpt_path = ctx.latest_checkpoint()
if ckpt_path:
    state = torch.load(ckpt_path)
    model.load_state_dict(state["model"])
```

#### `ctx.log(**metrics)`

Report metrics at the current step:

```python
ctx.log(loss=0.42, lr=1e-4, grad_norm=0.5)
```

The `loss` keyword is forwarded as the dedicated loss field. All other keywords go into `metrics`.

#### `ctx.log_eval(metrics)`

Report evaluation results (not throttled):

```python
ctx.log_eval({"val_loss": 0.38, "bleu": 32.5})
```

#### Path helpers

```python
logs_dir = ctx.sub_dir("logs")        # run_dir/logs/ (auto-created, umask 002)
plots_dir = ctx.artifact_dir("plots") # run_dir/artifacts/plots/ (auto-created)
```

#### Event hooks

Register callbacks that fire at the right time in the training loop:

```python
def evaluate(ctx, step):
    metrics = run_eval(model, val_loader)
    ctx.log_eval(metrics)

def save(ctx, step):
    ctx.save_checkpoint({"model": model.state_dict(), "step": step})

@al.managed(total_steps=100_000, eval_every=5_000, checkpoint_every=10_000)
def train(ctx):
    ctx.on("on_eval", evaluate)
    ctx.on("on_checkpoint", save)

    model = build_model(ctx.params)
    for step in ctx.steps():
        loss = model.train_step()
        ctx.log(loss=loss)
```

Available events:

| Event | When |
|---|---|
| `on_step_start` | Before each step is yielded |
| `on_step_end` | After each step completes |
| `on_eval` | When `step % eval_every == 0` (step > 0) |
| `on_checkpoint` | When `step % checkpoint_every == 0` (step > 0) |

Hooks can be chained: `ctx.on("on_eval", fn1).on("on_checkpoint", fn2)`.

### Preflight checks

Before your training function runs, managed mode automatically:

1. Verifies all `reads` paths exist and are readable
2. Verifies all `writes` paths have writable parents
3. Ensures `run_dir` parent is writable
4. Creates `run_dir` and `checkpoint_dir` (umask 002, group-writable)
5. Warns if disk space < 1 GiB
6. Checks `torch.cuda.is_available()` (raises if torch is installed but no GPU)
7. Detects existing checkpoints and sets `ctx.is_resume = True`

---

## ManagedTraining Base Class

For more structured training loops, subclass `ManagedTraining`:

```python
from alchemy_sdk.managed import ManagedTraining

class MyTraining(ManagedTraining):
    def setup(self, config):
        self.model = build_model(config)
        self.optimizer = build_optimizer(self.model, config)

    def state(self):
        return {
            "model": self.model.state_dict(),
            "optimizer": self.optimizer.state_dict(),
        }

    def load_state(self, state):
        self.model.load_state_dict(state["model"])
        self.optimizer.load_state_dict(state["optimizer"])

    def step_fn(self, batch):
        loss = self.model.train_on_batch(batch)
        return {"loss": loss}

    def data_iterator(self):
        while True:
            for batch in dataloader:
                yield batch

if __name__ == "__main__":
    ManagedTraining.run(MyTraining, total_steps=100_000)
```

`ManagedTraining` handles:
- Auto-checkpoint by step count or wall time
- Auto-restore from latest checkpoint on startup
- SIGTERM graceful shutdown (checkpoint + exit)
- SIGUSR1 immediate checkpoint
- CLI argument parsing (`--total-steps`, `--checkpoint-every-steps`, `--checkpoint-dir`, `--config`, `--resume-from`)
- Alchemy reporting (progress, checkpoints, done)

Checkpoints are saved as pickle files (`checkpoint_{step}.pkl`).

---

## Framework Callbacks

Drop-in callbacks for popular frameworks. No changes to your training code.

### PyTorch Lightning

```python
from alchemy_sdk.callbacks import AlchemyPLCallback
import pytorch_lightning as pl

trainer = pl.Trainer(
    max_steps=100_000,
    callbacks=[AlchemyPLCallback()],
)
trainer.fit(model, datamodule)
```

`AlchemyPLCallback` reports progress on every batch end (throttled), declares checkpoints on save, handles `should_stop`, and calls `done()` on train end. Optionally pass `total_steps=N` if you want to override auto-detection.

### HuggingFace Transformers

```python
from alchemy_sdk.callbacks import AlchemyHFCallback
from transformers import Trainer

trainer = Trainer(
    model=model,
    args=training_args,
    callbacks=[AlchemyHFCallback()],
)
trainer.train()
```

`AlchemyHFCallback` hooks into HuggingFace's `on_log`, `on_save`, and `on_train_end` events.

---

## Environment Variables

| Variable | Description | Required |
|---|---|---|
| `ALCHEMY_TASK_ID` | Task UUID assigned by stub. Presence enables managed/strict mode. | Set by stub |
| `ALCHEMY_STUB_SOCKET` | Unix socket path for stub communication (preferred transport). | Set by stub |
| `ALCHEMY_SERVER` | HTTP server URL (fallback transport if socket unavailable). | Set by stub |
| `ALCHEMY_PARAMS` | JSON-encoded hyperparameter dict. | Set by stub |
| `ALCHEMY_RUN_DIR` | Working directory for the run. Server-authoritative. | Set by stub |

The SDK reads these at `__init__` time. You never need to set them manually — the Alchemy stub sets them when launching your script.

### Transport selection

The SDK auto-selects the best transport:

1. **Unix socket** (`ALCHEMY_STUB_SOCKET`) — preferred, bidirectional, with heartbeat
2. **HTTP** (`ALCHEMY_SERVER`) — fallback, POST to `/api/sdk/report`
3. **Noop** — no server available, all calls silently succeed

---

## Local Development (Noop Mode)

When no `ALCHEMY_TASK_ID` is set, the SDK runs in **noop mode**:

- All reporting methods (`log`, `done`, `notify`, etc.) silently do nothing
- `al.param(key, default=val)` returns the default (defaults are allowed)
- `al.params()` returns `{}`
- `al.should_stop()` returns `False` (until SIGTERM)
- `al.is_managed` returns `False`
- In managed mode, `run_dir` falls back to `./runs/{fingerprint[:12]}`

This means you can develop and test locally with the exact same training script — no `if alchemy: ...` branching needed.

---

## Complete Examples

### Example 1: Basic training loop

```python
import torch
from alchemy_sdk import Alchemy

al = Alchemy()

# Read hyperparameters (defaults for local dev)
lr = al.param("lr", default=3e-4)
hidden = al.param("hidden_dim", default=256)
total_steps = al.param("total_steps", default=50_000)

# Report config
al.log_config({"lr": lr, "hidden_dim": hidden})

model = build_model(hidden)
optimizer = torch.optim.Adam(model.parameters(), lr=lr)

with al:
    for step in range(total_steps):
        loss = train_step(model, optimizer)
        al.log(step, total_steps, loss=loss)

        if step > 0 and step % 5000 == 0:
            with al.phase("eval"):
                val_metrics = evaluate(model)
                al.log_eval(val_metrics)

            with al.phase("checkpoint"):
                path = f"checkpoints/step_{step}.pt"
                torch.save(model.state_dict(), path)
                al.checkpoint(path)

        if al.should_stop():
            al.notify("Preempted, saving checkpoint", level="warning")
            torch.save(model.state_dict(), "checkpoints/interrupted.pt")
            al.checkpoint("checkpoints/interrupted.pt")
            break
    # al.done() called automatically by context manager
```

### Example 2: Managed mode with hooks

```python
import torch
from alchemy_sdk import Alchemy

al = Alchemy()

@al.managed(
    total_steps=500_000,
    eval_every=10_000,
    checkpoint_every=50_000,
    reads=["data/train/", "data/val/"],
)
def train(ctx):
    p = ctx.params
    model = build_model(p["hidden_dim"])
    optimizer = torch.optim.Adam(model.parameters(), lr=p["lr"])

    # Resume support
    if ctx.is_resume:
        ckpt = ctx.latest_checkpoint()
        state = torch.load(ckpt)
        model.load_state_dict(state["model"])
        optimizer.load_state_dict(state["optimizer"])
        start = state["step"] + 1
    else:
        start = 0

    # Register hooks
    def do_eval(ctx, step):
        metrics = evaluate(model)
        ctx.log_eval(metrics)

    def do_checkpoint(ctx, step):
        ctx.save_checkpoint({
            "model": model.state_dict(),
            "optimizer": optimizer.state_dict(),
            "step": step,
        })

    ctx.on("on_eval", do_eval).on("on_checkpoint", do_checkpoint)

    # Training loop
    for step in ctx.steps(start=start):
        loss = train_step(model, optimizer)
        ctx.log(loss=loss)

train()
```

### Example 3: ManagedTraining subclass

```python
import torch
from alchemy_sdk.managed import ManagedTraining

class AtariTraining(ManagedTraining):
    def setup(self, config):
        self.model = build_atari_agent(config)
        self.optimizer = torch.optim.Adam(
            self.model.parameters(), lr=config.get("lr", 1e-4)
        )
        self.env = make_env(config["env_name"])
        self.step_count = 0

    def state(self):
        return {
            "model": self.model.state_dict(),
            "optimizer": self.optimizer.state_dict(),
            "step": self.step_count,
        }

    def load_state(self, state):
        self.model.load_state_dict(state["model"])
        self.optimizer.load_state_dict(state["optimizer"])
        self.step_count = state["step"]

    def step_fn(self, batch):
        obs = self.env.step()
        loss = self.model.update(obs)
        self.step_count += 1
        return {"loss": loss}

if __name__ == "__main__":
    ManagedTraining.run(
        AtariTraining,
        config="config.yaml",
        total_steps=1_000_000,
        checkpoint_every_steps=5000,
    )
```

Run with CLI overrides:

```bash
python train_atari.py --total-steps 2000000 --checkpoint-every-steps 10000
```
