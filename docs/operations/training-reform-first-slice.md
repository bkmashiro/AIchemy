# 训练框架改造：首批已实现行为与迁移注意事项

2026-10-05。本文件描述当前源代码改动，与 `docs/design/agent-training-framework.md` 中尚未实现的完整目标设计分开。没有部署或重启生产。

## 已实现

### 实验提交

DAG admission 先分配所有任务 ID 并解析依赖，再在 SQLite 事务中写入任务、grid、experiment 和创建事件。提交成功后才更新内存索引、发布事件和触发调度。合法 DAG 不要求调用者拓扑排序。

`Experiment.submit()` 默认生成稳定的幂等键，同一个对象重复提交保留此键。显式传入新键表示新一次逻辑提交。跨进程恢复仍需调用者保存 key 和相同规格，本批没有自动请求日志或查询 handle。

```python
from alchemy_sdk import ExperimentSubmissionError

try:
    result = exp.submit(idempotency_key="my-persisted-request-id")
except ExperimentSubmissionError as error:
    print(error.code, error.status, error.outcome, error.request_key)
    # outcome == "unknown"：服务器可能已接受，请保留规格和同一 key。
    # 修复网络后用相同 key 重试，不要盲目生成新 key。
```

SDK 不自动重试。400 类响应为 rejected；网络/响应读取失败等为 unknown。错误类型保持 RuntimeError 兼容，畸形响应不会假装成功。

### SDK 生命周期与 preflight

- `Alchemy.managed(writes=...)` 真正执行输出路径检查。
- 默认不因安装 torch 强制 CUDA。需要 CUDA 时显式 `device="cuda"`，CPU 可写 `device="cpu"`。
- context manager/AOP 异常退出不发送成功 done，保留原异常并清理连接。
- ManagedTraining 合作式停止保存 checkpoint 后清理，正常完成才发送 done。

```python
@al.managed(total_steps=1000, reads=["data/train"], writes=["outputs"], device="cuda")
def train(ctx):
    # 用户训练逻辑
    return {"final_loss": 0.1}
```

这个 preflight 仍在训练 Python 进程中执行，不能等同于提交前远端预检。可靠下行控制协议仍待实现，不能因为 SDK 有 should_stop 就承诺服务器请求一定能到达。

### Checkpoint

默认 managed checkpoint 目录按 task/run 身份隔离，无 task 身份的本地运行使用独立目录。现有执行端未普遍注入 attempt ID，因而当前默认隔离主要是 task 级，不是完整 attempt 级。

新 checkpoint 使用 SDK 标记、格式版本和 next_step；保存先写同目录临时文件再原子替换。恢复从下一步继续，扫描 latest 按数字文件名，不反序列化所有候选来排序。旧 checkpoint 可显式恢复，有兼容警告和文件名步数推断。仅加载可信文件。

### 共享 Bitbucket 挂载目录

新任务的默认 run_dir 为 `{output-root}/{完整 task ID}`，不再复用短 fingerprint。显式/已持久化 run_dir 保留原路径。

目录 `.alchemy_owner` 通过同目录 POSIX 硬链接进行不可覆盖发布。已有 marker 必须同时匹配 task ID、stub ID、fingerprint 才允许复用；其他 owner、legacy 缺字段或不可读 claim 拒绝启动。没有 fingerprint 的任务也会 claim。

这是一份持久所有权声明，不是同一 owner 内的进程互斥锁，也不是支持失效转移的租约。相同 owner 的重复进程需要执行器自身防重；跨 worker 恢复/旧目录接管不自动放行。不要为重跑直接删除 marker，先确认旧 writer 已停止，并优先给新任务新目录、显式引用旧 checkpoint。

**cwd 未静默改动。** 任意脚本若直接在共享 cwd 写 `checkpoint.pt`，仍可能覆盖其他作业。本批对声明在 run_dir 之外的 outputs 记录 warning，但不能拦截未声明的任意文件写入。训练代码应使用 ctx 的 checkpoint/artifact 目录或明确的 run_dir 下输出。

claim 测试是在本机 POSIX 文件系统两个独立进程间执行；真实 `/vol/bitbucket` 挂载的 link/一致性语义尚未实测。对象存储不受此实现保证，硬链接不支持时应拒绝而非退为非原子覆盖。

### Slurm allocation GPU 范围

Slurm GPU 上报按可证明的 allocation 可见标识过滤。GPU UUID 可直接匹配；数字 ID 仅当 CUDA_VISIBLE_DEVICES 与数字 SLURM_JOB_GPUS 集合一致时匹配。MIG、未知映射、请求标识部分匹配、失败/畸形 telemetry 标记未知，不能返回整台主机容量。

scheduler 对 allocation 未知的 GPU 任务返回 gpu_allocation_unknown；CPU-only 的任务不因这个状态被拦截。未升级的旧 Slurm stub 不提供 allocation_known，GPU 任务会等待而非继续按主机容量执行。因此升级时必须先规划新 stub capability，不能只部署 server 后认为老 worker 不受影响。

**可见设备不等于配额。** 这批限制了设备观测范围，没有建立共享 GPU/MIG 的分数显存配额或 cgroup 用量保证。CPU 现有 allocation 内存声明路径保留。真实 Slurm 验证与分数资源契约仍需后续实现。

## 本地验收

主控集成后执行：SDK 全量 455 passed；stub 全量 325 passed、12 skipped，存在一条 daemon shell-exec 测试 coroutine 未 await 的 RuntimeWarning；server 六组定向回归共 186 passed，包含原有 scheduler/socket-stub、实验 admission 和新 allocation 测试。Server TypeScript 构建及 git diff --check 通过。

以上是 macOS 本地执行证据。GPU 检查使用 nvidia-smi 替身，Slurm/MIG/共享挂载尚未实测；跳过项未视作通过。本轮未触发 GitHub Actions，也未部署。

## 尚未完成

- 单一 ResolvedLaunchSpec、context file 与 env 合并的全面收敛；
- 正式 attempt 命名空间、迁移后的跨 worker resume 和安全所有权转移；
- 目标解释器下的分阶段远端 preflight 与统一持久诊断；
- SDK/stub 的可确认下行 stop/checkpoint 控制；
- 有界异步 HTTP telemetry；
- 统一 agent handle/request 恢复流程、完整 session 和 DDP adapter；
- 重复 stub 包清理。

本批是危险路径修复和隔离底座，不是整份改造设计的完成声明。后续按实施计划继续推进，发布前另行获得部署/重启授权。
