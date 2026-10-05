# ICL SDK / stub / daemon 真实链路验收计划

2026-10-05。状态：首五组已实际执行并通过，结果见 `../operations/icl-training-e2e.md`；第七组断线/控制边界未执行。下文保留实施前的计划与验收约束。

## 目标

用真实 server、SDK submit、两个独立 daemon、真实训练子进程和 Unix task socket，验证包来源、参数/目录/环境传播、指标回传、checkpoint/result 路径、共享存储并发隔离。训练脚本仅做轻量 CPU 循环，不安装 torch、不跑昂贵模型。

不连接已有 production server、不启动 Cloudflare tunnel、不重启已有 worker、不提交 Slurm allocation。gpu32/33 已有相同共享 wheel runtime，测试启动独立实例。Slurm 同机不同 allocation 的真实调度验证另行进行，不能由 workstation E2E 替代。

## 网络与隔离

推荐控制端为 Mac，使用现有 server 依赖启动 localhost 专用测试 server。准备唯一 DB_FILE、测试凭据、无 tunnel/无部署目标的配置。测试 harness 应显式绑定 127.0.0.1，不能直接使用监听全部接口且读取生产部署配置的默认入口。启动前确认端口空闲。

Mac 经现有 gpucluster2 跳转分别对 gpu32/gpu33 建立 SSH reverse forwarding，例如 `-R 127.0.0.1:<remote-port>:127.0.0.1:<local-port>`。daemon 连接本机远端 loopback 转发端口，Socket.IO/WebSocket 走同一隧道。`ExitOnForwardFailure=yes`，禁止绑定 0.0.0.0；启动后用 health 验证，不假定 SSH 进程存在就转发成功。

SSH 登录本身无需 Cloudflare tunnel，但远端 daemon 需要能访问 server；本方案只需要临时 SSH 隧道。若服务器已有可用公开地址，技术上可免 SSH forward，但本次为了隔离不使用现有服务。

若 ICL 禁用 remote forwarding，停止该网络路线。推荐替代为 gpu32 本机运行隔离 server，并通过 SSH local forward 让 Mac 客户端访问；gpu33 连接受限地址需要另行验证。已探测 gpu32 有 node、无 npm，不能宣称已具备 server 构建环境。

## 测试文件与执行过程

候选实现文件：
- `tests/e2e/icl_training_probe.py`：真实 SDK 训练入口。
- `tests/e2e/icl_training_e2e.py`：submit/status/遥测/result 验收及 cleanup orchestrator。
- 独立 server bootstrap/harness，复用真实 API、store、scheduler 和 socket handlers，不 mock 消费者；缺少安全入口时增加最小测试入口，不修改 production 默认运行行为。

远端本轮使用新建的 generation 专属 stage/result 目录，保留旧数据。脚本绝对路径执行，SDK 从目标环境 wheel 导入。daemon 用该环境绝对解释器 `-I -m alchemy_stub` 启动，有唯一 instance identity、PID、日志、输出根和截止时间；不使用宽泛 pkill。测试启动前回读 task count/进程，不能只依据用户“无人使用”进行杀进程。

脚本记录：hostname、task/stub 标识、sys.executable、sys.prefix、SDK __file__/version、cwd、run_dir、checkpoint/artifact 路径，以及允许公开的测试 env。禁止输出全量 env/token。使用 SDK 读取参数、managed/context、上报进度及 eval、保存声明的 checkpoint/result。具体方法签名以代码为准，不复制目标设计中尚未实现的 API。

## 验收矩阵

1. **单任务全链路**：通过 SDK Experiment 提交，不直接 SSH 运行训练脚本。server 分配 task，daemon 真实启动进程；Unix SDK 上报抵达 server，退出状态和 artifact 校验正确。
2. **gpu32/33 共享环境**：同一 wheel env，各任务真实子进程均加载安装包，不导入旧 shared checkout；分别 target 指定 worker，不依赖调度碰巧选中。
3. **共享输入、同名输出**：两个任务读同一小型输入，并发各自写 `checkpoint.pkl`/`result.json` 到 SDK run_dir。完整 task-ID 目录不同，结果 marker 与 task 一致，输入不被修改。重复提交新 key/task 仍使用新输出目录。
4. **强制输出冲突**：两个不同 owner 显式指定同一 run_dir，用独立 worker 并发启动。最多一个获得 claim，另一个 preflight 明确失败，失败者训练入口从未运行，不覆盖胜者输出。记录 POSIX 共享挂载上的实际结果，不用本机测试替代。
5. **环境与失败路径**：缺少 reads、writes 无权限、训练函数主动抛异常。按实际权限可执行性选择夹具，不靠 chmod 假设一定不可写。要求明确失败、原异常可见、不报自然完成，不留下测试子进程。
6. **checkpoint 恢复**：显式 trusted checkpoint → 新任务的独立目录，恢复 next_step 并验证无重复/遗漏。旧 run_dir 保持不变。不能复用旧 owner 的输出目录来绕过 claim。
7. **断线/终止边界（独立子阶段）**：只断本轮临时隧道，验证进程状态不被立刻错误终结；恢复隧道后检查实际 resume。当前可靠下行 stop/checkpoint 协议尚未完整实现，对其做能力/缺陷报告，不写一个总是通过的“支持”测试。强制取消与 checkpoint 友好停止分开判定。

## 预算、产物与清理

工程预算目标：两台 workstation，最多同时两个轻量 probe，不进行 GPU 计算，单任务约数十秒；完整运行设置约十分钟硬截止。该预算是测试设计，非已测时长。超时停止本轮 PID/进程组并保留失败日志。

产物包含 spec、SDK 回读的实验/task ID、预期/实际路径、关键 server/daemon 日志和 JSON 汇总。只收集本轮任务，不抓历史任务或全量秘密状态。本地验证后保留小型结果，删除/停止本轮隧道、daemon、server 及临时进程；不动安装环境、旧源码或训练数据。

通过标准：真实链路和并发隔离有运行证据，而非 import/单元测试通过。失败时返回具体阶段、来源和最小修复，修复后重跑受影响用例。Slurm 真实 allocation/cgroup/MIG 另设验收，不能包含在本次“全部通过”的结论里。
