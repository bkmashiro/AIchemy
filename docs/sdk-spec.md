# AIchemy SDK Spec

## Overview

`alchemy-sdk` 是一个 Python 包，让用户用装饰器定义自定义节点，用代码编排 workflow，通过 CLI 提交到 alchemy server。

## Installation

```bash
pip install alchemy-sdk
```

## 1. Node Definition

### @node 装饰器

```python
from alchemy_sdk import node, Port, NodeConfig

@node(
    name="train_gpt",                    # 唯一标识符，snake_case
    label="Train GPT",                   # 显示名称
    description="Fine-tune GPT model",
    category="training",                 # 面板分组
    icon="⬡",                           # 编辑器图标
    gpu=True,                            # 需要GPU
    estimated_vram_mb=24000,
    env_setup="conda activate jema",     # 环境初始化
)
def train_gpt(
    # --- Inputs (type-annotated parameters) ---
    dataset: Port.dir("Training dataset", required=True),
    config: Port.file("Config YAML", required=True),
    base_ckpt: Port.checkpoint("Pretrained weights"),
    lr: Port.number("Learning rate", default=1e-4),
    epochs: Port.number("Training epochs", default=10),
    notes: Port.string("Run notes"),
) -> NodeConfig:
    """
    函数体返回 NodeConfig，告诉 alchemy 怎么执行这个节点。
    输入端口的值在运行时自动注入为参数。
    """
    return NodeConfig(
        command=f"python train.py --data {dataset} --config {config} --lr {lr} --epochs {epochs}",
        cwd="/home/ys25/jema",
        env={"WANDB_PROJECT": "jema", "NOTES": notes or ""},
        outputs={
            "run_dir": Port.dir("Output directory"),          # alchemy 自动分配路径
            "best_ckpt": Port.checkpoint("Best checkpoint"),  # 从 run_dir 内推断
            "metrics": Port.metrics("Final metrics"),         # 从 stdout/文件解析
            "exit_code": Port.number("Exit code"),
        },
    )
```

### Port 类型

```python
class Port:
    @staticmethod
    def dir(desc: str, required: bool = False, default: str = None) -> PortSpec: ...
    
    @staticmethod
    def file(desc: str, required: bool = False, default: str = None, 
             extensions: list[str] = None) -> PortSpec: ...
    
    @staticmethod
    def checkpoint(desc: str, required: bool = False) -> PortSpec: ...
    
    @staticmethod
    def metrics(desc: str, required: bool = False) -> PortSpec: ...
    
    @staticmethod
    def params(desc: str, required: bool = False, 
               schema: dict = None) -> PortSpec: ...
    
    @staticmethod
    def number(desc: str, required: bool = False, default: float = None,
               min: float = None, max: float = None) -> PortSpec: ...
    
    @staticmethod
    def string(desc: str, required: bool = False, default: str = None,
               choices: list[str] = None) -> PortSpec: ...
    
    @staticmethod
    def bool(desc: str, required: bool = False, default: bool = None) -> PortSpec: ...
    
    @staticmethod
    def any(desc: str, required: bool = False) -> PortSpec: ...
    
    @staticmethod
    def list(inner_type: str, desc: str, required: bool = False) -> PortSpec: ...
```

### NodeConfig 返回值

```python
@dataclass
class NodeConfig:
    command: str                          # 执行的命令
    cwd: str | None = None               # 工作目录
    env: dict[str, str] | None = None    # 环境变量
    env_setup: str | None = None         # 覆盖 @node 的 env_setup
    outputs: dict[str, PortSpec] = None  # 输出端口定义
    run_dir_template: str | None = None  # 输出目录模板
    
    # 高级选项
    resumable: bool = False
    post_hooks: list[str] | None = None
    timeout_s: int | None = None
```

### Control Node (非 GPU)

```python
@node(name="select_best", label="Select Best Checkpoint", gpu=False)
def select_best(
    run_dir: Port.dir("Run directory", required=True),
    metric: Port.string("Metric name", default="val_loss"),
    mode: Port.string("Selection mode", default="min", choices=["min", "max"]),
) -> NodeConfig:
    return NodeConfig(
        # gpu=False 的节点在 server 端执行，command 跑在任意在线 stub 上
        command=f"python -c \"import json,glob; files=glob.glob('{run_dir}/checkpoints/*.json'); "
                f"best=sorted(files, key=lambda f: json.load(open(f))['{metric}'])"
                f"{'[0]' if mode == 'min' else '[-1]'}; print(best)\"",
        outputs={
            "checkpoint": Port.checkpoint("Best checkpoint"),
            "metric_value": Port.number("Metric value"),
        },
    )
```

## 2. Workflow Definition (Programmatic)

```python
from alchemy_sdk import Workflow

wf = Workflow(name="jema_full_pipeline", description="JEMA training pipeline")

# 添加节点（引用已注册的节点类型）
pretrain = wf.add("train_gpt", label="Pretrain",
    config="/home/ys25/jema/configs/pretrain.yaml",
    lr=1e-4, epochs=100,
)

select = wf.add("select_best", label="Select Pretrain Ckpt",
    metric="val_loss", mode="min",
)

finetune = wf.add("train_gpt", label="Fine-tune",
    config="/home/ys25/jema/configs/finetune.yaml",
    lr=1e-5, epochs=50,
)

evaluate = wf.add("evaluate_model", label="Eval",
    eval_script="eval.py",
)

# 连线（source.output_port >> target.input_port）
pretrain.run_dir >> select.run_dir
select.checkpoint >> finetune.base_ckpt
finetune.run_dir >> evaluate.run_dir

# 提交
wf.submit()  # 等价于 POST /api/workflows + POST /api/workflows/:id/run
```

### 条件分支

```python
from alchemy_sdk import Branch

check = wf.add("check_loss", label="Loss OK?",
    threshold=0.1, operator="lt",
)

pretrain.metrics >> check.condition

# Branch 语法
with check.true_branch:
    ft = wf.add("train_gpt", label="Fine-tune (good)")
    select.checkpoint >> ft.base_ckpt

with check.false_branch:
    retry = wf.add("train_gpt", label="Retrain (bad)",
        lr=5e-5, epochs=200,
    )
```

### 参数扫描 (Grid in Workflow)

```python
from alchemy_sdk import Grid

# 在 workflow 内展开参数网格
grid = wf.grid("train_gpt", label="LR Sweep",
    config="/home/ys25/jema/configs/pretrain.yaml",
    lr=[1e-3, 1e-4, 1e-5],
    epochs=[50, 100],
)
# grid 自动展开为 6 个 compute 节点
# grid.best 输出最优结果
grid.best.checkpoint >> finetune.base_ckpt
```

## 3. Node Registration API

### Upload & Register

```
POST /api/nodes/register
Content-Type: multipart/form-data

file: train_gpt.py
```

**Server-side 处理：**

1. 接收 `.py` 文件
2. AST 解析（`ast.parse`，不执行代码）：
   - 找到所有 `@node` 装饰器
   - 提取 name, label, description, category, gpu, estimated_vram_mb, env_setup
   - 解析函数签名，提取输入端口（参数名 + Port.xxx 调用）
   - 解析返回值中的 outputs dict
3. 校验：
   - `name` 唯一且合法（`[a-z0-9_]+`）
   - 不与内置节点冲突
   - 所有 Port 类型合法
   - import 列表检查（只允许标准库 + alchemy_sdk + 白名单包）
   - 无危险调用（`os.system`, `subprocess`, `eval`, `exec` 等）
4. 保存文件到 `nodes/` 目录
5. 注册到 store，前端可用

### Response

```json
{
  "ok": true,
  "nodes": [
    {
      "name": "train_gpt",
      "label": "Train GPT",
      "category": "training",
      "gpu": true,
      "inputs": [
        { "name": "dataset", "type": "dir", "required": true, "description": "Training dataset" },
        { "name": "config", "type": "file", "required": true, "description": "Config YAML" },
        { "name": "lr", "type": "number", "required": false, "default": 0.0001 }
      ],
      "outputs": [
        { "name": "run_dir", "type": "dir", "description": "Output directory" },
        { "name": "best_ckpt", "type": "checkpoint", "description": "Best checkpoint" },
        { "name": "metrics", "type": "metrics", "description": "Final metrics" }
      ]
    }
  ],
  "warnings": []
}
```

### Other Endpoints

```
GET    /api/nodes                — 列出所有节点（内置 + 自定义）
GET    /api/nodes/:name          — 节点详情
DELETE /api/nodes/:name          — 删除自定义节点（内置不可删）
PUT    /api/nodes/:name          — 更新（重新上传）
POST   /api/nodes/:name/validate — 校验脚本，不注册
GET    /api/nodes/:name/source   — 下载源文件
```

## 4. CLI

```bash
# 节点管理
alchemy node register train_gpt.py     # 上传并注册
alchemy node list                       # 列出所有节点
alchemy node info train_gpt             # 查看节点详情
alchemy node delete train_gpt           # 删除

# Workflow
alchemy workflow submit pipeline.py     # 提交 workflow 脚本
alchemy workflow list                   # 列出
alchemy workflow status <id>            # 查看状态
alchemy workflow cancel <id>            # 取消
alchemy workflow logs <id>              # 查看日志

# 快捷方式
alchemy run train_gpt.py \
  --dataset /data/train \
  --config config.yaml \
  --lr 1e-4                             # 直接跑单个节点（不建 workflow）
```

### CLI Config

```yaml
# ~/.alchemy/config.yaml
server: https://alchemy-v2.yuzhes.com
token: default-dev-token
default_stub: gpu30
```

## 5. AST Parser Design

Server 端用 Node.js 调用 Python AST 解析器（或者用 TypeScript 实现简化版）。

### Python Parser (推荐)

```python
# server/scripts/parse_node.py
"""Parse @node decorated functions from a Python file using AST."""
import ast
import json
import sys

class NodeVisitor(ast.NodeVisitor):
    def __init__(self):
        self.nodes = []
    
    def visit_FunctionDef(self, func):
        for deco in func.decorator_list:
            if self._is_node_decorator(deco):
                node_def = self._extract_node(func, deco)
                self.nodes.append(node_def)
    
    def _is_node_decorator(self, deco):
        if isinstance(deco, ast.Call):
            return getattr(deco.func, 'id', '') == 'node'
        return getattr(deco, 'id', '') == 'node'
    
    def _extract_node(self, func, deco):
        # Extract @node() kwargs
        meta = {}
        if isinstance(deco, ast.Call):
            for kw in deco.keywords:
                meta[kw.arg] = ast.literal_eval(kw.value)
        
        # Extract input ports from function params
        inputs = []
        for arg in func.args.args:
            if arg.arg == 'self':
                continue
            port = self._parse_port_annotation(arg)
            if port:
                inputs.append(port)
        
        # Extract output ports from return statement
        outputs = self._extract_outputs(func)
        
        # Extract imports
        imports = self._extract_imports(func)
        
        return {
            "name": meta.get("name", func.name),
            "label": meta.get("label", func.name),
            "description": meta.get("description", ""),
            "category": meta.get("category", "custom"),
            "gpu": meta.get("gpu", True),
            "estimated_vram_mb": meta.get("estimated_vram_mb"),
            "env_setup": meta.get("env_setup"),
            "inputs": inputs,
            "outputs": outputs,
            "source_function": func.name,
        }
    
    def _parse_port_annotation(self, arg):
        ann = arg.annotation
        if not isinstance(ann, ast.Call):
            return None
        # Port.dir("desc", required=True) → { name, type, desc, required }
        attr = getattr(ann.func, 'attr', None)
        if attr is None:
            return None
        port = {
            "name": arg.arg,
            "type": attr,
            "description": "",
            "required": False,
        }
        if ann.args:
            port["description"] = ast.literal_eval(ann.args[0])
        for kw in ann.keywords:
            port[kw.arg] = ast.literal_eval(kw.value)
        return port
    
    def _extract_outputs(self, func):
        # Walk function body for NodeConfig(outputs={...})
        outputs = []
        for node in ast.walk(func):
            if isinstance(node, ast.Call) and getattr(node.func, 'id', '') == 'NodeConfig':
                for kw in node.keywords:
                    if kw.arg == 'outputs' and isinstance(kw.value, ast.Dict):
                        for key, val in zip(kw.value.keys, kw.value.values):
                            name = ast.literal_eval(key)
                            port_type = getattr(val.func, 'attr', 'any')
                            desc = ast.literal_eval(val.args[0]) if val.args else ""
                            outputs.append({
                                "name": name,
                                "type": port_type,
                                "description": desc,
                            })
        return outputs

def parse_file(filepath):
    with open(filepath) as f:
        tree = ast.parse(f.read())
    
    # Security: check imports
    dangerous = {'os.system', 'subprocess', 'eval', 'exec', '__import__'}
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func_name = getattr(node.func, 'id', '') or getattr(node.func, 'attr', '')
            if func_name in dangerous:
                return {"error": f"Dangerous call detected: {func_name}"}
    
    visitor = NodeVisitor()
    visitor.visit(tree)
    return {"nodes": visitor.nodes, "warnings": []}

if __name__ == "__main__":
    result = parse_file(sys.argv[1])
    print(json.dumps(result))
```

Server 调用：`child_process.execFile('python3', ['scripts/parse_node.py', filepath])`

## 6. Runtime Execution

当 workflow 执行到自定义节点时：

1. Server 从 store 取出节点定义（inputs/outputs schema）
2. 从上游 edge 收集 input port 值
3. 在 stub 上执行：
   ```bash
   # 生成临时执行脚本
   cd {cwd}
   {env_setup}
   export ALCHEMY_NODE_INPUTS='{"dataset":"/data/train","lr":0.0001}'
   python -c "
   from {module} import {function}
   import json, os
   inputs = json.loads(os.environ['ALCHEMY_NODE_INPUTS'])
   config = {function}(**inputs)
   print(json.dumps({'command': config.command, 'env': config.env}))
   " > /tmp/alchemy_node_config.json
   
   # 读取生成的 command 并执行
   eval $(jq -r '.command' /tmp/alchemy_node_config.json)
   ```
4. 或者更简单：server 端 AST 已经知道 command 模板，直接字符串替换 input 值，不需要运行时调用 Python 函数。

**推荐方案：** 静态模板替换。`@node` 函数体在注册时 AST 解析出 command 模板（含 `{input_name}` 占位符），运行时 server 直接替换。避免在 stub 上安装 SDK。

## 7. Package Structure

```
alchemy-sdk/
├── alchemy_sdk/
│   ├── __init__.py          # 导出 node, Port, NodeConfig, Workflow
│   ├── decorators.py        # @node 装饰器
│   ├── ports.py             # Port 类型定义
│   ├── config.py            # NodeConfig
│   ├── workflow.py          # Workflow 编排类
│   └── cli.py               # CLI 入口
├── pyproject.toml
└── README.md
```

## 8. Integration with Editor

前端节点面板动态加载：

```
GET /api/nodes → [
  { name: "compute",  builtin: true,  category: "core", ... },
  { name: "copy",     builtin: true,  category: "core", ... },
  { name: "train_gpt", builtin: false, category: "training", ... },
  { name: "evaluate",  builtin: false, category: "evaluation", ... },
]
```

面板按 category 分组显示。自定义节点带 "custom" 标签。

编辑器创建节点时，根据 API 返回的 inputs/outputs 动态生成端口，不需要硬编码。
