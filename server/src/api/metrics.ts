/**
 * api/metrics.ts — Metrics and logs endpoints.
 *
 * GET /overview — cached 10s global stats.
 * GET /stubs/:id/metrics — GPU/CPU/MEM ring buffer (1h).
 * GET /tasks/:id/metrics — loss/step time series.
 * GET /tasks/:id/logs — task log tail.
 */

import { Router, Request, Response } from "express";
import { store } from "../store";
import { metricsStore } from "../metrics";

let overviewCache: { data: any; ts: number } | null = null;
const OVERVIEW_CACHE_TTL = 10_000;

export function createMetricsRouter(): Router {
  const router = Router();

  // GET /overview
  router.get("/overview", (_req: Request, res: Response) => {
    const now = Date.now();
    if (overviewCache && now - overviewCache.ts < OVERVIEW_CACHE_TTL) {
      res.json(overviewCache.data);
      return;
    }

    const stubs = store.getAllStubs();
    const onlineCount = stubs.filter((s) => s.status === "online").length;

    const tasks = store.getAllTasks();
    const taskCounts = {
      total: tasks.length,
      pending: 0, queued: 0, dispatched: 0, running: 0,
      paused: 0, completed: 0, failed: 0, killed: 0, lost: 0,
    };
    for (const t of tasks) {
      if (t.status in taskCounts) {
        (taskCounts as any)[t.status]++;
      }
    }

    let totalVram = 0;
    let usedVram = 0;
    for (const s of stubs) {
      if (s.status !== "online") continue;
      totalVram += s.gpu.vram_total_mb * s.gpu.count;
      if (s.gpu_stats?.gpus) {
        for (const g of s.gpu_stats.gpus) {
          usedVram += g.memory_used_mb;
        }
      }
    }

    const grids = store.getAllGrids();
    const gridCounts = { total: grids.length, running: 0, completed: 0, failed: 0 };
    for (const g of grids) {
      if (g.status === "running") gridCounts.running++;
      else if (g.status === "completed") gridCounts.completed++;
      else if (g.status === "failed") gridCounts.failed++;
    }

    const data = {
      stubs: { total: stubs.length, online: onlineCount, offline: stubs.length - onlineCount },
      tasks: taskCounts,
      gpus: { total_vram_mb: totalVram, used_vram_mb: usedVram },
      grids: gridCounts,
      cached_at: new Date().toISOString(),
    };

    overviewCache = { data, ts: now };
    res.json(data);
  });

  // GET /stubs/:id/metrics
  router.get("/stubs/:id/metrics", (req: Request, res: Response) => {
    const hours = req.query.hours !== undefined ? parseFloat(req.query.hours as string) : 1;
    const points = metricsStore.getStubMetrics(req.params.id, hours);
    res.json({ stub_id: req.params.id, hours, points });
  });

  // GET /tasks/:id/metrics
  router.get("/tasks/:id/metrics", (req: Request, res: Response) => {
    const taskId = req.params.id;
    // Structured per-key metrics (from task.metrics events)
    const metrics_buffer = metricsStore.getTaskMetricsDirect(taskId);
    // Legacy flat time-series (from task.progress events)
    const points = metricsStore.getTaskMetrics(taskId);
    res.json({ task_id: taskId, metrics_buffer, points });
  });

  // GET /tasks/:id/logs
  router.get("/tasks/:id/logs", (req: Request, res: Response) => {
    const found = store.findTask(req.params.id);
    if (!found) { res.status(404).json({ error: "Task not found" }); return; }
    const { task } = found;
    const tail = req.query.tail ? parseInt(req.query.tail as string, 10) : undefined;
    const lines = tail ? task.log_buffer.slice(-tail) : task.log_buffer;
    res.json({ task_id: task.id, lines });
  });

  return router;
}
