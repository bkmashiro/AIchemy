/**
 * api/cluster.ts — Cluster management API.
 *
 * Proxies SLURM operations through the controller daemon.
 *
 * GET  /cluster/status      — current GPU availability + queue snapshot
 * GET  /cluster/partitions  — partition analysis
 * POST /cluster/submit      — submit a SLURM job
 * DELETE /cluster/jobs/:id  — cancel a SLURM job
 * POST /cluster/jobs/:id/restart — restart a stub on a node
 */

import { Router, Request, Response } from "express";
import {
  getClusterStatus,
  getControllerInfo,
  emitToController,
} from "../socket/controller";
import { logger } from "../log";

export function createClusterRouter(): Router {
  const router = Router();

  // GET /cluster/status
  router.get("/status", (_req: Request, res: Response): void => {
    const status = getClusterStatus();
    if (!status) {
      const info = getControllerInfo();
      res.status(503).json({
        error: "Controller not connected",
        controller: info,
      });
      return;
    }
    res.json(status);
  });

  // GET /cluster/partitions
  router.get("/partitions", (_req: Request, res: Response): void => {
    const status = getClusterStatus();
    if (!status) {
      res.status(503).json({ error: "Controller not connected" });
      return;
    }
    res.json({
      partitions: status.partitions ?? [],
      queue_analysis: status.queue_analysis ?? {},
    });
  });

  // GET /cluster/controller — controller connection info
  router.get("/controller", (_req: Request, res: Response): void => {
    const info = getControllerInfo();
    if (!info) {
      res.status(503).json({ error: "Controller not connected" });
      return;
    }
    res.json(info);
  });

  // POST /cluster/submit
  router.post("/submit", async (req: Request, res: Response): Promise<void> => {
    const body = req.body;
    if (!body.partition) {
      res.status(400).json({ error: "partition required" });
      return;
    }
    logger.info("cluster.submit", { partition: body.partition, user: body.user });
    try {
      const response = await emitToController("slurm.submit", body);
      if (response?.ok === false) {
        res.status(500).json({ error: response.error || "Submit failed" });
        return;
      }
      res.status(201).json(response);
    } catch (err: any) {
      logger.error("cluster.submit error", { error: String(err) });
      res.status(503).json({ error: err.message });
    }
  });

  // DELETE /cluster/jobs/:id
  router.delete("/jobs/:id", async (req: Request, res: Response): Promise<void> => {
    const jobId = req.params.id;
    const user = (req.query.user as string) || undefined;
    logger.info("cluster.cancel", { job_id: jobId, user });
    try {
      const response = await emitToController("slurm.cancel", { job_id: jobId, user });
      if (response?.ok === false) {
        res.status(500).json({ error: response.error || "Cancel failed" });
        return;
      }
      res.json(response);
    } catch (err: any) {
      logger.error("cluster.cancel error", { error: String(err) });
      res.status(503).json({ error: err.message });
    }
  });

  // POST /cluster/jobs/:id/restart — restart a stub on a node
  router.post("/jobs/:id/restart", async (req: Request, res: Response): Promise<void> => {
    const { node, user } = req.body;
    if (!node) {
      res.status(400).json({ error: "node required" });
      return;
    }
    logger.info("cluster.stub_restart", { node, user });
    try {
      const response = await emitToController("stub.restart", { node, user });
      if (response?.ok === false) {
        res.status(500).json({ error: response.error || "Restart failed" });
        return;
      }
      res.json(response);
    } catch (err: any) {
      logger.error("cluster.stub_restart error", { error: String(err) });
      res.status(503).json({ error: err.message });
    }
  });

  // POST /cluster/status/refresh — trigger immediate status update from controller
  router.post("/status/refresh", async (_req: Request, res: Response): Promise<void> => {
    logger.info("cluster.status.refresh");
    try {
      const response = await emitToController("slurm.status", {});
      res.json({ ok: true, ...response });
    } catch (err: any) {
      res.status(503).json({ error: err.message });
    }
  });

  return router;
}
