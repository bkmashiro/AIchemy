# Alchemy：面向 agent 的训练与管理框架

状态：**设计提案，未实现**。2026-10-05。依据：[源码审计](../audits/2026-10-05-training-framework-audit.md)。文中新增 API/命令均为候选接口，不可复制为当前可用命令。

## 1. 产品目标与取舍

让 agent 用一份实验声明完成提交、等待、诊断和有限干预，训练作者只负责模型逻辑和明确的恢复钩子。通常不再手写 `ALCHEMY_*`、拼激活 shell、猜远端 cwd、反复 SSH 找错误。

保留 Python SDK、TypeScript server、Python stub、SQLite、现有调度与实验结果模型。最简单可行的替代是只补 CLI 和错误信息；它能改善提示，却无法消除 warm/普通环境分叉、控制链断口和多套生命周期。因此建议重构这些边界，其他基础设施不动。

不建议整库重写、引入 Ray/Kubernetes、自动安装缺失依赖、自动修改训练配置。它们增加迁移和运行负担，尚无本任务需求证明其收益。

这里的 AOP 是显式函数包装和生命周期钩子：在用户训练前检查、训练中记录和合作控制、退出时完成记录。不要全局 monkeypatch torch、自动猜 optimizer 或偷偷接管 dataloader。对任意 Python 训练做到无侵入自动 checkpoint 不现实。

## 2. 三个明确所有者

### 控制端：实验意图与持久状态

Server 拥有实验/任务/attempt 身份、调度、提交幂等、停止意图、结果聚合和权限。SDK/CLI 只是相同契约的客户端。沿用已有 assignment diagnosis、summary、result validation、replacement refs；不再创建并行的“agent 状态”。

### 执行端：实际启动条件与进程事实

Stub 在目标机器解析 runtime、合并 env、分配 attempt 目录、完成准备和检查，然后启动确定的 argv。它报告解释器、cwd、代码身份、检查结果、进程退出与产物事实。server 不用自己机器的 `process.cwd()` 猜远端目录。

### 训练端：一个 TrainingSession

一个 attempt 内一个 session 持有 transport、上下文、hook 和关闭状态。AOP、`with`、Lightning/HF callback 都复用它。训练进度/模型状态归训练代码，实验成功判断归现有 server 结果契约，进程生死归 stub。

## 3. 把环境复杂性收进一个启动规格

在现有 `RuntimeProfile` 上演进，避免同时引入一套同义的用户 profile。序列化规格增加显式 schema version。逻辑上分两种对象：

- **ExperimentSpec**：调用者意图，可本地校验和版本管理，不含秘密值或本机隐式状态。
- **ResolvedLaunchSpec**：stub 已解析的启动决定。记录具体解释器、argv、cwd、代码引用、attempt 路径、环境来源、资源映射和协议能力。server 保存可公开的脱敏投影，训练端读取任务本地上下文。

ResolvedLaunchSpec 是执行参数，不是新的数据库控制平台。只在已有任务/attempt 记录上保存必要字段。

### 环境优先级与边界

新协议唯一顺序：

1. stub 允许继承的基础进程变量，如必要 PATH/locale；
2. 已注册 runtime profile 的普通 env；
3. 显式 task env；
4. stub 所有的保留控制变量与设备映射。

禁止用户覆盖保留变量，发现冲突返回字段级错误，不能静默纠正。runtime/device 字段控制 CUDA 可见性；普通 env 不重复承载调度决策。默认不继承 server token、无关云凭证和其他作业的控制变量。分布式训练需要的通信变量由 launcher adapter 显式声明。

`env_overrides` 迁移时折叠到 task env，保留旧的覆盖顺序并报告冲突来源，新协议只保留一个 task env 字段。普通字符串按字面值处理，不做隐式 `$VAR` 展开。PATH 等确需组合的变量使用受限 append/prepend 字段；legacy adapter 保留旧展开规则但发出兼容诊断，不能在升级时静默改变旧任务含义。

秘密使用引用：stub 在执行前解析，只把值注入进程，不进入实验规格、日志或 diagnostics。第一版可仅支持现有受控本机 secret source，不为此建立独立 vault 产品。

### 解释器、代码与路径

- runtime 名称必须解析到目标节点注册的具体解释器/版本。unknown capability 与 environment missing 分开；二者均不能悄悄用默认 Python 开跑。
- Python 脚本/模块优先直接 argv 执行。支持 conda/venv 时由注册 runtime 提供已解析启动方式，不要求 agent 写 activate 字符串。
- 原始 shell 保留为明确的 legacy/advanced execution kind。其 preflight 可验证范围有限，报告 unknown，不保证可复现。不要让 shell 与 argv 在内部随意互相转换。
- cwd 必须相对于目标 workspace 解析；本地路径不得自动当成远端路径。source 支持显式注册 checkout + commit。第一阶段不自动同步代码、不自动 pip install。
- 用户只选择存储根/策略，stub 按实验、task、attempt 生成隔离目录。逻辑产物引用与机器路径分离，跨节点消费先确认共享存储或显式传输，不凭字符串路径假定可见。
- task 重试创建新 attempt。旧目录只读保留，resume 选择显式 checkpoint，避免 freshness 检查与恢复使用同一目录产生歧义。

### 训练端只保留少量 bootstrap 变量

新 SDK 从 `ALCHEMY_CONTEXT_FILE` 加载 schema-versioned 上下文，从其中获得任务/attempt ID、有效配置、目录和 socket。文件原子写入、限制权限，禁止携带控制端长期 token。旧 `ALCHEMY_PARAMS/RUN_DIR/CONFIG/...` 由兼容层从同一个对象生成，最终淘汰双向读取与各自补默认值。

普通 env 仍可供第三方库使用；目标是减少 agent 需要管理的变量，不是消灭环境变量机制。

## 4. Preflight：检查范围、时机和副作用都可见

所有阶段返回相同 CheckReport，单项结果为 `pass | fail | unknown | skipped`，带 scope、时间、spec 身份、目标节点/解释器。unknown 不显示为绿灯。

### 阶段一：本地规格校验

无联网，不 import 训练入口。校验 schema、DAG、参数类型、互斥项、路径种类、重复输出声明、保留 env 冲突。产出规范化 spec。不能检查目标依赖、设备和文件。

### 阶段二：服务端 admission / 排队解释

校验权限、请求幂等、目标能力与资源约束；没有当前可用节点可以入队，但明确 `pending_target`，不声称 remote preflight passed。已有 `python_env_missing` 等诊断应统一到 CheckReport，而非重写调度评分。

### 阶段三：选定节点后的 prepare + launch preflight

在同一个 ResolvedLaunchSpec 下：

1. prepare 创建受管目录和上下文文件，这一步有明确副作用；
2. 在选定解释器、cwd、最终 env、设备可见性下运行受限 bootstrap 检查；
3. 检查脚本/输入存在、声明的包和版本、存储读写、所需设备、SDK 协议；
4. 成功后进入用户代码；失败输出结构化报告，不导入训练入口，不消耗训练步骤。

可写性实际探针会创建再删除临时文件，包导入也可能有副作用。接口必须标为“执行诊断”，不可声称纯只读。先做静态路径/package metadata 检查，只有显式声明的 import/smoke 才执行，设置超时及资源边界。未知任意训练脚本不能为预检而直接运行。

GPU 初始化检查需要 GPU allocation；没有 allocation 的提前检查只报告硬件能力未知。远端检查不会自动 sbatch、安装环境或占用付费资源。诊断成功也不保证之后内存始终充足，启动前重新验证易变条件。

### 阶段四：训练初始化

装饰器进入用户函数前检查 config schema 与 hooks；用户可提供显式 `validate(ctx)` 做模型相关轻量检查。真实 OOM、数据内容损坏、训练数值发散仍是运行期问题，不能靠 preflight 全部排除。

### 诊断示例（拟议 wire shape）

```json
{
  "schema_version": 1,
  "code": "runtime.python_not_found",
  "stage": "launch_preflight",
  "status": "fail",
  "task_ref": "train",
  "attempt_id": "attempt-example",
  "field": "runtime.python",
  "message": "The selected runtime interpreter is unavailable on this worker",
  "retryable": false,
  "remediation": {"action": "select_registered_runtime", "candidates": ["torch-stable"]}
}
```

脱敏 observed/expected 和字段来源可作为补充。不要让 remediation 是来自日志的任意 shell 命令。自动 agent 只能从受控 action 集合选择，改变依赖/配置/资源需求需要用户或既定策略授权。

## 5. AOP 使用体验与生命周期

以下只是候选 API 示意，类型/名称实施时再冻结：

```python
@alchemy.training(config=TrainConfig, device="cuda", reads=["data/train"])
def train(ctx):
    model, optimizer = build(ctx.config)
    ctx.on_checkpoint(lambda: snapshot(model, optimizer))
    ctx.on_restore(lambda state: restore(model, optimizer, state))
    ctx.restore_if_requested()

    for step in ctx.steps(ctx.config.steps):
        loss = train_step(model, optimizer)
        ctx.log(step=step, loss=loss)

    return {"final_loss": loss}
```

- `ctx.steps` 在安全边界处理请求；任意长时间阻塞的 train_step 不能被 Python 包装器瞬时安全中断。
- 自定义循环可显式调用 `ctx.poll_control()`，框架 callback 在框架允许的位置调用同一逻辑。
- checkpoint/restore 是显式注册 hook。未注册时声明 `checkpoint=false`，请求返回 unsupported，不能假装成功。
- 配置默认值定义在同一 schema，提交前解析并保存实际值。未知 key 拒绝。受管/本地模式使用同一配置规则，避免目前“本地默认成功，远端缺参数”的双重行为。
- local 模式显式选择或无 bootstrap 时使用；若发现受管上下文损坏，立即报错，不静默退为 noop。连接中断则进入可观测的 degraded 状态，不因指标故障杀训练。
- 异常保持原 traceback；装饰器只附加失败记录和 finally 清理，不能吞异常或报 done。session close 幂等，flush 有截止时间，不会无限阻塞退出。
- 迁移期 `Alchemy`、`TrainingContext`、callbacks 是此 session 的薄适配；`ManagedTraining` 不再保留独立 checkpoint/循环规则，最终弃用其继承式 runner。

## 6. 可靠控制与有界观测

### 控制

首先实现 stop 与 checkpoint；eval 复用同一协议但仅在声明 hook 时支持。请求带 `control_id`、attempt ID 和截止时间；状态区分 requested、received、completed、failed、expired。收到请求不等于已保存 checkpoint。

Stub 保存尚未完成的控制请求；重连重送同一 control_id，SDK 去重。完成结果在本地持久化小型记录并确认，重启后不可无依据宣称成功。权限和作用域限当前 attempt，禁止迟到请求影响新 attempt。

SIGTERM/SIGUSR1 handler 只设置标志，不能在异步信号处理器里保存模型。SDK 与框架的 handler 安装/恢复要有所有权；非主线程不能偷偷覆盖进程级 handler。stop 超过 grace period 才强杀。slurm walltime/preemption 走同一请求语义并保留原因。

### 结果与终态

尽量保留当前 task 状态枚举，新增明确 outcome/stop_reason，避免一次迁移改写所有历史状态。进程零退出码、训练自然完成、合作停止、结果验证通过是不同事实。

- 正常完成 + 退出成功 + 必需产物有效，才可满足成功契约。
- 用户请求提前停止，即使 checkpoint 成功且退出码为零，也不自动满足依赖成功条件。
- stop 与自然完成竞争时按持久请求/完成事件和 attempt 顺序判定，不靠最后一条 WebSocket 消息覆盖。
- 迟到 done/completed 不能复活 cancelled/failed attempt。
- DAG 默认只在成功契约满足后推进；“停止后允许 eval”需要显式依赖策略，不能默认执行。

### Telemetry

训练线程只入有界队列，发送线程/任务负责 socket IO。高频进度可合并，记录 dropped_count、last_sent、last_ack 和连接状态。指标停滞不等于进程死掉，heartbeat 与训练进展分开显示。

checkpoint/result/outcome 是低频可靠事件，带事件 ID、确认和有界本地补发存储。存储满或无法持久化时明确报告 degraded/failed，不能套用 metrics 的静默丢弃规则。容量和超时采用可配置工程默认值，先用故障注入与训练吞吐测量确定，不在此虚构性能数字。

首版受管训练优先 SDK ↔ stub Unix socket ↔ server。HTTP fallback 若保留，明确为 telemetry-only 能力，不能提供假的 stop/checkpoint 保证；训练进程无需长期 server 管理 token。

## 7. Checkpoint 与分布式训练边界

checkpoint 发布流程：用户 hook 生成状态 → attempt 临时文件写完 → 同文件系统原子 rename → metadata/最新引用发布 → 通知 stub。需要耐久保证时增加 fsync；跨对象存储不能套用 rename，需要 adapter 的提交语义。

metadata 至少含格式版本、task/attempt、next_step、config/代码兼容标识和文件引用。模型、optimizer、scheduler、RNG、数据迭代位置由训练 adapter 明确负责。通用 SDK 不承诺任意模型的 bitwise resume。pickle/torch.load 只加载可信来源，agent 不应自动反序列化任意远端 artifact。

DDP/torchrun 需单独 adapter：主 rank 报指标/产物，控制在所有 rank 的安全边界协调；checkpoint 可为 sharded 集合，所有 shard 完成才发布。第一批交付单进程闭环，多进程模式在适配前显式 unsupported，不能因为主 rank 可运行就宣布支持分布式恢复。

## 8. Agent 的单一操作流程

拟议流程：

```text
spec.validate()
→ client.preflight(spec, target=...)   # 有目标才做远端诊断
→ client.submit(spec, request_key=...)
→ handle.wait()/snapshot()
→ handle.why()/logs(cursor=...)
→ handle.request_checkpoint()/request_stop()
```

公开 API 实施时优先沿用 Experiment/ExperimentClient 命名，新增 handle 可只是返回值类型，不再增加独立 AgentClient。CLI 调用相同服务，`--json` 输出稳定 schema，stderr 留人类提示。错误统一含 code、phase、retryable、request_id、known outcome；客户端超时用 `outcome=unknown`，不能显示为“服务器已失败”。

submit 的本地请求记录要在发请求前保存，支持 agent 重启后恢复；秘密不写入记录。相同 key 不同规范化 payload 返回冲突。有意重跑生成新 key；身份不是实验名字，内容相同也允许新实验。

snapshot 汇总现有状态、当前 attempt、等待原因、检查结果、控制状态、观测新鲜度与结果校验，避免 agent 为普通排障遍历全部历史实验。复用已有 wait 并明确 timeout 只停止等待，不取消训练。

## 9. 迁移与明确删除项

按 capability/schema version 协商：先 server 接受新字段，再新 stub 支持启动/控制，再 SDK 启用新路径。旧任务保持原执行语义，运行中任务不热切换协议。旧 stub 不具备新能力时，新规格返回 unsupported 或 pending-compatible-worker，不能 silent downgrade。

移除条件满足后删除：

- 内嵌重复 stub 包；先确认打包、部署复制和所有引用不依赖它；
- 多套 env 合并/隐式展开逻辑；
- SDK submit/CLI 重复 HTTP 错误实现；
- ManagedTraining 独立生命周期和共享 checkpoint 默认；
- 旧 env_setup/env_overrides 主路径；兼容 adapter 有明确剩余消费者和退出版本；
- 未经收益验证的 warm 训练默认路径；不要求一次性删除仍有明确用户的 worker 功能。

历史设计文档改为 historical，并提供当前契约入口。保留已有 capacity/campaign 数据与功能，但暂停增加其自动化，直到训练闭环验收。发布、stub 重启、生产 canary 需要单独授权。

## 10. 成功标准

- 常规 agent 任务不直接设置 Alchemy 控制 env，也不写激活 shell。
- 错误环境/配置/路径在用户训练函数执行前被定位到字段和阶段。
- 响应丢失后重试同一提交不会增加任务；失败 admission 不留下任务。
- server 暂时离线不阻塞训练步骤；指标丢失可见，控制请求不会虚假成功。
- stop/checkpoint/resume 具有真实进程验收，失败与提前停止不冒充成功。
- 新旧协议混用的边界可解释，运行中旧任务不受迁移影响。

以上是待验收目标，不是当前产品能力声明。
