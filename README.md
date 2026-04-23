# Alchemy v2

GPU job orchestration platform for managing distributed training across SLURM clusters and standalone GPU nodes.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Web UI      │────▶│  Server      │◀────│  Stub(s)     │
│  React+Vite  │     │  Express+WS  │     │  Python      │
└─────────────┘     └──────┬───────┘     └──────┬───────┘
                           │                     │
                     ┌─────┴──────┐        ┌─────┴──────┐
                     │ State JSON  │        │ GPU Nodes   │
                     │ Backup/Auto │        │ SLURM/Local │
                     └────────────┘        └────────────┘
```

## Components

| Directory | Stack | Description |
|-----------|-------|-------------|
| `server/` | Node.js, TypeScript, Express, socket.io | API server, scheduler, state management |
| `web/` | React 18, Vite, TailwindCSS | Dashboard with real-time updates |
| `stub/` | Python 3.10+, asyncio, python-socketio | Daemon running on GPU nodes |
| `sdk/` | Python 3.10+ | Training SDK — progress reporting, should_stop, callbacks |

## Features

- **Task Scheduling** — Priority queue (0-9), global queue with auto-dispatch, DAG dependencies
- **Grid Search** — Parameter grid expansion, parallel cell execution
- **SDK Integration** — Progress reporting, graceful stop, GPU metrics, loss tracking
- **Error Classification** — Auto-detect OOM, NCCL, CUDA errors from logs + exit codes
- **Metrics** — Per-stub GPU VRAM, per-task loss curves (in-memory ring buffers)
- **Audit Log** — All mutations logged (1000-entry ring buffer)
- **State Backup** — Auto-backup every 30min, manual backup/restore, 48 backups retained
- **Notifications** — Discord webhooks with rate limiting
- **SLURM Auto-Queue** — Automatic job submission based on QOS limits
- **Stub Graceful Restart** — SIGUSR1-based hot restart (SLURM-safe, process never exits)
- **Task Timeout** — Configurable per-task `timeout_s`, server enforces automatically
- **Callbacks** — PyTorch Lightning + HuggingFace Trainer callbacks included

## Quick Start

### 1. Server

```bash
cd server
npm install
npm run dev    # http://localhost:3001
```

A default token (`alchemy-v2-token`) is created on first start.

### 2. Web Dashboard

```bash
cd web
npm install
npm run dev    # http://localhost:3000
```

### 3. Stub (GPU node)

```bash
cd stub
pip install -e .
python -m alchemy_stub \
  --server http://SERVER:3001 \
  --token YOUR_TOKEN \
  --max-concurrent 3
```

### 4. Submit a task

```bash
curl -X POST http://localhost:3001/api/stubs/STUB_ID/tasks \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "python train.py", "priority": 7}'
```

Or use the global queue (auto-dispatched to any available stub):

```bash
curl -X POST http://localhost:3001/api/tasks \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "python train.py", "priority": 5}'
```

## SDK

```python
from alchemy_sdk import Alchemy

with Alchemy(server="http://localhost:3001", collect_gpu=True) as al:
    for step in range(100000):
        loss = train_step()
        al.log(step=step, total=100000, loss=loss)

        if al.should_stop:
            save_checkpoint()
            break

        if al.should_checkpoint:
            save_checkpoint()
            al.checkpoint("ckpt.pt")
```

### PyTorch Lightning

```python
from alchemy_sdk.callbacks import AlchemyPLCallback

trainer = pl.Trainer(callbacks=[AlchemyPLCallback()])
```

### HuggingFace Trainer

```python
from alchemy_sdk.callbacks import AlchemyHFCallback

trainer = Trainer(..., callbacks=[AlchemyHFCallback()])
```

## SLURM Integration

```bash
#!/bin/bash
#SBATCH --gres=gpu:1
#SBATCH --time=72:00:00

python -m alchemy_stub \
  --server wss://alchemy.example.com \
  --token $ALCHEMY_TOKEN \
  --idle-timeout 600
```

The stub supports graceful restart via `kill -USR1 <pid>` — the Python process stays alive (SLURM-safe), only the daemon loop restarts.

## Testing

```bash
# Server unit tests (222 tests)
cd server && npx vitest run

# Stub unit tests (63 tests)
cd stub && python -m pytest tests/ -q

# SDK unit tests (39 tests)
cd sdk && python -m pytest tests/ -q

# Full simulation (29 integration tests)
cd . && python tests/simulate.py --stubs 2 --tasks 5
```

## REST API

| Method | Path | Description |
|--------|------|-------------|
| **Stubs** | | |
| GET | `/api/stubs` | List all stubs |
| GET | `/api/stubs/:id` | Get stub details |
| DELETE | `/api/stubs/offline` | Purge offline stubs |
| GET | `/api/stubs/:id/metrics` | Stub GPU metrics history |
| **Tasks** | | |
| POST | `/api/stubs/:id/tasks` | Submit task to stub |
| POST | `/api/tasks` | Submit to global queue |
| GET | `/api/tasks/:id` | Get task status |
| PATCH | `/api/stubs/:id/tasks/:tid` | pause / resume / kill / requeue |
| GET | `/api/stubs/:id/tasks/:tid/logs` | Task log buffer |
| POST | `/api/stubs/:id/tasks/:tid/stop` | Set should_stop flag |
| **Grids** | | |
| POST | `/api/grids` | Create grid search |
| GET | `/api/grids/:id` | Get grid status |
| **System** | | |
| GET | `/api/overview` | Cluster overview (public) |
| GET | `/api/metrics/summary` | Metrics summary |
| GET | `/api/audit` | Audit log |
| GET | `/api/alerts` | Active alerts |
| POST | `/api/tokens` | Create auth token |
| POST | `/api/admin/backup` | Manual backup |
| GET | `/api/admin/backups` | List backups |
| GET | `/api/config/stall` | Stall detection config |
| **SDK** | | |
| POST | `/api/sdk/report` | Progress report (no auth, task_id = credential) |
