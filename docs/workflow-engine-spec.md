# AIchemy v2 Workflow Engine Spec

## Overview

将 alchemy 从 task runner 升级为可视化 workflow engine。用户在节点编辑器中编排训练流水线，alchemy 管理数据流、依赖、调度和执行。

类似 ComfyUI 的节点编排，但面向 ML 训练：compute 节点跑在远程 GPU stub 上，control 节点在 server 端本地执行。

## Core Concepts

### Workflow
一个 DAG（有向无环图），由 Node 和 Edge 组成。

```typescript
interface Workflow {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  status: "draft" | "validating" | "ready" | "running" | "completed" | "failed" | "paused";
  created_at: string;
  started_at?: string;
  finished_at?: string;
  created_by?: string;
}
```

### Node
每个节点是一个可执行单元，有类型化的输入/输出端口。

```typescript
interface WorkflowNode {
  id: string;
  type: string;           // "compute" | "copy" | "filter" | "branch" | "merge" | "transform" | "checkpoint_select"
  label: string;
  config: NodeConfig;     // type-specific configuration
  position: { x: number; y: number };  // canvas position
  inputs: Port[];
  outputs: Port[];
  status: "pending" | "ready" | "running" | "completed" | "failed" | "skipped";
  task_id?: string;       // linked alchemy task (for compute nodes)
  result?: any;           // execution result (for control nodes)
}

interface Port {
  id: string;
  name: string;
  type: PortType;
  required: boolean;
  value?: any;            // resolved value after execution
}

type PortType = "dir" | "file" | "checkpoint" | "metrics" | "params" | "bool" | "string" | "number";
```

### Edge
连接两个端口，定义数据流。

```typescript
interface WorkflowEdge {
  id: string;
  source_node: string;
  source_port: string;
  target_node: string;
  target_port: string;
}
```

## Node Types

### 1. Compute Node (GPU)
在远程 stub 上执行训练/推理命令。

**Inputs:**
- `cwd` (dir, optional) — 工作目录
- `config` (file, optional) — 配置文件路径
- `checkpoint` (checkpoint, optional) — 预训练权重
- `params` (params, optional) — 超参数覆盖

**Outputs:**
- `run_dir` (dir) — 输出目录
- `checkpoint` (checkpoint) — 最终/最优 checkpoint
- `metrics` (metrics) — 训练指标 (loss, acc, etc.)
- `exit_code` (number) — 退出码

**Config:**
```typescript
interface ComputeNodeConfig {
  command: string;
  env?: Record<string, string>;
  env_setup?: string;
  estimated_vram_mb?: number;
  stub_id?: string;       // 指定 stub，不指定则自动分配
  resumable?: boolean;
  run_dir_template?: string;  // e.g. "experiments/{workflow_name}/{node_label}"
}
```

### 2. Copy Node (Server)
文件/目录复制。server 端通过 SSH 或 stub shell 执行。

**Inputs:**
- `source` (dir|file)
- `destination` (string) — 目标路径

**Outputs:**
- `path` (dir|file) — 复制后的路径

### 3. Filter/Select Node (Server)
从目录中选择文件，按条件筛选。

**Inputs:**
- `source_dir` (dir)
- `pattern` (string) — glob pattern
- `sort_by` (string, optional) — metric name
- `top_k` (number, optional)

**Outputs:**
- `selected` (file|checkpoint) — 选中的文件

**Use case:** 从多次训练中选 loss 最低的 checkpoint。

### 4. Branch Node (Server)
条件分支。根据上游 metric 决定走哪条路。

**Inputs:**
- `condition` (bool|number|metrics)
- `threshold` (number, optional)
- `operator` (string) — "gt" | "lt" | "eq" | "contains"

**Outputs:**
- `true_branch` (any) — 条件为真时传递
- `false_branch` (any) — 条件为假时传递

**Use case:** loss < 0.1 时继续 fine-tune，否则重新训练。

### 5. Merge Node (Server)
多路输入汇合为一个输出。

**Inputs:**
- `input_1..N` (any) — 动态端口数量

**Outputs:**
- `merged` (dir) — 合并后的目录/数据

### 6. Transform Node (Server)
数据格式转换、参数映射。执行一段轻量脚本。

**Inputs:**
- `input` (any)
- `script` (string) — inline bash/python script

**Outputs:**
- `output` (any)

### 7. Checkpoint Select Node (Server)
专用节点：从 run_dir 中按 metric 选最优 checkpoint。

**Inputs:**
- `run_dir` (dir)
- `metric` (string) — e.g. "val_loss"
- `mode` (string) — "min" | "max"

**Outputs:**
- `checkpoint` (checkpoint)
- `metric_value` (number)

## Validation Rules

### Compile-time (编辑器内实时校验)

1. **类型匹配** — Edge 的 source port type 必须兼容 target port type
   - 兼容矩阵:
     - `dir` → `dir`, `file` (子路径解析)
     - `checkpoint` → `file`, `checkpoint`
     - `file` → `file`, `string` (路径)
     - `any` → any type
   
2. **必填端口** — `required: true` 的 input port 必须有 edge 连入，或有 default value

3. **无环** — DAG 不允许环（已有 `hasCycle` 实现）

4. **孤立节点** — 警告无连接的节点（不阻止提交）

5. **Compute 节点约束**:
   - `command` 不能为空
   - `estimated_vram_mb` 建议填写

### Runtime (提交前校验)

1. **路径存在性** — input dir/file 端口引用的路径必须存在（通过 stub shell 检查）
2. **Stub 可用性** — 指定 stub_id 的节点，stub 必须 online
3. **VRAM 充足** — 所有 compute 节点的 VRAM 需求不超过可用资源
4. **依赖完整性** — depends_on chain 中的所有 task 必须存在

## Execution Engine

### 拓扑排序执行

1. 计算 DAG 拓扑序
2. 按层级并行执行（同层无依赖的节点并行）
3. Compute 节点 → 创建 alchemy task，派发到 stub
4. Control 节点 → server 端直接执行（< 30s 超时）

### 数据流传递

节点完成后，引擎将 output port 的值传递到下游 input port：

- `dir` 类型：传递路径字符串（e.g. `/data/exp001/`）
- `checkpoint` 类型：传递文件路径
- `metrics` 类型：传递 JSON object
- Compute 节点的 `run_dir` 由 alchemy 自动管理路径

### 错误处理

- **Compute 节点失败** → 标记为 failed，下游全部 skipped
- **Branch false** → false_branch 下游执行，true_branch 下游 skipped
- **Control 节点超时** → 标记为 failed，可配置 retry
- **Stub 断连** → compute 节点标记为 interrupted，等待重连或迁移

### Workflow 级操作

- **Pause** — 暂停所有 running compute 节点，pending 节点不启动
- **Resume** — 恢复执行
- **Cancel** — kill 所有 running 节点，整体标记 failed
- **Retry** — 从第一个 failed 节点重新开始

## API Endpoints

```
POST   /api/workflows              — 创建 workflow
GET    /api/workflows              — 列出所有 workflows
GET    /api/workflows/:id          — 获取 workflow 详情
PATCH  /api/workflows/:id          — 更新 workflow（编辑节点/边）
DELETE /api/workflows/:id          — 删除 workflow
POST   /api/workflows/:id/validate — 校验 workflow
POST   /api/workflows/:id/run      — 执行 workflow
POST   /api/workflows/:id/pause    — 暂停
POST   /api/workflows/:id/resume   — 恢复
POST   /api/workflows/:id/cancel   — 取消
POST   /api/workflows/:id/retry    — 从失败处重试
```

## WebSocket Events

```
workflow.update    — workflow 状态变更
workflow.node.update — 单个节点状态变更
workflow.edge.data — edge 数据传递事件（调试用）
```

## Frontend: Node Editor

### Tech Stack
- React Flow (MIT license) — 节点编辑器核心
- dagre — 自动布局
- 或参考 ComfyUI 的 litegraph.js（更轻量，无 React 依赖）

### UI 交互
1. 左侧面板：节点类型列表，拖入画布
2. 画布：拖拽节点、连线、选中编辑
3. 右侧面板：选中节点的配置表单
4. 顶栏：Validate / Run / Pause / Cancel 按钮
5. 底栏：执行日志流

### 实时更新
- WebSocket 推送节点状态变更
- 节点颜色反映状态（grey=pending, blue=running, green=completed, red=failed）
- Edge 动画表示数据传输中

## Implementation Phases

### Phase 1: DAG 可视化（只读）
- 现有 task chain 渲染为节点图
- 状态实时更新
- 无编辑功能
- ~2-3 天

### Phase 2: Workflow CRUD + 基础编辑
- Workflow 数据模型 + API
- 节点编辑器（Compute + Copy 两种节点）
- 校验 + 执行
- ~5-7 天

### Phase 3: Control 节点 + 高级编排
- Branch / Merge / Filter / Transform 节点
- 条件执行
- Retry / partial re-run
- ~3-5 天

### Phase 4: 模板 + 复用
- Workflow 模板保存/加载
- 子 workflow（节点组）
- 参数化 workflow（外部传入变量）
- ~3-5 天
