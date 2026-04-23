import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { store } from "../store";
import { GridTask, GridCell, Task } from "../types";
import { Namespace } from "socket.io";
import { dispatchQueuedTasks } from "../socket/stub";
import { pickBestStub } from "../scheduler";
import { logAudit } from "../audit";

/**
 * Generate all combinations (cartesian product) of parameter values.
 */
function cartesian(params: Record<string, any[]>): Record<string, any>[] {
  const keys = Object.keys(params);
  if (keys.length === 0) return [{}];

  const [first, ...rest] = keys;
  const restCombinations = cartesian(Object.fromEntries(rest.map((k) => [k, params[k]])));

  const result: Record<string, any>[] = [];
  for (const val of params[first]) {
    for (const combo of restCombinations) {
      result.push({ [first]: val, ...combo });
    }
  }
  return result;
}

/**
 * Substitute {key} placeholders in a template string.
 */
function interpolate(template: string, vars: Record<string, any>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    return key in vars ? String(vars[key]) : `{${key}}`;
  });
}

export function createGridsRouter(stubNs: Namespace, webNs: Namespace): Router {
  const router = Router();

  // POST /api/grids — create grid task
  router.post("/", (req: Request, res: Response) => {
    const { name, command_template, parameters, base_config, stub_id, force } = req.body;

    if (!name || !command_template || !parameters) {
      res.status(400).json({ error: "name, command_template, and parameters required" });
      return;
    }

    if (typeof parameters !== "object" || Object.values(parameters).some((v) => !Array.isArray(v))) {
      res.status(400).json({ error: "parameters must be an object of arrays" });
      return;
    }

    // Conflict detection: check for existing grid with same name that has completed cells
    if (!force) {
      const existingGrid = store.getAllGrids().find((g) => g.name === name);
      if (existingGrid) {
        const completedCells = existingGrid.cells.filter((c) => c.status === "completed");
        if (completedCells.length > 0) {
          res.status(409).json({
            error: "Grid with this name already has completed cells",
            existing_grid_id: existingGrid.id,
            completed_count: completedCells.length,
            hint: "Use force: true to override",
          });
          return;
        }
      }
    }

    // Pre-check: if stub_id is specified, verify it's online; otherwise check any stub is available
    if (stub_id) {
      const requestedStub = store.getStub(stub_id);
      if (!requestedStub || requestedStub.status !== "online") {
        res.status(503).json({ error: "Requested stub is offline or not found", stub_id });
        return;
      }
    } else {
      const anyOnline = store.getAllStubs().some((s) => s.status === "online");
      if (!anyOnline) {
        res.status(503).json({ error: "No stubs available to schedule grid cells" });
        return;
      }
    }

    const gridId = uuidv4();
    const combinations = cartesian(parameters);

    const cells: GridCell[] = combinations.map((params) => ({
      id: uuidv4(),
      grid_id: gridId,
      params,
      status: "pending",
    }));

    const grid: GridTask = {
      id: gridId,
      name,
      command_template,
      base_config,
      parameters,
      cells,
      status: "pending",
      created_at: new Date().toISOString(),
      stub_id,
    };

    store.setGrid(grid);

    // Create tasks for each cell
    for (const cell of cells) {
      const command = interpolate(command_template, {
        ...cell.params,
        config_path: base_config || "",
        generated_config_path: base_config || "",
      });

      // Determine target stub
      let targetStub = stub_id ? store.getStub(stub_id) : pickBestStub(0);
      if (!targetStub) {
        // No stub available — tasks stay in limbo (grid cell pending)
        continue;
      }

      const task: Task = {
        id: uuidv4(),
        stub_id: targetStub.id,
        command,
        status: "queued",
        created_at: new Date().toISOString(),
        log_buffer: [],
        grid_id: gridId,
        grid_cell_id: cell.id,
        param_overrides: cell.params,
        base_config,
        env: { ALCHEMY_PARAMS: JSON.stringify(cell.params) },
      };

      targetStub.tasks.push(task);
      store.setStub(targetStub);

      // Link cell to task
      store.updateGridCell(gridId, cell.id, { task_id: task.id, status: "pending" });

      webNs.emit("task.update", task);
      dispatchQueuedTasks(targetStub.id, stubNs);
    }

    const created = store.getGrid(gridId);
    logAudit("grid.create", { grid_id: gridId, name, cells: cells.length });
    res.status(201).json(created);
  });

  // GET /api/grids
  router.get("/", (_req: Request, res: Response) => {
    res.json(store.getAllGrids());
  });

  // GET /api/grids/:id
  router.get("/:id", (req: Request, res: Response) => {
    const grid = store.getGrid(req.params.id);
    if (!grid) {
      res.status(404).json({ error: "Grid not found" });
      return;
    }

    // Enrich cells with task status
    const enriched = {
      ...grid,
      cells: grid.cells.map((cell) => {
        if (cell.task_id) {
          // Find task across stubs
          const task = findTask(cell.task_id);
          if (task) {
            return {
              ...cell,
              status: mapTaskStatusToCell(task.status),
              metrics: task.metrics,
            };
          }
        }
        return cell;
      }),
    };

    res.json(enriched);
  });

  // POST /api/grids/:id/retry-failed
  router.post("/:id/retry-failed", (req: Request, res: Response) => {
    const grid = store.getGrid(req.params.id);
    if (!grid) {
      res.status(404).json({ error: "Grid not found" });
      return;
    }

    let retried = 0;
    for (const cell of grid.cells) {
      const task = cell.task_id ? findTask(cell.task_id) : undefined;
      if (task && (task.status === "failed" || task.status === "killed")) {
        resubmitCell(grid, cell, stubNs, webNs);
        retried++;
      }
    }

    res.json({ ok: true, retried });
  });

  // POST /api/grids/:id/cells/:cid/retry
  router.post("/:id/cells/:cid/retry", (req: Request, res: Response) => {
    const grid = store.getGrid(req.params.id);
    if (!grid) {
      res.status(404).json({ error: "Grid not found" });
      return;
    }

    const cell = grid.cells.find((c) => c.id === req.params.cid);
    if (!cell) {
      res.status(404).json({ error: "Cell not found" });
      return;
    }

    resubmitCell(grid, cell, stubNs, webNs);
    res.json({ ok: true });
  });

  // DELETE /api/grids/:id — kill all cells
  router.delete("/:id", (req: Request, res: Response) => {
    const grid = store.getGrid(req.params.id);
    if (!grid) {
      res.status(404).json({ error: "Grid not found" });
      return;
    }

    for (const cell of grid.cells) {
      if (cell.task_id) {
        const task = findTask(cell.task_id);
        if (task && (task.status === "running" || task.status === "paused" || task.status === "queued")) {
          stubNs.to(`stub:${task.stub_id}`).emit("task.kill", { task_id: task.id, signal: "SIGTERM" });
          store.updateTask(task.stub_id, task.id, { status: "killed", finished_at: new Date().toISOString() });
          webNs.emit("task.update", { ...task, status: "killed" });
        }
      }
    }

    store.deleteGrid(grid.id);
    logAudit("grid.delete", { grid_id: grid.id, name: grid.name });
    res.json({ ok: true });
  });

  return router;
}

function findTask(taskId: string): Task | undefined {
  for (const stub of store.getAllStubs()) {
    const task = stub.tasks.find((t) => t.id === taskId);
    if (task) return task;
  }
  return undefined;
}

function mapTaskStatusToCell(status: string): GridCell["status"] {
  switch (status) {
    case "completed":
    case "completed_with_errors":
      return "completed";
    case "failed":
    case "killed":
    case "interrupted":
      return "failed";
    case "running":
    case "paused":
      return "running";
    default:
      return "pending";
  }
}


function resubmitCell(grid: GridTask, cell: GridCell, stubNs: Namespace, webNs: Namespace): void {
  const command = interpolate(grid.command_template, {
    ...cell.params,
    config_path: grid.base_config || "",
    generated_config_path: grid.base_config || "",
  });

  const targetStub = grid.stub_id ? store.getStub(grid.stub_id) : pickBestStub(0);
  if (!targetStub) return;

  const task: Task = {
    id: uuidv4(),
    stub_id: targetStub.id,
    command,
    status: "queued",
    created_at: new Date().toISOString(),
    log_buffer: [],
    grid_id: grid.id,
    grid_cell_id: cell.id,
    param_overrides: cell.params,
    base_config: grid.base_config,
    env: { ALCHEMY_PARAMS: JSON.stringify(cell.params) },
  };

  targetStub.tasks.push(task);
  store.setStub(targetStub);
  store.updateGridCell(grid.id, cell.id, { task_id: task.id, status: "pending" });

  webNs.emit("task.update", task);
  dispatchQueuedTasks(targetStub.id, stubNs);
}
