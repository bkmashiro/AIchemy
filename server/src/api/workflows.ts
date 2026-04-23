import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { Namespace } from "socket.io";
import { store } from "../store";
import { Workflow, WorkflowVariable } from "../types";
import { validateWorkflow } from "../workflow/validator";
import { createAndRunWorkflow, pauseWorkflowRun, resumeWorkflowRun, cancelWorkflowRun, retryWorkflowRun } from "../workflow/executor";

export function createWorkflowsRouter(stubNs: Namespace, webNs: Namespace): Router {
  const router = Router();

  // POST / — create workflow
  router.post("/", (req: Request, res: Response) => {
    const { name, description, nodes, edges, variables } = req.body;
    if (!name) {
      res.status(400).json({ error: "name required" });
      return;
    }

    const workflow: Workflow = {
      id: uuidv4(),
      name,
      description,
      nodes: nodes || [],
      edges: edges || [],
      variables,
      status: "draft",
      created_at: new Date().toISOString(),
    };

    store.setWorkflow(workflow);
    webNs.emit("workflow.update", workflow);
    res.status(201).json(workflow);
  });

  // GET / — list all workflows
  router.get("/", (_req: Request, res: Response) => {
    res.json(store.getWorkflows());
  });

  // GET /:id — get workflow
  router.get("/:id", (req: Request, res: Response) => {
    const workflow = store.getWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    res.json(workflow);
  });

  // GET /:id/export — export workflow as portable JSON
  router.get("/:id/export", (req: Request, res: Response) => {
    const workflow = store.getWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    // Strip internal IDs and runtime data, produce clean export
    const exportData = {
      alchemy_version: "2",
      type: "workflow",
      name: workflow.name,
      description: workflow.description || "",
      variables: (workflow.variables || []).map((v: WorkflowVariable) => ({
        name: v.name,
        type: v.type,
        description: v.description,
        default: v.default,
        required: v.required,
      })),
      nodes: workflow.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        label: n.label,
        config: n.config,
        position: n.position,
        inputs: n.inputs.map((p) => ({ id: p.id, name: p.name, type: p.type, required: p.required })),
        outputs: n.outputs.map((p) => ({ id: p.id, name: p.name, type: p.type, required: p.required })),
      })),
      edges: workflow.edges.map((e) => ({
        id: e.id,
        source_node: e.source_node,
        source_port: e.source_port,
        target_node: e.target_node,
        target_port: e.target_port,
      })),
    };

    res.json(exportData);
  });

  // POST /import — import workflow from exported JSON
  router.post("/import", (req: Request, res: Response) => {
    const data = req.body;
    if (!data || data.type !== "workflow") {
      res.status(400).json({ error: "Invalid workflow export format" });
      return;
    }

    // Generate new IDs: build old->new mapping for nodes and ports
    const nodeIdMap = new Map<string, string>();
    const portIdMap = new Map<string, string>();

    const newNodes = (data.nodes || []).map((n: any) => {
      const newNodeId = uuidv4();
      nodeIdMap.set(n.id, newNodeId);

      const inputs = (n.inputs || []).map((p: any) => {
        const newPortId = uuidv4();
        portIdMap.set(p.id, newPortId);
        return { ...p, id: newPortId };
      });
      const outputs = (n.outputs || []).map((p: any) => {
        const newPortId = uuidv4();
        portIdMap.set(p.id, newPortId);
        return { ...p, id: newPortId };
      });

      return { ...n, id: newNodeId, inputs, outputs };
    });

    const newEdges = (data.edges || []).map((e: any) => ({
      id: uuidv4(),
      source_node: nodeIdMap.get(e.source_node) || e.source_node,
      source_port: portIdMap.get(e.source_port) || e.source_port,
      target_node: nodeIdMap.get(e.target_node) || e.target_node,
      target_port: portIdMap.get(e.target_port) || e.target_port,
    }));

    const workflow: Workflow = {
      id: uuidv4(),
      name: data.name || "Imported Workflow",
      description: data.description,
      nodes: newNodes,
      edges: newEdges,
      variables: data.variables,
      status: "draft",
      created_at: new Date().toISOString(),
    };

    store.setWorkflow(workflow);
    webNs.emit("workflow.update", workflow);
    res.status(201).json(workflow);
  });

  // PATCH /:id — update workflow
  router.patch("/:id", (req: Request, res: Response) => {
    const workflow = store.getWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    const { name, description, nodes, edges, variables } = req.body;
    if (name !== undefined) workflow.name = name;
    if (description !== undefined) workflow.description = description;
    if (nodes !== undefined) workflow.nodes = nodes;
    if (edges !== undefined) workflow.edges = edges;
    if (variables !== undefined) workflow.variables = variables;

    // Reset status to draft on edit
    workflow.status = "draft";

    store.setWorkflow(workflow);
    webNs.emit("workflow.update", workflow);
    res.json(workflow);
  });

  // DELETE /:id — delete workflow
  router.delete("/:id", (req: Request, res: Response) => {
    const workflow = store.getWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    // Cancel any running runs
    for (const run of store.getWorkflowRuns(workflow.id)) {
      if (run.status === "running" || run.status === "paused") {
        cancelWorkflowRun(run, stubNs, webNs);
      }
    }

    store.deleteWorkflow(workflow.id);
    res.json({ ok: true });
  });

  // POST /:id/validate — validate DAG
  router.post("/:id/validate", (req: Request, res: Response) => {
    const workflow = store.getWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    workflow.status = "validating";
    store.setWorkflow(workflow);

    const issues = validateWorkflow(workflow);
    const hasErrors = issues.some((i) => i.level === "error");

    workflow.status = hasErrors ? "draft" : "ready";
    store.setWorkflow(workflow);
    webNs.emit("workflow.update", workflow);

    res.json({ valid: !hasErrors, issues });
  });

  // POST /:id/run — execute workflow (creates a WorkflowRun)
  router.post("/:id/run", (req: Request, res: Response) => {
    const workflow = store.getWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    const variables: Record<string, any> = req.body.variables || {};

    // Resolve defaults for declared variables
    for (const v of workflow.variables || []) {
      if (variables[v.name] === undefined && v.default !== undefined) {
        variables[v.name] = v.default;
      }
    }

    // Validate (including variable checks)
    const issues = validateWorkflow(workflow, variables);
    const hasErrors = issues.some((i) => i.level === "error");
    if (hasErrors) {
      res.status(400).json({ error: "Workflow has validation errors", issues });
      return;
    }

    const run = createAndRunWorkflow(workflow, variables, stubNs, webNs);
    res.status(201).json(run);
  });

  // GET /:id/runs — list runs for a workflow
  router.get("/:id/runs", (req: Request, res: Response) => {
    const workflow = store.getWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    res.json(store.getWorkflowRuns(workflow.id));
  });

  // GET /runs/:run_id — get run details
  router.get("/runs/:run_id", (req: Request, res: Response) => {
    const run = store.getWorkflowRun(req.params.run_id);
    if (!run) {
      res.status(404).json({ error: "WorkflowRun not found" });
      return;
    }
    res.json(run);
  });

  // GET /runs/:run_id/nodes/:node_id/logs — get logs for a specific node in a run
  router.get("/runs/:run_id/nodes/:node_id/logs", (req: Request, res: Response) => {
    const run = store.getWorkflowRun(req.params.run_id);
    if (!run) {
      res.status(404).json({ error: "WorkflowRun not found" });
      return;
    }

    const runNode = run.nodes.find((n) => n.node_id === req.params.node_id);
    if (!runNode) {
      res.status(404).json({ error: "Node not found in run" });
      return;
    }

    // If the task is still running, fetch live logs from the task
    if (runNode.task_id) {
      const task = store.getAllTasks().find((t) => t.id === runNode.task_id);
      if (task) {
        res.json({ node_id: runNode.node_id, lines: task.log_buffer });
        return;
      }
    }

    res.json({ node_id: runNode.node_id, lines: runNode.log_buffer || [] });
  });

  // POST /runs/:run_id/pause
  router.post("/runs/:run_id/pause", (req: Request, res: Response) => {
    const run = store.getWorkflowRun(req.params.run_id);
    if (!run) { res.status(404).json({ error: "Run not found" }); return; }
    if (run.status !== "running") { res.status(400).json({ error: "Run is not running" }); return; }
    pauseWorkflowRun(run, stubNs, webNs);
    res.json(store.getWorkflowRun(run.id));
  });

  // POST /runs/:run_id/resume
  router.post("/runs/:run_id/resume", (req: Request, res: Response) => {
    const run = store.getWorkflowRun(req.params.run_id);
    if (!run) { res.status(404).json({ error: "Run not found" }); return; }
    if (run.status !== "paused") { res.status(400).json({ error: "Run is not paused" }); return; }
    resumeWorkflowRun(run, stubNs, webNs);
    res.json(store.getWorkflowRun(run.id));
  });

  // POST /runs/:run_id/cancel
  router.post("/runs/:run_id/cancel", (req: Request, res: Response) => {
    const run = store.getWorkflowRun(req.params.run_id);
    if (!run) { res.status(404).json({ error: "Run not found" }); return; }
    if (!["running", "paused"].includes(run.status)) { res.status(400).json({ error: "Run is not running or paused" }); return; }
    cancelWorkflowRun(run, stubNs, webNs);
    res.json(store.getWorkflowRun(run.id));
  });

  // POST /runs/:run_id/retry
  router.post("/runs/:run_id/retry", (req: Request, res: Response) => {
    const run = store.getWorkflowRun(req.params.run_id);
    if (!run) { res.status(404).json({ error: "Run not found" }); return; }
    if (!["failed", "cancelled"].includes(run.status)) { res.status(400).json({ error: "Can only retry failed or cancelled runs" }); return; }
    const retried = retryWorkflowRun(run, stubNs, webNs);
    res.json(retried);
  });

  return router;
}
