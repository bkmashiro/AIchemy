# T4 控制链与断线恢复：验收记录

状态：此批实现与验证已完成。最终运行目录为 `t4-control-20261006-d`。

## 当前接口和语义

仍使用已有 PATCH：

```text
PATCH /api/tasks/<id>  {"should_checkpoint": true}
PATCH /api/tasks/<id>  {"should_stop": true}
```

每个请求生成并保存语义 request_id。checkpoint 的状态是 pending → received → completed；收到 SDK 保存后的路径报告才进入 completed。只收到 Socket.IO ACK 或 SDK 接收回执，不等于已保存。

重复 `should_checkpoint=true` 是同一个逻辑请求，不反复保存。要发起新的 checkpoint，请先 PATCH false，再 PATCH true。保存失败不报告 completed；应用需处理保存错误，agent 可明确发起新请求。当前没有 failed 控制状态或自动修复/重试模型保存。

Stop 是持久的 level intent，接受后不可撤回。SDK 接收后在训练安全边界响应；零退出码仍记录 cancelled/cooperative_stop，不能计为自然成功或推进成功 DAG。仅支持 running/assigned task；排队任务应使用 status=cancelled。暂停、HTTP-only 和老 SDK 的控制能力不在本次认证范围。

## 真实 T4 结果

27 项断言全部通过，使用两个真实 T4 allocation：Slurm jobs `295594` / `295595`。除先前的 13 项资源/路径断言外，新增验证：

- 主动模拟保存失败，控制状态没有假报 completed。
- 成功请求的报告路径指向真实 JSON 文件，文件中的 task/request ID 正确。
- 重复 PATCH 不创建新 request ID 或重复保存。
- 周期 checkpoint 不覆盖已完成请求的归属路径。
- 实际关闭 SSH reverse forwarding，server 与两个 daemon 断开。
- server 保持训练 running，真实进程 PID 不变，训练步骤继续推进。
- 断线期间的新请求保持 pending，不假报 received/completed。
- 重建隧道后同一进程恢复连接，原语义 ID 的请求完成，保存恰好一次。
- 合作 stop 后保存 stop checkpoint 与结果，再正常以 0 退出。
- server 将其标为 cancelled，依赖任务也取消且从未启动，实验进入非成功终态。

本次是轻量 CPU probe + T4 allocation，未运行大模型、DDP 或 GPU 训练计算。

## 清理证据须分层

原 runner 在两 jobs 为 COMPLETING 时提前判断 cleanup_failed；原始 summary 保留，没有改写成通过。两个 worker 已发出 own-processes-stopped 回执。随后主控独立用 scontrol 回读两 jobs：COMPLETED，ExitCode=0:0；用户队列为空、本机测试 server 无 listener。

追加证据：

```text
~/.hermes/cache/scratch/t4-control-20261006-d/post-cleanup-verification.json
```

清理 harness 已修正：通过 Slurm batch USR1 指示本轮 worker 停止，而非仅依赖新建 STOP 文件的即时跨挂载可见性；Bash trap 转发给自己的 worker，避免 wait 被信号中断后误退出。stdout 退出回执与 scheduler epilog 终态分别检查，COMPLETING 不能当作需要强制取消的运行任务。

## 本轮额外发现与修复

- 之前 DAG 原子 admission 改造遗漏了依赖任务的 blocked 初态。该回归已在 router 测试复现并补回，不把旧 baseline 中存在的问题当作可忽略。
- SDK ctx.steps 无 checkpoint hook 时不能提前消费一次性请求，保留给用户循环显式处理。
- 已完成请求不能继续挂到后续周期 checkpoint；重复/未知请求 ID 不降级为普通保存报告。
- 控制 PATCH 不能绕过 status/spec 校验；错误布尔值、queued controls 明确拒绝。
- 活跃 task 的 DB 写入失败不能先泄漏到内存；控制 receipt 保存失败要 NACK，路径和计数一次提交。
- 完成确认按该 request 的保存路径验证，不拿全局 latest 路径替代，避免周期保存与迟到确认互相干扰。
- Resume 根据真实 disconnected_at 清除断线标记，兼容旧 flag。

## 本次没有认证的边界

- 自动 Slurm walltime drain 仍是原来的 SIGTERM 路径，未转换为此控制协议。
- 测试原来申请 10 分钟，与 daemon 10 分钟 drain threshold 冲突；现在 allocation 上限为 20 分钟，但 worker/controller 仍有短时截止并主动结束。不是模拟剩余时间或禁用生产 drain。
- SDK 请求去重保存在同一训练进程内；未证明 SDK 进程崩溃重启后的 exactly-once。
- 未验证 daemon/server crash 与磁盘故障的完整恢复矩阵；只验证了网络断线、同 PID 重连和定向 DB 故障回归。
- Server 核验保存路径报告与语义 ID，不读取远端 checkpoint 内容；真实测试额外读取了文件，二者能力范围不同。
- 未提供异步/多线程 checkpoint 身份绑定、MIG、分数 VRAM 配额、远端 eval 或 HTTP back-channel 的保证。

## 本地回归与测试副作用

最终：SDK 全量 472 passed；stub 全量 337 passed、12 skipped（一个既有未 await coroutine warning）；server 全量 46 suites / 892 passed，构建通过。

server 原先的 11 项失败已经收口：隔离重放 f025 基线确认旧 run_dir 断言和 DAG blocked 初态问题，未把“基线也失败”当作可以跳过；修复生产状态初始化后 scenario/fuzz 76 项通过。其余间歇性超时没有用长等待或削弱断言遮掩，最终全量也通过。

主控直接跑旧 harness 时，它读取默认部署配置并短暂启动了真实 cloudflared，结束时已停止。测试默认环境现固定为 loopback 与 `deploy-disabled.yaml`，完整重跑日志没有 tunnel.started；临时 DB 路径也改为遵循 TMPDIR。没有重启生产服务，但该测试副作用如实保留在本记录中。

## 重跑

使用 `tests/e2e/icl_slurm_e2e.py --controls`，显式提供从当前源码构建的 SDK/stub wheels。网络、T4 staging 和资源限制与 `icl-t4-slurm-e2e.md` 相同。原始 token/DB/logs 只留私有 evidence，不提交到 Git。
