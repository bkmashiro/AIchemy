# Alchemy v2 — Technical Specification

## Overview

Alchemy v2 is a GPU job orchestration platform. It consists of four components:

1. **Server** — Node.js backend with REST API + socket.io
2. **Web** — React dashboard for monitoring and control
3. **Stub** — Python daemon that runs on GPU nodes, connects to server via socket.io
4. **SDK** — Optional lightweight Python library for training code to report progress

## Architecture

```
Browser ──► React Web App ──► Alchemy Server (Node.js)
                                  │
                         socket.io (wss://)
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
                Stub A        Stub B        Stub C
              (SLURM A40)  (SLURM A100)  (Workstation)
                 │               │             │
              train.py        train.py      train.py
              (SDK opt)       (SDK opt)     (SDK opt)
```

Connection direction: Stub connects TO server (outbound only). This means stubs work behind NAT/firewalls without port forwarding.

## Repository Structure

```
alchemy-v2/
├── server/                 # Node.js + TypeScript
│   ├── src/
│   │   ├── index.ts        # Entry point
│   │   ├── socket/         # socket.io handlers
│   │   │   ├── stub.ts     # Stub namespace handlers
│   │   │   └── web.ts      # Web client namespace
│   │   ├── api/            # REST routes
│   │   │   ├── stubs.ts
│   │   │   └── tasks.ts
│   │   ├── store/          # In-memory state (no DB for now)
│   │   │   ├── index.ts
│   │   │   ├── stubs.ts
│   │   │   └── tasks.ts
│   │   └── types.ts        # Shared types
│   ├── package.json
│   └── tsconfig.json
├── web/                    # React + Vite
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx    # Overview: all stubs + tasks
│   │   │   ├── StubDetail.tsx   # Single stub: GPU stats, tasks, logs
│   │   │   └── TaskQueue.tsx    # Global task queue management
│   │   ├── components/
│   │   │   ├── StubCard.tsx
│   │   │   ├── TaskRow.tsx
│   │   │   ├── GpuChart.tsx     # GPU util/vram chart
│   │   │   ├── LogViewer.tsx    # Real-time log tail
│   │   │   └── TaskForm.tsx     # Submit new task form
│   │   ├── hooks/
│   │   │   └── useSocket.ts     # socket.io-client hook
│   │   └── lib/
│   │       └── api.ts           # REST client
│   ├── package.json
│   └── vite.config.ts
├── stub/                   # Python
│   ├── alchemy_stub/
│   │   ├── __init__.py
│   │   ├── __main__.py     # Entry: python -m alchemy_stub
│   │   ├── daemon.py       # Main loop, socket.io connection
│   │   ├── process_mgr.py  # Subprocess management
│   │   ├── gpu_monitor.py  # nvidia-smi polling
│   │   └── config.py       # CLI args + env config
│   ├── pyproject.toml
│   └── requirements.txt    # python-socketio[client], psutil
├── sdk/                    # Python
│   ├── alchemy_sdk/
│   │   ├── __init__.py     # exports: Alchemy class
│   │   ├── client.py       # Main SDK class
│   │   └── transport.py    # HTTP reporter with throttling
│   ├── pyproject.toml
│   └── requirements.txt    # requests only
├── tests/
│   ├── e2e/
│   │   ├── test_full_flow.py       # Full E2E: server + stub + tasks
│   │   ├── test_concurrent.py      # Multiple stubs, parallel tasks
│   │   ├── test_reconnect.py       # Stub disconnect/reconnect
│   │   ├── test_task_lifecycle.py  # start/pause/resume/kill
│   │   └── conftest.py            # Fixtures: start server, stubs
│   └── mocks/
│       ├── fake_train.py           # Simulates training: prints steps, sleeps
│       ├── fake_train_crash.py     # Crashes after N steps
│       ├── fake_train_slow.py      # Very slow, for testing kill
│       └── fake_gpu_stats.py       # Mock nvidia-smi output
└── docker-compose.yml              # Local dev: server + web
```

## Data Models

### Stub

```typescript
interface Stub {
  id: string;               // server-assigned UUID
  name: string;             // human-readable, e.g. "gpuvm35-233597"
  hostname: string;
  gpu: {
    name: string;           // "NVIDIA A40"
    vram_total_mb: number;
    count: number;
  };
  slurm_job_id?: string;
  status: "online" | "offline" | "stale";  // stale = missed 3 heartbeats
  connected_at: string;     // ISO timestamp
  last_heartbeat: string;
  max_concurrent: number;   // how many tasks can run in parallel
  tasks: Task[];
  gpu_stats: GpuStats;      // latest snapshot
  token: string;            // auth token
}
```

### Task

```typescript
interface Task {
  id: string;               // UUID
  stub_id: string;
  command: string;          // shell command to execute
  cwd?: string;             // working directory
  env?: Record<string, string>;  // extra env vars
  status: "queued" | "running" | "paused" | "completed" | "failed" | "killed";
  exit_code?: number;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  progress?: {              // from SDK or parsed from logs
    step: number;
    total: number;
    loss?: number;
    metrics?: Record<string, number>;
  };
  log_buffer: string[];     // last 500 lines
}
```

### GpuStats

```typescript
interface GpuStats {
  timestamp: string;
  gpus: Array<{
    index: number;
    utilization_pct: number;
    memory_used_mb: number;
    memory_total_mb: number;
    temperature_c: number;
  }>;
}
```

## Socket.io Protocol

### Namespace: `/stubs` (Stub ↔ Server)

#### Stub → Server events:

| Event | Payload | Description |
|-------|---------|-------------|
| `register` | `{ hostname, gpu, slurm_job_id?, max_concurrent, token }` | First event after connect |
| `heartbeat` | `{ timestamp }` | Every 30s |
| `gpu_stats` | `GpuStats` | Every 30s (with heartbeat) |
| `task.started` | `{ task_id, pid }` | Subprocess launched |
| `task.progress` | `{ task_id, step, total, loss?, metrics? }` | From SDK or log parsing |
| `task.log` | `{ task_id, lines: string[] }` | Batched, every 2s |
| `task.completed` | `{ task_id, exit_code }` | Subprocess exited |
| `task.failed` | `{ task_id, exit_code, error? }` | Non-zero exit |

#### Server → Stub events:

| Event | Payload | Description |
|-------|---------|-------------|
| `registered` | `{ stub_id }` | Confirm registration |
| `task.run` | `{ task_id, command, cwd?, env? }` | Execute this task |
| `task.kill` | `{ task_id, signal?: "SIGTERM" \| "SIGKILL" }` | Kill task |
| `task.pause` | `{ task_id }` | SIGSTOP |
| `task.resume` | `{ task_id }` | SIGCONT |
| `config.update` | `{ max_concurrent? }` | Update runtime config |

### Namespace: `/web` (Dashboard ↔ Server)

#### Server → Web (real-time push):

| Event | Payload | Description |
|-------|---------|-------------|
| `stubs.update` | `Stub[]` | Full state on connect, then diffs |
| `stub.online` | `Stub` | New stub connected |
| `stub.offline` | `{ stub_id }` | Stub disconnected |
| `task.update` | `Task` | Any task state change |
| `gpu_stats` | `{ stub_id, stats: GpuStats }` | Forward GPU stats |
| `task.log` | `{ stub_id, task_id, lines }` | Forward logs |

## REST API

All routes prefixed with `/api`.

### Stubs

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/stubs` | List all stubs |
| `GET` | `/stubs/:id` | Get stub detail |
| `DELETE` | `/stubs/:id` | Disconnect stub |
| `PATCH` | `/stubs/:id` | Update config (max_concurrent) |

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/stubs/:id/tasks` | List tasks on stub |
| `POST` | `/stubs/:id/tasks` | Submit new task `{ command, cwd?, env? }` |
| `PATCH` | `/stubs/:id/tasks/:tid` | Update: `{ action: "pause" \| "resume" \| "kill" }` |
| `DELETE` | `/stubs/:id/tasks/:tid` | Kill and remove task |
| `GET` | `/stubs/:id/tasks/:tid/logs` | Get log buffer |

### Tokens

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/tokens` | Generate new stub auth token |
| `GET` | `/tokens` | List active tokens |
| `DELETE` | `/tokens/:token` | Revoke token |

## SDK API

```python
from alchemy_sdk import Alchemy

# Initialize — connects to server via HTTP
al = Alchemy(
    server="https://alchemy.example.com",
    task_id="auto",          # auto-detect from ALCHEMY_TASK_ID env var
)

# Log progress — throttled to 1 request per 10s internally
al.log(step=1000, total=500000, loss=0.342, metrics={"silhouette": 0.55})

# Mark checkpoint
al.checkpoint("runs/jema_ctx256_s42/checkpoint_50000.pt")

# Done (auto-called on context manager exit)
al.done()

# Context manager usage
with Alchemy(server="...") as al:
    for step in range(500000):
        loss = train_step()
        al.log(step=step, total=500000, loss=loss)
# auto al.done()
```

The SDK communicates via HTTP `POST /api/sdk/report` with:
```json
{
  "task_id": "xxx",
  "step": 1000,
  "total": 500000,
  "loss": 0.342,
  "metrics": {"silhouette": 0.55},
  "checkpoint": null
}
```

SDK is **optional**. If not used, the stub still works — progress can be parsed from log output (regex for tqdm patterns), or just shown as running/completed.

## Stub Daemon Details

### Process Manager

```python
class ProcessManager:
    """Manages concurrent subprocesses for tasks."""
    
    def __init__(self, max_concurrent: int = 3):
        self.max_concurrent = max_concurrent
        self.processes: dict[str, subprocess.Popen] = {}
    
    def start(self, task_id: str, command: str, cwd: str, env: dict):
        """Start task as subprocess. Queue if at max_concurrent."""
        
    def kill(self, task_id: str, signal: str = "SIGTERM"):
        """Send signal to task. SIGTERM first, SIGKILL after 10s timeout."""
        
    def pause(self, task_id: str):
        """Send SIGSTOP."""
        
    def resume(self, task_id: str):
        """Send SIGCONT."""
```

### GPU Monitor

```python
class GpuMonitor:
    """Polls nvidia-smi for GPU stats."""
    
    def query(self) -> GpuStats:
        """Run nvidia-smi --query-gpu=... and parse output."""
        # Falls back to mock data if nvidia-smi not available (for testing)
```

### Log Capture

Each subprocess stdout/stderr is captured line-by-line:
- Last 500 lines kept in memory ring buffer
- Batched and sent to server every 2s via socket.io
- Server forwards to web clients watching that task

### Walltime Awareness

SLURM 有 hard walltime（通常 72h），到期整个 job 被 SIGTERM → SIGKILL。

1. **Stub 启动时记录 walltime**: 从 `SLURM_JOB_ID` 读取 `scontrol show job $SLURM_JOB_ID` 的 `TimeLimit` 和 `StartTime`，算出 deadline
2. **剩余时间上报**: heartbeat 中包含 `remaining_walltime_s`，dashboard 显示倒计时
3. **预警机制**:
   - 剩余 30min: server 发 Discord 通知 + dashboard 高亮
   - 剩余 10min: 不再接受新任务
   - 剩余 5min: Discord 通知。如果 task 用了 SDK → 设 `should_checkpoint` flag；否则发 SIGUSR1（task 可选注册 handler）
4. **自动续命（可选）**: 如果配置了 SLURM 脚本模板，server 可在 walltime 到期前自动 `sbatch` 新 job，新 stub 启动后接管任务队列
5. **非 SLURM 模式**: workstation 上跑的 stub 没有 walltime 限制，跳过此逻辑

### Environment Management

Stub 不假设全局 conda 环境。每个 task 可以独立配置环境。

```typescript
interface Task {
  // ... existing fields ...
  env_setup?: string;    // shell commands to run BEFORE command, e.g. "source activate myenv"
}
```

**三层环境模型:**

1. **Stub 默认环境**: 启动时通过 `--env-setup` 配置，所有 task 继承
   ```bash
   python -m alchemy_stub --server wss://... --token xxx \
     --env-setup "export PATH=/vol/bitbucket/ys25/conda-envs/jema/bin:\$PATH"
   ```

2. **Task 级环境**: 提交 task 时可覆盖
   ```json
   {
     "command": "python train.py --config cfg.yaml",
     "env_setup": "source /opt/conda/envs/other/bin/activate",
     "env": {"CUDA_VISIBLE_DEVICES": "0", "WANDB_MODE": "offline"}
   }
   ```

3. **执行顺序**: stub 默认 env_setup → task env_setup → task env vars → command

**实现:** 每个 task 实际执行的是:
```bash
bash -c '
  ${stub_env_setup}
  ${task_env_setup}
  export KEY1=VAL1
  export KEY2=VAL2
  exec ${command}
'
```

这样不同 task 可以用不同 conda env，互不干扰。Dashboard 的 TaskForm 里加 env_setup 输入框。

### Reconnection

- socket.io-client handles automatic reconnect with exponential backoff
- On reconnect, stub re-sends `register` event
- Server matches by token + hostname, restores stub state
- Running tasks continue — stub re-reports their PIDs and status

## React Dashboard Pages

### 1. Dashboard (/)

Overview page:
- Grid of StubCards showing: hostname, GPU name, utilization bar, task count, online/offline badge
- Summary stats: total GPUs, total tasks running, tasks queued
- Click card → StubDetail

### 2. StubDetail (/stubs/:id)

- GPU stats chart (line chart, last 30 min: util% and VRAM%)
- Task list: status badge, command (truncated), progress bar, duration
- Actions per task: pause/resume/kill buttons
- "New Task" button → TaskForm modal
- Log viewer: select task → real-time log tail

### 3. TaskQueue (/tasks)

- Global view of all tasks across all stubs
- Filterable by status, stub
- Bulk actions: kill selected, resubmit failed
- Task submission: pick stub (or auto-assign to least busy)

## Tech Stack

| Component | Stack |
|-----------|-------|
| Server | Node.js, TypeScript, Express, socket.io, tsx |
| Web | React 18, Vite, TailwindCSS, socket.io-client, recharts (GPU charts) |
| Stub | Python 3.10+, python-socketio[asyncio_client], psutil |
| SDK | Python 3.10+, requests (zero heavy deps) |
| Tests | pytest (E2E + stub + sdk), vitest (server unit tests) |

## E2E Test Plan

Tests run locally. `conftest.py` fixture:
1. Start alchemy server on random port
2. Start N stub daemons pointing to that server (with mock GPU monitor)
3. Tests use REST API to submit tasks and assert state transitions

### Test Cases

#### `test_full_flow.py`
1. Start server
2. Start 1 stub → assert stub appears in `GET /stubs` with status "online"
3. Submit `fake_train.py` (runs 10 steps, prints progress, exits 0) → assert task transitions: queued → running → completed
4. Assert exit_code == 0
5. Assert log buffer contains expected output
6. Disconnect stub → assert status "offline"

#### `test_concurrent.py`
1. Start stub with max_concurrent=2
2. Submit 3 tasks (fake_train_slow.py, sleeps 5s each)
3. Assert 2 running + 1 queued
4. When first completes → queued one starts
5. All complete → assert 3 completed

#### `test_task_lifecycle.py`
1. Submit fake_train_slow.py (runs 60s)
2. Pause → assert status "paused", process stopped
3. Resume → assert status "running"
4. Kill → assert status "killed"

#### `test_reconnect.py`
1. Start stub, submit long task
2. Kill stub process (simulate network drop)
3. Assert server marks stub "stale" after missed heartbeats
4. Restart stub with same token
5. Assert stub re-registers, task still shows as running (subprocess survived parent reconnect? or mark as unknown)

#### `test_sdk_reporting.py`
1. Start server + stub
2. Submit task that uses SDK to report progress
3. Assert progress updates appear in task state via REST API
4. Assert log throttling works (not flooded)

### Mock Scripts

**`fake_train.py`**
```python
import time, sys, os
steps = int(sys.argv[1]) if len(sys.argv) > 1 else 10
for i in range(steps):
    print(f"Training: {i+1}/{steps} loss={1.0/(i+1):.4f}")
    sys.stdout.flush()
    time.sleep(0.5)
print("Done!")
```

**`fake_train_crash.py`**
```python
import time, sys
for i in range(5):
    print(f"Step {i}")
    time.sleep(0.3)
raise RuntimeError("CUDA OOM (fake)")
```

**`fake_train_slow.py`**
```python
import time, signal, sys
signal.signal(signal.SIGTERM, lambda s,f: (print("Got SIGTERM, exiting"), sys.exit(0)))
duration = int(sys.argv[1]) if len(sys.argv) > 1 else 60
start = time.time()
while time.time() - start < duration:
    print(f"Running... {time.time()-start:.0f}s/{duration}s")
    sys.stdout.flush()
    time.sleep(1)
```

## Resilience & Fault Tolerance

### Stub: Never Dies

Stub 的设计原则：**除非收到显式 shutdown 指令或 SLURM walltime 到期，永不退出。**

1. **顶层 try-catch-restart**: main loop 被 try/except 包裹，任何未捕获异常只打日志不退出，sleep 5s 重来
2. **socket.io 断连**: 自动重连，指数退避（1s → 2s → 4s → ... → 60s cap），永不放弃
3. **子进程崩溃不影响 stub**: task 挂了就标记 failed，stub 继续活着等下一个任务
4. **GPU monitor 异常**: nvidia-smi 超时/报错 → 跳过本轮上报，不影响任务执行
5. **磁盘满**: 日志 buffer 在内存，不写本地文件（可选写），不会因磁盘满挂掉
6. **OOM 防护**: stub 自身内存极小（< 50MB），log buffer 有上限（500行 ring buffer）

### Server: 可重启

1. **State snapshot**: 每 60s 将 stubs/tasks 状态写到 `state.json`，重启时恢复
2. **Server 重启后**: stub 自动重连 → re-register → server 从 snapshot + stub 上报重建状态
3. **Graceful shutdown**: SIGTERM → 通知所有 stub "server restarting" → stub 保持任务运行，等重连
4. **Server crash**: stub 检测到断连，继续跑任务，持续尝试重连。任务不中断。

### Stub 重启恢复

如果 stub 进程本身被 kill 了（不是 SLURM job 结束）：
1. 子进程是独立的 process group，不会随 stub 死亡 — 使用 `setsid` / `start_new_session=True`
2. Stub 重启后扫描自己的 PID 文件（`/tmp/alchemy_stub_tasks.json`），尝试 re-attach 存活的进程
3. 能 attach → 标记 running，继续监控
4. 不能 attach → 标记 unknown，报给 server，让用户决定

### 双向心跳

- Stub → Server: heartbeat 每 30s
- Server → Stub: pong 确认
- Stub 连续 3 次没收到 pong → 主动断开重连（防止半开连接）
- Server 连续 3 次没收到 heartbeat → 标记 stub stale（但不 kill 任务）

### 幂等操作

- 所有 task 操作幂等: 重复 kill 已 killed 的 task → no-op
- 重复 register → 更新信息，不创建新 stub
- 重复 task.run 同一 task_id → 忽略（防止重连后重复下发）

## Security Notes

- Stub auth via token (generated by server, passed as CLI arg or env var)
- Invalid token → connection rejected
- Rate limit on socket events to prevent abuse
- Commands are plain strings — trusted environment (internal cluster only)
- Task commands: use shlex.split, no shell=True
- Remote shell: shell=True, 仅限 escape 模式（见下）

### Remote Shell (Escape Hatch)

Stub 支持远程执行任意 shell 命令，用于调试和紧急操作。

**Server → Stub event:**
| Event | Payload | Description |
|-------|---------|-------------|
| `shell.exec` | `{ id, command, timeout? }` | 执行 shell 命令 |

**Stub → Server event:**
| Event | Payload | Description |
|-------|---------|-------------|
| `shell.result` | `{ id, stdout, stderr, exit_code, timed_out }` | 执行结果 |

- 默认 timeout 30s，可配
- `shell=True`，能跑任何命令（cd、pip install、nvidia-smi、kill 等）
- Dashboard 提供 terminal-like UI：输入框 + 输出区域
- REST API: `POST /api/stubs/:id/shell` `{ command, timeout? }` → 同步返回结果

**用途:** 紧急修环境、查文件、装依赖、手动 kill 进程、排查问题。相当于远程 SSH 的替代品。

## Deployment

For now (our use case):
- Server runs in existing container (alongside current alchemy or replaces it)
- Cloudflare tunnel exposes server
- Stub is launched inside SLURM job: `python -m alchemy_stub --server wss://... --token ...`
- SDK is pip-installed in training conda env

## Stub Types

Stub 统一架构，不区分 SLURM / workstation。只是元数据不同：

```typescript
interface Stub {
  // ... existing fields ...
  type: "slurm" | "workstation";  // 自动检测：有 SLURM_JOB_ID 就是 slurm
  slurm?: {
    job_id: string;
    partition: string;       // a40, a30, a100
    walltime_remaining_s: number;
    node: string;
  };
}
```

Dashboard 上两种 stub 同一页面展示，可按 type 过滤。

## SLURM Auto-Queue (占坑机)

Server 自动维持 SLURM GPU 占用率，确保 QOS 上限打满。

### 配置

```typescript
interface SlurmPoolConfig {
  enabled: boolean;
  ssh_target: string;           // "gpucluster2" or "hw2025@gpucluster2"
  submit_script: string;        // path to submit script on cluster
  max_concurrent_jobs: number;  // QOS 上限，e.g. 3
  partitions: string[];         // ["a40", "a30", "a100"]，优先级从左到右
  default_walltime: string;     // "72:00:00"
  default_mem: string;          // "64G"
  stub_command: string;         // stub 启动命令模板
  min_queue_ahead: number;      // 至少保持 N 个 pending job，默认 1
}
```

### 逻辑

```
每 60s 检查:
  active_stubs = online SLURM stubs 数量
  pending_jobs = squeue 中 PENDING 的我们的 job 数量
  total = active_stubs + pending_jobs

  if total < max_concurrent_jobs + min_queue_ahead:
    # 需要补坑
    sbatch 新 job → 启动 stub → 自动连回 server
    # 新 stub 连上后从 task queue 拉任务
```

### 流程

1. Server 通过 SSH 执行 `squeue -u ys25` 检查当前 job 状态
2. 发现空位 → `sbatch` 提交新 job（job 内容就是启动 stub）
3. SLURM 分配到 GPU → stub 启动 → 连接 server → 从全局 task queue 拉任务
4. 任务跑完 → stub 空闲 → 自动拉下一个
5. 全局 queue 空了 → stub idle
6. **Idle 超时释放**: stub 空闲超过 `idle_timeout`（默认 10min）→ stub 自行退出 → SLURM job 结束，释放 GPU
7. Server 检测到 stub 减少 → 如果还有 pending tasks → 补新 job
8. **不排新坑条件**: 全局 task queue 为空 → 不提交新 job，避免浪费配额

### SLURM Job 模板

Server 动态生成的 sbatch 脚本：
```bash
#!/bin/bash
#SBATCH --gres=gpu:1
#SBATCH --mem=64G
#SBATCH --time=72:00:00
#SBATCH --partition=a40
#SBATCH --job-name=alchemy-stub

export PATH="/vol/bitbucket/ys25/conda-envs/jema/bin:$PATH"
python -m alchemy_stub \
  --server wss://alchemy.example.com \
  --token ${TOKEN} \
  --env-setup "export PATH=/vol/bitbucket/ys25/conda-envs/jema/bin:\$PATH"
```

### Dashboard UI

- SLURM Pool 面板：当前 active/pending/max，一键开关
- 手动触发排队按钮
- 历史：GPU 占用率时间线

## Grid Tasks（参数网格）

批量参数扫描，一次定义，自动展开为多个 task。

### 数据模型

```typescript
interface GridTask {
  id: string;
  name: string;                    // e.g. "ctx_ablation"
  command_template: string;        // "python train.py --config {config_path}"
  parameters: Record<string, any[]>;  // {"context_len": [1,2,4,...], "seed": [42,123,789]}
  cells: GridCell[];               // 自动展开的每个组合
  status: "pending" | "running" | "completed" | "partial";
  created_at: string;
}

interface GridCell {
  id: string;
  grid_id: string;
  params: Record<string, any>;     // {"context_len": 128, "seed": 42}
  task_id?: string;                // 关联的 task
  status: "pending" | "running" | "completed" | "failed";
  metrics?: Record<string, number>; // 从 run_dir/metrics.json 读取
}
```

### 参数传递：双模式

#### 模式 B: SDK Param API（新代码推荐）

Server 通过环境变量 `ALCHEMY_PARAMS` 注入参数，SDK 读取：

```python
from aichemy_sdk import Alchemy
al = Alchemy()

ctx = al.param("context_len")       # 单个参数
seed = al.param("seed", default=42) # 带默认值
config = al.params()                # 整个 dict: {"context_len": 128, "seed": 42}
```

Stub 启动 task 时设置环境变量：
```bash
ALCHEMY_PARAMS='{"context_len":128,"seed":42}' python train.py
```

SDK 实现：
```python
def param(self, key: str, default=None):
    params = json.loads(os.environ.get("ALCHEMY_PARAMS", "{}"))
    if key not in params and default is None:
        raise KeyError(f"Parameter '{key}' not found. Available: {list(params.keys())}")
    return params.get(key, default)

def params(self) -> dict:
    return json.loads(os.environ.get("ALCHEMY_PARAMS", "{}"))
```

#### 模式 C: Config 生成（现有代码兼容）

Server 拿 base YAML + grid 参数 → 生成临时 config 文件 → 通过 `{generated_config_path}` 传给命令。

```yaml
# base_ctx_ablation.yaml
hidden_dim: 512
total_steps: 500000
# ... 其他固定参数
```

Grid 提交时：
```json
{
  "name": "ctx_ablation",
  "base_config": "configs/base_ctx_ablation.yaml",
  "parameters": {
    "context_len": [1, 2, 4, 8, 16, 32, 64, 128, 256, 512],
    "seed": [42, 123, 789]
  },
  "command_template": "python train.py --config {generated_config_path}"
}
```

生成流程：
1. Stub 收到 `task.run` 时，如果 task 有 `base_config` + `param_overrides`
2. Stub 读取 base YAML → deep merge 参数覆盖 → 写到临时文件 `{workdir}/.aichemy_configs/{task_id}.yaml`
3. 命令中 `{generated_config_path}` 替换为临时文件路径
4. 任务完成后清理临时文件（可选保留）

这样训练代码零修改，只要原来支持 `--config xxx.yaml` 就行。

#### 两种模式共存

- `ALCHEMY_PARAMS` 环境变量**始终注入**（不管哪种模式）
- 模式 C 额外生成 config 文件
- 训练代码可以两种都用，也可以只用一种

### Dashboard: 矩阵视图

- 热力图矩阵：x=context_len, y=seed
- 颜色 = status（灰=pending, 蓝=running, 绿=completed, 红=failed）或 metric 值
- 点击格子 → 跳转到 task 详情
- 操作：重跑单格、批量 kill、筛选失败的重提交
- 自动检测缺失格子，一键补提交

### REST API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/grids` | 创建 grid task |
| `GET` | `/api/grids` | 列出所有 grids |
| `GET` | `/api/grids/:id` | Grid 详情 + 所有 cells |
| `POST` | `/api/grids/:id/retry-failed` | 重跑所有失败的 cell |
| `POST` | `/api/grids/:id/cells/:cid/retry` | 重跑单个 cell |
| `DELETE` | `/api/grids/:id` | Kill 所有 cell 任务 |

---

## Task DAG 编排

Task 之间可以有依赖关系。

### 数据模型

```typescript
interface Task {
  // ... existing fields ...
  depends_on?: string[];           // task IDs that must complete before this starts
  post_hooks?: string[];           // commands to run after task completes successfully
}
```

### 逻辑

- Task 有 `depends_on` → 状态为 `waiting`，不下发给 stub
- 所有前置 task completed → 状态变 `queued` → 正常调度
- 任一前置 failed → 状态变 `blocked`，通知用户
- Server 维护拓扑排序，检测循环依赖

### Post-hooks（轻量版 DAG）

大部分场景不需要完整 DAG，只需要"训练完自动跑 eval"：

```json
{
  "command": "python train.py --config ctx128_s42.yaml",
  "post_hooks": [
    "python eval_silhouette.py --run {run_dir}",
    "python probe_multiworld.py --checkpoint {run_dir}/final.pt"
  ]
}
```

- `{run_dir}` 等变量由 server 自动替换
- post_hooks 在同一个 stub 上顺序执行
- 任一 hook 失败 → 标记 task 为 `completed_with_errors`，不影响主任务状态

### Dashboard

- DAG 可视化：节点 = task，边 = 依赖
- Grid 可以作为 DAG 的一个节点（等所有 cell 完成 → 触发后续）

---

## ManagedTraining SDK（可恢复任务）

SDK 提供 `ManagedTraining` 基类，用户实现 4 个方法，AIchemy 管理其余一切。

### 用户接口

```python
from aichemy_sdk import ManagedTraining

class MyTraining(ManagedTraining):
    def setup(self, config: dict):
        """初始化模型、优化器。首次启动或恢复时调用。"""
        self.model = build_model(config)
        self.optimizer = Adam(self.model.parameters())
        
    def state(self) -> dict:
        """导出全部可序列化状态。AIchemy 调用此方法做 checkpoint。"""
        return {
            "model": self.model.state_dict(),
            "optimizer": self.optimizer.state_dict(),
            "step": self.step,
            "rng": torch.get_rng_state(),
        }
    
    def load_state(self, state: dict):
        """从 state dict 恢复。"""
        self.model.load_state_dict(state["model"])
        self.optimizer.load_state_dict(state["optimizer"])
        self.step = state["step"]
        torch.set_rng_state(state["rng"])
    
    def step_fn(self, batch) -> dict:
        """单步训练，返回 metrics。纯计算，无副作用。"""
        loss = self.model(batch)
        loss.backward()
        self.optimizer.step()
        return {"loss": loss.item()}

# 启动
if __name__ == "__main__":
    ManagedTraining.run(MyTraining, config="ctx128_s42.yaml")
```

### AIchemy 管理的事

- **自动 checkpoint**: 按策略存（每 N 步 / 每 M 分钟 / 收到迁移请求时）
- **自动上报**: `step_fn` 返回的 metrics 自动通过 SDK 上报
- **自动恢复**: 启动时检测已有 checkpoint → `setup()` + `load_state()` → 继续
- **迁移支持**: 收到迁移请求 → `state()` → 序列化到共享存储 → 暂停

### 迁移流程（人工触发）

Dashboard 上显示"建议迁移到 gpu31"，用户点确认后：

1. Server → Stub(旧): `task.checkpoint_and_pause`
2. Stub(旧): 调 `state()` → 存到共享存储 `{shared_path}/migrate_{task_id}.pt`
3. Stub(旧): 报告 checkpoint 路径 → task 状态变 `migrating`
4. Server → Stub(新): `task.run --resume-from {path}`
5. Stub(新): `setup()` + `load_state()` → 继续训练
6. 确认新 stub 正常后 → Server → Stub(旧): `task.kill`

**迁移和调度不自动执行，只给建议 + 一键操作。**

### Task 元数据

```typescript
interface Task {
  // ... existing fields ...
  resumable: boolean;              // SDK ManagedTraining 标记
  checkpoint_path?: string;        // 最新 state 路径
  run_dir?: string;                // 训练输出目录
  migration_history?: Array<{
    from_stub: string;
    to_stub: string;
    at_step: number;
    timestamp: string;
  }>;
}
```

---

## 训练异常检测

Stub 和 Server 配合检测训练异常。

### Stall 检测

```typescript
interface StallConfig {
  enabled: boolean;
  no_progress_timeout_min: number;   // 默认 30min — 无新 checkpoint 且无 step 增长
  gpu_idle_threshold_pct: number;    // GPU 利用率低于此值视为 idle，默认 5%
  gpu_idle_timeout_min: number;      // GPU 连续 idle N 分钟 → 告警，默认 10min
}
```

- Stub 上报 GPU stats，server 检测连续 idle
- SDK 模式: step 不增长 N 分钟 → 告警
- 非 SDK 模式: 监控 log 输出频率，长时间无输出 → 告警

### Loss 异常

SDK 模式下：
- `step_fn` 返回 loss = NaN / Inf → 自动暂停 + Discord 通知
- loss 突然跳升 10x → 警告（不暂停，可能是正常波动）

### 通知

所有告警发 Discord webhook + dashboard 高亮。**只告警不自动处理**（除了 NaN 暂停）。

---

## 智能分配（Heterogeneous-Aware）

提交 task 时可以不指定 stub，server 根据任务需求自动选。

### 显存估算

```typescript
interface TaskRequirements {
  estimated_vram_mb?: number;      // 用户手动指定
  auto_estimate?: boolean;         // 或根据 config 自动估算
}
```

自动估算逻辑（基于 config 参数）：
- `context_len` × `hidden_dim` × `batch_size` → 粗略 VRAM 估算
- 用历史数据校准（同类 task 实际用了多少显存）

### 分配策略

1. 过滤：VRAM 够的 stub
2. 优先：空闲 > 低负载 > 高负载
3. 同类 GPU 优先（避免速度差异影响 seed 间对比）
4. 如果无合适 stub → 进全局 queue，等 stub 空闲或 SLURM auto-queue 补坑

### 迁移建议（不自动执行）

Server 定期检查：
- stub 上多个 task 共享 GPU，速度明显慢于单任务 → 建议拆分
- 有空闲 stub 但繁忙 stub 排了队列 → 建议迁移
- Dashboard 上显示建议，带"一键迁移"按钮

---

## 任务输出目录管理

AIchemy 不管实验逻辑，但帮助 task 维护好输出。

### 约定

- 每个 task 有 `run_dir`（由命令行或 config 决定）
- Task 完成后 stub 扫描 `{run_dir}/metrics.json`（如果存在）→ 读取 metrics 上报
- Dashboard 展示 metrics，但不存中心数据库
- Grid 视图的矩阵颜色可以用 metrics.json 中的值

### metrics.json 格式（约定，不强制）

```json
{
  "silhouette_l2": 0.543,
  "nmi": 0.771,
  "ari": 0.567,
  "final_loss": 0.023
}
```

训练代码在结束时写这个文件就行。SDK 模式下可自动生成。

---

## Out of Scope (for now)

- Persistent database（in-memory + JSON snapshot 够用）
- Multi-user / auth on dashboard
- 自动迁移 / 自动降级（只给建议，人工确认）
- 中心化结果数据库（metrics 留在 run_dir）
- 自动生成论文 figure（耦合太强）
