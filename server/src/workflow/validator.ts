import { Workflow, WorkflowNode, WorkflowEdge, PortType } from "../types";

export interface ValidationIssue {
  level: "error" | "warning";
  node_id?: string;
  message: string;
}

/**
 * Check if source port type is compatible with target port type.
 */
function isTypeCompatible(source: PortType, target: PortType): boolean {
  if (source === "any" || target === "any") return true;
  if (source === target) return true;

  // dir → dir, file
  if (source === "dir" && (target === "dir" || target === "file")) return true;
  // checkpoint → file, checkpoint
  if (source === "checkpoint" && (target === "file" || target === "checkpoint")) return true;
  // file → file, string
  if (source === "file" && (target === "file" || target === "string")) return true;

  return false;
}

/**
 * Detect cycles in the workflow DAG. Returns true if a cycle exists.
 */
function hasCycle(nodes: WorkflowNode[], edges: WorkflowEdge[]): boolean {
  const adj = new Map<string, string[]>();
  for (const node of nodes) {
    adj.set(node.id, []);
  }
  for (const edge of edges) {
    const list = adj.get(edge.source_node);
    if (list) list.push(edge.target_node);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(id: string): boolean {
    if (inStack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    inStack.add(id);
    for (const next of adj.get(id) || []) {
      if (dfs(next)) return true;
    }
    inStack.delete(id);
    return false;
  }

  for (const node of nodes) {
    if (dfs(node.id)) return true;
  }
  return false;
}

/**
 * Extract all ${variable_name} references from a string.
 */
function extractVariableRefs(text: string): string[] {
  const refs: string[] = [];
  const regex = /\$\{(\w+)\}/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

/**
 * Validate a workflow DAG. Returns an array of issues (errors and warnings).
 * Optionally accepts runtime variables to validate required variables are provided.
 */
export function validateWorkflow(workflow: Workflow, runtimeVariables?: Record<string, any>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeMap = new Map(workflow.nodes.map((n) => [n.id, n]));

  // 1. Cycle detection
  if (hasCycle(workflow.nodes, workflow.edges)) {
    issues.push({ level: "error", message: "Workflow contains a cycle" });
  }

  // 2. Edge validity — referenced nodes and ports must exist
  for (const edge of workflow.edges) {
    const srcNode = nodeMap.get(edge.source_node);
    const tgtNode = nodeMap.get(edge.target_node);

    if (!srcNode) {
      issues.push({ level: "error", message: `Edge ${edge.id}: source node ${edge.source_node} not found` });
      continue;
    }
    if (!tgtNode) {
      issues.push({ level: "error", node_id: edge.target_node, message: `Edge ${edge.id}: target node ${edge.target_node} not found` });
      continue;
    }

    const srcPort = srcNode.outputs.find((p) => p.id === edge.source_port);
    const tgtPort = tgtNode.inputs.find((p) => p.id === edge.target_port);

    if (!srcPort) {
      issues.push({ level: "error", node_id: srcNode.id, message: `Edge ${edge.id}: source port ${edge.source_port} not found on node "${srcNode.label}"` });
      continue;
    }
    if (!tgtPort) {
      issues.push({ level: "error", node_id: tgtNode.id, message: `Edge ${edge.id}: target port ${edge.target_port} not found on node "${tgtNode.label}"` });
      continue;
    }

    // 3. Type compatibility
    if (!isTypeCompatible(srcPort.type, tgtPort.type)) {
      issues.push({
        level: "error",
        node_id: tgtNode.id,
        message: `Type mismatch on edge ${edge.id}: ${srcPort.type} → ${tgtPort.type} (${srcNode.label}.${srcPort.name} → ${tgtNode.label}.${tgtPort.name})`,
      });
    }
  }

  // 4. Required input ports must have a connected edge or a default value
  const connectedInputs = new Set(workflow.edges.map((e) => `${e.target_node}:${e.target_port}`));
  for (const node of workflow.nodes) {
    for (const port of node.inputs) {
      if (port.required && !connectedInputs.has(`${node.id}:${port.id}`) && port.value === undefined) {
        issues.push({
          level: "error",
          node_id: node.id,
          message: `Required input port "${port.name}" on node "${node.label}" has no connection and no default value`,
        });
      }
    }
  }

  // 5. Isolated nodes — warning only
  const connectedNodes = new Set<string>();
  for (const edge of workflow.edges) {
    connectedNodes.add(edge.source_node);
    connectedNodes.add(edge.target_node);
  }
  for (const node of workflow.nodes) {
    if (!connectedNodes.has(node.id) && workflow.nodes.length > 1) {
      issues.push({
        level: "warning",
        node_id: node.id,
        message: `Node "${node.label}" is isolated (no connections)`,
      });
    }
  }

  // 6. Compute node constraints
  for (const node of workflow.nodes) {
    if (node.type === "compute") {
      if (!node.config.command) {
        issues.push({
          level: "error",
          node_id: node.id,
          message: `Compute node "${node.label}" has no command`,
        });
      }
      if (!node.config.estimated_vram_mb) {
        issues.push({
          level: "warning",
          node_id: node.id,
          message: `Compute node "${node.label}" has no estimated_vram_mb`,
        });
      }
    }
  }

  // 7. Variable validation
  const declaredVarNames = new Set((workflow.variables || []).map((v) => v.name));

  // Check that ${var} references in node configs match declared variables
  for (const node of workflow.nodes) {
    for (const [key, value] of Object.entries(node.config)) {
      if (typeof value === "string") {
        const refs = extractVariableRefs(value);
        for (const ref of refs) {
          if (!declaredVarNames.has(ref)) {
            issues.push({
              level: "error",
              node_id: node.id,
              message: `Node "${node.label}" config.${key} references undeclared variable "\${${ref}}"`,
            });
          }
        }
      }
    }
  }

  // If runtime variables provided, check required variables are supplied
  if (runtimeVariables) {
    for (const v of workflow.variables || []) {
      if (v.required && runtimeVariables[v.name] === undefined && v.default === undefined) {
        issues.push({
          level: "error",
          message: `Required variable "${v.name}" is not provided and has no default`,
        });
      }
    }
  }

  return issues;
}
