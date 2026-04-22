import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { store } from "../store";
import { createTestServer, TestContext, createMockStub } from "./helpers/setup";
import { createSlurmAccountsRouter } from "../api/slurm-accounts";
import { v4 as uuidv4 } from "uuid";

describe("SLURM Accounts", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
    ctx.app.use("/api/slurm/accounts", createSlurmAccountsRouter());
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("should create a SLURM account", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/slurm/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "ys25",
        ssh_target: "ys25@gpucluster2",
        qos_limit: 3,
        partitions: ["a40", "a30", "a100"],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("ys25");
    expect(body.qos_limit).toBe(3);
    expect(body.partitions).toEqual(["a40", "a30", "a100"]);
    expect(body.id).toBeDefined();
  });

  it("should list all accounts", async () => {
    // Create two accounts
    await fetch(`${ctx.baseUrl}/api/slurm/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ys25", ssh_target: "ys25@cluster", qos_limit: 3 }),
    });
    await fetch(`${ctx.baseUrl}/api/slurm/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "hw2025", ssh_target: "hw2025@cluster", qos_limit: 3 }),
    });

    const res = await fetch(`${ctx.baseUrl}/api/slurm/accounts`);
    const body = await res.json();
    expect(body.length).toBe(2);
    expect(body[0].current_usage).toBe(0);
  });

  it("should compute current_usage from online stubs", async () => {
    // Create account
    const createRes = await fetch(`${ctx.baseUrl}/api/slurm/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ys25", ssh_target: "ys25@cluster", qos_limit: 3 }),
    });
    const account = await createRes.json();

    // Create stubs linked to this account
    const stub1 = createMockStub({ slurm_account_id: account.id, status: "online" });
    const stub2 = createMockStub({ slurm_account_id: account.id, status: "online" });
    const stub3 = createMockStub({ slurm_account_id: account.id, status: "offline" });
    store.setStub(stub1);
    store.setStub(stub2);
    store.setStub(stub3);

    // Check utilization
    const res = await fetch(`${ctx.baseUrl}/api/slurm/accounts/${account.id}/utilization`);
    const body = await res.json();
    expect(body.online_stubs).toBe(2);
    expect(body.total_stubs).toBe(3);
  });

  it("should update account", async () => {
    const createRes = await fetch(`${ctx.baseUrl}/api/slurm/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ys25", ssh_target: "ys25@cluster", qos_limit: 3 }),
    });
    const account = await createRes.json();

    const res = await fetch(`${ctx.baseUrl}/api/slurm/accounts/${account.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qos_limit: 5 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.qos_limit).toBe(5);
    expect(body.name).toBe("ys25");
  });

  it("should delete account", async () => {
    const createRes = await fetch(`${ctx.baseUrl}/api/slurm/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "temp", ssh_target: "t@c", qos_limit: 1 }),
    });
    const account = await createRes.json();

    const res = await fetch(`${ctx.baseUrl}/api/slurm/accounts/${account.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const getRes = await fetch(`${ctx.baseUrl}/api/slurm/accounts/${account.id}`);
    expect(getRes.status).toBe(404);
  });

  describe("Auto-Queue config", () => {
    it("should create autoqueue config for account", async () => {
      const createRes = await fetch(`${ctx.baseUrl}/api/slurm/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "ys25", ssh_target: "ys25@cluster", qos_limit: 3 }),
      });
      const account = await createRes.json();

      const res = await fetch(`${ctx.baseUrl}/api/slurm/accounts/${account.id}/autoqueue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_slots: 3,
          idle_timeout_min: 30,
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.target_slots).toBe(3);
      expect(body.account_id).toBe(account.id);
      expect(body.enabled).toBe(true);
    });

    it("should list autoqueue configs for account", async () => {
      const createRes = await fetch(`${ctx.baseUrl}/api/slurm/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "ys25", ssh_target: "ys25@cluster", qos_limit: 3 }),
      });
      const account = await createRes.json();

      await fetch(`${ctx.baseUrl}/api/slurm/accounts/${account.id}/autoqueue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_slots: 3 }),
      });

      const res = await fetch(`${ctx.baseUrl}/api/slurm/accounts/${account.id}/autoqueue`);
      const body = await res.json();
      expect(body.length).toBe(1);
    });
  });
});
