/**
 * api/deploy.ts — REST API for stub deployment management.
 *
 * GET  /deploy/targets           — list configured stub targets (no SSH)
 * POST /deploy/stubs/:name       — deploy a single stub (sync + restart)
 * POST /deploy/stubs             — deploy all (or filtered) stubs, 3 at a time
 * GET  /deploy/stubs/:name/status — check if stub process is running (via SSH)
 * POST /deploy/stubs/:name/restart — restart stub without re-syncing code
 */

import { Router, Request, Response } from "express";
import { DeployFileConfig } from "../types";
import { deployStub, getStubStatus, restartStub, stopStub } from "../deploy";
import { TunnelManager } from "../tunnel";

function resolveDeployConnection(req: Request, res: Response): { serverUrl: string; token: string } | undefined {
  const serverUrl = req.body?.server_url || process.env.ALCHEMY_SERVER_URL;
  const token = req.body?.token || process.env.ALCHEMY_TOKEN;
  if (!serverUrl || !token) {
    res.status(400).json({
      error: "Missing deploy connection settings",
      details: "Provide server_url and token in the request body, or set ALCHEMY_SERVER_URL and ALCHEMY_TOKEN.",
    });
    return undefined;
  }
  return { serverUrl, token };
}

export function createDeployRouter(config: DeployFileConfig | null, tunnelMgr?: TunnelManager | null): Router {
  const router = Router();

  // GET /deploy/targets — list all configured stub targets (no SSH, instant)
  router.get("/targets", async (_req: Request, res: Response): Promise<void> => {
    if (!config) { res.json([]); return; }
    res.json(config.stubs.map((s) => ({
      name: s.name,
      type: s.type ?? "ssh",
      host: s.host,
      user: s.user,
      ssh_host: s.ssh_host,
      ssh_user: s.ssh_user,
      partition: s.partition,
      gres: s.gres,
      mem: s.mem,
      time: s.time,
      qos: s.qos,
      jump_host: s.jump_host,
      python_path: s.python_path,
      default_cwd: s.default_cwd,
      env_setup: s.env_setup,
      tags: s.tags,
      max_concurrent: s.max_concurrent,
    })));
  });

  // POST /deploy/stubs/:name — deploy a single stub
  router.post("/stubs/:name", async (req: Request, res: Response): Promise<void> => {
    if (!config) { res.status(404).json({ error: "No deploy config" }); return; }
    const target = config.stubs.find((s) => s.name === req.params.name);
    if (!target) { res.status(404).json({ error: "Target not found" }); return; }

    const conn = resolveDeployConnection(req, res);
    if (!conn) return;
    const { serverUrl, token } = conn;
    const slurmOverrides = req.body?.mem || req.body?.time || req.body?.idle_timeout
      ? { mem: req.body.mem, time: req.body.time, idle_timeout: req.body.idle_timeout }
      : undefined;
    const result = await deployStub(
      target, serverUrl, token,
      config.ssh?.key_path, config.stub_package?.local_path, slurmOverrides,
    );
    res.json(result);
  });

  // POST /deploy/stubs — deploy all (or subset by name/skip filter), 3 concurrent
  router.post("/stubs", async (req: Request, res: Response): Promise<void> => {
    if (!config) { res.json([]); return; }

    const { names, skip } = req.body || {};
    let targets = config.stubs;
    if (names) targets = targets.filter((s) => (names as string[]).includes(s.name));
    if (skip) targets = targets.filter((s) => !(skip as string[]).includes(s.name));

    const conn = resolveDeployConnection(req, res);
    if (!conn) return;
    const { serverUrl, token } = conn;

    const results = [];
    for (let i = 0; i < targets.length; i += 3) {
      const batch = targets.slice(i, i + 3);
      const batchResults = await Promise.all(
        batch.map((t) =>
          deployStub(t, serverUrl, token, config.ssh?.key_path, config.stub_package?.local_path)
        ),
      );
      results.push(...batchResults);
    }
    res.json(results);
  });

  // GET /deploy/stubs/:name/status — SSH/SLURM check if stub process is running
  router.get("/stubs/:name/status", async (req: Request, res: Response): Promise<void> => {
    if (!config) { res.status(404).json({ error: "No deploy config" }); return; }
    const target = config.stubs.find((s) => s.name === req.params.name);
    if (!target) { res.status(404).json({ error: "Target not found" }); return; }

    const jobId = req.query.job_id as string | undefined;
    const status = await getStubStatus(target, config.ssh?.key_path, jobId);
    res.json(status);
  });

  // POST /deploy/stubs/:name/restart — restart stub process without re-syncing code
  router.post("/stubs/:name/restart", async (req: Request, res: Response): Promise<void> => {
    if (!config) { res.status(404).json({ error: "No deploy config" }); return; }
    const target = config.stubs.find((s) => s.name === req.params.name);
    if (!target) { res.status(404).json({ error: "Target not found" }); return; }

    const conn = resolveDeployConnection(req, res);
    if (!conn) return;
    const { serverUrl, token } = conn;
    const slurmOverrides = req.body?.mem || req.body?.time || req.body?.idle_timeout
      ? { mem: req.body.mem, time: req.body.time, idle_timeout: req.body.idle_timeout }
      : undefined;
    const result = await restartStub(
      target, serverUrl, token,
      config.ssh?.key_path, slurmOverrides,
    );
    res.json(result);
  });

  // POST /deploy/stubs/:name/stop — stop stub (SSH: kill PID; SLURM: scancel)
  router.post("/stubs/:name/stop", async (req: Request, res: Response): Promise<void> => {
    if (!config) { res.status(404).json({ error: "No deploy config" }); return; }
    const target = config.stubs.find((s) => s.name === req.params.name);
    if (!target) { res.status(404).json({ error: "Target not found" }); return; }

    const jobId = req.body?.job_id as string | undefined;
    const result = await stopStub(target, config.ssh?.key_path, jobId);
    res.json(result);
  });

  // ─── Tunnel endpoints ─────────────────────────────────────────────────────

  // GET /deploy/tunnel — tunnel status
  router.get("/tunnel", (_req: Request, res: Response): void => {
    if (!tunnelMgr) { res.json({ running: false, error: "No tunnel configured" }); return; }
    res.json(tunnelMgr.status());
  });

  // POST /deploy/tunnel/restart — restart tunnel
  router.post("/tunnel/restart", async (_req: Request, res: Response): Promise<void> => {
    if (!tunnelMgr) { res.status(404).json({ error: "No tunnel configured" }); return; }
    await tunnelMgr.stop();
    tunnelMgr.start();
    res.json({ ok: true });
  });

  return router;
}
