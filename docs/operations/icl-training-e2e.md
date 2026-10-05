# ICL 真实训练链路验收

2026-10-05。结论：gpu32/gpu33 上首五组真实链路验收通过，最后一次运行 33 项断言全部通过，10 个任务，耗时 162.04 秒。这里使用真实 SDK、server、SQLite、scheduler、daemon、训练子进程、Unix socket 和共享挂载，不使用这些组件的 mock。

## 运行方式

```bash
cd ~/projects/alchemy-v2
cd server && npm run build && cd ..
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$PWD/sdk" \
  uv run --project sdk --no-sync python tests/e2e/icl_training_e2e.py \
  --evidence "$HOME/.hermes/cache/scratch/icl-e2e-$(date +%Y%m%dT%H%M%S)"
```

执行前确认 SSH 能严格校验访问 `ys25@gpu32/gpu33`（经 gpucluster2）、目标 installed runtime 存在、Mac 测试端口空闲。runner 依赖本机已安装的 server dependencies，不运行 npm install，不启动已有服务。当前 fixture 明确面向这两台 ICL workstation，runtime 常量在脚本中，不能当成任意集群通用启动器。

- `tests/e2e/icl_training_probe.py`：真实 SDK workload，CPU 小循环、路径/版本证明、指标、checkpoint/result、失败和显式恢复。
- `tests/e2e/icl_training_e2e.py`：本机控制、SSH 隧道/远端启动、SDK 提交、回读断言、私有证据和精确进程清理。
- server 新增 `BIND_HOST`：测试设为 127.0.0.1，production 默认行为未改变。

## 隔离与网络

Mac 两个独立测试 server，端口 34127/34130，独立 DB 与空部署配置，tunnel disabled。SSH reverse forwarding 仅绑定目标 loopback，端口 34128/34129/34131。Cloudflare tunnel 未启动，没有修改实际 server 配置或接入历史任务。

gpu32 启动一个测试 daemon；gpu33 启动两个分别连接独立 server 的 daemon，使用不同 default_cwd 分开本地实例锁。所有实例使用已安装 runtime 的绝对 Python `-I -m alchemy_stub`，关闭 warm worker。本轮没有 Slurm allocation，也没有 GPU 计算。

## 实测结果

### 1. SDK 全链路与导入来源

通过 SDK Experiment 提交，真实 scheduler 路由到 gpu32，daemon 启动任务，训练通过 UnixSocketTransport 上报，server 收到 loss/probe_metric 和 eval，结果/checkpoint 路径抵达任务 exports。

单任务 ID：`ef820ff7-5ff7-4209-b799-7e51ba4a2706`。

SDK 来源为共享新 venv 的 `lib/python3.14/site-packages/alchemy_sdk`，不是旧 checkout。解释器、cwd、task ID、显式 env 和 resolved config 均有真实脚本记录。

这里需区分两个契约：Experiment.base_config 被送到 ALCHEMY_CONFIG 的 JSON 文件；Alchemy.params() 读取 ALCHEMY_PARAMS，二者当前并不自动合并。验收分别检查了 resolved config=17，以及 raw task param_overrides 通过 SDK params 到达训练=17，不把它们混为一个接口。

### 2. 两机器并发，同名输出

两个任务真实运行时间重叠，gpu32/33 都复用同一 installed runtime。它们读取同一输入，各写 `result.json` 与同名 checkpoint，但 run_dir 使用不同完整 task ID。结果中的 task ID 与文件目录一致，共享输入内容保持不变。

任务 ID：`a379acf1-86d5-420a-b68c-38bc79a198aa`、`81eac037-2b0b-4e96-91ce-fda740cc6069`。

### 3. 跨 server 共享目录冲突

单 server 先用进程内 admission write lock 返回 409，无法直接用它验证跨 server 的文件 claim。因此本轮额外建立第二个隔离 server，没有关闭或绕过第一层保护。

两个不同 server/daemon 对同一个明确 run_dir 发起任务。实测只有一个 completed，另一个 failed；失败者无训练 PID，日志明确 `run_dir already claimed`，没有生成用户函数 entry marker。胜者结果与任务身份一致，另一任务没有覆盖文件。

强制 run_dir 用当前真实 task API 提交，训练脚本仍用 SDK。当前 Experiment.task 不暴露 run_dir，本测试没有偷偷修改 SDK 的内部 spec 来假装公开支持。

### 4. 失败边界

缺失 reads、writes 父目录不存在时，AOP preflight 拒绝，用户训练函数没有进入。主动抛 RuntimeError 时，函数确实进入，然后任务 failed；未冒充 completed。这里验证的是不存在的写路径父目录，不声称测试了所有文件系统权限配置。

这些预期失败与冲突失败合计 4 个 failed task；其他 6 个 task completed。33 项断言通过不表示 10 个任务都应成功。

### 5. gpu32 → gpu33 checkpoint 恢复

首任务真实执行步骤 0、1、2，发布 checkpoint 引用。runner 从 task exports 获取 `last_checkpoint_path`，不猜文件夹名字。第二任务在 gpu33 新 run_dir 中显式恢复，再执行 3、4、5。

结果 seen 为 `[0, 1, 2, 3, 4, 5]`；无重复、无遗漏、无复用旧 owner 的输出目录。

任务 ID：`acfb41b4-d675-4479-a682-a9aacd79272e`、`d5e6b7ee-ee5a-450a-88c8-443388d942b1`。

## 实测发现并修复的问题

首次用 `gpu_mem_mb=0` 表示 CPU-only 时，API 接受并入队，但 scheduler 判定 invalid_resource_requirement，任务一直 pending。CPU-only 的当前合法表达是省略 GPU requirement。现已统一 SDK 与 server 的数值校验：cpu_mem_mb/gpu_mem_mb 若提供，必须为正的有限数；0、负数、bool、string、NaN/Infinity 在提交前拒绝。

新增测试先在旧实现失败；修复后 SDK 12 个边界回归通过。真实 E2E 进一步证明 tasks/experiments 两条 API 均返回 400，且无 pending task 残留。现有 SDK 原来的“只 warning”测试改为明确拒绝，没有放宽 scheduler 的资源条件。

过程中还纠正了测试自身的几处假设：base_config 不等于 params，读取文本不能用 print 多加换行，checkpoint 路径应回读 exports；macOS SSH control socket 路径还需留出临时后缀空间。早期失败代次保留在私有 evidence 中，没有计为通过。

## 证据与清理

最终本机私有 evidence：

```text
~/.hermes/cache/scratch/icl-e2e-parent-20261005-h/summary.json
```

包含逐项断言、任务 snapshots、metrics、server/daemon 日志和 cleanup 结果。目录权限 0700，测试凭据文件权限 0600。原始日志与 DB 不入 Git，因它们可能包含本轮测试凭据或本机路径。

远端本轮结果目录保留用于检查：

```text
/vol/bitbucket/ys25/alchemy-e2e/icl-e2e-parent-20261005-h
```

runner 停止自己创建的两个 server、三条 forward 和三台 daemon，未用宽泛 pkill。主控另行 SSH 检查 gpu32/33：没有本轮存活训练/daemon 进程，34128/34129/34131 无 listener；本机 34127/34130 无 listener。清理了已知测试 task ID 的临时 config/socket，结果与日志保留，安装环境/旧 checkout/训练数据未动。

## 验证边界

- 没有覆盖 Slurm 多 allocation、cgroup/MIG 或 GPU 模型训练。
- 没有证明任意共享 cwd 相对写入会自动隔离；脚本使用受管 run_dir。
- 没有验证完整合作式 stop/checkpoint 下行和断线重连，这些仍为后续阶段。
- wheel 来源验证针对 installed 环境；显式用户 PYTHONPATH 或自己源码目录的 shadow 仍需启动契约解决。
- 数值校验修复和 BIND_HOST 是当前源代码修改，没有部署生产 server。

本地配套回归：SDK 全量 467 passed；server 7 组定向回归 315 passed，构建通过。真实 E2E 33 passed 是独立证据，不与单元测试数量混算。
