import { v4 as uuidv4 } from "uuid";
import { store } from "../store";
import { Workflow, WorkflowNode, WorkflowRun, WorkflowRunNode, Task } from "../types";
import { Namespace } from "socket.io";
import { dispatchQueuedTasks } from "../socket/stub";
import { pickBestStub } from "../scheduler";
import { execSync } from "child_process";
import { sendDiscordNotification } from "../notifications";

// Track active timeout timers for node timeouts (keyed by run_id:node_id)
const nodeTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Resolve ${variable_name} references in a string using run variables.
 */
function resolveVariables(text: string, variables: Record<string, any>): string {
  return text.replace(/\$\{(\w+)\}/g, (_match, name) => {
    const val = variables[name];
    return val !== undefined ? String(val) : `\${${name}}`;
  });
}

/**
 * Resolve variables in all string values of a config object (shallow).
 */
function resolveConfigVariables(config: Record<string, any>, variables: Record<string, any>): Record<string, any> {
  const resolved: Record<string, any> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") {
      resolved[key] = resolveVariables(value, variables);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Get the WorkflowRunNode for a given node_id from a run.
 */
function getRunNode(run: WorkflowRun, nodeId: string): WorkflowRunNode | undefined {
  return run.nodes.find((n) => n.node_id === nodeId);
}

/**
 * Get template node from the run's workflow snapshot.
 */
function getTemplateNode(run: WorkflowRun, nodeId: string): WorkflowNode | undefined {
  return run.workflow_snapshot.nodes.find((n) => n.id === nodeId);
}

/**
 * Propagate output port values from a completed node to downstream input ports via edges.
 */
function propagateOutputs(run: WorkflowRun, completedNodeId: string): void {
  const snapshot = run.workflow_snapshot;
  const templateNode = snapshot.nodes.find((n) => n.id === completedNodeId);
  if (!templateNode) return;

  for (const edge of snapshot.edges) {
    if (edge.source_node !== completedNodeId) continue;
    const srcPort = templateNode.outputs.find((p) => p.id === edge.source_port);
    if (!srcPort) continue;

    const tgtTemplateNode = snapshot.nodes.find((n) => n.id === edge.target_node);
    if (!tgtTemplateNode) continue;
    const tgtPort = tgtTemplateNode.inputs.find((p) => p.id === edge.target_port);
    if (tgtPort) {
      tgtPort.value = srcPort.value;
    }
  }
}

/**
 * Mark all downstream nodes of a failed/skipped node as "skipped".
 */
function skipDownstream(run: WorkflowRun, nodeId: string, webNs: Namespace): void {
  const snapshot = run.workflow_snapshot;
  const downstream = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of snapshot.edges) {
      if (edge.source_node === current && !downstream.has(edge.target_node)) {
        downstream.add(edge.target_node);
        queue.push(edge.target_node);
      }
    }
  }

  for (const id of downstream) {
    const runNode = getRunNode(run, id);
    if (runNode && runNode.status !== "completed" && runNode.status !== "failed") {
      runNode.status = "skipped";
      runNode.finished_at = new Date().toISOString();
      store.setWorkflowRun(run);
      webNs.emit("workflow.run.node.update", { run_id: run.id, workflow_id: run.workflow_id, node: runNode });
    }
  }
}

/**
 * Execute a compute node by creating an alchemy task.
 */
function executeComputeNode(
  templateNode: WorkflowNode,
  run: WorkflowRun,
  runNode: WorkflowRunNode,
  stubNs: Namespace,
  webNs: Namespace,
): void {
  const resolvedConfig = resolveConfigVariables(templateNode.config, run.variables);
  const command = resolvedConfig.command as string;
  if (!command) {
    runNode.status = "failed";
    runNode.error = "No command specified";
    runNode.finished_at = new Date().toISOString();
    store.setWorkflowRun(run);
    webNs.emit("workflow.run.node.update", { run_id: run.id, workflow_id: run.workflow_id, node: runNode });
    skipDownstream(run, templateNode.id, webNs);
    checkRunCompletion(run, webNs);
    return;
  }

  // Resolve cwd/env from input ports
  const cwdPort = templateNode.inputs.find((p) => p.name === "cwd");
  const cwd = cwdPort?.value as string | undefined;
  const env = resolvedConfig.env as Record<string, string> | undefined;
  const envSetup = resolvedConfig.env_setup as string | undefined;
  const estimatedVram = resolvedConfig.estimated_vram_mb as number | undefined;

  // Pick a target stub
  const stubId = resolvedConfig.stub_id as string | undefined;
  const targetStub = stubId ? store.getStub(stubId) : pickBestStub(estimatedVram || 0);

  if (!targetStub || targetStub.status !== "online") {
    runNode.status = "failed";
    runNode.error = "No available stub";
    runNode.finished_at = new Date().toISOString();
    store.setWorkflowRun(run);
    webNs.emit("workflow.run.node.update", { run_id: run.id, workflow_id: run.workflow_id, node: runNode });
    skipDownstream(run, templateNode.id, webNs);
    checkRunCompletion(run, webNs);
    return;
  }

  const task: Task = {
    id: uuidv4(),
    stub_id: targetStub.id,
    command,
    cwd,
    env,
    env_setup: envSetup,
    status: "queued",
    created_at: new Date().toISOString(),
    log_buffer: [],
    depends_on: [],
    post_hooks: [],
    resumable: resolvedConfig.resumable || false,
    estimated_vram_mb: estimatedVram,
  };

  targetStub.tasks.push(task);
  store.setStub(targetStub);

  runNode.task_id = task.id;
  runNode.status = "running";
  runNode.started_at = new Date().toISOString();
  store.setWorkflowRun(run);

  webNs.emit("task.update", task);
  webNs.emit("workflow.run.node.update", { run_id: run.id, workflow_id: run.workflow_id, node: runNode });
  dispatchQueuedTasks(targetStub.id, stubNs);

  // Set up timeout if configured
  const timeoutS = templateNode.config.timeout_s as number | undefined;
  if (timeoutS && timeoutS > 0) {
    const timerKey = `${run.id}:${templateNode.id}`;
    const timer = setTimeout(() => {
      nodeTimeouts.delete(timerKey);
      handleNodeTimeout(run.id, templateNode.id, task.id, stubNs, webNs);
    }, timeoutS * 1000);
    nodeTimeouts.set(timerKey, timer);
  }
}

/**
 * Handle a compute node exceeding its timeout.
 */
function handleNodeTimeout(
  runId: string,
  nodeId: string,
  taskId: string,
  stubNs: Namespace,
  webNs: Namespace,
): void {
  const currentRun = store.getWorkflowRun(runId);
  if (!currentRun) return;
  const currentRunNode = getRunNode(currentRun, nodeId);
  if (!currentRunNode || currentRunNode.status !== "running") return;

  // Kill the task
  for (const stub of store.getAllStubs()) {
    const task = stub.tasks.find((t) => t.id === taskId);
    if (task && ["running", "queued", "dispatched"].includes(task.status)) {
      stubNs.to(`stub:${stub.id}`).emit("task.kill", { task_id: task.id, signal: "SIGTERM" });
      store.updateTask(stub.id, task.id, { status: "killed", finished_at: new Date().toISOString() });
      webNs.emit("task.update", { ...task, status: "killed" });
    }
  }

  currentRunNode.status = "failed";
  currentRunNode.error = "Timeout exceeded";
  currentRunNode.finished_at = new Date().toISOString();
  store.setWorkflowRun(currentRun);
  webNs.emit("workflow.run.node.update", { run_id: currentRun.id, workflow_id: currentRun.workflow_id, node: currentRunNode });
  skipDownstream(currentRun, nodeId, webNs);
  checkRunCompletion(currentRun, webNs);
}

/**
 * Clear timeout for a node if one exists.
 */
function clearNodeTimeout(runId: string, nodeId: string): void {
  const key = `${runId}:${nodeId}`;
  const timer = nodeTimeouts.get(key);
  if (timer) {
    clearTimeout(timer);
    nodeTimeouts.delete(key);
  }
}

/**
 * Execute a copy node (server-side file copy).
 */
function executeCopyNode(
  templateNode: WorkflowNode,
  run: WorkflowRun,
  runNode: WorkflowRunNode,
  webNs: Namespace,
): void {
  const srcPort = templateNode.inputs.find((p) => p.name === "source");
  const destPort = templateNode.inputs.find((p) => p.name === "destination");

  const source = srcPort?.value as string | undefined;
  const destination = destPort?.value as string | undefined;

  if (!source || !destination) {
    runNode.status = "failed";
    runNode.error = "Missing source or destination";
    runNode.finished_at = new Date().toISOString();
    store.setWorkflowRun(run);
    webNs.emit("workflow.run.node.update", { run_id: run.id, workflow_id: run.workflow_id, node: runNode });
    skipDownstream(run, templateNode.id, webNs);
    checkRunCompletion(run, webNs);
    return;
  }

  try {
    execSync(`cp -r ${JSON.stringify(source)} ${JSON.stringify(destination)}`, { timeout: 30_000 });
    const outPort = templateNode.outputs.find((p) => p.name === "path");
    if (outPort) outPort.value = destination;
    runNode.status = "completed";
    runNode.result = { path: destination };
    runNode.finished_at = new Date().toISOString();
  } catch (err: any) {
    runNode.status = "failed";
    runNode.error = err.message || "Copy failed";
    runNode.finished_at = new Date().toISOString();
  }

  store.setWorkflowRun(run);
  webNs.emit("workflow.run.node.update", { run_id: run.id, workflow_id: run.workflow_id, node: runNode });

  if (runNode.status === "completed") {
    propagateOutputs(run, templateNode.id);
  } else {
    skipDownstream(run, templateNode.id, webNs);
  }
  checkRunCompletion(run, webNs);
}

/**
 * Execute a control node (stub — not yet implemented for filter/branch/merge/transform/checkpoint_select).
 */
function executeControlNodeStub(
  templateNode: WorkflowNode,
  run: WorkflowRun,
  runNode: WorkflowRunNode,
  webNs: Namespace,
): void {
  runNode.status = "completed";
  runNode.result = { info: `${templateNode.type} node — stub execution (not yet implemented)` };
  runNode.finished_at = new Date().toISOString();

  // Pass through input values to outputs as-is
  for (const outPort of templateNode.outputs) {
    const inPort = templateNode.inputs[0];
    if (inPort) outPort.value = inPort.value;
  }

  store.setWorkflowRun(run);
  webNs.emit("workflow.run.node.update", { run_id: run.id, workflow_id: run.workflow_id, node: runNode });
  propagateOutputs(run, templateNode.id);
  checkRunCompletion(run, webNs);
}

/**
 * Check if a run has completed (all nodes done/skipped/failed).
 */
function checkRunCompletion(run: WorkflowRun, webNs: Namespace): void {
  const allDone = run.nodes.every((n) =>
    ["completed", "failed", "skipped"].includes(n.status)
  );

  if (!allDone) return;

  const anyFailed = run.nodes.some((n) => n.status === "failed");
  run.status = anyFailed ? "failed" : "completed";
  run.finished_at = new Date().toISOString();
  store.setWorkflowRun(run);
  webNs.emit("workflow.run.update", run);

  // Discord notification for workflow completion/failure
  const workflow = store.getWorkflow(run.workflow_id);
  const event = anyFailed ? "workflow.failed" : "workflow.completed";
  sendDiscordNotification(store.getNotificationConfig(), event, {
    name: workflow?.name || run.workflow_id,
    id: run.id,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
  });

  // Notify on individual failed nodes
  for (const node of run.nodes) {
    if (node.status === "failed") {
      sendDiscordNotification(store.getNotificationConfig(), "node.failed", {
        name: workflow?.nodes.find((n) => n.id === node.node_id)?.label || node.node_id,
        id: node.node_id,
        status: "failed",
        error: node.error,
        started_at: node.started_at,
        finished_at: node.finished_at,
      });
    }
  }
}

/**
 * Handle task completion — called when an alchemy task finishes.
 * Updates the corresponding WorkflowRunNode and triggers next layer.
 */
export function onTaskCompleted(
  taskId: string,
  exitCode: number,
  stubNs: Namespace,
  webNs: Namespace,
): void {
  for (const run of store.getWorkflowRuns()) {
    if (run.status !== "running") continue;

    const runNode = run.nodes.find((n) => n.task_id === taskId);
    if (!runNode) continue;

    const templateNode = getTemplateNode(run, runNode.node_id);
    if (!templateNode) continue;

    // Clear any timeout
    clearNodeTimeout(run.id, runNode.node_id);

    if (exitCode === 0) {
      runNode.status = "completed";
      runNode.exit_code = exitCode;
      runNode.finished_at = new Date().toISOString();

      // Resolve output ports from the task
      const task = store.getAllTasks().find((t) => t.id === taskId);
      if (task) {
        const runDirPort = templateNode.outputs.find((p) => p.name === "run_dir");
        if (runDirPort) runDirPort.value = task.run_dir || task.cwd;

        const ckptPort = templateNode.outputs.find((p) => p.name === "checkpoint");
        if (ckptPort) ckptPort.value = task.checkpoint_path;

        const metricsPort = templateNode.outputs.find((p) => p.name === "metrics");
        if (metricsPort) metricsPort.value = task.metrics;

        const exitPort = templateNode.outputs.find((p) => p.name === "exit_code");
        if (exitPort) exitPort.value = exitCode;

        runNode.log_buffer = task.log_buffer.slice(-100);
      }

      propagateOutputs(run, templateNode.id);
    } else {
      runNode.status = "failed";
      runNode.exit_code = exitCode;
      runNode.error = `Task exited with code ${exitCode}`;
      runNode.finished_at = new Date().toISOString();

      const task = store.getAllTasks().find((t) => t.id === taskId);
      if (task) {
        runNode.log_buffer = task.log_buffer.slice(-100);
      }

      skipDownstream(run, templateNode.id, webNs);
    }

    store.setWorkflowRun(run);
    webNs.emit("workflow.run.node.update", { run_id: run.id, workflow_id: run.workflow_id, node: runNode });

    executeReadyNodes(run, stubNs, webNs);
    checkRunCompletion(run, webNs);
    return;
  }
}

/**
 * Find and execute all nodes that are ready (all upstream deps completed).
 */
function executeReadyNodes(run: WorkflowRun, stubNs: Namespace, webNs: Namespace): void {
  if (run.status === "paused" || run.status === "failed" || run.status === "cancelled") return;

  const snapshot = run.workflow_snapshot;
  const completedNodeIds = new Set(
    run.nodes.filter((n) => n.status === "completed").map((n) => n.node_id)
  );

  for (const runNode of run.nodes) {
    if (runNode.status !== "pending") continue;

    const upstreamEdges = snapshot.edges.filter((e) => e.target_node === runNode.node_id);
    const allUpstreamDone = upstreamEdges.every((e) => completedNodeIds.has(e.source_node));

    if (upstreamEdges.length === 0 || allUpstreamDone) {
      const templateNode = getTemplateNode(run, runNode.node_id);
      if (templateNode) {
        executeNode(templateNode, run, runNode, stubNs, webNs);
      }
    }
  }
}

/**
 * Execute a single node based on its type.
 */
function executeNode(
  templateNode: WorkflowNode,
  run: WorkflowRun,
  runNode: WorkflowRunNode,
  stubNs: Namespace,
  webNs: Namespace,
): void {
  runNode.status = "running";
  runNode.started_at = new Date().toISOString();
  store.setWorkflowRun(run);
  webNs.emit("workflow.run.node.update", { run_id: run.id, workflow_id: run.workflow_id, node: runNode });

  switch (templateNode.type) {
    case "compute":
      executeComputeNode(templateNode, run, runNode, stubNs, webNs);
      break;
    case "copy":
      executeCopyNode(templateNode, run, runNode, webNs);
      break;
    default:
      executeControlNodeStub(templateNode, run, runNode, webNs);
      break;
  }
}

/**
 * Create and start a WorkflowRun from a workflow template.
 */
export function createAndRunWorkflow(
  workflow: Workflow,
  variables: Record<string, any>,
  stubNs: Namespace,
  webNs: Namespace,
): WorkflowRun {
  const now = new Date().toISOString();

  // Deep-clone the workflow as a snapshot so template edits don't affect running runs
  const snapshot: Workflow = JSON.parse(JSON.stringify(workflow));

  const run: WorkflowRun = {
    id: uuidv4(),
    workflow_id: workflow.id,
    workflow_snapshot: snapshot,
    variables,
    nodes: workflow.nodes.map((n) => ({
      node_id: n.id,
      status: "pending" as const,
    })),
    status: "running",
    created_at: now,
    started_at: now,
  };

  store.setWorkflowRun(run);
  webNs.emit("workflow.run.update", run);

  executeReadyNodes(run, stubNs, webNs);
  return run;
}

/**
 * Pause a running workflow run.
 */
export function pauseWorkflowRun(run: WorkflowRun, stubNs: Namespace, webNs: Namespace): void {
  run.status = "paused";

  for (const runNode of run.nodes) {
    if (runNode.status === "running" && runNode.task_id) {
      for (const stub of store.getAllStubs()) {
        const task = stub.tasks.find((t) => t.id === runNode.task_id);
        if (task && task.status === "running") {
          stubNs.to(`stub:${stub.id}`).emit("task.pause", { task_id: task.id });
          store.updateTask(stub.id, task.id, { status: "paused" });
          webNs.emit("task.update", { ...task, status: "paused" });
        }
      }
    }
  }

  store.setWorkflowRun(run);
  webNs.emit("workflow.run.update", run);
}

/**
 * Resume a paused workflow run.
 */
export function resumeWorkflowRun(run: WorkflowRun, stubNs: Namespace, webNs: Namespace): void {
  run.status = "running";

  for (const runNode of run.nodes) {
    if (runNode.status === "running" && runNode.task_id) {
      for (const stub of store.getAllStubs()) {
        const task = stub.tasks.find((t) => t.id === runNode.task_id);
        if (task && task.status === "paused") {
          stubNs.to(`stub:${stub.id}`).emit("task.resume", { task_id: task.id });
          store.updateTask(stub.id, task.id, { status: "running" });
          webNs.emit("task.update", { ...task, status: "running" });
        }
      }
    }
  }

  store.setWorkflowRun(run);
  webNs.emit("workflow.run.update", run);

  executeReadyNodes(run, stubNs, webNs);
}

/**
 * Cancel a workflow run.
 */
export function cancelWorkflowRun(run: WorkflowRun, stubNs: Namespace, webNs: Namespace): void {
  for (const runNode of run.nodes) {
    if ((runNode.status === "running" || runNode.status === "pending") && runNode.task_id) {
      clearNodeTimeout(run.id, runNode.node_id);

      for (const stub of store.getAllStubs()) {
        const task = stub.tasks.find((t) => t.id === runNode.task_id);
        if (task && ["running", "paused", "queued", "dispatched"].includes(task.status)) {
          stubNs.to(`stub:${stub.id}`).emit("task.kill", { task_id: task.id, signal: "SIGTERM" });
          store.updateTask(stub.id, task.id, { status: "killed", finished_at: new Date().toISOString() });
          webNs.emit("task.update", { ...task, status: "killed" });
        }
      }
    }

    if (runNode.status === "running") {
      runNode.status = "failed";
      runNode.finished_at = new Date().toISOString();
    } else if (runNode.status === "pending") {
      runNode.status = "skipped";
      runNode.finished_at = new Date().toISOString();
    }
  }

  run.status = "cancelled";
  run.finished_at = new Date().toISOString();
  store.setWorkflowRun(run);
  webNs.emit("workflow.run.update", run);
}

/**
 * Retry a failed/cancelled run — restart from the first failed node.
 */
export function retryWorkflowRun(run: WorkflowRun, stubNs: Namespace, webNs: Namespace): WorkflowRun {
  // Reset failed and skipped nodes back to pending
  for (const runNode of run.nodes) {
    if (runNode.status === "failed" || runNode.status === "skipped") {
      runNode.status = "pending";
      runNode.task_id = undefined;
      runNode.result = undefined;
      runNode.error = undefined;
      runNode.exit_code = undefined;
      runNode.started_at = undefined;
      runNode.finished_at = undefined;
      runNode.log_buffer = undefined;
    }
  }

  // Reset output port values for non-completed snapshot nodes
  const completedNodeIds = new Set(
    run.nodes.filter((n) => n.status === "completed").map((n) => n.node_id)
  );
  for (const node of run.workflow_snapshot.nodes) {
    if (!completedNodeIds.has(node.id)) {
      for (const port of node.outputs) {
        port.value = undefined;
      }
    }
  }

  run.status = "running";
  run.finished_at = undefined;
  store.setWorkflowRun(run);
  webNs.emit("workflow.run.update", run);

  executeReadyNodes(run, stubNs, webNs);
  return run;
}
