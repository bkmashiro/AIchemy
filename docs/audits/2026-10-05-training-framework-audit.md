# Alchemy 训练框架综合审计

日期：2026-10-05。基线：`6d061fef0b160c9ee88e84a76b3148ffadf73457`，本地 `main`。开始时工作区干净，未 fetch；不代表已核对 GitHub 或生产部署版本。

## 结论

Alchemy 已有值得保留的执行基础：server/stub 分工、SQLite 状态、资源调度、实验 DAG、结果契约、研究记录，以及低依赖 Python SDK。当前阻碍 agent 使用的主要问题是同一事实由多层解释：环境、执行参数、目录、完成状态和错误含义没有统一契约。增加更多环境变量或再包一层 CLI，不能消除这些分歧。

建议保留现有后端与调度体系，重做从实验声明到实际启动的接口，并将训练 SDK 收敛为一个显式生命周期的 session。首批价值来自防止重复/半成功提交、阻止错误环境启动、提前给出可修复的诊断、可靠停止与恢复。没有历史故障统计或 GPU 浪费时长数据，本报告不量化节省比例。

阅读顺序：本报告 → [目标设计](../design/agent-training-framework.md) → [实施与迁移计划](../plans/2026-10-05-training-framework-reform.md)。后两份是提案，尚未实现。

## 范围与证据

重点覆盖 SDK/CLI → 实验 API → 调度 payload → stub preflight/process → SDK 训练生命周期 → 上报/终态。查看了已有架构、SDK 和维护路线文档。未做 Web 全面 UX 审计、Slurm 生产实测、完整安全审计、性能基准或全库逐行审查。

证据分级：
- **本地复现**：用隔离探针调用真实 SDK，替换网络/torch 等依赖。
- **源码确认**：追到具体调用与消费者，但未执行对应远端路径。
- **设计缺口**：能力/所有权不足，不声称已发生生产事故。

本轮没有部署、重启、提交远端任务或调用生产 API。只增加本次文档。

## 当前主路径

1. `sdk/alchemy_sdk/experiment.py` 构建规格、合并配置、校验 DAG 和 lint。
2. `sdk/alchemy_sdk/submit.py` 单独实现提交/简化状态 HTTP；`experiments.py` 另有查询、wait、报告；CLI 再有 `ApiClient`。
3. `server/src/api/experiments.ts` 验证请求，依次创建任务、入队，再建立 grid/experiment。
4. `server/src/scheduler.ts` 选择 stub，组合 cwd/env/env_setup/run_dir。
5. `stub/alchemy_stub/daemon.py` 执行 preflight，交给 `process_mgr.py`；普通进程与 warm worker 有不同启动路径。
6. SDK 从 `ALCHEMY_*` 重建参数、目录、transport。AOP、context manager、ManagedTraining、callback 各自处理生命周期。
7. task socket 接收 telemetry；进程退出回报驱动任务终态。SDK `done` 本身不是任务成功的权威。

## 高优先级问题

### A01：DAG 提交失败可能留下已入队任务

**源码确认；高。** `server/src/api/experiments.ts:1417–1478`。

任务按输入顺序创建。若依赖尚未出现在 `refToTaskId`，返回 400；但此前的任务已经 `store.addToGlobalQueue()`。例如 `[root, eval(depends_on=train), train]` 是有效 DAG，却在 root 入队后拒绝。此时 experiment/grid 尚未创建，留下引用未完成实验的任务。SDK 的 DAG 验证检查依赖和环，不保证所有 API 调用者按拓扑顺序提交。

修复应先完成全图验证、分配全部 ID、解析全部依赖，再原子持久化任务/grid/experiment/幂等记录。事务提交之后才发布事件和触发调度。仅在 SDK 排序不能保护 REST 调用者或写入中途异常。需要真实 router + 隔离 store 的失败回归，当前本轮没有运行这个特定复现。

### A02：SDK 未暴露服务端已有的提交幂等契约

**源码确认；高。** `sdk/alchemy_sdk/submit.py:13–65`；`server/src/api/experiments.ts:1353–1372`。

服务端支持 DAG `idempotency_key` 和 payload 冲突 409，SDK 提交参数及 payload 未传该字段。请求已接受但响应丢失时，agent 重跑提交脚本可能再建实验。不能靠名字或 fingerprint 推断“这是同一次提交”。

修复应给一次逻辑提交持久化稳定 key，并支持查询结果或原 key 重试；有意重跑使用新 key。SDK/CLI 共用相同错误和请求契约。还需验证服务端崩溃恢复和并发唯一性，不能把当前数组查询去重当作最终事务保证。

### A03：合作式控制链不完整，生命周期语义分散

**源码确认，异常退出上报另有本地复现；高。**

- `sdk/alchemy_sdk/transport.py:194–229` 等待 signal 消息；`stub/alchemy_stub/task_socket.py:134–211` 当前处理连接只读消息，没有对应下行发送。
- HTTP transport 的 `should_stop/checkpoint/eval` 恒为 False（`transport.py:68–75`），也不读取服务器响应中的信号。
- `stub/alchemy_stub/process_mgr.py:528–562` 终止走进程组 SIGTERM；`sdk/alchemy_sdk/managed.py:180–183` 只安装 SIGUSR1 checkpoint handler。不能依赖文档所说的 SDK SIGTERM stop flag。
- `ManagedTraining` stop 分支保存 checkpoint 后 break，末尾仍调用 `done()`，零退出码走 completed（`managed.py:210–235`，`stub/alchemy_stub/daemon.py:813–824`，`server/src/socket/stub.ts:1108–1120`）。这是补通 stop 后还必须处理的结果语义问题，不能只修传输。
- `Alchemy.__exit__` 不检查异常便调用 `done()`（`client.py:210–211`）。隔离探针确认抛 ValueError 后仍发送 `{"type":"done"}`。这不等于服务器一定误判成功：当前任务终态仍主要来自进程退出。

需要一个 session 管理退出、控制确认和资源关闭，明确自然完成、合作停止、强制取消、失败。已有进程退出事实和实验结果校验应保留。

### A04：checkpoint 默认恢复可能跨任务，latest 选择与恢复步数也不可靠

**源码确认；latest 排序已本地复现；高。** `sdk/alchemy_sdk/managed.py:69–94, 171–201`。

默认 checkpoint 目录是共享 `/tmp/alchemy_checkpoints`，未明确 resume 时会自动读取其中 latest。不同任务使用默认配置时，可能加载另一任务状态。写文件直接覆盖，没有临时文件原子发布。`sorted(Path...)` 按字符串选择 latest，实测存在 `checkpoint_99.pkl` 与 `checkpoint_100.pkl` 时选到 99。显式 `resume_from` 只调用 `load_state`，框架没有同步恢复 `_current_step`；自动恢复则从文件名推断。

必须使用任务/attempt 隔离目录；resume 显式指定兼容 checkpoint。状态记录 next_step、模型/优化器等用户状态、必要的 RNG/数据迭代恢复信息和格式版本；文件完成写入后再发布引用。文件存在不能等同于可恢复，跨任务恢复需用户明确选择。

## 环境与 preflight

### A05：环境发现缺失时仍可能静默回退

**源码确认；中高，触发条件有限。** `server/src/scheduler.ts:278–280, 524–549`。

必须保留一个重要限定：已有 `available_envs` 列表且不包含指定名字时，scheduler 会给出 `python_env_missing`，并非所有未知环境都能启动。缺口在列表缺失的 legacy/unknown 能力状态：eligibility 跳过环境检查，`resolveEnvSetup` 未命中后退回 task/deploy env_setup。任务声明的 Python 环境不再构成启动保证。注册更新允许沿用缺失状态（`server/src/socket/stub.ts:834`）。

建议 unknown 与 missing 分开诊断；受管训练在实际解释器未解析成功前不得启动。不要用增加 shell fallback 修复这个问题。

### A06：warm 与普通进程环境语义不同

**源码确认；中，限 warm 条件路径。** `stub/alchemy_stub/process_mgr.py:384–400, 452–469`；`warm_worker.py:181–190`。

warm 分支要求 pool 已启用、无 `command_argv`、无 task env_setup 且 command 可 runpy。因此不能说所有现代 argv 任务都会触发。该分支只合并 task env/env_overrides，未消费 `ProcessManager.default_env`，也不同于普通路径 `merge_env` 的展开语义。daemon 没有将 default_env 作为同样规则传给 WarmPool。

短期应默认走新进程，保留 warm 作为显式可选能力；若继续维护，必须消费同一个有效启动规格，并证明任务间 module/global/env 隔离。没有端到端收益证据，不建议为长时间训练优先维护这条快路径。

### A07：AOP 的 writes 声明被忽略

**本地复现；中。** `sdk/alchemy_sdk/client.py:217–249`。

`managed(writes=...)` 接收参数，但 `run_preflight(ctx, reads=...)` 不传 writes。探针拦截真实调用，kwargs 只有 reads。用户以为已声明输出检查，实际上直到写入阶段才暴露错误。preflight 自身已有 writes 分支，问题在接线而非缺少检查函数。

### A08：安装了 CPU-only torch 就导致 preflight 失败

**本地复现；中。** `sdk/alchemy_sdk/preflight.py:90–99`。

能 import torch 后无条件要求 CUDA 可用；没有 torch 却跳过检查。因此 CPU 训练被误拒，GPU 任务也未必被正确验证。用替身 torch 模拟 cuda unavailable，确认在用户函数执行前抛 RuntimeError。

设备要求必须来自显式任务声明。preflight 应在选定解释器及实际 CUDA 可见性下执行，区分 CPU、必需 CUDA、可选加速。

### A09：preflight 分散，检查结论没有统一适用范围

**设计缺口。** SDK `dry_run` 检查规格；stub 自检检查 daemon 环境；task preflight 检查部分远端路径；AOP preflight 已经发生在训练 Python 内。它们不是同一个“可运行”保证。

建议报告阶段、执行主机/解释器、spec 身份、检查时间、pass/fail/unknown/skipped。远端最终检查必须在真实目标环境内进行。提交端不能因为自己的路径/torch 正常就宣布 GPU 节点可运行；排队中没有目标节点时，应明确未检查。具体机制见设计文档。

## Agent 接口与维护问题

### A10：HTTP telemetry 同步阻塞且掩盖失败

**源码确认；500 返回行为已本地复现；中。** `sdk/alchemy_sdk/transport.py:47–66`，`client.py:143`。

训练线程中调用 requests，失败后再尝试 urllib，两个请求各设置 5 秒 timeout；不能把它当成严格总计 10 秒上限。requests 响应不检查状态，500 也正常返回。错误最终吞掉，agent 不能区分无新指标与断报。文档却说 non-blocking。

高频指标应有界异步发送、合并和丢弃计数；checkpoint/result/控制确认不能套用同样的静默丢弃策略。是否保留 HTTP 全功能 fallback 要在能力协商中明确，不应冒充 socket 等价替代。

### A11：多套 client 与错误协议增加 agent 分支

**源码确认及设计缺口；中。** `submit.py:67–112`、`experiments.py:220–261`、`cli/main.py` 的 `ApiClient`。

`Experiment.status()` 使用旧的简化状态路径；`ExperimentClient` 已有 resolve、summary、wait 等能力。不能写成“SDK 没有 wait”。真正问题是提交、查询、等待、CLI 错误处理分散，网络失败与 HTTP 验证失败没有统一稳定错误代码，超时后也缺乏明确的 outcome unknown 操作。

复用现有 summary/assignment diagnosis/result validation，向 agent 提供统一的实验 handle 和 JSON 诊断。不要再建立第二套结果状态机或逐条 grep 日志的自动修复器。

### A12：源码与说明存在可直接影响接入的漂移

**本地复现/源码确认；中低。**

- README:97 的 `collect_gpu=True` 不在构造函数签名中，实测 TypeError。
- `sdk/pyproject.toml:7` 为 2.2.0，`sdk/alchemy_sdk/__init__.py:15` 为 2.1.0。
- SDK 打包指定 README.md，但该文件缺失；未运行构建，不声称一定构建失败。
- `DESIGN_PHILOSOPHY.md` 仍含 JSON 状态存储、旧状态名、SIGTERM handler 等过期描述；`docs/experiment-sdk-design.md` 的名称幂等说明与当前显式 key 契约不一致。
- `stub/alchemy_stub/alchemy_stub/` 是 Git 跟踪的第二份实现。当前包入口使用外层实现，没有证据证明内层正在生产执行；它是实际的维护/打包歧义，不应当作两个活跃 runtime 的证据。

## 验证记录

以下由主控实际执行，均为本地检查：

```bash
# sdk/：217 passed
PYTHONDONTWRITEBYTECODE=1 uv run --no-sync pytest -q -p no:cacheprovider \
  tests/test_experiment_spec.py tests/test_experiment_submit_payload.py \
  tests/test_experiment_client.py tests/test_cli.py

# sdk/：167 passed
PYTHONDONTWRITEBYTECODE=1 uv run --no-sync pytest -q -p no:cacheprovider \
  tests/test_client.py tests/test_context.py tests/test_preflight.py \
  tests/test_transport.py tests/test_should_stop.py tests/test_callbacks.py

# server/：52 passed，配置 DB_FILE=:memory:，调度 mock
npm test -- --run src/__tests__/experiments-lineage.test.ts \
  src/__tests__/task-spec-validation-api.test.ts
```

共 436 项现有定向测试通过，另有 6 项缺陷刻画探针通过：writes 丢失、README 参数报错、异常退出仍发 done、99/100 checkpoint 选择、CPU-only CUDA 拒绝、HTTP 500 无异常返回。探针未联网，CPU/GPU 条件是依赖替身，不是硬件测量。

初始直接使用 `sdk/.venv/bin/python -m pytest` 失败：该解释器无 pytest。另一次命令引用不存在的 `test_managed.py`，未运行测试；随后按实际文件清单使用上述命令成功。没有将这两次失败算进通过数。

这些通过数不能证明 A01 的原子性、A02 的超时安全、远端 env 解析或控制下行正确。当前最缺的是跨层契约与真实进程行为测试，而不是单纯增加单元测试数量。

## 改造优先级

1. 先封住半提交、重复提交、跨任务 checkpoint 和错误终态。
2. 单一有效启动规格，环境解析失败关闭启动路径；结构化诊断同时落地。
3. 在选定解释器/实际 cwd/env 下完成 preflight，再进入训练。
4. 一个 session 支撑 AOP、显式 context 和框架 callback；可靠控制与非阻塞观测分开。
5. SDK/CLI 统一 handle、wait、why、日志与错误；迁移后删除重复实现和过期入口。

先不扩大 capacity/campaign 自动化、不替换数据库/服务端语言、不引入新分布式运行平台。这些不能直接修复当前训练接入问题。
