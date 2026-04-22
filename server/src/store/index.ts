import fs from "fs";
import path from "path";
import { Stub, Task, Token, ServerState, SlurmPoolConfig, GridTask, GridCell, AnomalyAlert, MigrationSuggestion, StallConfig } from "../types";

const STATE_FILE = process.env.STATE_FILE || path.join(process.cwd(), "state.json");
const SNAPSHOT_INTERVAL = 60_000;

class Store {
  private stubs: Map<string, Stub> = new Map();
  private tokens: Map<string, Token> = new Map();
  private grids: Map<string, GridTask> = new Map();
  private alerts: Map<string, AnomalyAlert> = new Map();
  private migrationSuggestions: Map<string, MigrationSuggestion> = new Map();
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
  private stallConfig: StallConfig = {
    enabled: true,
    no_progress_timeout_min: 30,
    gpu_idle_threshold_pct: 5,
    gpu_idle_timeout_min: 10,
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

  // Grid Tasks
  getGrid(id: string): GridTask | undefined {
    return this.grids.get(id);
  }

  getAllGrids(): GridTask[] {
    return Array.from(this.grids.values());
  }

  setGrid(grid: GridTask): void {
    this.grids.set(grid.id, grid);
  }

  deleteGrid(id: string): void {
    this.grids.delete(id);
  }

  updateGridCell(gridId: string, cellId: string, update: Partial<GridCell>): GridCell | undefined {
    const grid = this.grids.get(gridId);
    if (!grid) return undefined;
    const idx = grid.cells.findIndex((c) => c.id === cellId);
    if (idx === -1) return undefined;
    grid.cells[idx] = { ...grid.cells[idx], ...update };
    // Update grid status
    const statuses = grid.cells.map((c) => c.status);
    if (statuses.every((s) => s === "completed")) grid.status = "completed";
    else if (statuses.some((s) => s === "running")) grid.status = "running";
    else if (statuses.some((s) => s === "failed") && statuses.every((s) => s === "failed" || s === "completed")) grid.status = "partial";
    else if (statuses.some((s) => s === "failed")) grid.status = "partial";
    else if (statuses.some((s) => s === "completed")) grid.status = "running";
    this.grids.set(gridId, grid);
    return grid.cells[idx];
  }

  // Alerts
  addAlert(alert: AnomalyAlert): void {
    this.alerts.set(alert.id, alert);
  }

  getAlert(id: string): AnomalyAlert | undefined {
    return this.alerts.get(id);
  }

  getAllAlerts(): AnomalyAlert[] {
    return Array.from(this.alerts.values());
  }

  resolveAlert(id: string): void {
    const alert = this.alerts.get(id);
    if (alert) {
      alert.resolved = true;
      this.alerts.set(id, alert);
    }
  }

  // Migration suggestions
  addMigrationSuggestion(s: MigrationSuggestion): void {
    this.migrationSuggestions.set(s.id, s);
  }

  getAllMigrationSuggestions(): MigrationSuggestion[] {
    return Array.from(this.migrationSuggestions.values());
  }

  deleteMigrationSuggestion(id: string): void {
    this.migrationSuggestions.delete(id);
  }

  // Stall config
  getStallConfig(): StallConfig {
    return this.stallConfig;
  }

  setStallConfig(cfg: Partial<StallConfig>): void {
    this.stallConfig = { ...this.stallConfig, ...cfg };
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
        grids: Array.from(this.grids.values()),
        stall_config: this.stallConfig,
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

      for (const grid of state.grids || []) {
        this.grids.set(grid.id, grid);
      }

      if (state.stall_config) {
        this.stallConfig = state.stall_config;
      }

      console.log(`[store] Loaded state: ${this.stubs.size} stubs, ${this.tokens.size} tokens, ${this.grids.size} grids`);
    } catch (err) {
      console.error("[store] Failed to load state:", err);
    }
  }
}

export const store = new Store();
