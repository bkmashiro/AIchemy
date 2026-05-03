# Experiment Config + Lineage Design

扩展现有 Experiment SDK（见 `experiment-sdk-design.md`），增加 config 管理、实验血缘、分支。

**原则：零 YAML，纯 Python，与现有 DAG 设计正交融合。**

---

## 1. Config 作为一等公民

### 1.1 Experiment 新增 `config` 字段

```python
exp = Experiment("scale40_baseline")

exp.config = {
    "model": {
        "state_dim": 256,
        "rule_dim": 64,
        "memory_slots": 512,
        "obs_type": "atari",
        "action_dim": 18,
    },
    "train": {
        "batch_size": 64,
        "lr": 3e-4,
        "max_steps": 500000,
        "warmup_buffer": 5000,
    },
    "games": JEMA_40,
}
```

`config` 就是一个 `dict[str, Any]`。SDK 不做 schema 验证——那是训练脚本的事。

### 1.2 Config 注入到 task

task 运行时自动获得实验 config：

```python
# 方式1：环境变量注入（最简单）
# stub 把 config dump 成 JSON 写到临时文件，设置 ALCHEMY_CONFIG=/tmp/xxx.json
# 训练脚本读：
from alchemy_sdk import Alchemy
al = Alchemy()
config = al.config  # 自动从 ALCHEMY_CONFIG 读

# 方式2：task 级别覆盖
exp.task("train",
    script="train_atari_v3.py",
    config_overrides={"train.seed": 42},  # 只覆盖这个字段
)
```

不用命令行传参。config 是结构化数据，不是字符串拼接。

### 1.3 submit 时 config 快照

```python
exp.submit()
# POST /api/experiments body 新增：
# {
#   "name": "scale40_baseline",
#   "config": { ... },          ← 完整快照
#   "config_diff": null,        ← 无 parent 时为 null
#   "parent_id": null,
#   "task_specs": [...]
# }
```

Server 存完整 config 快照。**不存文件路径，不引用外部 YAML。** 实验的 config 是自包含的。

---

## 2. 血缘 (Lineage)

### 2.1 Fork

```python
from experiments.scale40_baseline import exp as base

v2 = base.fork("scale40_v2")
v2.config["train"]["batch_size"] = 32      # 改一个参数
v2.config.setdefault("atari", {})["var_coef"] = 5.0  # 加一个参数
v2.submit()
```

`fork()` 做三件事：
1. 深拷贝 parent 的 config
2. 深拷贝 parent 的 task DAG 结构
3. 记录 `parent_id`（指向 parent experiment 的 name，不是 ID——因为 name 是语义标识）

SDK 实现：

```python
class Experiment:
    def fork(self, name: str, *, description: str = "") -> "Experiment":
        """从当前实验派生一个新实验。"""
        import copy
        child = Experiment(name, description=description, server=self._server)
        child.config = copy.deepcopy(self.config)
        child._parent_name = self.name
        child._parent_config = copy.deepcopy(self.config)  # 用于算 diff
        # 复制 task 结构（但不复制 task_id）
        for t in self._tasks:
            child._tasks.append(TaskNode(ref=t.ref, _spec=copy.deepcopy(t._spec)))
            child._refs.add(t.ref)
        return child
```

### 2.2 Config Diff

submit 时 SDK 自动计算 diff：

```python
def _compute_config_diff(self) -> dict | None:
    if not self._parent_config:
        return None
    return _deep_diff(self._parent_config, self.config)

def _deep_diff(old: dict, new: dict, prefix: str = "") -> dict:
    """递归 diff，返回 {path: {old, new}} 格式。"""
    changes = {}
    all_keys = set(old.keys()) | set(new.keys())
    for key in all_keys:
        path = f"{prefix}.{key}" if prefix else key
        if key not in old:
            changes[path] = {"old": None, "new": new[key]}
        elif key not in new:
            changes[path] = {"old": old[key], "new": None}
        elif isinstance(old[key], dict) and isinstance(new[key], dict):
            changes.update(_deep_diff(old[key], new[key], path))
        elif old[key] != new[key]:
            changes[path] = {"old": old[key], "new": new[key]}
    return changes
```

例：scale40_v2 相对 baseline 的 diff：
```json
{
    "train.batch_size": {"old": 64, "new": 32},
    "atari.var_coef": {"old": null, "new": 5.0}
}
```

一眼看出改了什么。这就是 scale40 s42 翻车的根因——有了这个就不会再犯。

### 2.3 Server 存储

Experiment 记录新增字段：

```typescript
interface Experiment {
    // ... 现有字段 ...
    config?: Record<string, any>;       // 完整 config 快照
    config_diff?: Record<string, {old: any, new: any}>;  // 对 parent 的 diff
    parent_name?: string;               // fork 来源
    parent_id?: string;                 // fork 来源的 experiment ID（如果能找到）
}
```

Server 在收到 `parent_name` 时，尝试查找最近同名已完成的 experiment，填充 `parent_id`。找不到也不报错——lineage 是 best-effort。

---

## 3. 模板 = Python 函数

不需要新的 DSL。模板就是返回 Experiment 的函数。

### 3.1 Seed Sweep

```python
# experiments/templates.py

def seed_sweep(
    base: Experiment,
    name: str,
    seeds: list[int],
    eval_script: str | None = None,
) -> Experiment:
    """为每个 seed 生成独立的 train (+eval) task。"""
    exp = Experiment(name, description=f"Seed sweep from {base.name}")
    exp.config = copy.deepcopy(base.config)
    exp._parent_name = base.name
    exp._parent_config = copy.deepcopy(base.config)

    for seed in seeds:
        train_ref = f"train_s{seed}"
        train = exp.task(
            train_ref,
            script=base._get_task("train")._spec["script"],
            config_overrides={"train.seed": seed},
        )
        if eval_script:
            exp.task(
                f"eval_s{seed}",
                script=eval_script,
                args_template={
                    "--checkpoint": f"{{{{tasks.{train_ref}.exports.checkpoint}}}}",
                },
                depends_on=[train],
            )
    return exp
```

用法：
```python
from experiments.scale40_baseline import exp as base
from experiments.templates import seed_sweep

sweep = seed_sweep(base, "scale40_3seed", seeds=[42, 123, 114514],
                   eval_script="eval_scale40.py")
sweep.submit()
```

### 3.2 Ablation

```python
def ablate(
    base: Experiment,
    name: str,
    param_path: str,
    values: list,
    seeds: list[int] | None = None,
) -> Experiment:
    """单参数消融。param_path 用点号分隔，如 "train.lr"。"""
    seeds = seeds or [base.config.get("train", {}).get("seed", 42)]
    exp = Experiment(name, description=f"Ablation on {param_path}")
    exp.config = copy.deepcopy(base.config)
    exp._parent_name = base.name
    exp._parent_config = copy.deepcopy(base.config)

    for val in values:
        for seed in seeds:
            safe_val = str(val).replace(".", "p")
            ref = f"train_{param_path.split('.')[-1]}_{safe_val}_s{seed}"
            exp.task(
                ref,
                script=base._get_task("train")._spec["script"],
                config_overrides={param_path: val, "train.seed": seed},
            )
    return exp
```

用法：
```python
abl = ablate(base, "var_coef_ablation",
    param_path="atari.var_coef",
    values=[0.5, 1.0, 2.0, 5.0],
    seeds=[42, 123],
)
abl.submit()
# → 8 个 task: var_coef_0p5_s42, var_coef_0p5_s123, var_coef_1p0_s42, ...
```

### 3.3 Grid Search

```python
def grid(
    base: Experiment,
    name: str,
    params: dict[str, list],  # {"train.lr": [1e-3, 3e-4], "train.batch_size": [32, 64]}
) -> Experiment:
    """笛卡尔积。"""
    import itertools
    keys = list(params.keys())
    exp = Experiment(name, description=f"Grid search on {keys}")
    exp.config = copy.deepcopy(base.config)
    exp._parent_name = base.name
    exp._parent_config = copy.deepcopy(base.config)

    for combo in itertools.product(*params.values()):
        overrides = dict(zip(keys, combo))
        suffix = "_".join(f"{k.split('.')[-1]}{v}" for k, v in overrides.items())
        exp.task(
            f"train_{suffix}",
            script=base._get_task("train")._spec["script"],
            config_overrides=overrides,
        )
    return exp
```

**模板不是 SDK 内置的**——放在项目的 `experiments/templates.py` 里。不同项目可以写自己的模板。SDK 只提供 `Experiment.fork()` 和 `config_overrides` 机制。

---

## 4. config_overrides 机制

task 级别的 config 覆盖：

```python
exp.task("train_s42",
    script="train_atari_v3.py",
    config_overrides={"train.seed": 42, "train.batch_size": 32},
)
```

**实现：** submit 时，SDK 把 experiment.config 和 task.config_overrides 合并成该 task 的 final config。

```python
def _resolve_task_config(self, task: TaskNode) -> dict:
    """合并实验 config + task 覆盖。"""
    config = copy.deepcopy(self.config)
    overrides = task._spec.get("config_overrides", {})
    for dotpath, value in overrides.items():
        _set_nested(config, dotpath, value)
    return config

def _set_nested(d: dict, path: str, value):
    keys = path.split(".")
    for k in keys[:-1]:
        d = d.setdefault(k, {})
    d[keys[-1]] = value
```

Server 为每个 task 存一份 `resolved_config`。web 端可以对比任意两个 task 的 config diff。

---

## 5. Web 端展示

### 5.1 实验树

```
scale40_baseline
├── scale40_v2          diff: {train.batch_size: 64→32, atari.var_coef: +5.0}
├── scale40_3seed       3 tasks (s42, s123, s114514)
└── var_coef_ablation   8 tasks (4 values × 2 seeds)
```

每个节点点进去看：
- 完整 config
- 对 parent 的 diff（高亮变化）
- task 列表 + 状态
- metrics 对比（从 `al.log_eval()` / `al.export()` 收集）

### 5.2 Config Diff 视图

```diff
  model:
    state_dim: 256
    rule_dim: 64
  train:
-   batch_size: 64
+   batch_size: 32
    lr: 0.0003
+ atari:
+   var_coef: 5.0
```

Server API：`GET /api/experiments/:id/diff` 返回结构化 diff JSON，前端渲染。

### 5.3 Metrics 比较表

```
                    sil_l2   NMI    ARI    mean_norm
scale40_baseline
  s42               0.423   0.839  0.506  0.519
  s123              0.341   0.816  0.458  52.27
scale40_v2
  s42               0.934   1.000  1.000  0.034    ← 异常
```

数据来源：task 的 `exports` + `al.log_eval()`。按实验分组，按 seed/参数排列。

---

## 6. 对现有系统的改动

### 6.1 SDK 改动（最小）

`experiment.py` 新增：
- `Experiment.config: dict` 属性
- `Experiment.fork()` 方法
- `_compute_config_diff()` 内部方法
- `config_overrides` 参数在 `task()` 方法中

`submit.py` 改动：
- POST body 新增 `config`, `config_diff`, `parent_name` 字段

新增文件：无。模板是用户项目代码，不在 SDK 里。

### 6.2 Server 改动（最小）

`POST /api/experiments` 新增可选字段：`config`, `config_diff`, `parent_name`
- 存到 experiment 记录里
- 如果有 `parent_name`，查找最近同名已完成实验填充 `parent_id`

`GET /api/experiments/:id/diff` 新增端点
- 返回 config_diff

Task 创建时：
- 如果 experiment 有 config 且 task 有 config_overrides，合并后存为 task 的 `resolved_config`
- stub dispatch 时，把 `resolved_config` 写入临时文件，注入 `ALCHEMY_CONFIG` 环境变量

### 6.3 Stub 改动

dispatch task 时：
- 如果 task 携带 `resolved_config`，dump 成 `/tmp/alchemy_config_{task_id}.json`
- 设置 `ALCHEMY_CONFIG=/tmp/alchemy_config_{task_id}.json`
- task 完成后清理临时文件

### 6.4 训练脚本迁移

之前：
```python
with open(args.config) as f:
    config = yaml.safe_load(f)
```

之后：
```python
from alchemy_sdk import Alchemy
al = Alchemy()
config = al.config  # 自动从 ALCHEMY_CONFIG 读，或 fallback 到命令行 --config
```

渐进迁移。旧脚本继续用 `--config` 参数，新脚本用 `al.config`。两种方式并存。

---

## 7. 完整示例：scale40 实验族

```python
# experiments/scale40_baseline.py
from alchemy_sdk import Experiment
from experiments.game_lists import JEMA_40

exp = Experiment("scale40_baseline", description="Scale40 memory-based z_rule")

exp.config = {
    "model": {
        "state_dim": 256, "rule_dim": 64,
        "memory_slots": 512, "top_k": 8,
        "obs_type": "atari", "action_dim": 18,
    },
    "predictor": {"type": "film"},
    "train": {
        "batch_size": 64, "lr": 3e-4,
        "max_steps": 500000, "warmup_buffer": 5000,
    },
    "games": JEMA_40,
}

train = exp.task("train",
    script="/vol/bitbucket/ys25/jema/train_atari_v3.py",
    target_tags=["a30"],
)

exp.task("eval",
    script="/vol/bitbucket/ys25/jema/eval_scale40.py",
    args_template={
        "--checkpoint": "{{tasks.train.exports.checkpoint}}",
        "--output": "{{tasks.train.exports.run_dir}}/eval_scale40.json",
    },
    depends_on=[train],
    target_tags=["a30"],
)

if __name__ == "__main__":
    exp.submit()
```

```python
# experiments/scale40_3seed.py
from experiments.scale40_baseline import exp as base
from experiments.templates import seed_sweep

sweep = seed_sweep(base, "scale40_3seed",
    seeds=[42, 123, 114514],
    eval_script="/vol/bitbucket/ys25/jema/eval_scale40.py",
)

if __name__ == "__main__":
    sweep.submit()
```

```python
# experiments/scale40_v2_bad.py
# 这个就是出问题的那次——config diff 一目了然
from experiments.scale40_baseline import exp as base

v2 = base.fork("scale40_v2_var_coef")
v2.config.setdefault("atari", {})["var_coef"] = 5.0  # ← 就是这行害的
v2.config["train"]["batch_size"] = 32

if __name__ == "__main__":
    v2.submit()
    # web 端会显示：
    # diff: atari.var_coef: null → 5.0, train.batch_size: 64 → 32
```

---

## 8. 不做的事

- **不做 config schema 验证** — 训练脚本自己验证，SDK 不管
- **不做自动超参搜索** — Optuna/Ray Tune 做这个更好，alchemy 只管调度
- **不在 SDK 里内置模板** — 模板是项目代码，不同项目不同模板
- **不做 YAML 支持** — config 是 Python dict，句号
- **不做 config 版本控制** — git 管这个，alchemy 只存快照
