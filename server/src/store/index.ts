import fs from "fs";
import path from "path";
import { Stub, Task, Token, ServerState, SlurmPoolConfig } from "../types";

const STATE_FILE = process.env.STATE_FILE || path.join(process.cwd(), "state.json");
const SNAPSHOT_INTERVAL = 60_000;

class Store {
  private stubs: Map<string, Stub> = new Map();
  private tokens: Map<string, Token> = new Map();
  private slurmPool: SlurmPoolConfig = {
    enabled: false,
    ssh_target: "gpucluster2",
    max_concurrent_jobs: 3,
    partitions: ["a40", "a30", "a100"],
    default_walltime: "72:00:00",
    default_mem: "64G",
    stub_command: "python -m alchemy_stub",
    min_queue_ahead: 1,
  };

  constructor() {
    this.load();
    setInterval(() => this.save(), SNAPSHOT_INTERVAL);
  }

  // Stubs
  getStub(id: string): Stub | undefined {
    return this.stubs.get(id);
  }

  getStubByToken(token: string): Stub | undefined {
    for (const stub of this.stubs.values()) {
      if (stub.token === token) return stub;
    }
    return undefined;
  }

  getStubByHostnameAndToken(hostname: string, token: string): Stub | undefined {
    for (const stub of this.stubs.values()) {
      if (stub.token === token && stub.hostname === hostname) return stub;
    }
    return undefined;
  }

  getAllStubs(): Stub[] {
    return Array.from(this.stubs.values());
  }

  setStub(stub: Stub): void {
    this.stubs.set(stub.id, stub);
  }

  deleteStub(id: string): void {
    this.stubs.delete(id);
  }

  // Tokens
  getToken(token: string): Token | undefined {
    return this.tokens.get(token);
  }

  getAllTokens(): Token[] {
    return Array.from(this.tokens.values());
  }

  addToken(token: Token): void {
    this.tokens.set(token.token, token);
  }

  deleteToken(token: string): void {
    this.tokens.delete(token);
  }

  // SLURM Pool
  getSlurmPool(): SlurmPoolConfig {
    return this.slurmPool;
  }

  setSlurmPool(config: Partial<SlurmPoolConfig>): void {
    this.slurmPool = { ...this.slurmPool, ...config };
  }

  // Tasks helpers
  getTask(stubId: string, taskId: string): Task | undefined {
    const stub = this.stubs.get(stubId);
    if (!stub) return undefined;
    return stub.tasks.find((t) => t.id === taskId);
  }

  getAllTasks(): Task[] {
    const tasks: Task[] = [];
    for (const stub of this.stubs.values()) {
      tasks.push(...stub.tasks);
    }
    return tasks;
  }

  updateTask(stubId: string, taskId: string, update: Partial<Task>): Task | undefined {
    const stub = this.stubs.get(stubId);
    if (!stub) return undefined;
    const idx = stub.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return undefined;
    stub.tasks[idx] = { ...stub.tasks[idx], ...update };
    return stub.tasks[idx];
  }

  // Persistence
  save(): void {
    try {
      const state: ServerState = {
        stubs: Array.from(this.stubs.values()).map((s) => ({
          ...s,
          socket_id: undefined, // don't persist socket ids
          status: s.status === "online" ? "offline" : s.status,
        })),
        tokens: Array.from(this.tokens.values()),
        slurm_pool: this.slurmPool,
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error("[store] Failed to save state:", err);
    }
  }

  load(): void {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      const state: ServerState = JSON.parse(raw);

      for (const stub of state.stubs || []) {
        stub.missed_heartbeats = 0;
        stub.status = "offline";
        this.stubs.set(stub.id, stub);
      }

      for (const token of state.tokens || []) {
        this.tokens.set(token.token, token);
      }

      if (state.slurm_pool) {
        this.slurmPool = state.slurm_pool;
      }

      console.log(`[store] Loaded state: ${this.stubs.size} stubs, ${this.tokens.size} tokens`);
    } catch (err) {
      console.error("[store] Failed to load state:", err);
    }
  }
}

export const store = new Store();
