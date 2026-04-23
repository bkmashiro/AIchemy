import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { store } from "../store";
import { SlurmAccount, AutoQueueConfig } from "../types";

export function createSlurmAccountsRouter(): Router {
  const router = Router();

  // GET /api/slurm/accounts
  router.get("/", (_req: Request, res: Response) => {
    const accounts = store.getAllSlurmAccounts().map((a) => ({
      ...a,
      current_usage: computeUsage(a.id),
    }));
    res.json(accounts);
  });

  // POST /api/slurm/accounts
  router.post("/", (req: Request, res: Response) => {
    const { name, ssh_target, qos_limit, partitions, default_walltime, default_mem, stub_command, ssh_key_path } = req.body;
    if (!name || !ssh_target || !qos_limit) {
      res.status(400).json({ error: "name, ssh_target, and qos_limit required" });
      return;
    }

    const account: SlurmAccount = {
      id: uuidv4(),
      name,
      ssh_target,
      qos_limit,
      partitions: partitions || [],
      default_walltime: default_walltime || "72:00:00",
      default_mem: default_mem || "64G",
      stub_command: stub_command || "python -m alchemy_stub",
      ...(ssh_key_path ? { ssh_key_path } : {}),
    };

    store.setSlurmAccount(account);
    res.status(201).json(account);
  });

  // GET /api/slurm/accounts/:id
  router.get("/:id", (req: Request, res: Response) => {
    const account = store.getSlurmAccount(req.params.id);
    if (!account) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    res.json({ ...account, current_usage: computeUsage(account.id) });
  });

  // PATCH /api/slurm/accounts/:id
  router.patch("/:id", (req: Request, res: Response) => {
    const account = store.getSlurmAccount(req.params.id);
    if (!account) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    const updated = { ...account, ...req.body, id: account.id };
    store.setSlurmAccount(updated);
    res.json(updated);
  });

  // DELETE /api/slurm/accounts/:id
  router.delete("/:id", (req: Request, res: Response) => {
    if (!store.getSlurmAccount(req.params.id)) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    store.deleteSlurmAccount(req.params.id);
    res.json({ ok: true });
  });

  // GET /api/slurm/accounts/:id/utilization
  router.get("/:id/utilization", (req: Request, res: Response) => {
    const account = store.getSlurmAccount(req.params.id);
    if (!account) {
      res.status(404).json({ error: "Account not found" });
      return;
    }

    const stubs = store.getAllStubs().filter((s) => s.slurm_account_id === account.id);
    const online = stubs.filter((s) => s.status === "online");
    const runningTasks = online.flatMap((s) => s.tasks.filter((t) => t.status === "running"));

    res.json({
      account_id: account.id,
      qos_limit: account.qos_limit,
      online_stubs: online.length,
      total_stubs: stubs.length,
      running_tasks: runningTasks.length,
      stubs: stubs.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        running: s.tasks.filter((t) => t.status === "running").length,
        queued: s.tasks.filter((t) => t.status === "queued").length,
      })),
    });
  });

  // --- Auto-Queue endpoints ---

  // GET /api/slurm/accounts/:id/autoqueue
  router.get("/:id/autoqueue", (req: Request, res: Response) => {
    const configs = store.getAllAutoQueueConfigs().filter((c) => c.account_id === req.params.id);
    res.json(configs);
  });

  // POST /api/slurm/accounts/:id/autoqueue
  router.post("/:id/autoqueue", (req: Request, res: Response) => {
    const account = store.getSlurmAccount(req.params.id);
    if (!account) {
      res.status(404).json({ error: "Account not found" });
      return;
    }

    const { max_running, max_pending, qos_running_limit, qos_pending_limit,
            idle_timeout_min, check_interval_s, enabled } = req.body;
    const config: AutoQueueConfig = {
      id: uuidv4(),
      account_id: account.id,
      max_running: max_running ?? account.qos_limit,
      max_pending: max_pending ?? account.qos_limit,
      qos_running_limit: qos_running_limit ?? account.qos_limit,
      qos_pending_limit: qos_pending_limit ?? account.qos_limit,
      idle_timeout_min: idle_timeout_min ?? 30,
      check_interval_s: check_interval_s ?? 60,
      enabled: enabled !== false,
    };

    store.setAutoQueueConfig(config);
    res.status(201).json(config);
  });

  // PATCH /api/slurm/accounts/:accountId/autoqueue/:id
  router.patch("/:accountId/autoqueue/:id", (req: Request, res: Response) => {
    const config = store.getAutoQueueConfig(req.params.id);
    if (!config || config.account_id !== req.params.accountId) {
      res.status(404).json({ error: "Auto-queue config not found" });
      return;
    }
    const updated = { ...config, ...req.body, id: config.id, account_id: config.account_id };
    store.setAutoQueueConfig(updated);
    res.json(updated);
  });

  // DELETE /api/slurm/accounts/:accountId/autoqueue/:id
  router.delete("/:accountId/autoqueue/:id", (req: Request, res: Response) => {
    const config = store.getAutoQueueConfig(req.params.id);
    if (!config || config.account_id !== req.params.accountId) {
      res.status(404).json({ error: "Auto-queue config not found" });
      return;
    }
    store.deleteAutoQueueConfig(req.params.id);
    res.json({ ok: true });
  });

  return router;
}

function computeUsage(accountId: string): number {
  return store.getAllStubs().filter(
    (s) => s.slurm_account_id === accountId && s.status === "online"
  ).length;
}
