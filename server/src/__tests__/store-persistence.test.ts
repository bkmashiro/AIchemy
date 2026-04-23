import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { store } from "../store";
import { createMockStub } from "./helpers/setup";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";

// The STATE_FILE is evaluated once at module load time from process.env.STATE_FILE
// or falls back to cwd()/state.json. We can't change it per-test, but we can
// write/read the actual state file that the singleton uses.
const STATE_FILE = process.env.STATE_FILE || path.join(process.cwd(), "state.json");

describe("Store persistence", () => {
  beforeEach(() => {
    store.reset();
    // Remove existing state file to start fresh
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  });

  afterEach(() => {
    store.reset();
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  });

  it("save() writes state to file", () => {
    const stub = createMockStub({ status: "online" });
    store.setStub(stub);

    store.save();

    expect(fs.existsSync(STATE_FILE)).toBe(true);
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const state = JSON.parse(raw);
    expect(state.stubs.length).toBe(1);
    expect(state.stubs[0].id).toBe(stub.id);
  });

  it("save() marks online stubs as offline in the file", () => {
    const stub = createMockStub({ status: "online" });
    store.setStub(stub);

    store.save();

    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const state = JSON.parse(raw);
    // Online stubs are serialized as offline (they're not online across restarts)
    expect(state.stubs[0].status).toBe("offline");
  });

  it("save() does not persist socket_id", () => {
    const stub = createMockStub({ status: "online", socket_id: "some-socket-id" });
    store.setStub(stub);

    store.save();

    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const state = JSON.parse(raw);
    expect(state.stubs[0].socket_id).toBeUndefined();
  });

  it("save() round-trip for tokens", () => {
    const token = {
      token: `tok-${uuidv4().slice(0, 8)}`,
      created_at: new Date().toISOString(),
      label: "test-round-trip",
    };
    store.addToken(token);

    store.save();

    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const state = JSON.parse(raw);
    expect(state.tokens.length).toBe(1);
    expect(state.tokens[0].label).toBe("test-round-trip");
    expect(state.tokens[0].token).toBe(token.token);
  });

  it("save() round-trip for grids", () => {
    const gridId = uuidv4();
    store.setGrid({
      id: gridId,
      name: "persisted-grid",
      command_template: "echo {x}",
      parameters: { x: [1, 2] },
      cells: [
        { id: uuidv4(), grid_id: gridId, params: { x: 1 }, status: "pending" },
        { id: uuidv4(), grid_id: gridId, params: { x: 2 }, status: "completed" },
      ],
      status: "partial",
      created_at: new Date().toISOString(),
    });

    store.save();

    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const state = JSON.parse(raw);
    expect(state.grids.length).toBe(1);
    expect(state.grids[0].name).toBe("persisted-grid");
    expect(state.grids[0].cells.length).toBe(2);
  });

  it("save() round-trip for slurm accounts", () => {
    const account = {
      id: uuidv4(),
      name: "ys25",
      ssh_target: "ys25@gpucluster2",
      qos_limit: 3,
      partitions: ["a40", "a30"],
      default_walltime: "72:00:00",
      default_mem: "64G",
      stub_command: "python -m alchemy_stub",
    };
    store.setSlurmAccount(account);

    store.save();

    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const state = JSON.parse(raw);
    expect(state.slurm_accounts.length).toBe(1);
    expect(state.slurm_accounts[0].name).toBe("ys25");
    expect(state.slurm_accounts[0].qos_limit).toBe(3);
  });

  it("save() preserves stub tasks", () => {
    const stub = createMockStub({ status: "online" });
    stub.tasks.push({
      id: uuidv4(),
      stub_id: stub.id,
      command: "python train.py",
      status: "queued",
      created_at: new Date().toISOString(),
      log_buffer: ["line 1"],
    });
    store.setStub(stub);

    store.save();

    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const state = JSON.parse(raw);
    expect(state.stubs[0].tasks.length).toBe(1);
    expect(state.stubs[0].tasks[0].command).toBe("python train.py");
  });

  it("load() reads state file and sets stubs to offline status", () => {
    // Write a state file with an online stub manually
    const stubData = createMockStub({ status: "online" });
    const state = {
      stubs: [{ ...stubData, status: "online" }],
      tokens: [],
      grids: [],
      slurm_accounts: [],
      autoqueue_configs: [],
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));

    store.load();

    const loaded = store.getStub(stubData.id);
    expect(loaded?.status).toBe("offline");
    expect(loaded?.missed_heartbeats).toBe(0);
  });

  it("load() handles missing state file gracefully", () => {
    // File doesn't exist — should not throw
    expect(() => store.load()).not.toThrow();
  });

  it("load() restores tokens from file", () => {
    const token = { token: `tok-${uuidv4().slice(0, 8)}`, created_at: new Date().toISOString(), label: "restored" };
    const state = {
      stubs: [],
      tokens: [token],
      grids: [],
      slurm_accounts: [],
      autoqueue_configs: [],
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));

    store.load();

    const loaded = store.getToken(token.token);
    expect(loaded?.label).toBe("restored");
  });

  it("multiple stubs and tokens survive save", () => {
    const stub1 = createMockStub({ status: "online" });
    const stub2 = createMockStub({ status: "offline" });
    store.setStub(stub1);
    store.setStub(stub2);

    const tok1 = { token: `tok-${uuidv4().slice(0, 8)}`, created_at: new Date().toISOString(), label: "a" };
    const tok2 = { token: `tok-${uuidv4().slice(0, 8)}`, created_at: new Date().toISOString(), label: "b" };
    store.addToken(tok1);
    store.addToken(tok2);

    store.save();

    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const state = JSON.parse(raw);
    expect(state.stubs.length).toBe(2);
    expect(state.tokens.length).toBe(2);
  });

  it("store.reset() clears all data", () => {
    const stub = createMockStub({ status: "online" });
    store.setStub(stub);
    const token = { token: `tok-${uuidv4().slice(0, 8)}`, created_at: new Date().toISOString() };
    store.addToken(token);

    store.reset();

    expect(store.getAllStubs().length).toBe(0);
    expect(store.getAllTokens().length).toBe(0);
    expect(store.getAllGrids().length).toBe(0);
  });
});
