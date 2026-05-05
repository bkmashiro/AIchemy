# Experiment SDK Design

## Motivation

当前 Alchemy 提交任务是 flat 的：一个 `POST /tasks`，一个 script。多阶段实验（train → eval → report）需要手动串联。DAG pipeline 设计已批准（`depends_on` + experiment transaction），但缺少 Python-side API。

本文档定义 SDK 中的 `Experiment` 层——用 Python 代码定义 DAG，运行脚本即提交整个实验。

---

## 1. API Design

### 1.1 最小示例

```python
from alchemy_sdk import Experiment, Task

exp = Experiment("atari_pong_s42", description="Pong seed 42 full pipeline")

train = exp.task(
    "train",
    script="/home/ys25/jema/train_minigrid.py",
    args={"--env": "Pong", "--seed": "42", "--steps": "500000"},
    python_env="jema",
    target_tags=["a40"],
)

evaluate = exp.task(
    "eval",
    script="/home/ys25/jema/eval.py",
    args={"--env": "Pong"},
    depends_on=[train],
    python_env="jema",
)

exp.submit()
```

`exp.submit()` 原子提交两个 task 到 server，`eval` 初始状态 `blocked`，`train` 完成后自动 promote。

### 1.2 数据传递

训练脚本内通过已有的 `al.export()` 写出值：

```python
# train_minigrid.py (运行在 GPU 节点上)
from alchemy_sdk import Alchemy

al = Alchemy()
# ... training loop ...
al.export("best_model", "/data/runs/pong_s42/checkpoints/best.pt")
al.export("final_loss", 0.023)
al.done()
```

下游 task 用模板引用上游 export：

```python
evaluate = exp.task(
    "eval",
    script="/home/ys25/jema/eval.py",
    args_template={"--model": "{{tasks.train.exports.best_model}}"},
    depends_on=[train],
)
```

`args_template` 中的 `{{tasks.<ref>.exports.<key>}}` 在 server dispatch 时解析。

### 1.3 参数化

```python
def make_experiment(env: str, seed: int) -> Experiment:
    exp = Experiment(f"{env}_s{seed}")

    train = exp.task(
        "train",
        script="/home/ys25/jema/train_minigrid.py",
        args={"--env": env, "--seed": str(seed), "--steps": "500000"},
        python_env="jema",
    )

    exp.task(
        "eval",
        script="/home/ys25/jema/eval.py",
        args_template={"--model": "{{tasks.train.exports.best_model}}"},
        depends_on=[train],
    )

    return exp

# 提交多个
for seed in [42, 43, 44]:
    make_experiment("Pong", seed).submit()
```

这就是 "参数化"——Python 函数 + for 循环。不需要额外的 sweep 抽象。

### 1.4 可组合模板

```python
def add_eval_stage(exp: Experiment, train_task: TaskNode, env: str) -> TaskNode:
    """可复用的 eval 模板。"""
    return exp.task(
        "eval",
        script="/home/ys25/jema/eval.py",
        args={"--env": env},
        args_template={"--model": "{{tasks.train.exports.best_model}}"},
        depends_on=[train_task],
    )

# 用法
exp = Experiment("pong_full")
train = exp.task("train", script="...", args={...})
evaluate = add_eval_stage(exp, train, "Pong")
```

### 1.5 完整 Task 签名

```python
class TaskNode:
    """DAG 中的一个节点。由 Experiment.task() 创建，不要直接实例化。"""

    ref: str            # 实验内唯一名称
    task_id: str | None # submit 后由 server 分配

def task(
    self,
    ref: str,
    *,
    script: str,
    args: dict[str, str] | None = None,
    raw_args: str | None = None,
    args_template: dict[str, str] | None = None,
    depends_on: list[TaskNode] | None = None,
    cwd: str | None = None,
    python_env: str | None = None,
    env_setup: str | None = None,
    env: dict[str, str] | None = None,
    env_overrides: dict[str, str] | None = None,
    requirements: dict | None = None,
    target_tags: list[str] | None = None,
    max_retries: int = 0,
    priority: int = 5,
    outputs: list[str] | None = None,
) -> TaskNode:
```

### 1.6 Experiment 签名

```python
class Experiment:
    def __init__(
        self,
        name: str,
        *,
        description: str = "",
        server: str | None = None,  # 默认读 ALCHEMY_SERVER 或 ~/.alchemy/config.yaml
    ) -> None: ...

    def task(self, ref: str, **kwargs) -> TaskNode: ...

    def submit(self, *, dry_run: bool = False) -> ExperimentResult: ...
    def status(self) -> ExperimentStatus: ...

@dataclass
class ExperimentResult:
    experiment_id: str
    task_refs: dict[str, str]  # ref → task_id
    url: str                   # dashboard URL

@dataclass
class ExperimentStatus:
    experiment_id: str
    status: str  # "running" | "completed" | "partial" | "failed" | "cancelled"
    tasks: dict[str, TaskStatus]  # ref → status detail
```

---

## 2. Data Model

### 2.1 Server-side Experiment 记录

```typescript
interface Experiment {
  id: string;                              // UUID
  name: string;                            // 用户给的名，用于幂等
  description?: string;
  status: "pending" | "running" | "completed" | "partial" | "failed" | "cancelled";
  task_specs: TaskSpec[];                  // 原始 DAG 定义（存档）
  task_refs: Record<string, string>;       // ref → task_id
  created_at: string;
  finished_at?: string;
  submitted_by?: string;
  fingerprint: string;                     // name 的 hash，幂等用
}
```

已有的 `TaskSpec` 和 `Experiment` 类型基本匹配，需要加 `fingerprint` 字段。

### 2.2 Task 扩展

已有字段够用：
- `depends_on: string[]` — 依赖的 task ID 列表
- `ref: string` — 实验内名称
- `experiment_id: string` — 所属实验
- `args_template: Record<string, string>` — 模板参数
- `exports: Record<string, any>` — 运行时导出值
- `outputs: string[]` — 声明的输出路径

无需新增 Task 字段。

### 2.3 DAG 规则

- task 的 `depends_on` 存的是 **task_id**（server 在创建时将 ref 解析为 ID）
- 所有 dep 都 `completed` → task 从 `blocked` promote 到 `pending`
- 任一 dep `failed`/`killed` → task 标记 `cancelled`
- 模板 `{{tasks.<ref>.exports.<key>}}` 在 promote 时解析，注入到 `args`

---

## 3. Submission Flow

```
Python script                    Server
─────────────                    ──────
exp = Experiment("name")
exp.task("train", ...)
exp.task("eval", depends_on=[train])
exp.submit()
    │
    ├─► POST /api/experiments
    │   body: {
    │     name: "name",
    │     description: "...",
    │     task_specs: [
    │       { ref: "train", script: "...", args: {...} },
    │       { ref: "eval",  script: "...", depends_on: ["train"], args_template: {...} }
    │     ]
    │   }
    │                            ├─► 幂等检查（name 去重）
    │                            ├─► 验证 DAG（无环、ref 唯一、依赖存在）
    │                            ├─► 为每个 spec 创建 Task（分配 ID）
    │                            ├─► 将 depends_on 的 ref 替换为 task_id
    │                            ├─► 无依赖的 task → "pending"
    │                            ├─► 有依赖的 task → "blocked"
    │                            ├─► 创建 Experiment 记录
    │                            ├─► triggerSchedule()
    │                            └─► 返回 { experiment_id, task_refs }
    │
    ◄── 200 { experiment_id, task_refs, url }
```

**关键：一个 HTTP 请求，原子创建所有 task。** 不是逐个提交。

---

## 4. Idempotency

### 策略：experiment name 去重

```
POST /api/experiments { name: "atari_pong_s42", task_specs: [...] }
```

Server 逻辑：
1. 查找同名且非终态的 experiment
2. 如果存在 → 返回 `200` + 现有实验状态（不重复创建）
3. 如果不存在或已终态 → 创建新实验，返回 `201`

```python
# SDK 侧
result = exp.submit()
if result.already_exists:
    print(f"Experiment already running: {result.url}")
else:
    print(f"Submitted: {result.url}")
```

### 为什么用 name 而不是 fingerprint

Fingerprint（hash of script+args）在参数微调时容易误判。Name 是显式的语义标识——用户改了名就是新实验，不改名就是同一个。简单、可预测。

### Re-run 终态实验

同名实验全部终态时，`submit()` 创建新实验。如果需要强制重跑正在运行的实验：

```python
exp.submit(force=True)  # kill 现有同名实验，重新创建
```

---

## 5. Server Changes

### 5.1 新增 API

```
POST   /api/experiments          — 原子创建实验 + 所有 task
GET    /api/experiments          — 列出实验（分页）
GET    /api/experiments/:id      — 实验详情（含每个 task 状态）
DELETE /api/experiments/:id      — kill 实验内所有活跃 task
POST   /api/experiments/:id/retry — 重跑失败的 task
```

### 5.2 POST /api/experiments 处理流程

```typescript
router.post("/", (req, res) => {
  const { name, description, task_specs } = req.body;

  // 1. 幂等：查找同名活跃实验
  const existing = store.findActiveExperiment(name);
  if (existing) {
    return res.status(200).json(existing);
  }

  // 2. DAG 验证
  const refs = task_specs.map(s => s.ref);
  if (new Set(refs).size !== refs.length) {
    return res.status(400).json({ error: "Duplicate ref names" });
  }
  for (const spec of task_specs) {
    for (const dep of spec.depends_on || []) {
      if (!refs.includes(dep)) {
        return res.status(400).json({ error: `Unknown dependency: ${dep}` });
      }
    }
  }
  if (hasCycle(task_specs)) {
    return res.status(400).json({ error: "Cyclic dependency detected" });
  }

  // 3. 创建 task（原子）
  const taskRefs: Record<string, string> = {};
  const tasks: Task[] = [];

  for (const spec of topologicalSort(task_specs)) {
    // 将 depends_on 的 ref 转为 task_id
    const depIds = (spec.depends_on || []).map(r => taskRefs[r]);

    const task = createTask({
      ...spec,
      depends_on: depIds.length > 0 ? depIds : undefined,
      experiment_id: experimentId,
    });
    taskRefs[spec.ref] = task.id;
    tasks.push(task);
  }

  // 4. 创建 experiment 记录
  const experiment = {
    id: experimentId,
    name,
    description,
    status: "running",
    task_specs,
    task_refs: taskRefs,
    created_at: new Date().toISOString(),
  };

  // 5. 原子写入
  store.addExperiment(experiment);
  for (const task of tasks) {
    store.addToGlobalQueue(task);
  }

  triggerSchedule();
  res.status(201).json({ experiment_id: experimentId, task_refs: taskRefs });
});
```

### 5.3 Task 生命周期变更

现有 `depends_on` + `blocked` 状态已实现。需要新增：

**Promotion 逻辑（task 完成时触发）：**

```typescript
function onTaskCompleted(taskId: string) {
  // 查找所有 depends_on 包含此 task 的 blocked task
  const dependents = store.findBlockedDependents(taskId);
  for (const dep of dependents) {
    const allDeps = dep.depends_on || [];
    const allDone = allDeps.every(id => {
      const t = store.findTask(id)?.task;
      return t?.status === "completed";
    });
    if (allDone) {
      // 解析 args_template
      resolveTemplates(dep);
      // Promote
      store.updateTaskStatus(dep.id, "pending");
      triggerSchedule();
    }
  }
}

function onTaskFailed(taskId: string) {
  // 级联取消所有下游 task
  const downstream = store.findAllDownstream(taskId);
  for (const t of downstream) {
    store.updateTaskStatus(t.id, "cancelled");
  }
  // 更新实验状态
  updateExperimentStatus(taskId);
}
```

**Template 解析：**

```typescript
function resolveTemplates(task: Task) {
  if (!task.args_template) return;

  const resolved: Record<string, string> = {};
  for (const [key, template] of Object.entries(task.args_template)) {
    resolved[key] = template.replace(
      /\{\{tasks\.(\w+)\.exports\.(\w+)\}\}/g,
      (_, ref, exportKey) => {
        const refTaskId = findTaskIdByRef(task.experiment_id, ref);
        const refTask = store.findTask(refTaskId)?.task;
        return String(refTask?.exports?.[exportKey] ?? "");
      }
    );
  }

  // Merge into args
  task.args = { ...(task.args || {}), ...resolved };
}
```

### 5.4 Experiment 状态聚合

```typescript
function computeExperimentStatus(exp: Experiment): string {
  const tasks = Object.values(exp.task_refs).map(id => store.findTask(id)?.task);
  const statuses = tasks.map(t => t?.status);

  if (statuses.every(s => s === "completed")) return "completed";
  if (statuses.some(s => s === "failed" || s === "cancelled")) {
    return statuses.some(s => s === "completed") ? "partial" : "failed";
  }
  return "running";
}
```

---

## 6. SDK Changes

### 6.1 新增文件

```
alchemy_sdk/
├── experiment.py    # Experiment, TaskNode, ExperimentResult
├── submit.py        # HTTP submission logic
└── (existing files unchanged)
```

### 6.2 experiment.py

```python
"""Experiment DAG definition and submission."""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from typing import Any, Optional

from .submit import submit_experiment, get_experiment_status


@dataclass
class TaskNode:
    """A node in the experiment DAG. Created by Experiment.task()."""
    ref: str
    _spec: dict[str, Any] = field(repr=False)
    task_id: Optional[str] = None  # populated after submit

    def __repr__(self) -> str:
        status = f" id={self.task_id}" if self.task_id else ""
        return f"TaskNode({self.ref!r}{status})"


@dataclass
class ExperimentResult:
    experiment_id: str
    task_refs: dict[str, str]
    already_exists: bool
    url: str


@dataclass
class TaskStatusDetail:
    ref: str
    task_id: str
    status: str
    exit_code: Optional[int] = None
    exports: Optional[dict[str, Any]] = None


@dataclass
class ExperimentStatus:
    experiment_id: str
    name: str
    status: str
    tasks: dict[str, TaskStatusDetail]


class Experiment:
    """
    Define a DAG of tasks. Running the script submits the entire experiment.

    Usage:
        exp = Experiment("my_experiment")
        a = exp.task("train", script="train.py", args={"--lr": "1e-4"})
        b = exp.task("eval", script="eval.py", depends_on=[a])
        exp.submit()
    """

    def __init__(
        self,
        name: str,
        *,
        description: str = "",
        server: Optional[str] = None,
    ) -> None:
        self.name = name
        self.description = description
        self._server = server or os.environ.get("ALCHEMY_SERVER") or self._read_config_server()
        self._tasks: list[TaskNode] = []
        self._refs: set[str] = set()
        self._experiment_id: Optional[str] = None

    def task(
        self,
        ref: str,
        *,
        script: str,
        args: Optional[dict[str, str]] = None,
        raw_args: Optional[str] = None,
        args_template: Optional[dict[str, str]] = None,
        depends_on: Optional[list[TaskNode]] = None,
        cwd: Optional[str] = None,
        python_env: Optional[str] = None,
        env_setup: Optional[str] = None,
        env: Optional[dict[str, str]] = None,
        env_overrides: Optional[dict[str, str]] = None,
        requirements: Optional[dict] = None,
        target_tags: Optional[list[str]] = None,
        max_retries: int = 0,
        priority: int = 5,
        outputs: Optional[list[str]] = None,
    ) -> TaskNode:
        if ref in self._refs:
            raise ValueError(f"Duplicate task ref: {ref!r}")
        self._refs.add(ref)

        spec: dict[str, Any] = {"ref": ref, "script": script}
        if args:               spec["args"] = args
        if raw_args:           spec["raw_args"] = raw_args
        if args_template:      spec["args_template"] = args_template
        if depends_on:         spec["depends_on"] = [t.ref for t in depends_on]
        if cwd:                spec["cwd"] = cwd
        if python_env:         spec["python_env"] = python_env
        if env_setup:          spec["env_setup"] = env_setup
        if env:                spec["env"] = env
        if env_overrides:      spec["env_overrides"] = env_overrides
        if requirements:       spec["requirements"] = requirements
        if target_tags:        spec["target_tags"] = target_tags
        if max_retries:        spec["max_retries"] = max_retries
        if priority != 5:      spec["priority"] = priority
        if outputs:            spec["outputs"] = outputs

        node = TaskNode(ref=ref, _spec=spec)
        self._tasks.append(node)
        return node

    def submit(self, *, dry_run: bool = False, force: bool = False) -> ExperimentResult:
        """
        Submit the experiment to the server.

        dry_run: validate DAG and print what would be submitted, don't actually submit.
        force: if a same-name experiment is active, kill it and resubmit.
        """
        self._validate_dag()

        if dry_run:
            self._print_dag()
            return ExperimentResult(
                experiment_id="dry-run",
                task_refs={t.ref: "dry-run" for t in self._tasks},
                already_exists=False,
                url="",
            )

        specs = [t._spec for t in self._tasks]
        result = submit_experiment(
            server=self._server,
            name=self.name,
            description=self.description,
            task_specs=specs,
            force=force,
        )

        # Backfill task_ids
        self._experiment_id = result.experiment_id
        for t in self._tasks:
            t.task_id = result.task_refs.get(t.ref)

        return result

    def status(self) -> ExperimentStatus:
        if not self._experiment_id:
            raise RuntimeError("Experiment not yet submitted")
        return get_experiment_status(self._server, self._experiment_id)

    # ── Validation ──

    def _validate_dag(self) -> None:
        if not self._tasks:
            raise ValueError("Experiment has no tasks")

        # Check for cycles via DFS
        adj: dict[str, list[str]] = {t.ref: [] for t in self._tasks}
        for t in self._tasks:
            for dep_ref in t._spec.get("depends_on", []):
                if dep_ref not in adj:
                    raise ValueError(f"Task {t.ref!r} depends on unknown ref {dep_ref!r}")
                adj[dep_ref].append(t.ref)

        visited: set[str] = set()
        in_stack: set[str] = set()

        def dfs(node: str) -> None:
            visited.add(node)
            in_stack.add(node)
            for child in adj[node]:
                if child in in_stack:
                    raise ValueError(f"Cyclic dependency detected involving {child!r}")
                if child not in visited:
                    dfs(child)
            in_stack.discard(node)

        for ref in adj:
            if ref not in visited:
                dfs(ref)

    def _print_dag(self) -> None:
        print(f"Experiment: {self.name}")
        print(f"Tasks ({len(self._tasks)}):")
        for t in self._tasks:
            deps = t._spec.get("depends_on", [])
            dep_str = f" ← [{', '.join(deps)}]" if deps else ""
            print(f"  {t.ref}: {t._spec['script']}{dep_str}")

    @staticmethod
    def _read_config_server() -> str:
        """Read server URL from ~/.alchemy/config.yaml."""
        config_path = os.path.expanduser("~/.alchemy/config.yaml")
        if os.path.exists(config_path):
            try:
                import yaml  # type: ignore
                with open(config_path) as f:
                    cfg = yaml.safe_load(f)
                return cfg.get("server", "")
            except Exception:
                pass
        return ""
```

### 6.3 submit.py

```python
"""HTTP submission for experiments."""
from __future__ import annotations

import json
import urllib.request
import urllib.error
from typing import Any

from .experiment import ExperimentResult, ExperimentStatus, TaskStatusDetail


def submit_experiment(
    server: str,
    name: str,
    description: str,
    task_specs: list[dict[str, Any]],
    force: bool = False,
) -> ExperimentResult:
    url = f"{server.rstrip('/')}/api/experiments"
    payload = {
        "name": name,
        "description": description,
        "task_specs": task_specs,
        "force": force,
    }

    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})

    try:
        resp = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as e:
        error_body = e.read().decode(errors="replace")
        raise RuntimeError(f"Experiment submission failed ({e.code}): {error_body}") from e

    data = json.loads(resp.read())
    already_exists = resp.status == 200
    dashboard_url = f"{server.rstrip('/')}/experiments/{data['experiment_id']}"

    return ExperimentResult(
        experiment_id=data["experiment_id"],
        task_refs=data.get("task_refs", {}),
        already_exists=already_exists,
        url=dashboard_url,
    )


def get_experiment_status(server: str, experiment_id: str) -> ExperimentStatus:
    url = f"{server.rstrip('/')}/api/experiments/{experiment_id}"
    req = urllib.request.Request(url)

    try:
        resp = urllib.request.urlopen(req, timeout=15)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Failed to get experiment status ({e.code})") from e

    data = json.loads(resp.read())
    tasks = {}
    for ref, task_id in data.get("task_refs", {}).items():
        task_data = data.get("tasks", {}).get(task_id, {})
        tasks[ref] = TaskStatusDetail(
            ref=ref,
            task_id=task_id,
            status=task_data.get("status", "unknown"),
            exit_code=task_data.get("exit_code"),
            exports=task_data.get("exports"),
        )

    return ExperimentStatus(
        experiment_id=data["id"],
        name=data["name"],
        status=data["status"],
        tasks=tasks,
    )
```

### 6.4 `__init__.py` 更新

```python
from .client import Alchemy
from .context import TrainingContext
from .experiment import Experiment, TaskNode

__all__ = ["Alchemy", "TrainingContext", "Experiment", "TaskNode"]
```

---

## 7. Migration Path

### 现有用法不受影响

- `Alchemy()` / `al.log()` / `al.managed()` 完全不变
- 单 task 通过 `POST /tasks` 提交，跟以前一样
- `experiment_id` 字段可选，不填就是独立 task

### 渐进迁移

```
# Phase 1: depends_on + blocked 状态（已有）
# Phase 2: POST /api/experiments endpoint（原子提交）
# Phase 3: SDK Experiment 类（本文档）
# Phase 4: args_template 模板解析
```

每个 phase 独立部署，不需要一次全做。

---

## 8. Edge Cases

### 8.1 部分失败

- Task A 成功，Task B 失败
- 实验状态 → `partial`
- B 的下游全部 → `cancelled`
- 用户可以 `POST /api/experiments/:id/retry` 只重跑失败的 task

### 8.2 Task 重试

- Task 设置 `max_retries=2`
- 失败后 server 自动创建 retry task（现有逻辑），保持 `experiment_id` 和 `ref`
- retry task 继承 `depends_on`，但因为上游已完成，直接进 `pending`
- 只有超过 max_retries 才触发下游 cancel

### 8.3 DAG 修改（实验还在跑）

**不支持在线修改 DAG。** 改了脚本就 `submit(force=True)` 重跑。理由：

- 在线修改 DAG 的复杂度远超收益
- ML 实验不需要热更新——重跑一个 train job 本来就要几小时
- Git diff 才是真正的变更记录

### 8.4 大 fan-out

```python
# 30 个 seed
trains = [exp.task(f"train_s{s}", script="train.py", args={"--seed": str(s)}) for s in range(30)]
exp.task("aggregate", script="aggregate.py", depends_on=trains)
```

Server 侧：一次性创建 31 个 task。`aggregate` blocked 直到 30 个 train 全部完成。没有特殊限制，跟现有 global queue 一样排队。

### 8.5 幂等 re-run

```bash
# 第一次
python experiment.py    # → 201 Created, 启动实验
# 第二次（实验还在跑）
python experiment.py    # → 200 OK, 返回现有状态，不重复创建
# 第三次（实验已完成）
python experiment.py    # → 201 Created, 新的实验
```

### 8.6 export 缺失

下游 task 的 `args_template` 引用了一个不存在的 export key：

- Server 在 promote 时解析模板
- 如果 key 不存在 → promote 失败，task 标记 `failed`，error 写入 `error_message`
- 不会静默用空字符串替换——那样只会产生更难 debug 的错误

### 8.7 Stub 断线

- Task 变 `lost` → 跟独立 task 逻辑一致
- 不触发下游 cancel（`lost` 不是终态）
- 如果 stub 重连，task resume → 继续正常流程
- 如果 stub 永久丢失，手动 kill → 触发下游 cancel

---

## Appendix: 与 sdk-spec.md 的关系

`sdk-spec.md` 定义了更重的 Workflow + Node + Port 系统（类似 Airflow）。本文档的 Experiment 是轻量替代：

| | sdk-spec Workflow | 本文档 Experiment |
|---|---|---|
| 定义方式 | @node 装饰器 + Workflow 类 + Port 连线 | 普通 Python 脚本 + `exp.task()` |
| 注册 | 需要 `POST /api/nodes/register` | 不需要注册 |
| 数据传递 | Port 类型系统 + `>>` 连线 | `al.export()` + `args_template` |
| 复杂度 | 高（AST 解析、类型检查） | 低（JSON over HTTP） |
| 目标用户 | 平台工程师 | ML 研究员 |

两者可以共存。Experiment 是 v2.2 的实现目标。Workflow 是远期方向。
