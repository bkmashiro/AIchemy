# ICL 安装与 Python 导入来源

## 已观察到的故障

2026-10-05，gpu32 重装后的 `/usr/bin/python3` 是 Python 3.14.4。旧 `/vol/bitbucket/ys25/alchemy-v2/runtime` 和 `/homes/ys25/alchemy-v2/venv` 用 Python 3.12 创建，解释器却软链接到不带 minor version 的 `/usr/bin/python3`。在 gpucluster2 上能读 3.12 site-packages，在 gpu32 上变为 3.14，旧安装失效。

共享根目录还包含 `alchemy_stub/` 老源码。从该 cwd 执行 Python 会先导入此副本，而非期望的 wheel 包。旧 stub 又自动把 checkout 的 SDK 目录加进训练 PYTHONPATH，覆盖目标环境的安装。这是三个独立问题：解释器漂移、cwd shadow、执行器主动 path shadow。

## 安装规则

- 环境按目标 host、明确 Python minor version 和 source revision 分目录；不要复用一个跨异构节点的 runtime。
- 用 `/usr/bin/python3.14` 等明确解释器创建 venv。升级系统后仍必须检查实际 version/ABI；路径存在不等于环境有效。
- SDK 与 stub 用 wheel 安装，不在运行环境使用 editable 安装。目标训练环境需要 SDK 时显式安装，stub 不应替任务换 SDK。
- bootstrap/管理探针用 `python -I` 或安装后的 console script 启动，避免当前目录及 PYTHONPATH 影响管理包。不能把 `-I` 随意强加到所有用户训练脚本，因为用户项目可能需要自身模块和环境配置。
- 普通训练不应从 SDK/stub 源码目录启动。显式用户 PYTHONPATH 仍可能 shadow，需按任务实际入口检查 `alchemy_sdk.__file__`。
- 不根据 `pip show` 单独判断实际版本。同时查看 interpreter、`sys.prefix`、包 `__file__`、`__version__`、distribution version 和 direct_url。
- stub wheel 排除嵌套 legacy `alchemy_stub.alchemy_stub` 包，唯一执行包是外层 `alchemy_stub`。

## gpu32 已完成的 SDK 安装

SDK wheel 来自源码 revision `6984e28`，安装环境：

```text
/vol/bitbucket/ys25/alchemy-envs/gpu32/cpython-3.14-sdk-6984e28
```

该环境不替换旧 runtime，也未启动 daemon。已从共享根目录、旧 SDK 目录、旧 stub 目录分别用 `-I` 验证：SDK 都来自新 venv 的 `lib/python3.14/site-packages`，源码及 distribution version 均为 2.2.0，`Alchemy.managed` 包含 device 参数。`pip check` 通过。

旧共享 checkout 有未提交改动，已保存 tracked patch、HEAD、status 与源码快照至：

```text
/vol/bitbucket/ys25/alchemy-repair-backups/20261005T094529Z
```

没有删除旧代码、venv、训练数据或结果。备份用于后续比较和安全迁移，不能把旧环境“已保留”说成“已修复”。

## gpu32 已完成的 stub 安装

同一新环境已安装非 editable 的 stub wheel 和依赖，源码与 distribution version 均为 2.2.0。已验证：三个 cwd 下隔离导入 SDK/stub 来源一致、安装后的 `alchemy-stub --help` 与 `python -I -m alchemy_stub --help` 可运行、`pip check` 通过。GpuMonitor 实测识别 RTX 4080 一张卡、16376 MiB 显存；这是 workstation 实测，不是 Slurm allocation 配额验证。

源码已移除嵌套重复 stub 实现，并关闭 package-data 的隐式收集，实际 wheel 文件清单确认不包含 `alchemy_stub/alchemy_stub/`。普通与 warm 启动路径不再自动把 checkout SDK 加到 PYTHONPATH。显式用户路径和训练 cwd 仍由用户控制。

目前未启动 daemon、未切换实际 server 部署配置。新安装是可用的独立 runtime，旧源码 runtime 尚未替换。部署入口也必须用已安装模式，避免原有 PYTHONPATH 源码同步路径重新引入 shadow。

## 已安装部署模式

`StubTarget.runtime_mode: installed` 跳过源码同步，预检和 workstation/Slurm 启动均使用 `python -I`。预检拒绝从 sys.prefix 之外解析到的 stub。省略此字段仍是旧 source 模式，仅供尚未迁移的目标。

仓库 `deploy-config.yaml` 的 gpu32 目标已选择 installed 模式和上述新环境；**运行中的 server 配置没有切换，也没有调用部署接口**。已将实际构建生成的 installed preflight 命令在 gpu32 执行，exit 0。本地 stub 全套 327 passed、12 skipped，保留一个既有 coroutine 警告；server deploy/socket 回归 68 passed，构建通过。

环境目录末尾 6984e28 标识 SDK 来源基线，stub wheel 含本轮后续修复；环境目录名不能代替各包 artifact/source 记录。旧 shared checkout 仍保留其未提交工作，使用新源码快照时应选择独立 release 目录，而非覆盖它。

## 部署切换门槛

启动新 stub 前要证明同一环境中 SDK/stub wheel 来源正确、依赖完整、GPU telemetry 可读取，实际 CLI 不导入旧共享目录。调用管理入口用绝对 console-script 路径或 `python -I -m alchemy_stub`。

确认没有 consumer 使用旧源码后才能归档旧副本；跨节点 runtime 不可只改一个 shared symlink。gpucluster2、Slurm worker 和其他 workstation 应分别核实解释器版本。服务端配置、运行中 worker 重启和 Slurm allocation 提交与环境准备分开执行，不由安装脚本隐式触发。
