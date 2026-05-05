# Alchemy v2 — 设计哲学

> 一个 GPU 训练编排系统的架构决策与设计原则。

---

## 目录

1. [架构总览](#架构总览)
2. [纯函数思维](#纯函数思维)
3. [任务生命周期](#任务生命周期)
4. [防御性编程](#防御性编程)
5. [传输层降级](#传输层降级)
6. [调度器：硬约束与软评分](#调度器硬约束与软评分)
7. [状态持久化](#状态持久化)
8. [幂等与去重](#幂等与去重)
9. [可靠消息传递](#可靠消息传递)
10. [信号语义](#信号语义)
11. [日志哲学](#日志哲学)

---

## 架构总览

```
┌──────────┐      socket.io       ┌──────────────┐      unix socket      ┌──────────┐
│  Web UI  │◄────────────────────►│    Server     │◄─────────────────────►│  Stub(s) │
│ (React)  │    /web namespace    │ (Node/Express)│    /stubs namespace   │ (Python) │
└──────────┘                      └──────┬───────┘                       └────┬─────┘
                                         │                                    │
                                   ┌─────┴─────┐                    ┌────────┴────────┐
                                   │ state.json │                    │  GPU Processes   │
                                   │ (atomic)   │                    │  + SDK (Python)  │
                                   └───────────┘                    └─────────────────┘
```

三层分离：**编排（Server）**、**执行（Stub）**、**观测（SDK）**。

Server 是唯一的状态权威。Stub 是无状态的执行器——断线重连后通过 `resume` 事件同步全部本地状态，Server 做 reconciliation。SDK 是纯旁路观测，永远不影响训练逻辑的执行。

这种分层的核心原则：**任何一层挂掉，其他层继续工作。** Server 挂了，训练照跑；Stub 挂了，Server 标记 `lost` 等重连；SDK 挂了，训练不受影响。

---

## 纯函数思维

Alchemy 不是函数式语言写的，但多处采用了「纯函数」的设计直觉——**给定输入，输出确定，无隐式副作用**。

### 调度评分：`scoreStub(stub, task) → number`

调度器的核心是一个纯函数。给定一个 stub 和一个 task，返回一个分数。没有外部状态依赖，没有随机性，不修改任何东西。

```typescript
// 硬约束：不满足直接 -Infinity（拒绝）
if (stub.status !== "online") return -Infinity;
if (task.requirements?.gpu_mem_mb > availableVram(stub)) return -Infinity;

// 软评分：0-80 区间内的偏好
let s = 0;
s += 40 * idleRatio;         // 偏好空闲节点
s -= 10 * queueDepth;        // 惩罚堆积
s += 20 * gridLocality;      // 偏好同 grid 共址
s -= vramWaste / 1000;       // 惩罚过度分配
return s;
```

这不是巧合。调度是系统中最容易出 bug 的地方——如果评分函数有副作用或隐式状态，debug 时你永远不知道「为什么这个任务被分到了那台机器」。纯函数意味着可以在任何时刻用同样的输入重现同样的决策。

### 命令组装：`assembleCommand(task) → string`

给定 task 的 script、args、env，输出 shell 命令字符串。纯映射，无副作用。用于展示和日志，实际执行走 subprocess 环境注入。

### 参数不可变：`params` 的防御性拷贝

```python
@property
def params(self) -> dict[str, Any]:
    return dict(self._params)  # 每次返回新 dict
```

SDK 暴露给训练脚本的 `params` 永远是防御性拷贝。训练脚本拿到的 dict 随便改，不会污染 SDK 内部状态。这是纯函数思维的变体：**对外暴露的数据是值，不是引用。**

### 指纹计算：`computeFingerprint(input) → hash`

```typescript
const parts = [input.script, sortKeys(input.args), input.raw_args, sortKeys(input.param_overrides), input.cwd];
return sha256(parts.join("\0")).slice(0, 16);
```

同样的 script + args + params + cwd，永远算出同一个 fingerprint。纯函数。用于去重和幂等——两次提交同样的任务，系统知道它们是同一个。

### 状态转换函数

```typescript
// task-actions.ts 中的每个 action 都是：
// (currentState, event) → newState
export function startTask(stubId, taskId, pid): Task {
  return store.updateTask(stubId, taskId, {
    status: "running",
    started_at: now(),
    pid,
  });
}
```

虽然 `store.updateTask` 有副作用（写 store），但 **状态转换逻辑本身是确定的**。给定当前状态和事件，新状态可预测。所有状态变更都收敛到 `task-actions.ts` 一个文件，而不是散落在代码各处。

---

## 任务生命周期

### 状态机

```
pending ──→ queued ──→ dispatched ──→ running ──→ completed
   │           │           │            │  ↑         
   │           │           │            ↓  │         
   │           │           │          paused          
   │           │           │            │             
   ↓           ↓           ↓            ↓             
 killed      killed      failed      failed          
                                        │             
                                       lost ──→ recovered → running
                                        │
                                        ↓
                                   (retry if max_retries)
```

九个状态，每个转换都有明确的触发条件和唯一的执行路径。

**设计原则：状态转换是单向的，终态不可逆。**

`completed`、`failed`、`killed` 是终态。到达终态的任务被移入 archive，释放所有资源（写锁、fingerprint 引用、调度槽位）。没有「从 completed 回到 running」的路径——如果需要重跑，创建新任务（`retry`），保留 `retry_of` 引用。

这避免了分布式系统中最常见的 bug 类型：**状态回退导致的不一致**。

### 生命周期阶段的职责分离

| 阶段 | 决策者 | 做什么 |
|------|--------|--------|
| `pending` → `queued` | **Scheduler** | 选择最优 stub |
| `queued` → `dispatched` | **Server** | 计算 run_dir，发送 task.run |
| `dispatched` → `running` | **Stub** | fork 进程，上报 PID |
| `running` → `completed/failed` | **Stub** | 监控退出码 |
| `running` → `killed` | **Server** | 发起 kill chain |
| `*` → `lost` | **Server** | stub 心跳超时 |
| `lost` → `recovered` | **Server** | stub 重连，resume 恢复 |

每个阶段只有一个决策者。不存在「Stub 和 Server 同时决定任务该不该跑」的歧义。

### Kill Chain：SIGTERM 优先

旧流程（过度工程）：
```
Server → socket should_stop 信号 → 等待轮询 → SIGTERM → 等待 → SIGKILL
```

新流程（Unix 哲学）：
```
Server → Stub SIGTERM task PID → grace period → SIGKILL
```

SDK 注册 SIGTERM handler，设 `_stop_flag = True`。训练脚本通过 `al.should_stop()` 检查这个 flag。整条路径用的是 Unix 标准信号机制，不依赖 socket 轮询。

SLURM preempt、手动 cancel、Server kill chain——全走同一条 SIGTERM 路径。**一个机制覆盖所有场景。**

---

## 防御性编程

### 原则一：故障不扩散

SDK 的所有 IO 操作都包在 try/except 里，永远不 crash 训练脚本：

```python
def log(self, step, total, loss=None, metrics=None):
    try:
        self._transport.send("progress", {...})
    except Exception:
        pass  # 日志丢了不要紧，训练不能挂
```

但参数查询不一样——`al.param("lr")` 如果 key 不存在且没给 default，**直接 crash**。这是有意的：

```python
def param(self, key, default=_MISSING):
    if key not in self._params:
        if default is _MISSING:
            raise KeyError(f"param '{key}' not found")  # 快速失败
        return default
    return self._params[key]
```

**设计直觉：观测数据丢失是可容忍的（soft failure）。配置错误是不可容忍的（hard failure）。**

训练跑了 3 天少了几个 log 点无所谓。但 `lr` 参数打错了字跑 3 天，不可接受。

### 原则二：原子写入

```typescript
// Server 持久化
async function saveState(state: State): Promise<void> {
  const tmp = statePath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state));
  await fs.rename(tmp, statePath);  // 原子替换
}
```

```python
# Stub 磁盘所有权标记
def claim_run_dir(path, fingerprint):
    tmp = path / ".alchemy_owner.tmp"
    tmp.write_text(fingerprint)
    tmp.rename(path / ".alchemy_owner")  # 原子
```

write → rename 是文件系统级原子操作。进程在 write 和 rename 之间崩溃？临时文件留在磁盘上，下次启动忽略。不会出现写到一半的 state.json。

### 原则三：Preflight 验证

任务 spawn 之前，先跑一遍 preflight check：

```python
def preflight(task):
    errors = []
    if not run_dir.is_writable():
        errors.append("run_dir not writable")
    if not python_env_exists(task.python_env):
        errors.append(f"python env '{task.python_env}' not found")
    if owner_mismatch(run_dir, task.fingerprint):
        errors.append("run_dir owned by another task")
    if errors:
        emit("preflight.fail", errors)  # Server 标记 failed
        return False
    return True
```

不在运行时发现问题，在启动前发现。快速失败，清晰错误。

### 原则四：错误分类

训练脚本崩了，不只是报个 exit code。Error classifier 分析退出码 + 最后 50 行日志：

```python
def classify_failure(exit_code, last_lines):
    if exit_code in (-9, 137):  return "OOM"
    if exit_code in (-15, 143): return "SIGTERM"
    if "CUDA out of memory" in text: return "OOM"
    if "NCCL error" in text: return "CUDA_ERROR"
    if "Traceback" in text: return "PYTHON_ERROR"
    return "UNKNOWN"
```

OOM 和代码 bug 的处理策略完全不同。OOM 可以自动重试（换小 batch）；代码 bug 重试一百次也没用。分类让自动化决策成为可能。

### 原则五：写锁防冲突

```typescript
// 不允许两个活跃任务写同一个目录（或其子目录）
function acquireWriteLock(runDir: string, taskId: string): boolean {
    for (const [lockedDir, lockOwner] of writeLocks) {
        if (runDir.startsWith(lockedDir) || lockedDir.startsWith(runDir)) {
            return false;  // 前缀冲突
        }
    }
    writeLocks.set(runDir, taskId);
    return true;
}
```

Grid search 可能生成几十个任务写相似路径。写锁用前缀匹配检测冲突：`/data/exp1` 和 `/data/exp1/run3` 互斥。简单但有效。

---

## 传输层降级

SDK 和 Stub 之间的通信有三层 fallback：

```python
def make_transport(task_id, stub_socket, server):
    # 1. Unix socket — 微秒级延迟，零网络开销
    if stub_socket and _probe_unix_socket(stub_socket):
        return UnixSocketTransport(stub_socket, task_id)

    # 2. HTTP — 走网络，但总是可用
    if server:
        return HttpTransport(server, task_id)

    # 3. No-op — 独立模式，什么都不做
    return NoopTransport()
```

**设计直觉：通信是可选的，训练是必须的。**

如果 Unix socket 坏了（Stub 重启、权限问题），降级到 HTTP。HTTP 也不通？降级到 no-op。训练脚本的 `al.log()` 调用永远成功——只是数据可能到不了 Server。

三个 transport 实现同一个接口，调用方无感知。这是策略模式的经典应用，但动机不是「扩展性」，是**生存性**。

---

## 调度器：硬约束与软评分

调度决策分两层：

### 硬约束（不满足 = 不可能）

```
stub 离线          → -Infinity
GPU 显存不足        → -Infinity
GPU 型号不匹配      → -Infinity
CPU 内存不足        → -Infinity
Python 环境缺失     → -Infinity
并发槽位已满        → -Infinity
标签不匹配          → -Infinity
```

硬约束返回 `-Infinity`。不是 -100，不是 -999，是负无穷。**任何软评分都无法覆盖硬约束。** 这在数学上是严格的——不需要特殊的 if/else 分支来处理「硬约束失败但软评分很高」的情况。

### 软评分（满足 = 偏好）

```
空闲率           → +0~40 分（偏好空闲节点）
队列深度         → -10/任务（惩罚堆积）
Grid 共址        → +20 分（数据局部性）
显存浪费         → -waste/1000（避免大炮打蚊子）
```

软评分是「在所有可行方案中选最优」。两台 A100 都能跑你的任务，但一台空闲一台满载——选空闲的。

**为什么不用复杂的约束求解器？** 因为 GPU 集群的调度约束几乎都是线性的，O(tasks × stubs) 的贪心扫描完全够用。简单到能在脑子里模拟的算法，比正确但不可调试的优化器更有价值。

---

## 状态持久化

### 内存优先，磁盘兜底

```
内存 Store（权威）
    ↓ 60s 快照
  state.json（原子写入）
    ↓ 30min 备份
  backups/state_{timestamp}.json（保留 48 份）
```

Server 重启时从 state.json 恢复。如果 state.json 损坏（理论上不可能，因为原子写入），用最近的 backup。

**为什么不用数据库？**

因为整个系统的状态（几百个任务 + 几十个 stub）序列化后不超过几 MB。JSON 文件 + 原子写入的可靠性不亚于 SQLite，但运维复杂度为零。没有 migration，没有 schema 版本，没有连接池。`cat state.json | jq` 就是你的 debug 工具。

当状态规模增长到需要数据库的时候再迁移——但那一天可能永远不会来。**YAGNI（You Ain't Gonna Need It）是这个决策的核心。**

### 归档分离

终态任务从 active store 移入 archive。active store 只包含「还需要关注的」任务。这保证了调度器的扫描速度——不需要跳过几千个已完成的任务。

---

## 幂等与去重

### Fingerprint 去重

同一个 script + args + params + cwd 的组合，在系统中只允许一个活跃实例。

```
提交任务 → 计算 fingerprint → 查 fingerprintIndex
    → 已存在活跃任务？拒绝，返回冲突的 task_id
    → 不存在？创建，注册 fingerprint
```

这防止了最常见的操作失误：手抖双击提交、脚本 bug 循环提交、网络重试导致重复。

### 幂等缓存

```typescript
// 60 秒内重复提交同样的任务 → 返回缓存的 task_id
if (idempotencyCache.has(key) && age < 60_000) {
    return { task_id: cached_id, deduplicated: true };
}
```

幂等和去重是两个不同的机制：
- **去重**：基于 fingerprint，防止逻辑重复（同参数的任务不该跑两次）
- **幂等**：基于时间窗口，防止操作重复（同一次提交不该创建两个任务）

---

## 可靠消息传递

### Stub ↔ Server 通信

关键事件（task.run、task.kill）使用 socket.io 原生 ack 机制：

```typescript
// Server → Stub：发送 + 等待确认
async function reliableEmit(socket, event, payload) {
    for (let i = 0; i <= MAX_RETRIES; i++) {
        try {
            await emitWithAck(socket, event, payload);  // 10s 超时
            return;
        } catch {
            await sleep(3000);  // 重试间隔
        }
    }
    logger.error("gave_up", { event });
}
```

非关键事件（progress、log）不走可靠通道——丢了就丢了。

**设计直觉：区分「必须到达」和「尽力而为」。** 不要给所有消息加可靠性保证，那会把系统拖慢到不可用。只对状态变更消息保证送达。

### Resume 即全量同步

Stub 每次连接（首次 / 重连 / 热重启）都发送完整的本地状态：

```python
resume_payload = {
    "running_tasks": [{task_id, pid, step}, ...],
    "dead_tasks": [{task_id, exit_code}, ...],
    "local_queue": [task_id, ...],
}
```

Server 对比自己的记录，做 reconciliation：
- Server 记录 running，Stub 说 dead → 处理退出
- Server 记录 dispatched，Stub 说不知道 → 重新 dispatch
- Server 记录 killed，Stub 说还在跑 → 再发一次 kill

这是 **state reconciliation** 模式——不依赖事件的有序到达，而是周期性地对齐全量状态。在不可靠网络中，这比 event sourcing 更健壮。

---

## 信号语义

### `should_stop()` = SIGTERM flag

```python
class Alchemy:
    def __init__(self):
        self._stop_flag = False
        signal.signal(signal.SIGTERM, self._handle_sigterm)

    def _handle_sigterm(self, signum, frame):
        self._stop_flag = True

    def should_stop(self) -> bool:
        return self._stop_flag
```

一个 bool flag，一个 signal handler。覆盖所有停止场景：
- SLURM preempt → SIGTERM
- 用户手动 cancel → Server kill chain → SIGTERM
- OOM → SIGKILL（直接死，不需要优雅退出）

不需要 socket 轮询，不需要心跳查询，不需要 server 推送信号。**Unix 已经设计好了这套机制，用它就行。**

### 已废弃的信号

`should_checkpoint()` 和 `should_eval()` 曾经允许 Server 远程触发 checkpoint / eval。实际没人用——训练脚本自己知道什么时候该 checkpoint。这是过度设计的典型案例：在 Server 端实现了一个没有用户的功能。

### 通知分级

```python
def notify(self, msg, level="info"):
    # debug:  log_buffer only
    # info:   log_buffer + web UI
    # warning: + Discord (黄色 embed)
    # critical: + Discord (红色 embed + @mention)
```

不是所有通知都需要打断人。`debug` 和 `info` 是被动的（你去看才看得到）。`warning` 和 `critical` 是主动的（推到你面前）。分级通知的意义是**降低噪音、提升信噪比**。

---

## 日志哲学

### 结构化日志

```typescript
logger.info("scheduler.dispatch", { task_id, stub_id, score });
logger.warn("reliable.retry", { event, attempt, max: MAX_RETRIES });
logger.error("store.save_failed", { error: String(err), path: statePath });
```

事件名是 `namespace.action` 格式。payload 是 key-value 对。不用 `console.log("Dispatching task " + id + " to stub " + stubId)`——那种日志不能 grep、不能统计、不能告警。

### Fire-and-forget 通知

```typescript
notifyCompleted(task).catch(() => {});
```

Discord webhook 调用永远是 fire-and-forget。失败了记个 warn 日志，不重试。通知不是核心功能——不能因为 Discord API 限频就阻塞任务状态转换。

---

## 总结

Alchemy 的设计哲学可以归结为几句话：

1. **纯函数优先**：评分、指纹、命令组装——能做纯的就做纯的
2. **状态转换集中**：所有 mutation 经过一个入口，可审计可追踪
3. **防御性不对称**：配置错误 crash，观测丢失忽略
4. **降级而非崩溃**：传输层三级 fallback，通知 fire-and-forget
5. **Unix 哲学**：用 SIGTERM 不造信号，用文件不造数据库
6. **YAGNI**：JSON 文件够用就不上数据库，贪心够用就不上求解器
