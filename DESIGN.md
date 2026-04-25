# Alchemy v2 设计解析

> 架构师视角的深度设计文档。不是 API 手册，是设计决策背后的思维。

---

## 目录

1. [系统全貌](#1-系统全貌)
2. [纯函数与副作用隔离](#2-纯函数与副作用隔离)
3. [生命周期：状态机](#3-生命周期状态机)
4. [防御性编程](#4-防御性编程)
5. [设计哲学：为什么这样选择](#5-设计哲学为什么这样选择)
6. [关注点分离](#6-关注点分离)
7. [并发模型](#7-并发模型)
8. [训练即纯函数：核心抽象](#8-训练即纯函数alchemy-的核心抽象)
9. [SDK 设计：控制反转与语言特性](#9-sdk-设计控制反转与语言特性)
10. [Managed Values：零侵入的状态托管](#10-managed-values零侵入的状态托管)
11. [Experiment：假说驱动的实验管理](#11-experiment假说驱动的实验管理)

---

## 1. 系统全貌

Alchemy v2 是一个分布式 ML 任务调度系统，针对高校 GPU 集群（SLURM）设计。核心组件：

```
┌─────────────────────────────────────────────────────┐
│                     Server (Node.js)                 │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐  │
│  │  Store   │  │ Scheduler │  │ Socket Namespaces │  │
│  │ (in-mem) │  │ (scoring) │  │ /stubs /web /ctrl │  │
│  └──────────┘  └───────────┘  └──────────────────┘  │
│       │               │               │              │
│   state.json      triggerSchedule()  Socket.IO       │
└─────────────────────────────────────────────────────┘
         ↕ WebSocket (Socket.IO)          ↕ WebSocket
┌──────────────────────┐        ┌─────────────────────┐
│  Stub (Python)        │        │  Web Dashboard       │
│  daemon.py            │        │  (React SPA)         │
│  process_mgr.py       │        └─────────────────────┘
│  task_socket.py       │
└──────────────────────┘
         ↕ Unix socket (/tmp/alchemy_task_xxx.sock)
┌──────────────────────┐
│  Training Script      │
│  SDK (alchemy_sdk)    │
└──────────────────────┘
```

四层通信链路：
- **Web ↔ Server**: `/web` namespace，dashboard 接收实时推送
- **Stub ↔ Server**: `/stubs` namespace，关键事件走 reliable emit（ack 重试）
- **SDK ↔ Stub**: Unix domain socket，newline-delimited JSON
- **Controller ↔ Server**: `/controller` namespace，SLURM proxy

---

## 2. 纯函数与副作用隔离

### 刻意纯函数的模块

**`scheduler.ts` 的核心评分函数 `scoreStub()`**：

```typescript
export function scoreStub(stub: Stub, task: Task): number {
  // Hard constraints → -Infinity
  if (stub.status !== "online") return -Infinity;
  if (task.requirements?.gpu_mem_mb) {
    if (availableVram(stub) < task.requirements.gpu_mem_mb) return -Infinity;
  }
  // Soft scoring: pure arithmetic
  let s = 0;
  s += 40 * Math.max(0, stub.max_concurrent - running) / Math.max(1, stub.max_concurrent);
  s -= 10 * queued;
  return s;
}
```

这是**纯函数**：给定同样的 stub 和 task，始终返回同样的分数，不读写全局状态，完全可测试。`rejectReason()` 同理——返回人类可读的拒绝原因字符串，无副作用。

**`dedup.ts` 的 `computeFingerprint()`**：

```typescript
export function computeFingerprint(input: FingerprintInput): string {
  const parts = [
    input.script,
    JSON.stringify(sortKeys(input.args || {})),
    input.raw_args || "",
    JSON.stringify(sortKeys(input.param_overrides || {})),
    input.cwd || "",
  ];
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}
```

纯函数：确定性哈希，键排序消除参数顺序的影响，同一实验永远得到同一指纹。

**`store/backup.ts`** 的四个函数全部是纯工具函数，注释明确写了设计意图：

```typescript
/**
 * All functions are pure utilities operating on explicit file paths — no
 * singleton state — so they can be unit-tested without spinning up a server.
 */
```

`backupState(stateFile, backupsDir)` 接收路径，不依赖任何全局单例。这是刻意与 `store/index.ts` 的单例分离的。

**`task-actions.ts`** 是副作用受控的薄层：

```typescript
export function completeTask(stubId: string, taskId: string, exitCode: number): Task | undefined {
  return store.updateTask(stubId, taskId, {
    status: "completed",
    exit_code: exitCode,
    finished_at: now(),
  });
}
```

每个函数只做一件事：封装"哪个 transition 改哪些字段"的知识，副作用只有 `store.updateTask()` 一个入口。注释明确：**没有其他代码应该直接设置 `task.status`**。

### 状态流动方向

状态流动是单向的：

```
外部事件（socket/HTTP）
    ↓
task-actions.ts（定义 transition + 字段）
    ↓
store.updateTask()（验证 transition + 更新内存 + 触发副作用）
    ↓
副作用：fingerprint reindex / write lock release / auto-archive
    ↓
webNs.emit("task.update", updated)（广播给 dashboard）
```

副作用集中在 `store.updateTask()` 的 `_reindexTask()` 私有方法里，调用方无需关心索引维护：

```typescript
private _reindexTask(prev: Task, updated: Task): void {
  // Remove old index entry if status changed to terminal
  if (prev.fingerprint && this._isActive(prev.status) && !this._isActive(updated.status)) {
    this.fingerprintIndex.delete(prev.fingerprint);
  }
  // Handle write lock on terminal transitions
  if (!this._isActive(updated.status) && updated.run_dir) {
    writeLockTable.release(updated.run_dir);
  }
}
```

---

## 3. 生命周期：状态机

### Task 状态机

```
             submit
              ↓
           [pending]  ←─────────────────── (retry/requeue)
              │                                    ↑
       scheduler assigns to stub                   │
              ↓                                    │
           [queued]  ──── kill ──→ [killed] ───────┤
              │                                    │
       maybeDispatch()                             │
              ↓                                    │
         [dispatched]  ── lost ──→ [lost] ─────────┤
              │          ↑ stub 断连               │  ← auto-retry
              │          │                         │
         task.started   timeout                    │
              ↓                                    │
          [running]  ──── kill ──→ [killed] ────────┤
              │         │                           │
              │      SIGTERM                        │
              │         ↓                          │
              │      [paused]  ── kill ──→ [killed]│
              │                                    │
         exit 0         exit ≠ 0                   │
              ↓              ↓                     │
         [completed]    [failed] ──────────────────┘
```

状态机定义在 `state-machine.ts`，极简：

```typescript
const LEGAL_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending:    ["queued", "killed"],
  queued:     ["dispatched", "pending", "killed"],
  dispatched: ["running", "failed", "lost", "killed"],
  running:    ["completed", "failed", "paused", "killed", "lost"],
  paused:     ["running", "killed", "lost"],
  completed:  [],
  failed:     ["pending"],   // ← 允许 retry 重置
  killed:     ["pending"],   // ← 允许 retry 重置
  lost:       ["pending", "failed", "running"],  // running = 重连恢复
};
```

注意 `lost` 的特殊性：可以转回 `running`（stub 重连后发现任务还活着）。这是系统中最复杂的恢复路径。

所有 `store.updateTask()` 调用都通过 `canTransition()` 验证，非法 transition 直接返回 `undefined` 并记日志——**不抛异常，不崩溃**。

### Stub 生命周期

```
连接
  ↓
stub.resume 事件（携带 running_tasks + dead_tasks）
  ↓
服务器 handleResume()：
  1. 验证 token
  2. 计算 stable stub_id（hostname + gpu + slurm_job_id 的哈希）
  3. 踢掉旧 socket（防止 ghost 连接）
  4. 状态对账（reconciliation）：
     - 服务器认为 running，stub 没汇报 → loseTask()
     - Stub 汇报 running，服务器不知道 → kill 孤儿
     - 任务被标记 lost，但 stub 说还活着 → recoverTask()
     - dead_tasks 列表 → resolveDeadTask()
  5. 发送 resume_response（adopt_tasks + kill_tasks + queue）
  ↓
进入稳定运行：heartbeat 每 30s，超时 180s
  ↓
断连
  ↓
markTasksLost()：所有 running/dispatched/paused → lost
  ↓
（stub 重连后回到顶部）
```

stub_id 稳定性设计：同一台机器同一个 GPU 同一个 SLURM job 永远得到同一个 id：

```typescript
function computeStubId(hostname, gpu, defaultCwd, slurmJobId): string {
  const input = `${hostname}|${gpu.name}|${gpu.count}|${defaultCwd || ""}|${slurmJobId || ""}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}
```

包含 `slurmJobId` 是为了区分同一节点上的不同 SLURM job。

### 连接生命周期

Server→Stub 方向的关键事件使用 **reliable emit**：ack 超时自动重试，最多 10 次，间隔 3s。重试时重新检查 socket 是否仍然有效，防止向已断开的 socket 重试。

Stub→Server 方向的状态确认事件（`task.started`、`task.completed`、`task.failed`）使用 socket.io 原生 ack 回调，服务器处理函数里显式调用 `ack({ ok: true })`。

非关键事件（`heartbeat`、`gpu_stats`、`task.progress`、`task.log`）是 fire-and-forget，丢了无所谓。

---

## 4. 防御性编程

### 错误处理策略

**绝不让单个任务的错误崩溃守护进程。** Stub 里的每一个处理路径都有 try/except 包裹：

```python
try:
    pid = await self.process_mgr.start(...)
except Exception as e:
    await self._emit("task.log", {"task_id": task_id, "lines": [f"[alchemy-stub] {error_msg}"]})
    await self._emit("task.failed", {"task_id": task_id, "exit_code": -1, "error": error_msg})
    return
```

失败后立即向服务器汇报 `task.failed`，保证任务状态机不会卡在 `dispatched`。

**SDK 对训练脚本零影响。** `transport.send()` 永远不抛异常：

```python
def send(self, msg: dict) -> None:
    try:
        self._post(payload)
    except Exception:
        pass  # never crash training
```

`make_transport()` 优先 Unix socket，回退 HTTP，再回退 Noop。即使在没有 stub 的本地调试环境里，`Alchemy()` 也能正常实例化——所有方法变成 no-op。

**`param()` 的严格模式**：

```python
def param(self, key: str, default=_MISSING) -> Any:
    if key in self._params:
        return self._params[key]
    if self._managed:
        raise KeyError(f"Parameter '{key}' not found...")  # 禁止 default
```

在 managed 模式（`ALCHEMY_TASK_ID` 存在）下，禁止使用默认值。这防止了 `param("seeed", default=42)` 这种静默 typo 导致错误实验——结果看起来正常但参数是错的。

### 重连机制

**Stub 重连防风暴**：如果两次连接间隔 < 3000ms，直接断开新连接：

```typescript
if (elapsed < 3000) {
  logger.warn("stub.reconnect_too_fast", { elapsed_ms: elapsed });
  socket.disconnect(true);
  return;
}
```

**Stub 进程在 stub daemon 重启后的存活**：`ProcessManager.load_and_reattach()` 从 PID 文件恢复进程句柄，用 `os.kill(pid, 0)` 探活。还活着的进程继续监控，死掉的进入 `_dead_on_reattach` 列表，在下次 `resume` 时上报给服务器。

**periodic status.sync**：每 5 分钟，服务器向 stub 发一次 `status.sync` ack 请求，核对双方的 running tasks 列表。服务器认为 running 但 stub 说 `alive: false` 的 → `loseTask()`。这是连接层面健康检查之上的语义层面核对。

### 数据一致性

**原子写入**：

```typescript
async saveAsync(): Promise<void> {
  const data = this._serializeState();
  const tmpFile = path.join(dir, `.state.tmp.${process.pid}`);
  await fsp.writeFile(tmpFile, data);
  await fsp.rename(tmpFile, STATE_FILE);  // 原子 rename
}
```

在 Linux 上，同目录内的 rename 是原子操作。即使写入中途进程崩溃，state.json 也不会出现半写状态。PID 后缀防止多进程同时写入时互相覆盖 tmp 文件。

**指纹索引的一致性**：`store._reindexTask()` 在每次 `updateTask()` 后自动维护。服务器启动时调用 `rebuildFingerprintIndex()` 从持久化数据重建，防止重启后指纹索引与实际任务状态不一致。

**Write lock table**：防止两个任务写入同一 `run_dir`。任务 `task.started` 时 acquire，任务进入 terminal 状态时 `_reindexTask()` 自动 release。服务器重启后在 stub `resume` 时调用 `rebuildWriteLocks()`。

### 幂等操作

**任务提交**：两层幂等保护：
1. `idempotency_key`：60s TTL 的内存缓存，相同 key 返回之前创建的任务（适合网络重试）
2. `fingerprint dedup`：同一实验的 active 任务 → 409 Conflict（适合防止重复提交）

**stub resume**：无论是第一次连接还是重连，都走同一个 `resume` 事件路径，服务器做完整对账。设计上消除了"首次注册"和"重连同步"两个状态的区别——幂等的连接建立。

**任务分发**：`_handle_task_run` 有重复检查：

```python
if self.process_mgr.is_running(task_id):
    log.info("Task %s already running, ignoring duplicate task.run", task_id)
    return
```

reliable emit 重试可能导致 `task.run` 被发多次，这个检查保证幂等。

---

## 5. 设计哲学：为什么这样选择

### 为什么 Socket.IO 而不是 REST polling

ML 训练任务有几个特性：

1. **高频状态变更**：`task.progress` 每隔几秒一次，`task.log` 更频繁。REST polling 会制造大量无意义请求，延迟也高。
2. **双向信令**：服务器需要主动向 stub 发 `task.kill`、`task.run`。REST 无法做服务器推送（不加 long-polling 的话）。
3. **连接状态本身有意义**：stub 断连意味着任务可能 lost。Socket.IO 的 disconnect 事件是一个天然的故障探测机制。

Socket.IO 的 ack callback 机制为关键事件提供了应用层的送达确认，这正是分布式系统里"你以为发出去了但其实没到"这类问题的解。

namespace 隔离（`/stubs`、`/web`、`/controller`）让三类客户端的事件互不干扰，服务器可以精确控制哪些事件广播给哪类客户端。

### 为什么 JSON 文件而不是数据库

这个设计针对几个具体约束：

1. **部署极简**：目标环境是高校服务器，不一定有 Postgres/Redis 权限，甚至可能只有 SSH 端口。JSON 文件零依赖。
2. **状态规模有限**：同时运行的任务最多几十个，stubs 最多十几个。不需要数据库的查询优化。
3. **快速恢复**：服务器启动时全量加载到内存（`store.load()`），之后所有操作都是内存操作，无 I/O 延迟。JSON 文件只是持久化快照。
4. **可观察性**：`cat state.json | jq` 直接调试，不需要数据库客户端。

代价是不支持水平扩展——整个系统是单 server 架构。对于单实验室规模，这是合理的 tradeoff。

备份策略（每 30 分钟自动备份，保留 48 份）弥补了单文件风险。

### 调度器的设计取舍

调度器采用**贪心分配**而非全局最优化：

```typescript
for (const task of queue) {
  const freshStubs = store.getOnlineStubs(); // 每次迭代重新取
  const candidates = freshStubs
    .map((s) => ({ stub: s, score: scoreStub(s, task) }))
    .filter((c) => c.score > -Infinity)
    .sort((a, b) => b.score - a.score);
  const best = candidates[0].stub;
  store.moveToStubQueue(task.id, best.id);
}
```

注意每次迭代重新取 `freshStubs`——这是因为 `moveToStubQueue` 会修改 stub 的 tasks 列表，影响下一个任务的评分。这是刻意的：前面的任务分配会改变后面任务的评分环境，贪心保证局部最优。

评分设计：
- **硬约束**返回 `-Infinity`，彻底排除（GPU 显存不够、tag 不匹配、slot 满了）
- **软评分**考虑 idle ratio（40分）、queue depth（-10/个）、grid locality（+20）、VRAM waste（-penalty）

Grid locality 加分鼓励同一 grid 的任务跑在同一 stub 上，减少数据加载开销。

调度触发点：任务提交、stub 上线、任务完成、每 30s 定时。定时兜底是为了处理各种边界情况（如 stub 上线时调度器没来得及处理）。

### OOM 自动重试的显存递增

```typescript
if (isOom && task.max_retries > 0 && task.retry_count < task.max_retries) {
  const bumpedMem = task.requirements?.gpu_mem_mb
    ? Math.ceil(task.requirements.gpu_mem_mb * 1.2)
    : undefined;
  // 创建 retry 任务，显存需求 * 1.2
}
```

OOM（exit code 137）触发特殊重试逻辑：自动把显存需求上调 20%，然后重新进调度队列。调度器会根据新的显存需求重新选 stub。这是对 ML 训练"batch size 估错了"场景的自动适应。

---

## 6. 关注点分离

### 层次结构

```
┌─────────────────────────────────────────────────┐
│  API Layer (api/)                                │
│  HTTP 路由、请求验证、响应格式化                  │
│  不直接操作 socket，通过 triggerSchedule() 解耦  │
├─────────────────────────────────────────────────┤
│  Socket Layer (socket/)                          │
│  事件处理、对账逻辑、reliable emit               │
│  不知道 HTTP 的存在                              │
├─────────────────────────────────────────────────┤
│  Scheduler (scheduler.ts)                        │
│  纯调度逻辑：评分、分配、分发                    │
│  输入：store 快照；输出：store mutations         │
├─────────────────────────────────────────────────┤
│  Task Actions (task-actions.ts)                  │
│  状态 transition 的语义封装                      │
│  每个函数对应一个业务事件                        │
├─────────────────────────────────────────────────┤
│  Store (store/)                                  │
│  内存状态管理、持久化、索引维护                  │
│  不知道 socket 的存在，不广播事件                │
├─────────────────────────────────────────────────┤
│  State Machine (state-machine.ts)                │
│  合法 transition 表，纯数据，无逻辑              │
└─────────────────────────────────────────────────┘
```

关键设计原则：**Store 不广播事件**。所有 `webNs.emit("task.update", ...)` 调用发生在 socket 层和 API 层，store 只管数据。这使 store 可以独立测试。

**`task-actions.ts` 是唯一合法的状态写入入口**，其他代码不能直接 `store.updateTask(stubId, taskId, { status: "running" })`，必须通过 `startTask()` 等具名函数，让 transition 语义显式化。

### Stub 内部分层

```
daemon.py          ← socket.io 事件循环，业务逻辑协调
    │
    ├── process_mgr.py  ← 子进程生命周期管理，日志 tailing
    │       │
    │       └── /tmp/alchemy_xxx.json  ← PID 持久化（跨重启）
    │
    ├── task_socket.py  ← Unix socket server，SDK 通信
    │
    ├── gpu_monitor.py  ← nvidia-smi 查询，纯监控
    ├── system_monitor.py ← CPU/内存监控
    ├── walltime.py     ← SLURM walltime 查询
    └── preflight.py    ← 启动前检查（run_dir 可写、env 存在等）
```

`ProcessManager` 的回调设计：

```python
ProcessManager(
    on_started=self._on_task_started,
    on_log=self._on_task_log,
    on_completed=self._on_task_completed,
    on_failed=self._on_task_failed,
    on_zombie=self._on_task_zombie,
)
```

进程管理和 socket 通信通过回调解耦。`ProcessManager` 不知道 socket.io 的存在，只调用传入的 async 回调。`daemon.py` 负责将这些回调连接到 `self._emit()`。

### SDK 的传输层抽象

```python
def make_transport(task_id, stub_socket, server):
    if not task_id:
        return NoopTransport()
    if stub_socket and _probe_unix_socket(stub_socket):
        return UnixSocketTransport(stub_socket, task_id)
    if server:
        return HttpTransport(server, task_id)
    return NoopTransport()
```

`Alchemy` 类（用户 API）对传输方式无感知。本地调试、Unix socket 连接 stub、HTTP 回退——对上层 API 透明。

---

## 7. 并发模型

### Server 的并发

Node.js 单线程事件循环，所有操作是协作式并发。这简化了并发设计：

- **Store 操作天然线程安全**（JS 单线程，无竞态）
- **调度器不需要锁**：`schedule()` 是同步函数，在事件循环中执行，不会被中断
- **Reliable emit 是 async**：`reliableEmitToStub()` 用 `async/await`，重试时 `await sleep(3000)`，让出事件循环

唯一需要注意的是：`schedule()` 内的 `for (const task of queue)` 循环，每次迭代都 `store.getOnlineStubs()` 重新获取 stub 状态，是为了看到前一次 `moveToStubQueue` 的副作用。因为 JS 单线程，这是安全的——没有 TOCTOU 问题。

### Stub 的并发

Python asyncio 单线程（`StubDaemon`），加上多个 `asyncio.create_task()` 并发协程：

```python
asyncio.create_task(self._heartbeat_loop())
asyncio.create_task(self._idle_check_loop())
asyncio.create_task(self._walltime_check_loop())
asyncio.create_task(self._log_cleanup_loop())
```

子进程管理（`ProcessManager`）混合了两种并发模型：
- asyncio 事件循环：socket 通信、日志 flush、完成检测（`_monitor_loop`）
- `threading.Lock`：PID 文件的线程安全写入（`_pid_lock`），因为 PID 文件可能被其他线程并发访问

这是刻意的权衡：大部分操作在 asyncio 里，只有文件 I/O 的并发保护用 threading.Lock，避免引入 asyncio 锁（容易死锁）。

### 多 Stub 并行执行

调度器的工作方式：

```
全局队列（按优先级/时间排序）
    ↓
schedule() 遍历每个 pending 任务
    ↓
对所有 online stubs 评分
    ↓
最高分 stub → moveToStubQueue（pending → queued）
    ↓
maybeDispatch（queued → dispatched，reliable emit task.run）
```

`maybeDispatch(stub)` 同时处理多个 queued 任务：

```typescript
const toDispatch = queued.slice(0, slots);  // slots = max_concurrent - active
for (const task of toDispatch) {
  reliableEmitToStub(stub.id, "task.run", buildRunPayload(task, stub));
}
```

一次可以向同一 stub 发多个 `task.run`，stub 端 `ProcessManager` 的 `max_concurrent` 控制实际并行度。

### 任务分发与资源竞争

**VRAM 分配**是乐观的：

1. 任务调度时，基于当前 GPU stats（或显存估算）选 stub
2. 任务实际启动时，显存可能已被其他进程占用
3. 出现 OOM → exit 137 → 服务器检测到 → 自动重试并上调需求

这是**乐观分配 + 自动修正**，而非悲观锁定。原因：准确的 VRAM 预测在 ML 里很难（取决于 batch size、sequence length 等运行时因素），不如在运行时观测并调整。

**run_dir write lock** 是悲观的（任务提交时立即 acquire），因为两个任务写入同一目录会造成数据污染，不可恢复，代价高。

```typescript
// 任务提交时
if (run_dir) {
  const conflict = writeLockTable.getTaskId(run_dir);
  if (conflict) { res.status(409).json({...}); return; }
  writeLockTable.acquire(run_dir, task.id);  // 立即锁
}
// 任务完成时（store._reindexTask()）
if (!this._isActive(updated.status) && updated.run_dir) {
  writeLockTable.release(updated.run_dir);  // 自动释放
}
```

两种竞争处理策略的选择基于错误代价：VRAM OOM 可以自动重试（低代价），目录污染不可逆（高代价）。

---

## 8. 训练即纯函数：Alchemy 的核心抽象

Alchemy 最深层的设计信念是：**一次成功的训练是一个纯函数调用。**

```
f(code_hash, config, seed) → (model_weights, metrics)
```

给定相同的代码、配置和随机种子，在相同硬件上，训练结果是确定性的（bit-identical，假设 `torch.use_deterministic_algorithms(True)`）。这意味着：

- **可以随时杀掉、随时重启**——只要从最近的 checkpoint 恢复，结果不变
- **可以在不同机器间迁移**——gpu20 的 checkpoint 拿到 gpu31 继续跑
- **失败的运行可以无条件丢弃**——不存在"半成品"状态

### 三态模型

一个训练任务只有三种合法终态：

| 状态 | 含义 | 处理 |
|------|------|------|
| **completed** | 纯函数执行完毕，结果已产出 | 收割结果 |
| **resumable** | checkpoint 干净，中间状态一致 | 从 checkpoint 重启 |
| **failed** | 标记为脏，结果不可信 | 丢弃或调试 |

不存在第四种状态。不存在"跑了一半不知道行不行"。这消除了 ML 实验中最大的不确定性来源。

### 副作用隔离的实现

要让训练成为纯函数，必须隔离所有副作用：

| 副作用 | 传统做法（用户管理） | Alchemy 模型（框架管理） |
|--------|---------------------|------------------------|
| Checkpoint 写入 | `torch.save(path)` | `ctx.save()` → 原子写入 + 注册 |
| 指标记录 | `wandb.log()` | `al.log(step, loss)` → 自动收集 |
| 随机种子 | 用户手动 set | 框架注入，统一 torch/numpy/random |
| 配置读取 | `argparse` / yaml | `al.param("key")` → 服务器注入 |
| 临时文件 | 随意写 | 沙箱目录，框架清理 |
| 日志输出 | `print()` / `logging` | 框架截获 stdout/stderr |

SDK 的 `checkpoint(path)` 是**声明式的**——它不调用 `torch.save()`，只是告诉服务器"这个 checkpoint 存在了"。训练代码负责保存，SDK 负责注册和管理。这个分层确保训练逻辑和基础设施逻辑完全解耦。

### 确定性的边界

GPU 浮点运算在不同硬件上不严格确定（cuDNN nondeterminism）。"纯"的定义是：**给定相同硬件 + 驱动 + seed，结果 bit-identical**。跨硬件只保证统计等价。`torch.use_deterministic_algorithms(True)` 作为可选 flag 提供——牺牲性能换取严格确定性。

---

## 9. SDK 设计：控制反转与语言特性

### 设计哲学：从"调用 API"到"在生命周期里写代码"

传统 ML 框架的 SDK 是**被动**的——用户调 `wandb.log()`，框架只看到用户愿意告诉它的。Alchemy SDK 的目标是**反转控制**：

> 让用户在我们的生命周期里写代码，而不是在用户的代码里调我们的 API。

这不是 API 设计问题，是**编程范式**问题。

### 两层 API 设计

**第一层：最小侵入（当前实现）**

```python
al = Alchemy()
lr = al.param("lr")           # 服务器注入参数
for step in range(total):
    loss = train_step(batch)
    al.log(step, total, loss=loss)
    if al.should_stop():       # SIGTERM → 优雅退出
        break
al.done()
```

零重构成本。用户代码结构不变，只在关键点插入 SDK 调用。

**第二层：AOP 装饰器（目标架构）**

```python
@al.managed(total_steps=500_000, checkpoint_every=50_000)
def train(ctx: TrainingContext):
    model = build_model(ctx.config)
    if ctx.is_resume:
        model.load(ctx.latest_checkpoint())
    for batch in ctx.dataloader():
        loss = model.step(batch)
        ctx.step(loss)           # 自动收集 grad_norm/lr/throughput
        if ctx.should_eval():    # 服务器控制 eval 频率
            ctx.eval(run_eval(model))
        if ctx.should_save():    # 框架管理 checkpoint 生命周期
            ctx.save(model.state_dict())
```

`@al.managed` 注入 `TrainingContext` 作为第一个参数，包裹 preflight 检查和自动 `done()`。训练函数变成一个接收 context、返回 metrics 的纯函数。

### 六个切面（Aspect Points）

| 切面 | 功能 | 竞品对比 |
|------|------|---------|
| `ctx.step(loss)` | 自动采集 loss/grad_norm/lr/throughput，检测 NaN/spike | W&B 只采集用户显式 log 的 |
| `ctx.should_eval()` | 服务器控制 eval 频率，跨实验自动对比 | Lightning 需要 Callback |
| `ctx.should_save()` | checkpoint 生命周期：自动 prune 旧的，保留 best/latest | 手动管理 |
| `ctx.should_stop()` | 统一入口：plateau/OOM/SIGTERM/服务器信号 | 各自为政 |
| `ctx.optimizer()` | 包裹 torch.optim，注入超参数，支持动态 lr | 无 |
| `ctx.dataloader()` | 检测数据瓶颈，自动 tune num_workers | 无 |

与竞品的本质区别：W&B 只做观测，Lightning 需要重构代码结构，Ray 聚焦分布式。Alchemy 是**调度 + 观测 + 干预**三位一体，且数据留在自己的集群上。

### Python 语言特性的运用

**Sentinel 模式** (`client.py:12`)

```python
_MISSING = object()

def param(self, key: str, default=_MISSING) -> Any:
```

`object()` 作为 sentinel 区分"没传 default"和"default=None"。这比 `default=None` 更安全——用户可以合法地把 `None` 作为默认值。

**Managed 模式的严格性** (`client.py:114-118`)

```python
if self._managed:
    raise KeyError(f"Parameter '{key}' not found. Available: {list(self._params.keys())}")
```

Managed 模式下 `param()` 禁止使用默认值。这是**刻意的严格性**：`param("seeed", default=42)` 这种 typo 在 unmanaged 模式下静默通过，在 managed 模式下直接崩。因为 managed 模式意味着参数由服务器注入，任何"找不到"都是 bug，不应该被默认值掩盖。

**信号处理的生命周期** (`client.py:78-87`)

```python
def _install_sigterm_handler(self):
    import signal
    prev = signal.getsignal(signal.SIGTERM)
    def handler(signum, frame):
        self._stop_flag = True
        if callable(prev) and prev not in (signal.SIG_DFL, signal.SIG_IGN):
            prev(signum, frame)
    try:
        signal.signal(signal.SIGTERM, handler)
    except (OSError, ValueError):
        pass
```

保存并链式调用前一个 SIGTERM handler，确保不覆盖用户自定义的信号处理。`try/except` 兜底处理无法安装信号处理器的环境（如某些 Windows 配置或子线程）。

**传输层的三级降级** (`transport.py`)

```python
def make_transport(task_id, stub_socket, server):
    if not task_id:
        return NoopTransport()              # 本地调试
    if stub_socket and _probe_unix_socket(stub_socket):
        return UnixSocketTransport(...)     # 最优路径
    if server:
        return HttpTransport(...)           # 回退
    return NoopTransport()                  # 最终兜底
```

这是**策略模式 + 优雅降级**。`Alchemy` 类不知道底层走的是 Unix socket 还是 HTTP 还是 noop——对上层 API 完全透明。`_probe_unix_socket()` 用 2 秒超时非阻塞探测，避免在不可达的 socket 上挂起。

**Context Manager 与装饰器的双入口**

```python
# 入口一：Context Manager
with Alchemy() as al:
    al.log(step, total, loss=loss)
# __exit__ 自动调 done()

# 入口二：Decorator
@al.managed(total_steps=500_000)
def train(ctx):
    ...
# decorator 自动调 done()
```

两种风格服务不同场景：context manager 适合轻量使用，decorator 适合完整生命周期管理。都保证 `done()` 一定被调用——即使训练代码抛异常。

### 12-Factor 初始化

```python
class Alchemy:
    def __init__(self):
        self._task_id = os.environ.get("ALCHEMY_TASK_ID")
        self._managed = self._task_id is not None
        self._params = json.loads(os.environ.get("ALCHEMY_PARAMS", "{}"))
```

构造函数零参数。所有配置从环境变量读取。这是 12-factor app 的经典模式——进程不关心自己是怎么被启动的，只关心环境变量里有什么。这使得同一个训练脚本在本地 `python train.py` 和 Alchemy managed 模式下都能运行，行为由环境决定。

### SDK 的"不做什么"

SDK 刻意不做以下事情：

1. **不调用 `torch.save()`** — `checkpoint(path)` 只注册，不保存
2. **不修改模型权重** — 所有 report 方法返回 `None`
3. **不缓存训练状态** — 没有隐藏的 SDK 内部状态需要恢复
4. **不抛影响训练的异常** — `transport.send()` 吞掉所有异常

这意味着：从 SDK 的角度看，训练代码是纯的。SDK 只是一个单向的观测通道（report out）加两个控制信号（`param()` in, `should_stop()` in）。训练的正确性不依赖 SDK 的正确性。

---

## 10. Managed Values：零侵入的状态托管

### 核心洞察

训练代码里有两类状态：**配置**（param，只读）和**产出**（权重/指标/图片，可变）。`param()` 解决了配置注入，但产出的保存和恢复仍然是用户的负担——每个项目都在重复写 `if resume: load_state_dict(...)` 的样板代码。

Managed values 的设计目标：**让用户写出来的代码，和没有 alchemy 时几乎一样。**

### Descriptor 协议

```python
from alchemy_sdk import Alchemy, managed

al = Alchemy()

class train:
    model     = managed.Torch()       # nn.Module / Optimizer / 任何有 state_dict 的对象
    optimizer = managed.Torch()
    step      = managed.State(int, default=0)   # 任意 Python 对象
    scores    = managed.Json()         # dict/list → JSON 序列化
    fig       = managed.Image()        # PIL Image → artifact
    data      = managed.Numpy()        # ndarray → .npy
    pretrain  = managed.Input("pretrain.model")  # 跨任务引用
```

每种类型只是序列化策略不同：

| Descriptor | 存 | 恢复 | 适用对象 |
|-----------|-----|------|---------|
| `Torch()` | `state_dict()` | `load_state_dict()` | nn.Module, Optimizer, Scheduler, GradScaler |
| `State()` | pickle | pickle.load | int, dict, 自定义类 |
| `Json()` | `json.dump` | `json.load` | 可 JSON 序列化的数据 |
| `Numpy()` | `np.save` | `np.load` | ndarray |
| `Image()` | `PIL.save` | — (artifact, 只存不恢复) |
| `Input()` | — | 从另一个 task 的输出读 | 跨 task DAG |

### Python Descriptor 实现

```python
class Torch:
    def __set_name__(self, owner, name):
        self.name = name   # Python 自动注入属性名

    def __get__(self, obj, objtype=None):
        return obj._managed_values[self.name]

    def __set__(self, obj, value):
        obj._managed_values[self.name] = value
        obj._try_restore(self.name, value)  # 有 checkpoint → 自动恢复
```

`__set_name__` 是关键——Python 在 class 定义时自动调用，把 `"model"`、`"optimizer"` 等属性名注入 descriptor。用户不需要写任何字符串映射。

### 对比：有 alchemy vs 没有 alchemy

```python
# ── 没有 alchemy ──────────────────────────────────
model = MyModel(hidden=256)
optimizer = Adam(model.parameters(), lr=1e-3)
if resume_path:
    ckpt = torch.load(resume_path)
    model.load_state_dict(ckpt["model"])
    optimizer.load_state_dict(ckpt["optimizer"])
    start = ckpt["step"]
else:
    start = 0

for step in range(start, 500_000):
    loss = train_step(model, batch)
    if step % 50_000 == 0:
        torch.save({"model": model.state_dict(),
                     "optimizer": optimizer.state_dict(),
                     "step": step}, f"ckpt_{step}.pt")


# ── 有 alchemy ────────────────────────────────────
@al.managed(total_steps=500_000, checkpoint_every=50_000)
def train(ctx):
    ctx.model = MyModel(hidden=ctx.param("hidden"))
    ctx.optimizer = Adam(ctx.model.parameters(), lr=ctx.param("lr"))
    # 没了。resume 是透明的。

    for step in ctx.steps(ctx.step):
        loss = train_step(ctx.model, batch)
        ctx.log(loss=loss)

        if ctx.should_checkpoint():
            ctx.save()   # 自动存所有 managed values，原子写入

train()
```

差异只有 `ctx.` 前缀和 `ctx.param()`。心智负担接近零。

### 赋值即注册

`__set__` 触发两件事：

1. **注册到托管表**——`ctx.save()` 时自动遍历所有已注册对象，各自用自己的序列化协议存储
2. **尝试恢复**——如果 checkpoint 目录存在该属性名对应的文件，立即调用 `load_state_dict()`（Torch）或反序列化（State/Json/Numpy）

用户不需要知道 resume 的存在。赋值的瞬间，alchemy 已经决定了这是新建还是恢复。

### `Input()`：跨任务的 managed value 引用

```python
class eval:
    model = managed.Input("train.model")   # 读取 train 任务的 model 输出
```

`Input("train.model")` 声明了一条 DAG 边：eval 任务的 `model` 来自 train 任务的 `model` 输出。调度器看到这条依赖后，自动：

1. 确保 train 完成后再调度 eval
2. 把 train 的 checkpoint 路径注入 eval 的环境
3. eval 的 `ctx.model` 拿到的是 train 产出的权重

训练产出 → eval 输入，DAG 自动成型。

---

## 11. Experiment：假说驱动的实验管理

### 问题

Grid 解决了"批量提交"，但没解决"这组实验到底成功了没有"。用户提交 18 个 task（6 ctx × 3 seed），完成后要手动拉 JSON、对数字、判断哪些配置达标。这是最大的痛点——实验的成功标准在用户脑子里，不在系统里。

### 核心抽象：Experiment = 假说 + 证据

```python
exp = al.experiment("ctx_scaling_atari",
    description="context length 对 Atari z_rule 质量的影响",
    criteria={
        "silhouette_l2": "> 0.3",
        "nmi":           "> 0.1",
        "convergence":   "loss < 0.5",
    },
    matrix={
        "ctx_len": [16, 32, 64, 128, 256, 512],
        "seed":    [42, 123, 789],
    }
)

@exp.task(total_steps=500_000, eval_every=10_000)
def train(ctx):
    ctx.model = JEMAModel(ctx_len=ctx.param("ctx_len"))
    ctx.optimizer = Adam(ctx.model.parameters())
    for step in ctx.steps():
        ...
        if ctx.should_eval():
            metrics = evaluate(ctx.model)
            ctx.log_eval(metrics)  # ← server 自动校验 criteria
```

### 三层结构

```
Experiment
  ├── criteria{}          注册时声明，不可变
  ├── matrix{} → Grid     复用现有笛卡尔积逻辑
  └── tasks[]             每个 task 完成时自动校验
```

### 数据模型

```typescript
interface Experiment {
  id: string;
  name: string;
  description?: string;
  criteria: Record<string, string>;   // "metric": "op value"
  grid_id: string;                    // 关联的 grid
  status: "running" | "passed" | "partial" | "failed";
  results: {
    [taskId: string]: {
      passed: boolean;
      details: Record<string, {
        value: number;
        threshold: string;
        ok: boolean;
      }>;
    };
  };
  created_at: string;
}
```

### Criteria 表达式

支持简单比较运算：

| 表达式 | 含义 |
|--------|------|
| `"> 0.3"` | metric > 0.3 |
| `"< 0.5"` | metric < 0.5 |
| `">= 0.3 && < 0.8"` | 区间 |
| `"top_k(3)"` | 该 metric 在所有 task 中排前 3（相对标准） |

### 校验时机

`log_eval()` 到达 server 时，自动触发 criteria 检查：

1. 解析 criteria 表达式
2. 用最新 eval metrics 逐条校验
3. 更新 `experiment.results[taskId]`
4. 重新派生 experiment.status（全部 passed → "passed"，部分 → "partial"）
5. 状态变化时发 Discord 通知

### 总览视图

```
ctx_scaling_atari          12/18 passed  ██████████░░░░ 67%
├─ ctx16  s42 ✓  s123 ✓  s789 ✗ (sil=0.18)
├─ ctx32  s42 ✓  s123 ✓  s789 ✓
├─ ctx64  running...
└─ ...
```

### 与现有系统的关系

- Experiment **包含** Grid，不替代
- Grid 的 CRUD、调度、重试逻辑完全不变
- `log_eval()` 已存在，server 侧加 criteria hook
- SDK 新增 `al.experiment()` 返回带 `.task()` 装饰器的对象
- Web 新增 ExperimentsPage，复用 GridsPage 的 task 表格组件

---

## 附记：设计演进的痕迹

代码里有几处"遗留"设计值得关注：

`reliable.ts` 里存在 `@deprecated` 的 `getOrCreateEmitter()`、`destroyEmitter()`：

```typescript
/** @deprecated Use registerStubSocket instead */
export function getOrCreateEmitter(...) { ... }
```

这说明之前有一层自定义的 seq/ack/nack 协议，v2.1 重构为 socket.io 原生 ack。旧接口保留了向后兼容的空实现。

`daemon.py` 里的 `_handle_task_signal()`：

```python
async def _handle_task_signal(self, data: dict) -> None:
    # Legacy handler kept for backward compatibility — currently a no-op.
    pass
```

信号机制被简化了，但 handler 保留防止服务器发来旧格式事件时报错。

这种演进模式（保留 no-op 兼容层）使系统可以在不中断线上服务的情况下做协议升级。
