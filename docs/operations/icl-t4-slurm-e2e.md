# ICL T4：Slurm allocation 真实验收

2026-10-05/06。范围是 T4 allocation 的身份、GPU 可见范围、CPU 内存边界、SDK 实际启动和共享输出。最终一次真实 E2E：13 项断言通过，耗时 122.67 秒；Slurm jobs `295571` / `295572` 均 `COMPLETED`、`ExitCode=0:0`。

## 资源与环境事实

通过 gpucluster2 提交，仅使用 `t4` partition，节点 `kingfisher`。每份 allocation 请求一张 Tesla T4、一 CPU task，内存分别 1G / 2G；该站点实际 AllocTRES 是两 logical CPUs、1/2 GiB 内存、一 GPU。设置十分钟 walltime，并用 STOP/cleanup 提前结束。

真实计算节点 Python 为 3.12.3，没有 `/usr/bin/python3.14`。因此不能沿用 gpu32/33 的 3.14 venv。新运行环境在 allocation 内用 `/usr/bin/python3.12` 创建、安装 SDK/stub wheel；没有在 login host 构建或跑负载。

保留的已验证环境：

```text
/vol/bitbucket/ys25/alchemy-envs/t4/cpython-3.12-t4-e2e-20261006-d
```

实际 cgroup2 的 task leaf `memory.max=max`，但 job/user ancestor 有 numeric limit。探针取 ancestor 中最小数值，分别得到 `1073741824` / `2147483648` bytes，与 daemon 上报的 `slurm_constraints.mem_mb=1024/2048` 一致。没有做 OOM 压力测试，也没有测 GPU 模型吞吐。

## 抓到并修复的 GPU 重编号问题

两份 allocation 在同一物理节点，各有一张不同的 T4：

- 一份 `SLURM_JOB_GPUS=0`、`CUDA_VISIBLE_DEVICES=0`；
- 另一份 `SLURM_JOB_GPUS=5`，但 `CUDA_VISIBLE_DEVICES=0`；其 allocation 内 nvidia-smi 也显示 index 0。

因此 Slurm global GPU ID、CUDA ordinal 和 nvidia-smi index 不一定相同。旧逻辑仅接受两组数字一致，导致第二份合法 allocation 被报成 unknown 并阻止 GPU task。

现在数字 CUDA 选择由 CUDA Driver API 解析实际 UUID，再与 nvidia-smi UUID 精确匹配。使用标准库 ctypes，无新增依赖。Driver 暴露的 ordinal 是重新编号后的 `0..count-1`，不能直接把 CUDA_VISIBLE_DEVICES 的选择数字再次当 ordinal。

- 显式空设备集合保持 known zero。
- 库/API 失败、数量或 UUID 行不完整仍保持 unknown，不退回主机总量。
- 显式 GPU UUID 与原有精确数字兼容路径保留。
- mapping 在一个固定环境的 monitor 内缓存。

初版本地 MagicMock 测试漏掉了 ctypes 函数签名的错误，真实 T4 再次失败。已修正 `argtypes/restype` 设置，并增加真实 ctypes.CFUNCTYPE 回归，避免“mock 能赋值”被误当成真实 FFI 合法。所有早期失败 evidence 保留，不计入通过结果。

MIG、共享 GPU 的分数 VRAM 配额不在本次认证范围，不应把 T4 的成功外推过去。

## 13 项验收

- 两个不同 Slurm job 对应不同 stub ID；hostname 相同，不混同身份。
- 两个真实 cgroup 硬内存额度不同。
- 每个 stub 只报告自己的一个 T4，allocation known。
- 两份 allocation 的 CUDA UUID 确实不同，非伪造不同标签。
- 声明 1536 MiB 的 task 对 1 GiB allocation 保持 pending，并能回读 `cpu_memory_insufficient` 原因。
- 上述 pending probe 被显式取消，没有残留待调度任务。
- 两个合法 task 经 SDK/server/daemon 实际运行：128 MiB 请求在小 allocation 完成，1536 MiB 请求在大 allocation 完成。
- 两 task 都声明 GPU reservation，证明新 GPU scope 能用于真实 admission；workload 是轻量 CPU probe，没有进行模型 GPU 计算。
- task SDK 来自新的 installed Python 3.12 runtime，而非旧 shared checkout。
- 同名 result/checkpoint 使用不同 task run_dir，未互相覆盖。

本轮任务：

```text
72229dbd-bba9-47f8-9300-b407511b9d7b  oversize probe → cancelled
 a35506c1-ebe7-471a-90b2-931f6b7af19f allocation A → completed
 bbae76a5-145f-434e-8d3b-ff9cef1485fe allocation B → completed
```

## 网络和清理

Mac 上 localhost 隔离 server；SSH reverse forwarding 到 gpucluster2 loopback。每个 batch worker 再通过受验证的 SSH key 建 allocation 专属 local forward，连接真实 daemon。两份 allocation 共享物理机时使用不同端口与 default_cwd，避免本地 listener/实例锁冲突。

没有启动 Cloudflare，没有修改生产 server。源码 deploy-config 的 T4 target 已选择 installed mode 和上述 3.12 环境；gpu33 也补齐到已验证共享 3.14 环境。其他未验证机器不自动切换。

成功路径先写 STOP，等待各 worker 的 cleanup receipt，再读取 `scontrol show job`。本轮两个 jobs 均自然完成 0:0，daemon/SSH 子进程已停止；独立 `squeue -u ys25` 回读为空。只有仍活跃且超出清理时限的本轮 job 才按准确 job ID scancel。

`sacct` 在此次站点返回数据库连接失败，所以终态证据使用 scontrol，不虚构 accounting 数据。早期失败 E2E 的 Slurm wrapper 状态也保留：wrapper COMPLETED 不能单独证明断言通过。

## 重跑入口

```bash
cd ~/projects/alchemy-v2
uv build --wheel sdk --out-dir "$HOME/.hermes/cache/scratch/t4-wheels"
uv build --wheel stub --out-dir "$HOME/.hermes/cache/scratch/t4-wheels"
(cd server && npm run build)
PYTHONPATH="$PWD/sdk" uv run --project sdk --no-sync python \
  tests/e2e/icl_slurm_e2e.py \
  --sdk-wheel "$HOME/.hermes/cache/scratch/t4-wheels/alchemy_sdk-2.2.0-py3-none-any.whl" \
  --stub-wheel "$HOME/.hermes/cache/scratch/t4-wheels/alchemy_stub-2.2.0-py3-none-any.whl" \
  --evidence "$HOME/.hermes/cache/scratch/t4-e2e-$(date +%Y%m%dT%H%M%S)"
```

`slurm_runtime_probe.py` 收集 stdlib runtime/CUDA/cgroup 事实；`slurm_test_worker.py` 在 allocation 内准备环境、转发和运行 daemon；控制 runner 负责 SDK 提交、断言与清理。当前 fixture 明确面向这个 ICL T4 环境，不是跨集群通用调度器。

最终私有 evidence：

```text
~/.hermes/cache/scratch/t4-e2e-20261006-d/summary.json
/vol/bitbucket/ys25/alchemy-slurm-e2e/t4-e2e-20261006-d
```

测试 token、DB、原始 logs 不进 Git。保留有效 runtime 与结果；无用的失败代次环境可在核实无消费者后删除。配套本地回归：stub 全量 334 passed、12 skipped（一个既有 coroutine warning）；server scheduler/socket 127 passed。

## 仍未完成

断线重连验收、可靠的合作式 stop/checkpoint 下行，以及真实模型/多 rank 恢复另行进行。这次只完成并认证上述 T4 allocation 切片，不代表完整训练框架改革结束。
