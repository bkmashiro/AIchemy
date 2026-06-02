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

ec.list()                              # GET /api/experiments → list[dict]
ec.list(family="pretrain",             # server-side filters (forwarded as
        decision="keep",               # query params). decision="none"
        status="running")              # selects experiments with no decision.
ec.tree()                              # GET /api/experiments/tree → forest
ec.resolve("my-experiment")            # name-or-id → single experiment dict
ec.summary("my-experiment")            # GET /api/experiments/<id>/summary
ec.diff("my-experiment")               # GET /api/experiments/<id>/diff
ec.manifest("my-experiment")           # GET /api/experiments/<id>/manifest
ec.timeline("my-experiment")           # GET /api/experiments/<id>/timeline
ec.compare(["alpha", "beta-2"])        # GET /api/experiments/compare?ids=...

# Local dry-run: build a fork manifest without submitting anything. Only the
# two GET requests below run; nothing is written to the server.
ec.fork_plan(
    "my-experiment",
    set_overrides={"lr": 0.0002, "use_curiosity": True},
    unset_keys=["warmup"],
    name="my-experiment-curiosity",
    reason="ablate curiosity contribution",
)
```

Notes:

- All methods return raw decoded JSON (`dict` / `list`) — no dataclass wrapping.
- `list()` raises if the server returns a non-list body (typically an error
  envelope from an auth or middleware failure) instead of silently degrading.
- Filtered `list()` calls (with `family=` / `decision=` / `status=`) are not
  written to the resolution cache — only the unfiltered list backs name-or-id
  resolution.
- `resolve()` and `compare()` accept either UUIDs or experiment names. Names
  must be unambiguous; duplicates raise `RuntimeError`.
- `fork_plan()` accepts **flat top-level keys only**. Nested (dotted) keys
  like `"model.lr"` raise `RuntimeError`. The returned manifest mirrors the
  CLI's `alch experiments fork-plan` output and is purely local: the only
  network traffic is one `GET /api/experiments` and one
  `GET /api/experiments/<id>`.
- HTTP errors raise `RuntimeError` with the status code and response body
  included so you can see exactly what the server said.
- The companion CLI (`alch experiments tree|summary|diff|manifest|compare|
  timeline|fork-plan`) uses the same endpoints and is also read-only by
  design.

### Caching `/experiments` lookups

`summary`, `diff`, `manifest`, and `compare` all start by fetching
`GET /api/experiments` to resolve name-or-id refs. For notebooks/scripts that
fan out across many refs, you can opt into a per-client cache:

```python
ec = ExperimentClient(cache_experiments=True)
ec.summary("alpha")    # 1× /experiments  + 1× /summary
ec.diff("alpha")       #                   + 1× /diff   (no extra /experiments)
ec.compare(["a","b"])  #                   + 1× /compare
ec.list(refresh=True)  # force a re-fetch
ec.clear_cache()       # drop the memoized list
```

Default is `cache_experiments=False` so the client always reflects fresh
server state. Every read method accepts `refresh=True` to bypass the cache
once without flipping the flag.

### Operator CLI: read-only experiment commands

```bash
alch experiments ls                        # list all experiments
alch experiments ls --family pretrain \
    --decision none --status running       # server-side filters (decision=none = undecided)
alch experiments show <name-or-id>         # full detail dict
alch experiments tree                      # whole forest as JSON
alch experiments summary <name-or-id>      # rollups, best metrics
alch experiments diff <name-or-id>         # parameter / config diff vs parent
alch experiments manifest <name-or-id>     # reproducibility manifest
alch experiments compare <ref> <ref> ...   # multi-experiment compare
alch experiments timeline <name-or-id>     # event timeline
alch experiments fork-plan <name-or-id> \
    --set lr=0.0002 --unset warmup \
    --reason "ablation"                    # local dry-run: prints proposed config + diff
```

These are safe to run during live training: they only issue `GET` requests
against the Alchemy server. `fork-plan` in particular does **not** submit a
fork — pipe the manifest into your Python `Experiment().fork(...).submit()`
flow when you want to actually create the child experiment.

### Operator CLI: research metadata commands

```bash
alch experiments note <name-or-id> "loss flattened at step 12k" \
    --data '{"metric": 0.91}'

alch experiments artifact <name-or-id> s3://bucket/runs/abc/tb \
    --type tensorboard --name tb           # URI vs path is auto-detected

alch experiments checkpoint <name-or-id> /runs/abc/ckpt.pt --step 10000

alch experiments decide <name-or-id> keep \
    --reason "best zN with stable loss"    # also: drop / rerun / fork
```

These write **metadata only**:

- `note`, `artifact`, `checkpoint` append to the append-only event log.
- `decide` `PATCH`es the experiment decision + reason.
- None of these submit work, retry tasks, or change scheduler / runtime /
  stub state.
- Actor is derived server-side from the auth token. The CLI never sends
  `actor`.
