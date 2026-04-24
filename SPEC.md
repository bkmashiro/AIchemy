# Alchemy v2.1 — Technical Specification

## Overview

GPU job orchestration platform for ML training. Four components:

1. **Server** — Node.js: REST API + socket.io + scheduler + state
2. **Web** — React dashboard
3. **Stub** — Python daemon on GPU nodes, connects to server via socket.io
4. **SDK** — Python library in training code, reports progress + receives signals

```
Browser ──► React Web App ──► Alchemy Server (Node.js)
                                  │
                         socket.io (wss://)
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
                Stub A        Stub B        Stub C
              (SLURM A40)  (SLURM A30)   (Workstation)
                 │               │             │
              train.py        train.py      train.py
              (SDK ←→ Stub via Unix socket)
```

Stub connects TO server (outbound only). Works behind NAT/firewalls.

---

## 1. Data Models

### Task

```typescript
interface Task {
  // === Identity ===
  id: string;                    // UUID
  seq: number;                   // Global auto-increment (#1, #2, ...)
  fingerprint: string;           // sha256(script + args + params + cwd)[:16]
  name?: string;                 // User-defined name
  display_name: string;          // Auto-generated (see rules below)

  // === Structured Command ===
  script: string;                // "python train_atari.py"
  args?: Record<string, string>; // {"--config": "configs/x.yaml", "--seed": "42"}
  raw_args?: string;             // Unstructured fallback: "--verbose"

  // === Environment ===
  cwd?: string;                  // Working directory (inherits from stub)
  env_setup?: string;            // Shell setup commands (inherits from stub)
  env?: Record<string, string>;  // Extra env vars

  // === Assembled (read-only, server builds) ===
  command: string;               // Full shell command for stub to execute

  // === Resources ===
  requirements?: {
    gpu_mem_mb?: number;
    cpu_mem_mb?: number;
    gpu_type?: string[];         // ["A40", "A30"]
  };

  // === Scheduling ===
  status: TaskStatus;
  priority: number;              // Default 5, higher = first
  stub_id?: string;              // Assigned stub (null in global queue)
  target_tags?: string[];        // Tag-based routing (scheduler filters stubs by tag)

  // === Grid ===
  grid_id?: string;
  param_overrides?: Record<string, any>;

  // === Lifecycle ===
  created_at: string;
  started_at?: string;
  finished_at?: string;
  exit_code?: number;
  pid?: number;

  // === Progress ===
  progress?: { step: number; total: number; loss?: number; metrics?: Record<string, number> };
  log_buffer: string[];          // Ring buffer, last 500 lines
  config_snapshot?: Record<string, any>;

  // === Resume & Retry ===
  run_dir?: string;
  checkpoint_path?: string;
  retry_count: number;
  max_retries: number;           // Default 0
  retry_of?: string;             // Original task ID if this is a retry

  // === Server Signals ===
  should_stop: boolean;
  should_checkpoint: boolean;
}

type TaskStatus =
  | "pending"      // In global queue, unassigned
  | "queued"       // In stub local queue, waiting
  | "dispatched"   // Sent to stub, awaiting task.started
  | "running"      // Executing
  | "paused"       // SIGSTOP
  | "completed"    // Exit 0
  | "failed"       // Non-zero exit
  | "killed"       // User cancelled
  | "lost";        // Stub disconnected, fate unknown
```

**display_name rules:**
1. Has `name` → use it
2. Has `script` + `args` → `basename(script) args_summary`
   - e.g. `train_atari.py config=atari_ctx512_s42`
3. Only `command` → extract last meaningful segment

**command assembly (server):**
```
[env_setup &&] [cd cwd &&] [export K=V ...&&] script [--key value ...] [raw_args]
```

**fingerprint:**
```typescript
function fingerprint(task: TaskInput): string {
  const parts = [
    task.script,
    JSON.stringify(sortKeys(task.args || {})),
    JSON.stringify(sortKeys(task.param_overrides || {})),
    task.cwd || "",
  ];
  return sha256(parts.join("\0")).slice(0, 16);
}
```

### Stub

```typescript
interface Stub {
  id: string;                  // Stable: sha256(hostname + gpu_indices + default_cwd)[:12]
  name: string;                // Semantic name, auto or user-set
  hostname: string;
  gpu: { name: string; vram_total_mb: number; count: number };
  system_stats?: SystemStats;
  slurm_job_id?: string;
  status: "online" | "offline";
  type: "slurm" | "workstation";   // Auto: has SLURM_JOB_ID → slurm
  connected_at: string;
  last_heartbeat: string;
  max_concurrent: number;          // Server authoritative (persisted)
  tasks: Task[];
  gpu_stats?: GpuStats;
  env_setup?: string;
  default_cwd?: string;
  idle_timeout_s?: number;         // SLURM mode: exit when idle. Default: Infinity
}
```

**Semantic name auto-generation:**
- `{hostname_short}-{gpu_short}` → e.g. `gpu22-2080ti`, `clapper-a30`
- SLURM stub appends job ID suffix: `clapper-a30-4412`
- Customizable via `PATCH /stubs/:id`

### Grid

```typescript
interface Grid {
  id: string;
  name?: string;
  display_name: string;
  script: string;
  base_args?: Record<string, string>;
  param_space: Record<string, any[]>;  // {"seed": [42,123,789], "ctx": [256,512]}
  task_ids: string[];
  status: "pending" | "running" | "partial" | "completed" | "failed";
  created_at: string;
  max_retries: number;                 // Applied to each generated task
  requirements?: Task["requirements"];
}
```

Grid generates tasks = cartesian product of `param_space`. Each task gets `param_overrides` from its cell. Grid status derived from task statuses:
- All completed → completed
- Any running → running
- Mix of completed + failed → partial
- All failed → failed

---

## 2. Task Dedup & Write Lock

### Fingerprint Dedup

Submit 时 server 检查:
- Same fingerprint + status in `{pending, queued, dispatched, running, paused}` → **reject**, return existing task
- Same fingerprint + status in `{completed, failed, killed, lost}` → **allow** (re-run)
- API also accepts `idempotency_key` (client UUID), same key within 60s → idempotent return

### Write Lock Table

Server maintains `Map<normalized_path, task_id>` for all running tasks' `run_dir`.

- Submit → check `run_dir` not in lock table → add entry
- Task terminates → remove entry
- Path normalization: resolve `..`, trailing slash, canonicalize
- Prefix match: `runs/exp1/` conflicts with `runs/exp1/sub/`

Lock table rebuilt from running tasks on server restart (after stubs resume).

### Disk Flag (.alchemy_owner)

Last-resort safety net on shared filesystem. Stub writes flag when starting task:

```json
// {run_dir}/.alchemy_owner
{"stub_id": "gpu22-2080ti", "task_id": "xxx", "fingerprint": "a1b2c3...", "ts": 1745...}
```

Written atomically (tmp + rename).

**Decision tree on task start:**

```
No flag         → write flag, execute
Flag exists:
  Same fingerprint + own stub  → resume (own restart)
  Same fingerprint + other stub → ask server: original task alive?
    Server: dead  → overwrite flag, resume
    Server: alive → preflight.fail "directory occupied"
    Server: unreachable → preflight.fail "cannot verify"
  Different fingerprint → preflight.fail "directory belongs to different task"
```

#### Test Cases — Dedup & Write Lock

```
T1: Submit task A (fp=abc). Submit task B (fp=abc) while A running.
    → B rejected, response contains A's task_id.

T2: Submit task A (fp=abc). A completes. Submit task B (fp=abc).
    → B accepted (re-run allowed).

T3: Submit task A (run_dir=/x/y). Submit task B (run_dir=/x/y) while A running.
    → B rejected with "path conflict".

T4: Server restart. Stub resumes with A running (run_dir=/x/y). Submit B (run_dir=/x/y).
    → Lock table rebuilt from resume → B rejected.

T5: Stub-1 starts task A (fp=abc, run_dir=/shared/r). Stub-1 crashes.
    Stub-2 assigned retry of A (fp=abc, run_dir=/shared/r).
    → Stub-2 sees .alchemy_owner, fingerprint matches, server confirms A dead.
    → Stub-2 overwrites flag, resumes from checkpoint.

T6: Same as T5 but server unreachable.
    → Stub-2 refuses to start (preflight.fail).

T7: Double-click submit button.
    → First request creates task. Second request within 60s with same idempotency_key → returns same task.
```

---

## 3. Dual Queue Scheduling

```
                    ┌─────────────────────────┐
                    │  Global Queue (pending)  │
                    │  sorted: priority desc,  │
                    │  then created_at asc     │
                    └────────────┬────────────┘
                                 │
                   constraint-aware scheduler
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                   ▼
     ┌──────────────┐  ┌──────────────┐   ┌──────────────┐
     │ Stub A queue │  │ Stub B queue │   │ Stub C queue │
     │  (queued)    │  │  (queued)    │   │  (queued)    │
     └──────┬───────┘  └──────┬───────┘   └──────┬───────┘
            │                  │                   │
      max_concurrent=2    max_concurrent=3     max_concurrent=1
```

- **Global queue**: Unassigned tasks. `POST /api/tasks` enters here.
- **Stub local queue**: Assigned. `POST /api/stubs/:id/tasks` enters directly (bypass scheduler).
- **Stub offline**: Local queue preserved. Resumes on reconnect.

### Scheduler

```typescript
function schedule(): void {
  const stubs = store.getOnlineStubs();
  const queue = store.getGlobalQueue(); // sorted by priority desc, created_at asc

  for (const task of queue) {
    const best = stubs
      .map(s => ({ stub: s, score: score(s, task) }))
      .filter(c => c.score > -Infinity)
      .sort((a, b) => b.score - a.score)[0];

    if (best) {
      store.moveToStubQueue(task.id, best.stub.id);
      maybeDispatch(best.stub);
    }
  }
}

function score(stub: Stub, task: Task): number {
  // Hard constraints (any fail → -Infinity)
  if (stub.status !== "online") return -Infinity;
  if (task.requirements?.gpu_mem_mb) {
    if (availableVram(stub) < task.requirements.gpu_mem_mb) return -Infinity;
  }
  if (task.requirements?.gpu_type?.length) {
    if (!task.requirements.gpu_type.includes(normalize(stub.gpu.name))) return -Infinity;
  }
  if (task.requirements?.cpu_mem_mb && stub.system_stats) {
    if (availableMem(stub) < task.requirements.cpu_mem_mb) return -Infinity;
  }

  // Soft scoring
  let s = 0;
  const running = stub.tasks.filter(t => t.status === "running").length;
  const queued = stub.tasks.filter(t => t.status === "queued").length;
  s += 40 * Math.max(0, stub.max_concurrent - running) / Math.max(1, stub.max_concurrent);
  s -= 10 * queued;

  // Grid locality: same GPU type for fair comparison
  if (task.grid_id) {
    const gridStubs = store.getGridTasks(task.grid_id)
      .map(t => t.stub_id).filter(Boolean).map(id => store.getStub(id));
    if (gridStubs.some(gs => normalize(gs.gpu.name) === normalize(stub.gpu.name))) {
      s += 20;
    }
  }

  // VRAM waste penalty
  if (task.requirements?.gpu_mem_mb) {
    s -= (stub.gpu.vram_total_mb - task.requirements.gpu_mem_mb) / 1000;
  }

  return s;
}
```

**Triggers:** New task in global queue, stub comes online, task finishes (slot opens), 30s periodic.

### Dispatch

```typescript
function maybeDispatch(stub: Stub): void {
  const active = stub.tasks.filter(t => ["running", "dispatched"].includes(t.status)).length;
  const slots = stub.max_concurrent - active;
  const queued = stub.tasks.filter(t => t.status === "queued")
    .sort((a, b) => (b.priority - a.priority) || (a.created_at - b.created_at));

  for (let i = 0; i < Math.min(slots, queued.length); i++) {
    store.updateTask(queued[i].id, { status: "dispatched" });
    reliableEmit(stub.socketId, "task.run", buildRunPayload(queued[i]));
  }
}
```

#### Test Cases — Scheduling

```
T1: Submit task requiring A40. Only A30 stubs online.
    → Task stays in global queue. No dispatch.

T2: Submit task requiring A40. A40 stub comes online.
    → Scheduler triggers → task moves to A40 stub queue → dispatched.

T3: Two stubs: A (0/3 running), B (2/3 running). Submit task.
    → A scores higher (more idle) → assigned to A.

T4: Grid with seed=[42,123,789]. Stub A has A40, Stub B has A30.
    First task goes to A. Second task: A40 locality bonus → also goes to A if slots available.

T5: Submit to specific stub via POST /stubs/:id/tasks.
    → Bypasses global queue. Goes directly to stub's local queue.

T6: Stub goes offline. Its local queue preserved.
    Stub reconnects. → queued tasks still there, dispatch resumes.
```

---

## 4. Socket Protocol

### Reliable Messaging Layer

Application-level reliability over socket.io. Transparent ack + retransmit.

```typescript
interface ReliableMessage {
  seq: number;      // Monotonic per-connection
  event: string;
  payload: any;
  ts: number;
}
```

Transport events: `r` (message), `r.ack` (cumulative ack), `r.nack` (gap retransmit request).

```typescript
class ReliableEmitter {
  private seq = 0;
  private outbox: ReliableMessage[] = [];

  emit(event: string, payload: any): void {
    const msg = { seq: ++this.seq, event, payload, ts: Date.now() };
    this.outbox.push(msg);
    this.socket.emit("r", msg);
    this.scheduleRetry(msg, 5000);
  }

  onAck(ackSeq: number): void {
    this.outbox = this.outbox.filter(m => m.seq > ackSeq);
  }

  onResume(lastSeq: number): void {
    for (const msg of this.outbox.filter(m => m.seq > lastSeq)) {
      this.socket.emit("r", msg);
    }
  }
}

class ReliableReceiver {
  private lastSeq = 0;
  private pending = new Map<number, ReliableMessage>();

  onMessage(msg: ReliableMessage): void {
    if (msg.seq <= this.lastSeq) return; // dedup
    if (msg.seq === this.lastSeq + 1) {
      this.deliver(msg);
      this.lastSeq = msg.seq;
      while (this.pending.has(this.lastSeq + 1)) {
        const next = this.pending.get(this.lastSeq + 1)!;
        this.pending.delete(this.lastSeq + 1);
        this.deliver(next);
        this.lastSeq = next.seq;
      }
      this.socket.emit("r.ack", { seq: this.lastSeq });
    } else {
      this.pending.set(msg.seq, msg);
      this.socket.emit("r.nack", { from: this.lastSeq + 1, to: msg.seq - 1 });
    }
  }
}
```

**Reliable vs non-reliable events:**

| Direction | Event | Reliable | Reason |
|-----------|-------|----------|--------|
| S→Stub | `task.run` | ✅ | Lost = task never starts |
| S→Stub | `task.kill` | ✅ | Lost = unkillable |
| S→Stub | `task.signal` | ✅ | Lost = signal ignored |
| S→Stub | `resume_response` | ✅ | Must arrive |
| S→Stub | `config.update` | ✅ | Config drift |
| S→Stub | `request_sync` | ❌ | Next one covers it |
| Stub→S | `resume` | ✅ | Must arrive |
| Stub→S | `task.started` | ✅ | Status update |
| Stub→S | `task.completed/failed` | ✅ | Status update |
| Stub→S | `task.checkpoint` | ✅ | Checkpoint path |
| Stub→S | `preflight.fail` | ✅ | Status update |
| Stub→S | `heartbeat` | ❌ | Next one covers it |
| Stub→S | `gpu_stats/system_stats` | ❌ | Next one covers it |
| Stub→S | `task.progress` | ❌ | Next one covers it |
| Stub→S | `task.log` | ❌ | Few lines lost OK |

### Stub → Server Events

| Event | Payload |
|-------|---------|
| `resume` | `{ hostname, gpu, slurm_job_id?, max_concurrent, token, env_setup?, default_cwd?, running_tasks: [{task_id, pid, step?, status}], local_queue: [task_id...], lastSeq }` |
| `heartbeat` | `{ timestamp }` |
| `gpu_stats` | `GpuStats` |
| `system_stats` | `SystemStats` |
| `task.started` | `{ task_id, pid }` |
| `task.progress` | `{ task_id, step, total, loss?, metrics? }` |
| `task.log` | `{ task_id, lines: string[] }` |
| `task.completed` | `{ task_id, exit_code }` |
| `task.failed` | `{ task_id, exit_code, error? }` |
| `task.config` | `{ task_id, config }` |
| `task.checkpoint` | `{ task_id, path }` |
| `task.resource` | `{ task_id, gpu_mem_mb, cpu_mem_mb, gpu_util_pct }` |
| `preflight.fail` | `{ task_id, errors: string[] }` |

### Server → Stub Events

| Event | Payload |
|-------|---------|
| `resume_response` | `{ stub_id, name, adopt_tasks, kill_tasks, queue, config }` |
| `task.run` | `{ task_id, command, cwd?, env?, env_setup?, run_dir, params? }` |
| `task.kill` | `{ task_id, grace_period_s? }` |
| `task.signal` | `{ task_id, signal: "should_stop" \| "should_checkpoint" \| "should_eval" }` |
| `config.update` | `{ max_concurrent? }` |
| `request_sync` | `{}` |

### Server → Web Events

| Event | Payload |
|-------|---------|
| `stubs.snapshot` | `Stub[]` |
| `stub.update` | `Stub` |
| `stub.online/offline` | `Stub / { stub_id }` |
| `task.update` | `Task` |
| `gpu_stats` | `{ stub_id, stats }` |
| `system_stats` | `{ stub_id, stats }` |
| `task.log` | `{ stub_id, task_id, lines }` |

### Connection = Resume (Unified)

Every stub connection (first / reconnect / hot-restart) uses **one resume flow**. First connect = resume with empty state.

```
Stub connects:
  1. TCP established
  2. Stub → resume {
       hostname, gpu, ...,
       running_tasks: [...],     // empty on first connect
       local_queue: [...],       // empty on first connect
       lastSeq: 0               // 0 on first connect
     }

Server handles resume:
  1. Identify stub (hostname + gpu → stable id)
     Known → update connection
     Unknown → create record

  2. Reconcile (server records vs stub report):
     A: Server has task X on this stub, stub didn't report → lost
     B: Stub reports task Y, server doesn't know → kill (orphan)
     C: Server queue has task Z, stub doesn't → adopt (re-send)
     D: max_concurrent differs → server authoritative

  3. Reliable layer: replay outbox messages after stub's lastSeq

  4. Server → resume_response { stub_id, name, adopt_tasks, kill_tasks, queue, config }
```

**Periodic reconcile:** Every 5min server → `request_sync`, stub responds with `resume`.

#### Test Cases — Resume

```
T1: Fresh stub connects. running_tasks=[], lastSeq=0.
    → Server creates stub record. resume_response has empty adopt/kill, full queue if any pending.

T2: Stub disconnects, reconnects 30s later. Had 2 running tasks.
    → Stub sends resume with running_tasks=[A,B]. Server matches. No adopt/kill.

T3: Stub disconnects. Server kills task A via API while disconnected.
    Stub reconnects, reports A still running.
    → resume_response.kill_tasks includes A.

T4: Stub crashes (loses tasks). Reconnects with running_tasks=[].
    Server had A,B assigned. → A,B marked "lost". If max_retries > 0, requeued.

T5: Server restarts. Stub reconnects. Server loads state.json, matches stub by stable id.
    → Full reconciliation as normal.

T6: Same stub identity connects while old connection alive (ghost).
    → Server kicks old connection, accepts new one.
```

---

## 5. Graceful Kill Chain

```
User clicks "Cancel" or API PATCH status=killed
  → Server emits task.signal { signal: "should_stop" }     // SDK gets it
  → Wait grace_period (default 30s)                         // Let training save checkpoint
  → Server emits task.kill { grace_period_s: 5 }           // Stub sends SIGTERM
  → Stub: SIGTERM to process
  → Wait 5s
  → Stub: SIGKILL if still alive
  → Stub emits task.failed or task.completed
```

AOP mode: `ctx.should_stop()` returns true → training loop breaks → `__exit__` auto-saves checkpoint → clean exit.

Manual mode: User may not check `should_stop()`. SIGTERM handles it.

#### Test Cases — Kill Chain

```
T1: Kill task using AOP SDK. Task checks should_stop() every step.
    → should_stop becomes true → loop breaks → checkpoint saved → exit 0 → completed.

T2: Kill task not using SDK. No should_stop check.
    → 30s grace passes → SIGTERM → process exits → failed (exit 143).

T3: Kill task, process ignores SIGTERM.
    → SIGTERM → 5s → SIGKILL → failed (exit 137).

T4: Kill task that's already completed before signal arrives.
    → No-op. Task already completed.
```

---

## 6. Failure & Retry

### Failure Classification

```typescript
function classifyFailure(task: Task): "oom" | "error" | "lost" | "killed" {
  if (task.status === "killed") return "killed";
  if (task.status === "lost") return "lost";
  if (task.exit_code === 137) return "oom";       // SIGKILL (OOM killer)
  return "error";                                  // Everything else
}
```

### Retry Policy

```
max_retries > 0 AND retry_count < max_retries AND failure is "oom" or "lost":
  → Create new task (same fingerprint), retry_count + 1, retry_of = original.id
  → New task enters global queue (scheduler may pick different stub)
  → OOM retry: if original had gpu_mem_mb requirement, bump by 20%

failure is "error" → no auto-retry (script bug, fix code first)
failure is "killed" → no auto-retry (user intent)
```

#### Test Cases — Retry

```
T1: Task exits 137 (OOM), max_retries=2, retry_count=0.
    → New task created, retry_count=1, gpu_mem_mb bumped 20%.

T2: Same task OOMs again, retry_count=1.
    → New task, retry_count=2. Bumped again.

T3: Same task OOMs third time, retry_count=2, max_retries=2.
    → No more retries. Final status: failed.

T4: Task exits 1 (script error), max_retries=3.
    → No retry. Script errors don't auto-retry.

T5: Stub disconnects, task marked "lost", max_retries=1.
    → Requeued to global queue for re-dispatch.
```

---

## 7. REST API

All routes: `/api/*`. Auth: `Authorization: Bearer <token>`.

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tasks` | All tasks |
| `POST` | `/tasks` | Submit to global queue |
| `GET` | `/tasks/:id` | Task detail |
| `PATCH` | `/tasks/:id` | Update status/priority/name/should_stop |
| `POST` | `/tasks/:id/retry` | Manual retry (new task, same fingerprint) |
| `POST` | `/tasks/batch` | Batch action `{ action: "kill"\|"retry"\|"requeue"\|"delete", task_ids }` |

### Stubs

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/stubs` | All stubs |
| `GET` | `/stubs/:id` | Stub detail |
| `PATCH` | `/stubs/:id` | Update name/max_concurrent |
| `POST` | `/stubs/:id/tasks` | Submit directly to stub queue |

### Grids

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/grids` | Create grid `{ script, base_args, param_space, ... }` |
| `GET` | `/grids` | List grids |
| `GET` | `/grids/:id` | Grid detail + all tasks |
| `POST` | `/grids/:id/cancel` | Cancel all running tasks in grid |
| `POST` | `/grids/:id/retry-failed` | Retry all failed tasks in grid |

### Metrics

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/overview` | Global stats snapshot (cached 10s) |
| `GET` | `/stubs/:id/metrics` | GPU/CPU/MEM time series (1h ring buffer) |
| `GET` | `/tasks/:id/metrics` | Loss/step time series |
| `GET` | `/tasks/:id/logs?tail=100` | Task log tail |

### SDK Fallback

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/sdk/report` | SDK HTTP fallback `{ task_id, type, ... }` |

---

## 8. SDK

### Design Principles

1. **Pure / side-effect isolation**: Reads have no IO. Reports don't modify training state.
2. **Optional**: No SDK = everything works, just no progress/signals.
3. **Zero intrusion**: Doesn't touch model/optimizer/dataloader. Signal channel only.
4. **Graceful degradation**: Unix socket → HTTP fallback → silent no-op.

### Core API

```python
class Alchemy:
    def __init__(self):
        """Auto-init from env vars:
        ALCHEMY_TASK_ID, ALCHEMY_STUB_SOCKET, ALCHEMY_SERVER, ALCHEMY_PARAMS.

        Two modes:
        - Managed (ALCHEMY_TASK_ID present): strict, zero tolerance.
          param() rejects defaults — typo = crash, not silent wrong experiment.
          ALCHEMY_RUN_DIR must exist — missing = crash.
        - Standalone (no env vars): noop transport, permissive.
          param() accepts defaults. run_dir falls back to cwd/runs/.
          Training script runs normally without alchemy infrastructure."""

    @property
    def is_managed(self) -> bool:
        """True when running under alchemy. Strict mode."""

    # === Pure reads (no IO) ===
    def params(self) -> dict:
        """ALCHEMY_PARAMS parsed. Same value every call."""
    def param(self, key: str, default=_MISSING) -> any:
        """Single param.
        Managed: default FORBIDDEN. Missing key = KeyError (prevents silent typos).
        Standalone: default allowed for convenience."""

    # === Signal queries (pure, reads cached signal from stub) ===
    def should_stop(self) -> bool
    def should_checkpoint(self) -> bool
    def should_eval(self) -> bool

    # === Reports (side effects: sends to stub, never modifies training state) ===
    def log(self, step: int, total: int, loss: float = None, metrics: dict = None) -> None
        """Throttled to 1/10s. Non-blocking."""
    def log_eval(self, metrics: dict) -> None
    def log_config(self, config: dict) -> None
    def checkpoint(self, path: str) -> None
        """Declares checkpoint path. Does NOT torch.save — user does that."""
    def done(self, metrics: dict = None) -> None

    # === Context manager ===
    def __enter__(self): return self
    def __exit__(self, *exc): self.done()
```

### SDK ↔ Stub Communication

```
SDK ←→ Stub:  Unix socket /tmp/alchemy_task_{id}.sock (JSON lines)
Stub ←→ Server:  socket.io (reliable layer)
```

**Stub sets up per-task:**
1. Create Unix socket: `/tmp/alchemy_task_{task_id}.sock`
2. Set env: `ALCHEMY_STUB_SOCKET`, `ALCHEMY_TASK_ID`, `ALCHEMY_PARAMS`
3. Spawn subprocess

**Protocol (JSON lines):**

```
SDK → Stub:
  { "type": "progress", "step": N, "total": N, "loss": F, "metrics": {} }
  { "type": "eval", "metrics": {} }
  { "type": "checkpoint", "path": "..." }
  { "type": "config", "config": {} }
  { "type": "done", "metrics": {} }
  { "type": "heartbeat" }

Stub → SDK:
  { "type": "signal", "signal": "should_stop" }
  { "type": "signal", "signal": "should_checkpoint" }
  { "type": "signal", "signal": "should_eval" }
```

**Fallback chain:** Unix socket → HTTP POST `/api/sdk/report` → silent no-op.

### SDK Heartbeat & Zombie Detection

SDK sends `heartbeat` every 10s over Unix socket. Stub monitors:
- 60s no heartbeat but PID alive → mark task `zombie` (may be deadlocked/hung)
- Server notifies frontend ⚠️, user can manually kill
- PID dead + no `done`/`failed` → process crashed, stub emits `task.failed`

### AOP Training Runtime (Optional)

AOP decorator wraps manual SDK calls. Every `ctx` method maps to an explicit `al.*` call.

#### Core Principle: Idempotency & Side-Effect Isolation

In AOP mode, user training function is a **pure function**: `(params, data) → metrics`. All IO managed by framework:

```
Framework manages (user does NOT touch):
  ✗ Path selection — no hardcoded run_dir / checkpoint_path
  ✗ File creation — no makedirs / open
  ✗ Param source — no yaml / argparse
  ✗ Resume logic — no "if resume: load else: init"

User code only does:
  ✓ Read params from ctx → build model
  ✓ Training loop → produce loss / metrics
  ✓ Use ctx-provided paths for checkpoint save/load
  ✓ Respond to ctx signals (eval / stop / checkpoint)
```

**Idempotency guarantee**: Same task re-run N times → framework provides same params, same run_dir, auto-detects existing checkpoint → resume. User code doesn't know if it's run #1 or #5.

#### TrainingContext

```python
class TrainingContext:
    # === Pure reads ===
    params: dict                # Immutable, from ALCHEMY_PARAMS
    run_dir: Path               # Framework-allocated, deterministic
    checkpoint_dir: Path        # run_dir / "checkpoints"
    is_resume: bool             # True if existing checkpoint found

    # === Path allocation ===
    def output(self, name: str) -> Path:
        """run_dir / name. Auto makedirs + umask 002. Idempotent."""
    def artifact(self, name: str) -> Path:
        """run_dir / artifacts / name."""

    # === Checkpoint lifecycle ===
    def latest_checkpoint(self) -> Path | None:
        """Scan checkpoint_dir, return latest. None if fresh."""
    def save_checkpoint(self, state_dict, tag: str = "latest") -> Path:
        """torch.save to framework path + notify stub. Same tag = overwrite."""

    # === Training loop ===
    def steps(self, start: int = 0) -> Iterator[int]:
        """Step iterator. Auto al.log(). Resume: start from checkpoint step."""

    # === Signals (pure queries) ===
    def should_eval(self) -> bool      # step % eval_every or server signal
    def should_checkpoint(self) -> bool # step % ckpt_every or server signal
    def should_stop(self) -> bool       # server signal

    # === Reports ===
    def log(self, **metrics) -> None
    def log_eval(self, metrics: dict) -> None
```

#### run_dir Allocation

**Server-computed, single source of truth.** Server 在 dispatch 时计算 run_dir 并通过 `task.run` 事件下发。Stub 注入 `ALCHEMY_RUN_DIR` env var。SDK 读取该 env var，不独立计算。

```
run_dir = {base_output_dir} / {fingerprint[:12]}

base_output_dir priority (server-side):
  1. Task's run_dir field (user explicitly set)
  2. Stub's default output_dir
  3. cwd / "runs"
```

SDK 侧：
```python
run_dir = os.environ["ALCHEMY_RUN_DIR"]  # Always set by stub
# SDK never computes run_dir independently — server is authoritative
```

Fingerprint-based → same params always map to same directory → checkpoint reuse automatic.

#### Example

```python
al = Alchemy()

@al.managed(total_steps=500000, eval_every=10000, checkpoint_every=50000,
            reads=["data/atari/"])
def train(ctx: TrainingContext):
    model = build_model(ctx.params)
    optimizer = make_optimizer(model, ctx.params)

    if ckpt := ctx.latest_checkpoint():
        state = torch.load(ckpt)
        model.load_state_dict(state["model"])
        optimizer.load_state_dict(state["optimizer"])
        start = state["step"]
    else:
        start = 0

    for step in ctx.steps(start=start):
        loss = train_step(model, batch)
        ctx.log(loss=loss)
        if ctx.should_eval():
            ctx.log_eval(evaluate(model))
        if ctx.should_checkpoint():
            ctx.save_checkpoint({"model": model.state_dict(),
                                 "optimizer": optimizer.state_dict(),
                                 "step": step})
        if ctx.should_stop():
            break

    return {"final_loss": loss}  # auto al.done()
```

**TrainingContext is not magic:**
- `ctx.steps()` → iterator + `al.log(step=i, total=total_steps)`
- `ctx.should_eval()` → `step % eval_every == 0 or al.should_eval()`
- `ctx.should_checkpoint()` → `step % checkpoint_every == 0 or al.should_checkpoint()`
- `ctx.save_checkpoint(sd)` → `torch.save(sd, path)` + `al.checkpoint(path)`

### Preflight

**AOP preflight** (runs before training function):

| Check | Action | On fail |
|-------|--------|---------|
| `reads` exist | `os.access(path, R_OK)` | raise immediately |
| `run_dir` writable | `os.access(parent, W_OK)` | raise immediately |
| Directories | `os.makedirs(path, exist_ok=True)` | auto-create, umask 002 |
| Disk space | `shutil.disk_usage(path)` | warning if < 1G |
| Checkpoint | existing ckpt in checkpoint_dir | set `ctx.is_resume = True` |
| GPU | `torch.cuda.is_available()` | raise |

**Stub preflight** (runs before any task, AOP or not):

- `cwd` exists and accessible
- `script` file exists (for `python xxx.py` form)
- `run_dir` parent writable (if declared)
- `.alchemy_owner` check (see §2)
- Fail → emit `preflight.fail`, task → failed, no subprocess spawned.

#### Test Cases — SDK & AOP

```
T1: SDK initialized without env vars. al.params() returns {}.
    al.log() does nothing. al.should_stop() returns False. → No crash, no IO.

T2: AOP mode, first run. No checkpoint exists.
    → ctx.is_resume = False. ctx.latest_checkpoint() = None. Training from scratch.

T3: AOP mode, same fingerprint re-run. Checkpoint exists from previous run.
    → ctx.is_resume = True. ctx.latest_checkpoint() returns path. Resumes.

T4: AOP mode, preflight: reads=["data/nonexistent/"].
    → Raises before GPU allocation. Task fails with clear error.

T5: SDK heartbeat stops for 60s but PID alive.
    → Stub marks task "zombie". Frontend shows warning.

T6: Unix socket unavailable. ALCHEMY_SERVER set.
    → SDK falls back to HTTP POST. should_* always false.

T7: Both socket and HTTP unavailable.
    → SDK no-op. Training runs normally, just no reporting.
```

---

## 9. Stub

### Startup

```bash
python -m alchemy_stub \
  --server wss://alchemy-v2.yuzhes.com \
  --token <token> \
  --max-concurrent 3 \
  --env-setup "export PATH=/.../bin:\$PATH" \
  --default-cwd /vol/bitbucket/ys25/jema \
  --idle-timeout 600    # SLURM: exit when idle 10min. Default: infinity.
```

### Singleton (flock)

One stub per identity (hostname + GPU config) per machine:

```python
import fcntl

lock_path = f"/tmp/alchemy_stub_{identity_hash}.lock"
lock_fd = open(lock_path, "w")
try:
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    lock_fd.write(f"{os.getpid()}\n")
    lock_fd.flush()
except BlockingIOError:
    sys.exit("Another stub is already running with this identity")
# lock_fd held open for process lifetime. Kernel releases on any exit.
```

Different GPU configs (e.g., one stub for gpu0, another for gpu1) = different identity hash = can coexist.

### Self-Check (on startup)

```python
def stub_self_check():
    assert os.access("/tmp", os.W_OK), "/tmp not writable"
    assert test_connection(server_url), "Cannot reach server"
```

Passes → stub environment OK. Stub itself only writes to `/tmp` (lock file + Unix sockets). Task output goes to user-specified paths, checked per-task by preflight.

### Environment Model

```
Execution order: stub env_setup → task env_setup → task env vars → ALCHEMY_* → command
```

1. **Stub default**: `--env-setup`, inherited by all tasks
2. **Task level**: `env_setup` field overrides
3. **Auto-injected**: `ALCHEMY_TASK_ID`, `ALCHEMY_STUB_SOCKET`, `ALCHEMY_PARAMS`

### umask

`os.umask(0o002)` on stub startup. All subprocesses inherit. Output files are group-writable.

### Metrics Collection

Every 30s with heartbeat, via psutil:

```python
def collect_system_stats(tasks: dict[str, int]) -> SystemStats:
    return {
        "cpu_pct": psutil.cpu_percent(),
        "mem_used_mb": psutil.virtual_memory().used // (1024**2),
        "mem_total_mb": psutil.virtual_memory().total // (1024**2),
        "per_task": {
            task_id: {
                "cpu_pct": proc.cpu_percent(),
                "mem_mb": proc.memory_info().rss // (1024**2),
                "gpu_mem_mb": get_gpu_mem_for_pid(proc.pid),
            }
            for task_id, pid in tasks.items()
            if (proc := psutil.Process(pid)) and proc.is_running()
        }
    }
```

### Unix Socket Server

Per running task: `/tmp/alchemy_task_{task_id}.sock`

- `os.chmod(sock_path, 0o666)` — allow different users to connect
- SDK → Stub: progress/eval/checkpoint/config/done/heartbeat
- Stub → SDK: should_stop/should_checkpoint/should_eval signals
- Task ends → socket cleaned up

### Hot Update (Graceful Restart)

```python
def handle_sigusr1(signum, frame):
    stub.accepting_tasks = False
    stub.notify_server("draining")
    await wait_for_tasks(timeout=300)  # Wait up to 5min
    sys.exit(0)  # Outer loop restarts new version

signal.signal(signal.SIGUSR1, handle_sigusr1)
```

Outer loop (SLURM):
```bash
while true; do
    python -m alchemy_stub --server ... --token ...
    echo "Restarting in 5s..."
    sleep 5
done
```

New stub process → resume with running state from previous instance.

### SLURM Walltime 感知

Stub 检测 SLURM 剩余 walltime，自动优雅排空：

```python
def get_remaining_walltime() -> int | None:
    """返回剩余秒数。非 SLURM 环境返回 None。"""
    job_id = os.environ.get("SLURM_JOB_ID")
    if not job_id:
        return None
    result = subprocess.run(
        ["squeue", "-j", job_id, "-h", "-o", "%L"],
        capture_output=True, text=True
    )
    return parse_slurm_time(result.stdout.strip())
```

**排空策略：**
```
剩余 walltime < drain_threshold (默认 10min):
  1. 停止接受新任务 (accepting_tasks = False)
  2. 所有 running tasks 发 should_checkpoint 信号
  3. 等 60s 让 checkpoint 完成
  4. 所有 running tasks 发 should_stop 信号
  5. 等 tasks 退出（最多等到 walltime - 2min）
  6. 通知 server: "draining:walltime"
  7. 未完成的 tasks → server 标记 lost，自动 requeue

每 60s 检查一次 walltime。
```

### Stub 标签

Stub 支持 tags，用于任务路由到一组 stub 而非特定 stub：

```bash
python -m alchemy_stub --server ... --tags a40-cluster,ys25
```

Task 提交时可指定 `target_tags`：
```bash
alchemy submit train.py --tag a40-cluster
```

Scheduler 只考虑包含该 tag 的 stubs。无 tag 约束 = 所有 stub 都参与。

Tags 持久化在 stub 记录中，`PATCH /stubs/:id` 可修改。

### Resilience

- Top-level try/catch: uncaught exception → log + sleep 5s → restart
- socket.io disconnect: auto-reconnect, exponential backoff 1s→60s, never give up
- Subprocess crash: mark failed, stub continues
- GPU monitor error: skip round, no impact on tasks
- OOM protection: stub itself < 50MB, log ring buffer 500 lines

#### Test Cases — Stub

```
T1: Start two stubs with same identity on same machine.
    → Second one fails immediately: "Another stub is already running".

T2: Stub crashes (kill -9). Start another.
    → flock released by kernel. New stub acquires lock. Starts normally.

T3: Stub starts, /tmp is writable, server reachable. Self-check passes.
    → Connects, sends resume, receives resume_response.

T4: Stub idle for 600s, --idle-timeout=600.
    → Stub exits. SLURM job ends.

T5: SIGUSR1 sent to stub with 2 running tasks.
    → Stops accepting new tasks. Waits for tasks to finish. Exits. Outer loop restarts.

T6: Stub subprocess exits 137 (OOM). Stub itself still running.
    → task.failed emitted. Next queued task dispatched.

T7: SDK heartbeat missing for 60s, PID alive. Stub marks task zombie.
    → Server notified. Frontend shows warning.
```

---

## 10. Web Frontend

### TaskRow

```
#42  train_atari.py  config=atari_ctx512_s42
     RUNNING  3h22m  15000/300000 (5%)  loss=0.034  ETA 2h
     gpu22-2080ti
```

- Main: `#{seq} {display_name}`
- Sub: status badge, duration, progress bar, loss, ETA
- Right: stub name, action buttons
- `command` only in expanded detail panel

### StubCard

```
┌─────────────────────────────┐
│ gpu22-2080ti          🟢    │
│ RTX 2080 Ti  11G           │
│ ████████░░ 80% GPU         │
│ ████░░░░░░ 4.2/11G VRAM   │
│ 1/2 tasks  ⏳ 3 queued     │
└─────────────────────────────┘
```

### TaskForm

```
┌─────────────────────────────────────────┐
│ Script:   [python train_atari.py      ] │
│ Args:     [--config] [configs/xxx.yaml] │
│           [--seed  ] [42              ] │
│ Name:     [atari_ctx512_s42           ] │  ← optional
│ cwd:      [(inherit from stub)        ] │
│ GPU mem:  [15000] MB                    │  ← optional
│                                         │
│ [Submit to Queue]  [Submit to Stub ▼]   │
└─────────────────────────────────────────┘
```

### Pages

- **Dashboard**: All stubs + running tasks + global queue
- **Grid view**: Tasks grouped by grid, comparison table (params × metrics)
- **Resources** (`/resources`): All stubs GPU/CPU/MEM, global queue depth, online/offline count

### Load Strategy

Frontend opens → REST fetch cached data → render immediately → WebSocket for incremental updates.

```typescript
const overview = await api.get("/overview");
const stubs = await api.get("/stubs");
// then WebSocket overlay
```

---

## 11. Notifications

Discord webhook. Plain text only (no embeds).

Three events:
- `completed`: `✅ #42 train_atari.py config=ctx512_s42 completed (3h22m, loss=0.034)`
- `failed`: `❌ #42 train_atari.py config=ctx512_s42 failed (exit 137, OOM)`
- `lost`: `⚠️ #42 train_atari.py config=ctx512_s42 lost (stub gpu22-2080ti disconnected)`

Grid summary when all tasks finish:
`📊 Grid "atari_expansion" done: 15/18 completed, 3 failed. Best loss: 0.028 (seed=42, ctx=512)`

---

## 12. CLI

```bash
# Single task
alchemy submit python train_atari.py --config configs/x.yaml --seed 42

# With options
alchemy submit python train.py --seed 42 \
  --alchemy-name "my_experiment" \
  --alchemy-gpu-mem 15000 \
  --alchemy-stub gpu22-2080ti    # direct to stub, bypass global queue

# Grid
alchemy grid python train.py \
  --seed 42,123,789 \
  --ctx 256,512

# Status
alchemy status              # overview
alchemy status 42            # task #42 detail
alchemy logs 42              # stream task #42 logs
alchemy cancel 42            # cancel task #42
alchemy cancel --grid 5      # cancel all tasks in grid #5
```

All CLI commands are thin wrappers over REST API.

### 项目配置文件 `alchemy.yaml`

放项目根目录，CLI 自动向上查找并加载，不用每次重复 flag：

```yaml
server: wss://alchemy-v2.yuzhes.com
token: tk_a1b2c3...                     # 或 env: ALCHEMY_TOKEN
default_cwd: /vol/bitbucket/ys25/jema
env_setup: "export PATH=/vol/.../bin:$PATH"

deploy:
  slurm:
    ssh_host: gpucluster2
    ssh_user: ys25
    partition: gpu
    mem: 60G
    time: "8:00:00"
    python_path: /vol/.../bin/python
  workstations:
    gpu22:
      ssh_user: ys25
      python_path: ~/miniconda/envs/jema/bin/python
      max_concurrent: 2
    dipper:
      ssh_user: ys25
      python_path: ~/miniconda/envs/jema/bin/python
      max_concurrent: 5
```

CLI flag 优先级: 显式 flag > alchemy.yaml > 默认值。

### Metrics 导出

```bash
# Grid 结果导出
alchemy export --grid 5 --format csv > results.csv
alchemy export --grid 5 --format json

# 单任务 metrics
alchemy export --task 42 --metrics loss,eval_acc --format csv

# 输出示例 (CSV):
# seed,ctx,final_loss,eval_acc,duration,status
# 42,256,0.034,0.78,3h22m,completed
# 123,256,0.041,0.75,3h18m,completed
# 789,256,0.039,0.76,2h45m,failed
```

Grid 导出自动包含 param_overrides 各字段作为列 + 最终 metrics + 状态。

### Deploy

从本地一键部署 stub 到 SLURM 集群或 workstation。用户需预先配好目标机器的 SSH 和 Python 环境。

```bash
# SLURM — 通过 SSH 提交 sbatch
alchemy deploy slurm \
  --ssh-host gpucluster2 \
  --ssh-user ys25 \
  --partition gpu \
  --gres gpu:a40:1 \
  --mem 60G \
  --time 8:00:00 \
  --qos high \
  --max-concurrent 3 \
  --env-setup "export PATH=/vol/bitbucket/ys25/conda-envs/jema/bin:\$PATH" \
  --default-cwd /vol/bitbucket/ys25/jema \
  --python-path /vol/bitbucket/ys25/conda-envs/jema/bin/python

# Workstation — SSH 直连启动
alchemy deploy workstation \
  --ssh-host gpu22 \
  --ssh-user ys25 \
  --max-concurrent 2 \
  --env-setup "source ~/miniconda/bin/activate jema" \
  --default-cwd /home/ys25/jema \
  --python-path ~/miniconda/envs/jema/bin/python
```

**SLURM 部署流程：**

```
1. CLI 向 server 请求 stub token (POST /api/tokens)
2. 组装 sbatch 脚本:
   #!/bin/bash
   #SBATCH --partition={partition}
   #SBATCH --gres={gres}
   #SBATCH --mem={mem}
   #SBATCH --time={time}
   #SBATCH --qos={qos}
   #SBATCH --job-name=train_{hash[:6]}
   #SBATCH --output=/tmp/alchemy_stub_%j.out

   while true; do
       {python_path} -m alchemy_stub \
           --server {server_url} \
           --token {token} \
           --max-concurrent {max_concurrent} \
           --env-setup "{env_setup}" \
           --default-cwd {default_cwd}
       echo "Stub exited, restarting in 5s..."
       sleep 5
   done

3. SSH 到 login node，写 sbatch 脚本到 /tmp，执行 sbatch
4. 返回 SLURM job ID
5. Stub 上线后自动 resume 到 server
```

**Workstation 部署流程：**

```
1. CLI 向 server 请求 stub token
2. SSH 到目标机器
3. 在 tmux session (alchemy-stub) 里启动:
   {python_path} -m alchemy_stub \
       --server {server_url} --token {token} \
       --max-concurrent {max_concurrent} ...
4. 返回确认
```

**SSH 连接复用：**

CLI 启动 SSH ControlMaster，后续操作复用同一连接，零延迟：

```
~/.ssh/alchemy/
  ├── ctrl-gpucluster2    # ControlMaster socket
  ├── ctrl-gpu22
  └── ctrl-dipper
```

```bash
# deploy 时自动建立 ControlMaster（后台持久连接）
alchemy deploy slurm --ssh-host gpucluster2 ...
# → ssh -M -S ~/.ssh/alchemy/ctrl-gpucluster2 -fN gpucluster2

# 后续所有 CLI 操作复用连接，瞬间执行
alchemy ssh gpucluster2 squeue          # 相当于直接在集群上跑
alchemy ssh gpu22 nvidia-smi            # workstation 也一样
alchemy logs 42 --tail                  # 实际是 SSH 过去 tail -f 日志文件

# 手动管理
alchemy ssh list                        # 列出活跃连接
alchemy ssh close gpucluster2           # 关闭连接
```

CLI 内部所有 SSH 调用自动加 `-S ~/.ssh/alchemy/ctrl-{host} -o ControlMaster=auto`。连接不存在时自动建立。

**Stub 自动上传/更新：**

Deploy 时 CLI 将 stub 源码目录 rsync 到目标机器，直接用 `python -m alchemy_stub` 运行，不动用户环境：

```
1. rsync stub/alchemy_stub/ → {host}:{remote_dir}/alchemy_stub/
   remote_dir 默认 ~/.alchemy/stub/
2. 远程检查: {python_path} -c "import socketio, psutil" → 缺依赖则报错提示用户装
3. 启动: {python_path} -m alchemy_stub --server ... --token ...
```

不执行 pip install，不改环境。依赖缺了只报错，用户自己装。`--remote-dir` 可自定义上传位置。

**前提条件（用户负责）：**
- 目标机器 SSH 可达（读 `~/.ssh/config`）
- Python 环境已装好 stub 依赖（socketio, psutil, aiohttp）
- `--python-path` 指定正确的 Python 解释器

**凭证管理：**

```bash
alchemy token list                   # 列出所有 token
alchemy token create --name gpu22    # 创建 token
alchemy token revoke gpu22           # 吊销 token
```

Server 持久化 tokens 到 state.json。每个 token 可绑定到特定 stub name。

### Deploy REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tokens` | 列出所有 token |
| `POST` | `/tokens` | 创建 token `{ name }` → `{ name, token }` |
| `DELETE` | `/tokens/:name` | 吊销 token |

### SLURM 自动续命

Stub 的 SLURM job 即将到期 + 全局/本地队列仍有 pending tasks → 自动续命。

**触发条件（全部满足）：**
1. Stub 类型 = slurm
2. 剩余 walltime < 15min
3. 存在 pending/queued tasks（本地队列或全局队列有匹配 tag 的任务）
4. Server 侧 `auto_renew` 标记为 true（deploy 时 `--auto-renew` 开启）

**流程：**
```
1. Server 检测到 stub 即将过期 + 有待处理任务
2. 检查: 该 stub 的 deploy_config 是否保存（deploy 时持久化到 state.json）
3. 检查: SLURM quota 是否允许 → SSH 到 login node 执行 squeue -u {user} 计数
4. 检查: 同一 identity 是否已有 pending sbatch job → 有则不重复提交
5. 全部通过 → SSH 提交新 sbatch（用保存的 deploy_config）
6. 日志: {"event": "slurm.auto_renew", "old_job": "12345", "new_job": "12346"}
7. 新 stub 上线后 resume，pending tasks 自动调度

任何检查失败 → 不续命，只告警:
  {"event": "slurm.renew_skipped", "reason": "quota_exceeded"}
  Discord: ⚠️ Stub gpu22-a40 SLURM job expiring, auto-renew failed: quota exceeded
```

**SSH 访问方式：方案 A — Server 容器挂载 SSH Key**
- Server 部署时挂载 SSH private key（如 `-v ~/.ssh/id_ed25519:/app/ssh_key:ro`）
- 配置 `ALCHEMY_SSH_KEY_PATH` 指向 key 文件
- Server 直接 SSH 到 SLURM login node 执行 sbatch/squeue
- 简单直接，server 跑在受信环境内，无安全顾虑

**安全保证：**
- flock 防止新旧 stub 同时运行
- 新 job 只用保存的 deploy_config，不即兴生成
- 提交前 squeue 验证无重复 pending job
- 失败只告警不操作，宁可不续也不 corrupt
- SSH key 权限 600，容器内只读挂载

#### Test Cases — Deploy

```
T1: alchemy deploy slurm with valid SSH config.
    → sbatch script generated with correct SLURM directives.
    → SSH connects, submits job, returns job ID.

T2: alchemy deploy workstation with valid SSH.
    → SSH connects, starts tmux session, stub starts.
    → Stub appears online in server within 10s.

T3: Deploy with --python-path pointing to nonexistent path.
    → SSH succeeds but stub fails to start. User sees error in deploy output.

T4: Token create + revoke.
    → Created token works for stub auth. Revoked token → stub rejected (401).

T5: Deploy twice to same workstation.
    → Second deploy detects existing tmux session, asks to replace or abort.

T6: SLURM stub walltime < 15min, pending tasks exist, auto_renew=true.
    → Server SSH submits new sbatch. New stub starts after old one exits.

T7: Auto-renew but SLURM quota full.
    → squeue shows max jobs. Renew skipped. Discord alert sent.

T8: Auto-renew but same identity already has pending sbatch.
    → Duplicate detected. Renew skipped. No action.

T9: Auto-renew, deploy_config not saved (manual deploy without CLI).
    → Cannot renew. Warning logged.
```

---

## 13. Observability

Alchemy 自身的日志，不是训练任务的日志。

### Server 日志

结构化 JSON 日志输出到 stdout：

```json
{"ts":"2026-04-24T08:30:00Z","level":"info","event":"stub.resume","stub":"gpu22-2080ti","running":2,"queued":3}
{"ts":"...","level":"info","event":"task.dispatch","task_seq":42,"stub":"gpu22-2080ti","display_name":"train_atari.py ctx512_s42"}
{"ts":"...","level":"warn","event":"task.lost","task_seq":42,"stub":"gpu22-2080ti","reason":"stub disconnected"}
{"ts":"...","level":"error","event":"reliable.gap","stub":"gpu22-2080ti","expected":5,"got":8}
```

**日志事件分类：**

| Category | Events |
|----------|--------|
| Lifecycle | `server.start`, `server.stop` |
| Stub | `stub.resume`, `stub.offline`, `stub.identity_match`, `stub.ghost_kicked` |
| Task | `task.submit`, `task.dedup_reject`, `task.dispatch`, `task.started`, `task.completed`, `task.failed`, `task.killed`, `task.lost`, `task.retry` |
| Scheduler | `scheduler.run`, `scheduler.assign`, `scheduler.no_candidate` |
| Reliable | `reliable.send`, `reliable.ack`, `reliable.nack`, `reliable.gap`, `reliable.retry` |
| Dedup | `dedup.reject`, `writelock.conflict`, `writelock.acquire`, `writelock.release` |
| Persistence | `state.save`, `state.backup`, `state.load` |

Level 规则：正常流程 = info，异常但可恢复 = warn，数据丢失/不一致 = error。

### Stub 日志

同样结构化 JSON，输出到 stderr（stdout 留给子进程）：

```json
{"ts":"...","level":"info","event":"stub.start","identity":"gpu22-2080ti","server":"wss://..."}
{"ts":"...","level":"info","event":"task.run","task_id":"abc","command":"python train.py ..."}
{"ts":"...","level":"warn","event":"task.zombie","task_id":"abc","no_heartbeat_s":65}
{"ts":"...","level":"info","event":"preflight.pass","task_id":"abc"}
{"ts":"...","level":"error","event":"preflight.fail","task_id":"abc","errors":["cwd not found"]}
{"ts":"...","level":"info","event":"owner.verified","task_id":"abc","action":"resume"}
```

| Category | Events |
|----------|--------|
| Lifecycle | `stub.start`, `stub.stop`, `stub.self_check`, `stub.flock` |
| Connection | `sio.connect`, `sio.disconnect`, `sio.reconnect`, `resume.sent`, `resume_response` |
| Task | `task.run`, `task.started`, `task.completed`, `task.failed`, `task.kill_chain`, `task.zombie` |
| Preflight | `preflight.pass`, `preflight.fail`, `owner.verified`, `owner.conflict` |
| Reliable | `reliable.send`, `reliable.ack`, `reliable.gap` |

### SDK 日志

SDK 默认静默。设 `ALCHEMY_LOG_LEVEL=debug` 开启，输出到 stderr：

```json
{"ts":"...","level":"debug","event":"sdk.init","mode":"unix_socket","task_id":"abc"}
{"ts":"...","level":"debug","event":"sdk.log","step":1000,"total":500000}
{"ts":"...","level":"warn","event":"sdk.transport_fail","transport":"unix_socket","fallback":"http"}
```

### CLI 日志

人类可读格式（非 JSON），带颜色：

```
[10:23:01] ✓ Token created: gpu22-stub (tk_a1b2c3...)
[10:23:02] ✓ SSH connected: gpu22 (ControlMaster)
[10:23:03] ✓ Stub uploaded: ~/.alchemy/stub/
[10:23:04] ✓ Dep check: socketio ✓ psutil ✓ aiohttp ✓
[10:23:05] ✓ Stub started in tmux session: alchemy-stub
[10:23:08] ✓ Stub online: gpu22-2080ti
```

### Server 日志 REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/logs?level=warn&limit=100` | Server 自身日志（内存 ring buffer，最近 10000 条） |

前端可看 server 日志，方便远程调试。

---

## 14. State Persistence

- **In-memory**: All state in Maps (stubs, tasks, grids, seq counter, write lock table)
- **Snapshot**: `startPersistence()` called after `listen()` succeeds
  - Every 60s: atomic write `state.json` (tmp + rename)
  - Every 30min: backup to `backups/` (keep last 48)
- **Startup**: Load `state.json` → stubs resume → reconcile
- **What's persisted**: tasks, stubs (config only, not connection state), grids, seq counter
- **What's NOT persisted**: write lock table (rebuilt from resume), reliable messaging outbox (reset, resume covers it), metrics ring buffers (ephemeral)

---

## 14. Repository Structure

```
alchemy-v2/
├── server/
│   ├── src/
│   │   ├── index.ts
│   │   ├── types.ts              # All interfaces
│   │   ├── scheduler.ts          # Constraint-aware scheduler
│   │   ├── reliable.ts           # ReliableEmitter/Receiver
│   │   ├── dedup.ts              # Fingerprint + write lock
│   │   ├── notifications.ts     # Discord webhook
│   │   ├── socket/
│   │   │   ├── stub.ts           # Stub namespace + resume
│   │   │   └── web.ts
│   │   ├── api/
│   │   │   ├── tasks.ts
│   │   │   ├── stubs.ts
│   │   │   ├── grids.ts
│   │   │   ├── metrics.ts
│   │   │   └── sdk.ts            # SDK HTTP fallback
│   │   └── store/
│   │       ├── index.ts
│   │       └── backup.ts
│   ├── package.json
│   └── tsconfig.json
├── web/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx
│   │   │   ├── GridView.tsx
│   │   │   └── Resources.tsx
│   │   ├── components/
│   │   │   ├── StubCard.tsx
│   │   │   ├── TaskRow.tsx
│   │   │   └── TaskForm.tsx
│   │   ├── hooks/useSocket.ts
│   │   └── lib/api.ts
│   └── package.json
├── stub/
│   ├── alchemy_stub/
│   │   ├── __main__.py
│   │   ├── daemon.py
│   │   ├── reliable.py
│   │   ├── process_mgr.py
│   │   ├── preflight.py
│   │   ├── task_socket.py        # Unix socket per task
│   │   ├── gpu_monitor.py
│   │   ├── system_monitor.py
│   │   └── config.py
│   ├── pyproject.toml
│   └── requirements.txt
├── sdk/
│   ├── alchemy_sdk/
│   │   ├── __init__.py
│   │   ├── client.py             # Alchemy class
│   │   ├── transport.py          # Unix socket + HTTP fallback
│   │   ├── context.py            # TrainingContext (AOP)
│   │   └── preflight.py
│   ├── pyproject.toml
│   └── requirements.txt
├── cli/
│   ├── bin/alchemy               # Entry point
│   ├── commands/
│   │   ├── submit.ts
│   │   ├── grid.ts
│   │   ├── status.ts
│   │   ├── cancel.ts
│   │   ├── deploy.ts             # deploy slurm / deploy workstation
│   │   └── token.ts              # token create/list/revoke
│   └── package.json
├── tests/
│   ├── server/
│   │   ├── test_scheduler.ts
│   │   ├── test_dedup.ts
│   │   ├── test_reliable.ts
│   │   └── test_resume.ts
│   ├── stub/
│   │   ├── test_preflight.py
│   │   ├── test_singleton.py
│   │   └── test_process_mgr.py
│   ├── sdk/
│   │   ├── test_client.py
│   │   ├── test_context.py
│   │   └── test_transport.py
│   └── e2e/
│       ├── test_full_flow.py
│       ├── test_reconnect.py
│       └── test_kill_chain.py
└── docker-compose.yml
```

---

## 15. Out of Scope (v2.1)

- Persistent database (in-memory + JSON snapshot is enough)
- Multi-user auth
- Auto-migration between stubs (manual only)
- MCP agent interface (v2.2+)
- Task DAG / dependencies (v2.2+)
- Centralized result database (metrics stay in run_dir)
