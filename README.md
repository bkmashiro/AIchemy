# Alchemy v2

GPU job orchestration platform. Stubs run on GPU nodes, connect to server, execute tasks.

## Components

- **server/** — Node.js + TypeScript + Express + socket.io
- **web/** — React 18 + Vite + TailwindCSS dashboard
- **stub/** — Python daemon that runs on GPU nodes
- **sdk/** — Optional Python SDK for training scripts

## Quick Start

### 1. Start server

```bash
cd server
npm install
npm run dev
# Server on http://localhost:3001
```

### 2. Start web dashboard

```bash
cd web
npm install
npm run dev
# Dashboard on http://localhost:3000
```

### 3. Create a token

```bash
curl -X POST http://localhost:3001/api/tokens -H "Content-Type: application/json" -d '{"label":"mytoken"}'
# Returns: {"token": "uuid-here", ...}
```

### 4. Start a stub on a GPU node

```bash
cd stub
pip install -e .
python -m alchemy_stub \
  --server http://YOUR_SERVER:3001 \
  --token YOUR_TOKEN \
  --max-concurrent 3 \
  --env-setup "export PATH=/path/to/conda/bin:$PATH"
```

### 5. Submit a task

```bash
curl -X POST http://localhost:3001/api/stubs/STUB_ID/tasks \
  -H "Content-Type: application/json" \
  -d '{"command": "python train.py --config cfg.yaml", "cwd": "/path/to/project"}'
```

## SDK Usage

```python
from alchemy_sdk import Alchemy

with Alchemy(server="http://localhost:3001") as al:
    for step in range(500000):
        loss = train_step()
        al.log(step=step, total=500000, loss=loss)
        if al.should_checkpoint:
            save_checkpoint()
            al.checkpoint("checkpoint.pt")
```

## SLURM Usage

In your SLURM job script:

```bash
#!/bin/bash
#SBATCH --gres=gpu:1
#SBATCH --time=72:00:00

python -m alchemy_stub \
  --server wss://alchemy.example.com \
  --token $ALCHEMY_TOKEN \
  --idle-timeout 600
```

## E2E Tests

```bash
cd tests/e2e
python -m pytest . -v
```

## REST API

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/stubs | List all stubs |
| GET | /api/stubs/:id | Get stub |
| POST | /api/stubs/:id/tasks | Submit task |
| PATCH | /api/stubs/:id/tasks/:tid | pause/resume/kill |
| GET | /api/stubs/:id/tasks/:tid/logs | Get log buffer |
| POST | /api/stubs/:id/shell | Remote shell exec |
| POST | /api/tokens | Create auth token |
| POST | /api/sdk/report | SDK progress report |
