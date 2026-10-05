# Alchemy 训练框架改造：实施与迁移计划

状态：**待讨论的实施计划；本轮仅审计与文档，没有运行代码改动。**

目标：agent 使用单一实验规格提交、等待、诊断和合作式干预，训练作者通过一个 session/AOP 接入。以[审计报告](../audits/2026-10-05-training-framework-audit.md)及[目标设计](../design/agent-training-framework.md)为依据。

保护约束：不部署/重启生产；不影响在跑任务；保持 server 任务状态权威、已有实验结果契约及资源硬约束。旧协议不能静默改变环境或目录含义。不要在第一批引入新分布式平台、自动环境安装或新 capacity 自动策略。

实施推荐按以下六个切片推进。先交付 0–2，已经能解决大部分远端启动诊断成本；3–4 补齐训练控制与恢复；5 完成 agent 接入与旧路径退出。这个顺序是依赖关系，不是工期承诺。

## 0. 封住提交与训练结果的危险路径

涉及：
- `server/src/api/experiments.ts` DAG admission；`server/src/store/index.ts` 事务/内存状态发布；`server/src/store/schema.ts` 幂等唯一性（需要时迁移）。
- `sdk/alchemy_sdk/experiment.py`、`submit.py`：稳定请求 key 与结构化提交异常。
- `sdk/alchemy_sdk/managed.py`、`client.py`、`preflight.py`：显式 resume、隔离目录、恢复步数、writes 传递、按设备要求检查。
- 现有 `server/src/__tests__/experiments-lineage.test.ts`、`sdk/tests/test_experiment_submit_payload.py`、`test_preflight.py`、`test_client.py`；新增 `sdk/tests/test_managed_lifecycle.py`。

行为：
1. 全图先验证，预分配 ID，拓扑顺序不再是调用者隐含责任。DB 原子提交成功后才发布内存队列/事件；中途异常回滚。明确内存 store 与 SQLite 一致性，不能只给外层函数加 transaction 名称。
2. SDK 暴露 request key，客户端不确定结果使用同一 key 查询/重试。服务端事务保护 key 唯一性；同 key 不同 payload 返回 409。
3. 停止默认从公共目录自动恢复；新任务目录隔离，已有显式配置不改路径。恢复步数来自 metadata；legacy checkpoint 需要显式兼容输入和提示。
4. AOP writes 真正进入 preflight；CPU 任务不因 torch 存在而强制 CUDA。`__exit__` 异常不报告成功，保留异常并清理。

验收：
- 无序 DAG 成功，缺依赖/环失败且没有任务/grid/experiment/事件残留。
- 注入第 N 次持久写失败，无半提交；重启后可验证。
- 接受请求后丢失响应，同 key 重试只有一个实验；不同 key 可重复实验；冲突 key 不新增任务。
- 两任务使用默认 checkpoint 策略互不读取；99/100 latest、显式 resume next_step、写入中断不发布半文件。
- CPU-only、GPU required unavailable、writes 不可写、训练函数异常均有定向回归。

本切片可独立交付，不等待所有新 API 完成。但涉及终态的新语义只做必要纠错，不提前实现第二套状态机。

## 1. 单一启动规格与环境解析

涉及：
- `sdk/alchemy_sdk/experiment.py::RuntimeProfile/to_spec`。
- `server/src/types.ts`、`task-spec-validation.ts`、`scheduler.ts::buildRunPayload/evaluateStubEligibility`。
- `stub/alchemy_stub/process_mgr.py`、`warm_worker.py`、`env_discover.py`、`config.py`、`daemon.py`。
- 拟新增 `stub/alchemy_stub/launch_spec.py`：有效 env/cwd/argv/路径的唯一构造者。
- SDK/stub/server 的 execution-spec、process manager、scheduler 测试。

行为：
- 冻结最小版本化 schema，区分用户意图与 resolved launch。Python/TypeScript 用同一组 JSON fixture 验证，避免两份手写规则各自演进。
- 明确 profile/task/保留 env 优先级；未知 runtime capability 不能使用默认解释器启动。
- 新协议以直接 argv 和注册解释器为主；legacy shell 作为显式 adapter。
- 先让新进程路径正确，warm opt-in，不让优化路径绕过 launch contract。
- 在 attempt 目录写权限受限的 context file；旧变量单向由同一对象生成。

验收：
- 明确的 available_envs 缺名、列表缺失、注册解释器路径失效分别给出稳定诊断；都不能错误开跑。
- profile/task 冲突、保留 env、PATH 组合、secret 脱敏、cwd 相对解析、argv 空格/引号行为明确。
- 使用配置默认值和任务覆盖启动一个真实子进程，回报允许观测的解释器/env 来源并与 resolved spec 一致；不能只测字典函数。
- legacy 普通/warm 若仍支持，契约 fixture 等价；不支持的新能力显式拒绝。

依赖：可与 0 的局部缺陷修复并行设计，合并前明确 request/attempt 身份。

## 2. 统一诊断与分阶段 preflight

涉及：
- `stub/alchemy_stub/preflight.py`、`daemon.py`、`process_mgr.py`。
- `sdk/alchemy_sdk/preflight.py`、`submission_lint.py`、`experiment.py`。
- `server/src/task-spec-validation.ts`、`api/experiments.ts`、`socket/stub.ts`、任务持久字段。
- 拟新增 `stub/alchemy_stub/bootstrap.py`：在选定解释器中运行检查与入口启动。

行为：
- 定义 CheckReport/Diagnostic，统一字段、阶段、结果类型和脱敏；复用已有 scheduler reason codes。
- 本地 validate 不联机、不导入训练代码；server admission 不冒充 remote pass。
- prepare 与检查分开标明副作用；launch preflight 使用真实 argv/cwd/env/设备条件。
- package metadata 优先，声明 import/smoke 有超时。禁止根据任意日志自动执行 repair shell。
- 持久化最后一次检查结果及其有效范围，使 agent 可直接查询而非翻日志。

验收：
- 本地依赖存在而远端选定解释器缺失时，用户训练函数从未运行，返回 dependency 错误。
- 路径不存在、目录只读、设备不满足、错误解释器、import 超时、磁盘不足策略分别定位阶段/字段。
- 没有目标/没有 GPU allocation 返回 unknown/pending，而非 pass；不偷偷申请 Slurm allocation。
- 预检成功后环境变化，启动阶段重新拒绝或报告运行时错误，不能沿用陈旧绿灯。
- 诊断的 secret 值、长期 token、非授权路径内容不会进入响应。

依赖：1 的有效启动规格。完成 0–2 后先做一次本地真实进程闭环，评估是否已经消除主要接入痛点。

## 3. 收敛 session，并接通合作控制

涉及：
- `sdk/alchemy_sdk/client.py`、`context.py`、`transport.py`、`callbacks.py`、`managed.py`。
- 拟新增 `sdk/alchemy_sdk/session.py`，承接生命周期而非增加一个空 facade。
- `stub/alchemy_stub/task_socket.py`、`daemon.py`、`process_mgr.py`。
- `server/src/socket/stub.ts`、`task-actions.ts`、控制 API 和必要持久字段。

行为：
- 一个 session 承接开始、异常、自然退出、合作停止与 finally 清理。
- stop/checkpoint 带 attempt-scoped control ID、确认、去重和截止时间；重连后可恢复未完成请求。
- signal handler 只记录意图；所有重活在训练安全边界执行，恢复原 handler。
- 明确 stopped outcome 与进程 exit code；保留历史状态兼容映射，迟到事件不能覆盖终态。
- metrics 有界异步；关键事件可靠确认，不把 HTTP telemetry-only 当作完整受管能力。

验收：
- 真实进程与真实 Unix socket：stop 到达、checkpoint hook 完成、确认回传、退出 outcome 正确。
- 断线重连、重复/迟到 control、已取消 attempt、server 离线、socket 队列满均有测试。
- SIGTERM 在训练边界完成合作停止，超时后 stub 才强杀；SDK 不在 handler 中写模型。
- 异常保留 traceback，无 success 事件；所有路径关闭线程/socket，重复 close 安全。
- 请求 wait 超时不会自动 cancel 作业。

依赖：0 的正确结果边界、1 的 attempt identity、2 的统一诊断。未通过真实进程验收前，不称“支持可靠 AOP 控制”。

## 4. 可靠 checkpoint / resume 与框架适配

涉及：
- `sdk/alchemy_sdk/context.py`、`managed.py`、`callbacks.py` 与拟新增 checkpoint helper。
- stub 对 checkpoint/result 的验证与可靠事件处理。
- `sdk/tests/test_context.py`、`test_callbacks.py` 和新增恢复故障测试。

行为：
- 显式 save/load hooks 与能力声明；metadata 记录 next_step 和兼容信息。
- 原子发布 checkpoint，限制可信来源，清楚区分存在、完整、可恢复。
- 迁移 ManagedTraining 为 session adapter，停止维护独立循环规则。
- 首先完成单进程与已有框架 callback；DDP adapter 独立门控，不能默默支持一半。

验收：
- 本地小型确定性训练，运行 N 步 → checkpoint → 停止 → 新 attempt 恢复，步数/optimizer/RNG/数据序列按声明契约一致。
- 模拟保存中断、metadata 损坏、版本不兼容、用户 hook 抛错、缺少 hook；均不能报告可恢复。
- 旧 checkpoint 通过显式转换/兼容路径，默认不扫描公共目录。
- 若加入 DDP：至少两 rank 的真实 CPU 分布式 smoke，主 rank/control 协同与完整 shard 发布；GPU 分布式性能和 Slurm 行为仍需单独验证。

依赖：3。0 中的紧急 checkpoint 修复不需要等待本阶段。

## 5. Agent 统一入口与旧实现退出

涉及：
- `sdk/alchemy_sdk/experiments.py`、`submit.py`、`operator_config.py`、`cli/main.py`、包导出。
- server 现有实验 summary/why/results API，不再造平行查询系统。
- `README.md`、`sdk/USAGE.md`、SDK 包 metadata、旧设计文档。
- `stub/alchemy_stub/alchemy_stub/` 及打包/部署引用。

行为：
- 一个 HTTP client/error schema 支撑 SDK 和 CLI；提交返回可 query/wait/why/control 的 handle。
- 复用已有 `ExperimentClient.wait()` 与 summary，扩充诊断而非新建第二套 wait。
- `--json` 与 Python 对象共享 wire shape；request key 本地持久化，agent 重启后可恢复未确定提交。
- 文档只保留一个初学者/agent happy path，例子进入可执行 smoke；修复版本号和 README 打包路径。
- 搜索全部消费者，迁移完再删除重复 stub、旧合并函数和已无用户的 adapter。每个暂留 adapter 写明移除条件。

验收：
- 一个 agent fixture 不 SSH、不直接设置控制 env、不拼激活 shell，即可 validate → submit → wait → why → checkpoint/stop。
- 网络超时 JSON 能区分 outcome unknown 与明确拒绝；相同请求可安全恢复。
- wheel 在隔离环境安装/import，文档最小示例通过；只有一个 canonical stub 包。
- 对照旧 SDK + 新 server、新 SDK + 旧 stub、新全栈组合：兼容或明确 unsupported，没有 silent downgrade。

## 验证运行方式

实施时先确认实际测试文件名与环境，不假定系统 Python 有 pytest。本轮可用入口：

```bash
# sdk/，仅示例已有测试入口；新增测试落地后加入对应文件
uv run --no-sync pytest -q tests/test_client.py tests/test_context.py tests/test_preflight.py

# server/，选择性 suite，避免 full suite 的 tunnel/端口副作用
npm test -- --run src/__tests__/experiments-lineage.test.ts src/__tests__/task-spec-validation-api.test.ts
```

每个切片新增行为需要相应回归，完成后运行受影响包的相关测试与构建。生命周期/E2E 使用隔离 DB、临时目录、localhost、fake worker，无生产 token。Linux/Slurm 特有行为在获准的开发环境验证；不把 macOS 单元测试当作 GPU/Slurm 实测。

## 滚动升级与回退

1. server 先接受版本化字段并保留旧解析；迁移为 additive，先验证备份/恢复。
2. 在隔离环境验证新 stub 的 runtime/preflight/control capability。
3. 新 SDK 只在 capability 满足时提交新规格。旧规格按旧路径执行；旧运行任务不改写。
4. 获得生产授权后，只对新空闲 worker 做 canary；不为更新强杀在跑训练。
5. 失败时停止新协议 admission，新任务恢复旧客户端路径；新协议任务不能被旧 worker 无条件接管。保留新增字段/事件供诊断，不进行破坏性 schema downgrade。
6. 证明没有旧消费者后，另行删除 adapter 与旧字段。

## 实施前需明确的产品选择

本提案推荐：保留现有后端，重做启动与 session 契约；单进程优先；warm 默认关闭但暂不强删；新 API 不承诺 HTTP 完整控制；环境自动安装不进入首批。

这是本轮应讨论的主要设计边界。确认后即可从切片 0 开始，不需要先确定所有内部类名或未来扩展。
