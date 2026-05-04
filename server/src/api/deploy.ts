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
import { deployStub, getStubStatus, restartStub } from "../deploy";
import { TunnelManager } from "../tunnel";

export function createDeployRouter(config: DeployFileConfig | null, tunnelMgr?: TunnelManager | null): Router {
  const router = Router();

  // GET /deploy/targets — list all configured stub targets (no SSH, instant)
  router.get("/targets", async (_req: Request, res: Response): Promise<void> => {
    if (!config) { res.json([]); return; }
    res.json(config.stubs.map((s) => ({
      name: s.name,
      host: s.host,
      user: s.user,
      tags: s.tags,
      max_concurrent: s.max_concurrent,
    })));
  });

  // POST /deploy/stubs/:name — deploy a single stub
  router.post("/stubs/:name", async (req: Request, res: Response): Promise<void> => {
    if (!config) { res.status(404).json({ error: "No deploy config" }); return; }
    const target = config.stubs.find((s) => s.name === req.params.name);
    if (!target) { res.status(404).json({ error: "Target not found" }); return; }

    const serverUrl = req.body?.server_url || process.env.ALCHEMY_SERVER_URL || "";
    const token = process.env.ALCHEMY_TOKEN || "";
    const result = await deployStub(
      target, serverUrl, token,
      config.ssh?.key_path, config.stub_package?.local_path,
    );
    res.json(result);
  });

  // POST /deploy/stubs — deploy all (or subset by name/skip filter), 3 concurrent
  router.post("/stubs", async (req: Request, res: Response): Promise<void> => {
    if (!config) { res.json([]); return; }

    const { names, skip, server_url } = req.body || {};
    let targets = config.stubs;
    if (names) targets = targets.filter((s) => (names as string[]).includes(s.name));
    if (skip) targets = targets.filter((s) => !(skip as string[]).includes(s.name));

    const serverUrl = server_url || process.env.ALCHEMY_SERVER_URL || "";
    const token = process.env.ALCHEMY_TOKEN || "";

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

  // GET /deploy/stubs/:name/status — SSH check if stub process is running
  router.get("/stubs/:name/status", async (req: Request, res: Response): Promise<void> => {
    if (!config) { res.status(404).json({ error: "No deploy config" }); return; }
    const target = config.stubs.find((s) => s.name === req.params.name);
    if (!target) { res.status(404).json({ error: "Target not found" }); return; }

    const status = await getStubStatus(target, config.ssh?.key_path);
    res.json(status);
  });

  // POST /deploy/stubs/:name/restart — restart stub process without re-syncing code
  router.post("/stubs/:name/restart", async (req: Request, res: Response): Promise<void> => {
    if (!config) { res.status(404).json({ error: "No deploy config" }); return; }
    const target = config.stubs.find((s) => s.name === req.params.name);
    if (!target) { res.status(404).json({ error: "Target not found" }); return; }

    const serverUrl = req.body?.server_url || process.env.ALCHEMY_SERVER_URL || "";
    const result = await restartStub(
      target, serverUrl, process.env.ALCHEMY_TOKEN || "",
      config.ssh?.key_path,
    );
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
