/**
 * api-tasks.test.ts — Unit tests for api/tasks.ts
 *
 * Covers:
 *   - assembleCommand: env/cwd/args assembly and shell injection behaviour
 *   - generateDisplayName: naming priority
 *   - createTask: field propagation, defaults
 *   - POST /tasks: creation, dedup, write-lock, idempotency, validation
 *   - POST /tasks/batch: kill / retry / requeue / delete
 *   - POST /tasks/:id/retry: terminal guard, new task creation
 *   - PATCH /tasks/:id: kill-chain fall-through bug
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// ─── Mocks (must be set up before importing the modules under test) ───────────

vi.mock("../discord", () => ({
  notifySubmitted: vi.fn().mockResolvedValue(undefined),
  notifyTaskMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../scheduler", () => ({
  triggerSchedule: vi.fn(),
  maybeDispatch: vi.fn(),
  startScheduler: vi.fn(),
  diagnoseTaskAssignment: vi.fn(),
}));

vi.mock("../socket/stub", () => ({
  initiateKillChain: vi.fn(),
}));

// In tests that exercise destructive kill paths, make initiateKillChain mirror the
// real side effect: cooperative should_stop plus internal kill_requested.

vi.mock("../task-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../task-actions")>();
  return {
    ...actual,
    cancelTask: vi.fn(),
    cancelGlobalTask: vi.fn(),
    pauseTask: vi.fn(),
    resumeTask: vi.fn(),
  };
});

vi.mock("../reliable", () => ({
  reliableEmitToStub: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { store } from "../store";
import { assembleCommand, generateDisplayName, createTask, createGlobalTasksRouter } from "../api/tasks";
import { writeLockTable, idempotencyCache } from "../dedup";
import { initiateKillChain } from "../socket/stub";
import { cancelTask, cancelGlobalTask, pauseTask, resumeTask } from "../task-actions";
import { reliableEmitToStub } from "../reliable";
import { Task, Stub } from "../types";
import { diagnoseTaskAssignment } from "../scheduler";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStubNamespace() {
  return { emit: vi.fn(), sockets: { get: vi.fn() } } as any;
}

function makeWebNamespace() {
  return { emit: vi.fn() } as any;
}

function makeApp(stubNs?: any, webNs?: any) {
  const app = express();
  app.use(express.json());
  app.use("/tasks", createGlobalTasksRouter(stubNs ?? makeStubNamespace(), webNs ?? makeWebNamespace()));
  return app;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    seq: store.nextSeq(),
    fingerprint: `fp-${Math.random().toString(36).slice(2, 8)}`,
    display_name: "test task",
    script: "train.py",
    command: "python train.py",
    status: "pending",
    priority: 5,
    created_at: new Date().toISOString(),
    log_buffer: [],
    retry_count: 0,
    max_retries: 0,
    should_stop: false,
    should_checkpoint: false,
    kill_requested: false,
    ...overrides,
  };
}

function makeStub(overrides: Partial<Stub> = {}): Stub {
  return {
    id: `stub-${Math.random().toString(36).slice(2, 8)}`,
    name: "test-stub",
    hostname: "localhost",
    gpu: { name: "RTX3090", vram_total_mb: 24576, count: 1 },
    status: "online",
    type: "workstation",
    connected_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    max_concurrent: 2,
    tasks: [],
    ...overrides,
  };
}

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
});

afterEach(() => {
  writeLockTable.clear();
});

describe("GET /tasks/:id/assignment-diagnosis", () => {
  it("returns a read-only scheduler diagnosis", async () => {
    const app = makeApp();
    const task = makeTask({ id: "pending-why" });
    store.addToGlobalQueue(task);
    vi.mocked(diagnoseTaskAssignment).mockReturnValue({
      task_id: task.id,
      status: "pending",
      schedulable: false,
      blocker: "no_online_stubs",
      dependencies: [],
      requested: {},
      eligible_stub_ids: [],
      stubs: [],
    } as any);

    const before = JSON.stringify(store.findTask(task.id)?.task);
    const response = await request(app).get(`/tasks/${task.id}/assignment-diagnosis`);

    expect(response.status).toBe(200);
    expect(response.body.blocker).toBe("no_online_stubs");
    expect(diagnoseTaskAssignment).toHaveBeenCalledWith(task, []);
    expect(JSON.stringify(store.findTask(task.id)?.task)).toBe(before);
  });
});

// ─── assembleCommand ──────────────────────────────────────────────────────────

describe("assembleCommand", () => {
  it("returns bare script when no options provided", () => {
    // .py scripts get python prepended automatically
    expect(assembleCommand({ script: "train.py" })).toBe("python train.py");
  });

  it("prepends env_setup with &&", () => {
    const cmd = assembleCommand({ script: "train.py", env_setup: "source activate ml" });
    expect(cmd).toBe("source activate ml && python train.py");
  });

  it("prepends cd with single-quote-escaped cwd", () => {
    const cmd = assembleCommand({ script: "train.py", cwd: "/home/user/work" });
    expect(cmd).toBe("cd '/home/user/work' && python train.py");
  });

  it("escapes single quotes in cwd", () => {
    const cmd = assembleCommand({ script: "train.py", cwd: "/home/user's/work" });
    expect(cmd).toContain("'\\''");
  });

  it("prepends exported env vars in single quotes", () => {
    const cmd = assembleCommand({ script: "train.py", env: { FOO: "bar" } });
    expect(cmd).toBe("export FOO='bar' && python train.py");
  });

  it("escapes single quotes in env values", () => {
    const cmd = assembleCommand({ script: "train.py", env: { MSG: "it's alive" } });
    expect(cmd).toContain("'it'\\''s alive'");
  });

  it("filters ALCHEMY_ prefixed env keys", () => {
    const cmd = assembleCommand({ script: "train.py", env: { ALCHEMY_TOKEN: "secret", FOO: "bar" } });
    expect(cmd).not.toContain("ALCHEMY_TOKEN");
    expect(cmd).toContain("FOO");
  });

  it("appends args as key value pairs", () => {
    const cmd = assembleCommand({ script: "train.py", args: { "--seed": "42", "--lr": "0.001" } });
    expect(cmd).toContain("--seed 42");
    expect(cmd).toContain("--lr 0.001");
  });

  it("appends raw_args verbatim", () => {
    const cmd = assembleCommand({ script: "train.py", raw_args: "--extra foo" });
    expect(cmd).toBe("python train.py --extra foo");
  });

  it("preserves multiline raw_args without collapsing whitespace", () => {
    const raw = "- <<'PY'\nfrom pathlib import Path\nPath('/tmp/cfg.yaml').write_text('a: 1\\nb: 2\\n')\nPY\ncat /tmp/cfg.yaml";
    const cmd = assembleCommand({ script: "python", raw_args: raw });
    expect(cmd).toBe(`python ${raw}`);
    expect(cmd).toContain("\nfrom pathlib import Path\n");
    expect(cmd).toContain("\nPY\ncat /tmp/cfg.yaml");
  });

  it("quotes structured argv values instead of shell-expanding them", () => {
    const cmd = assembleCommand({ script: "train.py", argv: ["--name", "$(whoami)", "--message", "hello world"] } as any);
    expect(cmd).toBe("python train.py --name '$(whoami)' --message 'hello world'");
  });

  it("combines all parts in correct order", () => {
    const cmd = assembleCommand({
      script: "train.py",
      env_setup: "conda activate ml",
      cwd: "/workspace",
      env: { CUDA: "1" },
      args: { "--seed": "42" },
      raw_args: "--debug",
    });
    // env_setup → cd → export → script → args → raw_args
    const envSetupIdx = cmd.indexOf("conda activate ml");
    const cdIdx = cmd.indexOf("cd '/workspace'");
    const exportIdx = cmd.indexOf("export CUDA");
    const scriptIdx = cmd.indexOf("train.py", exportIdx + 1);
    const argsIdx = cmd.indexOf("--seed 42");
    const rawArgsIdx = cmd.indexOf("--debug");

    expect(envSetupIdx).toBeLessThan(cdIdx);
    expect(cdIdx).toBeLessThan(exportIdx);
    expect(exportIdx).toBeLessThan(scriptIdx);
    expect(scriptIdx).toBeLessThan(argsIdx);
    expect(argsIdx).toBeLessThan(rawArgsIdx);
  });

  // BUG DOCUMENTATION: env_setup is not sanitized — shell injection possible
  it("BUG: env_setup is concatenated verbatim (shell injection vector)", () => {
    const malicious = "true && echo INJECTED";
    const cmd = assembleCommand({ script: "train.py", env_setup: malicious });
    // The injected fragment appears literally in the command
    expect(cmd).toContain("echo INJECTED");
  });

  it("quotes record args values to avoid shell expansion", () => {
    const cmd = assembleCommand({ script: "train.py", args: { "--name": "$(whoami)" } });
    expect(cmd).toBe("python train.py --name '$(whoami)'");
  });

  // BUG DOCUMENTATION: raw_args is verbatim
  it("BUG: raw_args is appended verbatim (shell injection vector)", () => {
    const cmd = assembleCommand({ script: "train.py", raw_args: "; rm -rf /" });
    expect(cmd).toContain("; rm -rf /");
  });

  it("handles string args (Sub-JEPA style)", () => {
    const cmd = assembleCommand({ script: "eval.py", args: "--checkpoint /runs/ckpt.pt --seed 42" });
    expect(cmd).toBe("python eval.py --checkpoint /runs/ckpt.pt --seed 42");
  });

  it("handles string args with cwd", () => {
    const cmd = assembleCommand({ script: "eval.py", args: "--seed 42", cwd: "/workspace" });
    expect(cmd).toBe("cd '/workspace' && python eval.py --seed 42");
  });

  it("handles empty string args gracefully", () => {
    const cmd = assembleCommand({ script: "train.py", args: "  " });
    expect(cmd).toBe("python train.py");
  });

  it("handles array args", () => {
    const cmd = assembleCommand({ script: "run.sh", args: ["--seed", "42"] as any });
    expect(cmd).toContain("--seed");
    expect(cmd).toContain("42");
  });
});

// ─── generateDisplayName ──────────────────────────────────────────────────────

describe("generateDisplayName", () => {
  it("returns task.name when set", () => {
    expect(generateDisplayName({ name: "my-run", script: "train.py" })).toBe("my-run");
  });

  it("returns script basename when no name", () => {
    expect(generateDisplayName({ script: "/workspace/train.py" })).toBe("train.py");
  });

  it("returns script basename + args summary when args present", () => {
    const name = generateDisplayName({
      script: "train.py",
      args: { "--seed": "42", "--lr": "0.001" },
    });
    expect(name).toContain("train.py");
    expect(name).toContain("seed=42");
    expect(name).toContain("lr=0.001");
  });

  it("returns command basename when only command present", () => {
    const name = generateDisplayName({ command: "python /workspace/run.py" });
    expect(name).toBe("run.py");
  });

  it("returns script basename + string args when args is a string", () => {
    const name = generateDisplayName({
      script: "eval.py",
      args: "--checkpoint /runs/ckpt.pt --seed 42",
    });
    expect(name).toContain("eval.py");
    expect(name).toContain("--checkpoint");
  });

  it("returns 'task' as final fallback", () => {
    expect(generateDisplayName({})).toBe("task");
  });
});

// ─── createTask ───────────────────────────────────────────────────────────────

describe("createTask", () => {
  it("creates a task with correct defaults", () => {
    const task = createTask({ script: "train.py" });
    expect(task.status).toBe("pending");
    expect(task.priority).toBe(5);
    expect(task.retry_count).toBe(0);
    expect(task.max_retries).toBe(0);
    expect(task.should_stop).toBe(false);
    expect(task.should_checkpoint).toBe(false);
    expect(task.log_buffer).toEqual([]);
  });

  it("sets priority and max_retries from input", () => {
    const task = createTask({ script: "train.py", priority: 9, max_retries: 3 });
    expect(task.priority).toBe(9);
    expect(task.max_retries).toBe(3);
  });

  it("generates a fingerprint", () => {
    const task = createTask({ script: "train.py", args: { "--seed": "42" } });
    expect(task.fingerprint).toBeDefined();
    expect(task.fingerprint.length).toBe(16);
  });

  it("same inputs produce same fingerprint", () => {
    const t1 = createTask({ script: "train.py", args: { "--seed": "42" }, cwd: "/ws" });
    const t2 = createTask({ script: "train.py", args: { "--seed": "42" }, cwd: "/ws" });
    expect(t1.fingerprint).toBe(t2.fingerprint);
  });

  it("different args produce different fingerprint", () => {
    const t1 = createTask({ script: "train.py", args: { "--seed": "1" } });
    const t2 = createTask({ script: "train.py", args: { "--seed": "2" } });
    expect(t1.fingerprint).not.toBe(t2.fingerprint);
  });

  it("propagates stub_id and grid_id", () => {
    const task = createTask({ script: "train.py", stub_id: "stub-1", grid_id: "grid-1" });
    expect(task.stub_id).toBe("stub-1");
    expect(task.grid_id).toBe("grid-1");
  });

  it("assembles command from script and args", () => {
    const task = createTask({ script: "train.py", args: { "--seed": "42" } });
    expect(task.command).toContain("train.py");
    expect(task.command).toContain("--seed 42");
  });
});

// ─── POST /tasks ──────────────────────────────────────────────────────────────

describe("POST /tasks", () => {
  it("returns 400 when script is missing", async () => {
    const app = makeApp();
    const res = await request(app).post("/tasks").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/script required/i);
  });

  it("creates a task and returns 201", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/tasks")
      .send({ script: "/tmp/train.py", args: { "--seed": "1" } });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe("pending");
    expect(res.body.script).toBe("/tmp/train.py");
  });

  it("adds task to global queue", async () => {
    const app = makeApp();
    await request(app).post("/tasks").send({ script: "/tmp/train.py" });
    expect(store.getGlobalQueue()).toHaveLength(1);
  });

  it("rejects duplicate fingerprint with 409", async () => {
    const app = makeApp();
    const body = { script: "/tmp/train.py", args: { "--seed": "42" } };
    await request(app).post("/tasks").send(body);
    const res = await request(app).post("/tasks").send(body);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/fingerprint/i);
    expect(res.body.existing_task_id).toBeDefined();
  });

  it("allows duplicate fingerprint after task completes", async () => {
    const app = makeApp();
    const body = { script: "/tmp/train.py", args: { "--seed": "99" } };
    const first = await request(app).post("/tasks").send(body);
    expect(first.status).toBe(201);

    // Simulate the task going through the full lifecycle to terminal
    // pending → queued (must go through stubs since global queue doesn't support direct terminal)
    // Instead: set the archive directly to simulate completion
    const taskId = first.body.id;
    const removedTask = store.removeFromGlobalQueue(taskId);
    if (removedTask) {
      store.setArchive([...store.getArchive(), { ...removedTask, status: "completed" }]);
      // Fingerprint index is cleaned up via _reindexTask on status change, but
      // since we manually moved it, we must rebuild the index
      store.rebuildFingerprintIndex();
    }

    const second = await request(app).post("/tasks").send(body);
    expect(second.status).toBe(201);
  });

  it("rejects with 409 when run_dir is write-locked", async () => {
    const app = makeApp();
    // First task acquires the lock
    await request(app)
      .post("/tasks")
      .send({ script: "/tmp/train.py", args: { "--seed": "1" }, run_dir: "/runs/exp1" });

    // Second task with same run_dir and different fingerprint
    const res = await request(app)
      .post("/tasks")
      .send({ script: "/tmp/other.py", run_dir: "/runs/exp1" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/locked/i);
  });

  it("idempotency key returns same task on repeat", async () => {
    const app = makeApp();
    const body = { script: "/tmp/train.py", idempotency_key: "idem-test-1" };
    const first = await request(app).post("/tasks").send(body);
    expect(first.status).toBe(201);

    // Different fingerprint would normally be fine but idempotency short-circuits
    const second = await request(app)
      .post("/tasks")
      .send({ script: "/tmp/other.py", idempotency_key: "idem-test-1" });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it("emits task.update via webNs", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    await request(app).post("/tasks").send({ script: "/tmp/train.py" });
    expect(webNs.emit).toHaveBeenCalledWith("task.update", expect.objectContaining({ script: "/tmp/train.py" }));
  });

  it("passes priority from request body", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/tasks")
      .send({ script: "/tmp/train.py", priority: 9 });
    expect(res.status).toBe(201);
    expect(res.body.priority).toBe(9);
  });

  it("attaches submission warnings for risky standalone submissions", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/tasks")
      .send({
        script: "/vol/bitbucket/ys25/jspace-workspace-regularization/scripts/run_synthetic.py",
        raw_args: "--output results/synthetic_seed0.json",
        priority: 5,
      });

    expect(res.status).toBe(201);
    const codes = res.body.submission_warnings.map((w: any) => w.code);
    expect(codes).toContain("python_script_uses_default_python");
    expect(codes).toContain("high_priority_unrouted");
  });

  it("BUG: script as non-string truthy value passes validation", async () => {
    const app = makeApp();
    // JSON sends object — passes !script check since {} is truthy
    const res = await request(app)
      .post("/tasks")
      .send({ script: { evil: true } });
    // BUG: No type guard — an object passes !script since it's truthy.
    // The server returns 201 (not 400) and the command is built from "[object Object]".
    // A correct implementation would validate typeof script === "string".
    expect(res.status).not.toBe(400); // currently no type validation
  });
});

// ─── GET /tasks ───────────────────────────────────────────────────────────────

describe("GET /tasks", () => {
  it("returns empty list initially", async () => {
    const app = makeApp();
    const res = await request(app).get("/tasks");
    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it("returns paginated results with defaults", async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) {
      const task = makeTask({ script: `train${i}.py` });
      store.addToGlobalQueue(task);
    }
    const res = await request(app).get("/tasks");
    expect(res.body.total).toBe(5);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(100);
    expect(res.body.tasks).toHaveLength(5);
  });

  it("filters by status", async () => {
    const app = makeApp();
    const t1 = makeTask({ status: "pending" });
    const t2 = makeTask({ status: "pending", fingerprint: "fp-other" });
    store.addToGlobalQueue(t1);
    store.addToGlobalQueue(t2);

    // Add a running task via stub
    const stub = makeStub({ tasks: [makeTask({ status: "running", fingerprint: "fp-run" })] });
    store.setStub(stub);

    const res = await request(app).get("/tasks?status=pending");
    expect(res.body.tasks.every((t: Task) => t.status === "pending")).toBe(true);
  });

  it("excludes log_buffer by default", async () => {
    const app = makeApp();
    const task = makeTask({ log_buffer: ["line1", "line2"] });
    store.addToGlobalQueue(task);
    const res = await request(app).get("/tasks");
    expect(res.body.tasks[0].log_buffer).toBeUndefined();
  });

  it("includes log_buffer when logs=true", async () => {
    const app = makeApp();
    const task = makeTask({ log_buffer: ["line1", "line2"] });
    store.addToGlobalQueue(task);
    const res = await request(app).get("/tasks?logs=true");
    expect(res.body.tasks[0].log_buffer).toEqual(["line1", "line2"]);
  });

  it("respects page and limit params", async () => {
    const app = makeApp();
    for (let i = 0; i < 10; i++) {
      store.addToGlobalQueue(makeTask());
    }
    const res = await request(app).get("/tasks?page=2&limit=3");
    expect(res.body.page).toBe(2);
    expect(res.body.limit).toBe(3);
    expect(res.body.tasks).toHaveLength(3);
  });
});

// ─── GET /tasks/:id ───────────────────────────────────────────────────────────

describe("GET /tasks/:id", () => {
  it("returns 404 for unknown task", async () => {
    const app = makeApp();
    const res = await request(app).get("/tasks/nonexistent");
    expect(res.status).toBe(404);
  });

  it("returns task by id from global queue", async () => {
    const app = makeApp();
    const task = makeTask();
    store.addToGlobalQueue(task);
    const res = await request(app).get(`/tasks/${task.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(task.id);
  });

  it("returns task by id from stub", async () => {
    const app = makeApp();
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);
    const res = await request(app).get(`/tasks/${task.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(task.id);
  });
});

// ─── POST /tasks/batch ────────────────────────────────────────────────────────

describe("POST /tasks/batch", () => {
  it("returns 400 when task_ids not array", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/tasks/batch")
      .send({ action: "kill", task_ids: "not-an-array" });
    expect(res.status).toBe(400);
  });

  it("batch kill: returns error for non-killable task", async () => {
    const app = makeApp();
    const task = makeTask({ status: "completed" });
    store.addToGlobalQueue(task);

    const res = await request(app)
      .post("/tasks/batch")
      .send({ action: "kill", task_ids: [task.id] });
    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(false);
    expect(res.body.results[0].error).toMatch(/kill/i);
  });

  it("batch kill: kills pending task in global queue", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "pending" });
    store.addToGlobalQueue(task);

    const res = await request(app)
      .post("/tasks/batch")
      .send({ action: "kill", task_ids: [task.id] });
    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(true);
    expect(cancelGlobalTask).toHaveBeenCalledWith(task.id);
  });

  it("batch kill: calls initiateKillChain for running task on stub", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);

    const res = await request(app)
      .post("/tasks/batch")
      .send({ action: "kill", task_ids: [task.id] });
    expect(res.body.results[0].ok).toBe(true);
    expect(initiateKillChain).toHaveBeenCalledWith(stub.id, task.id);
  });

  it("batch retry: rejects non-terminal task", async () => {
    const app = makeApp();
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);

    const res = await request(app)
      .post("/tasks/batch")
      .send({ action: "retry", task_ids: [task.id] });
    expect(res.body.results[0].ok).toBe(false);
    expect(res.body.results[0].error).toMatch(/retry/i);
  });

  it("batch retry: creates new task for terminal task", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "failed" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);

    const res = await request(app)
      .post("/tasks/batch")
      .send({ action: "retry", task_ids: [task.id] });
    expect(res.body.results[0].ok).toBe(true);
    expect(res.body.results[0].new_task_id).toBeDefined();
    expect(res.body.results[0].new_task_id).not.toBe(task.id);
  });

  it("batch retry: increments retry_count", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "failed", retry_count: 2 });
    // Put directly in archive (terminal tasks live there)
    store.setArchive([task]);

    await request(app)
      .post("/tasks/batch")
      .send({ action: "retry", task_ids: [task.id] });

    // Find the new task in global queue
    const queue = store.getGlobalQueue();
    const retried = queue.find((t) => t.retry_of === task.id);
    expect(retried).toBeDefined();
    expect(retried!.retry_count).toBe(3);
  });

  it("batch requeue: moves task back to global queue", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "pending" });
    store.addToGlobalQueue(task);

    const res = await request(app)
      .post("/tasks/batch")
      .send({ action: "requeue", task_ids: [task.id] });
    expect(res.body.results[0].ok).toBe(true);
  });

  it("batch requeue: rejects running task", async () => {
    const app = makeApp();
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);

    const res = await request(app)
      .post("/tasks/batch")
      .send({ action: "requeue", task_ids: [task.id] });
    expect(res.body.results[0].ok).toBe(false);
  });

  it("batch delete: rejects non-terminal task", async () => {
    const app = makeApp();
    const task = makeTask({ status: "pending" });
    store.addToGlobalQueue(task);

    const res = await request(app)
      .post("/tasks/batch")
      .send({ action: "delete", task_ids: [task.id] });
    expect(res.body.results[0].ok).toBe(false);
    expect(res.body.results[0].error).toMatch(/delete/i);
  });

  it("batch delete: removes terminal task from archive", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "completed" });
    // Put directly in archive (terminal tasks live there)
    store.setArchive([task]);

    const res = await request(app)
      .post("/tasks/batch")
      .send({ action: "delete", task_ids: [task.id] });
    expect(res.body.results[0].ok).toBe(true);
    expect(webNs.emit).toHaveBeenCalledWith("task.deleted", { task_id: task.id });
    expect(store.getArchive()).toHaveLength(0);
  });

  it("batch unknown action: returns error", async () => {
    const app = makeApp();
    const task = makeTask();
    store.addToGlobalQueue(task);

    const res = await request(app)
      .post("/tasks/batch")
      .send({ action: "explode", task_ids: [task.id] });
    expect(res.body.results[0].ok).toBe(false);
    expect(res.body.results[0].error).toMatch(/unknown action/i);
  });

  it("batch: reports not-found for unknown task ids", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/tasks/batch")
      .send({ action: "kill", task_ids: ["does-not-exist"] });
    expect(res.body.results[0].ok).toBe(false);
    expect(res.body.results[0].error).toMatch(/not found/i);
  });

  it("batch: handles mixed results correctly", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const pending = makeTask({ status: "pending" });
    const completed = makeTask({ status: "completed", fingerprint: "fp-c" });
    store.addToGlobalQueue(pending);
    // completed task goes directly to archive
    store.setArchive([...store.getArchive(), completed]);

    const res = await request(app)
      .post("/tasks/batch")
      .send({ action: "kill", task_ids: [pending.id, completed.id] });
    // pending → can kill; completed → cannot kill
    const pendingResult = res.body.results.find((r: any) => r.id === pending.id);
    const completedResult = res.body.results.find((r: any) => r.id === completed.id);
    expect(pendingResult.ok).toBe(true);
    expect(completedResult.ok).toBe(false);
  });
});

// ─── POST /tasks/:id/retry ────────────────────────────────────────────────────

describe("POST /tasks/:id/retry", () => {
  it("returns 404 for unknown task", async () => {
    const app = makeApp();
    const res = await request(app).post("/tasks/nonexistent/retry").send({});
    expect(res.status).toBe(404);
  });

  it("returns 400 when task is not terminal", async () => {
    const app = makeApp();
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);

    const res = await request(app).post(`/tasks/${task.id}/retry`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/retry/i);
  });

  it("creates a new pending task for terminal task", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "failed", id: "original-id" });
    // Terminal tasks live in archive
    store.setArchive([task]);

    const res = await request(app).post(`/tasks/${task.id}/retry`).send({});
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(task.id);
    expect(res.body.status).toBe("pending");
    expect(res.body.retry_of).toBe(task.id);
    expect(res.body.retry_count).toBe(1);
  });

  it("preserves retry_of from original task in retry chain", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    // Simulate a task that is already a retry and is now failed
    const task = makeTask({ status: "failed", retry_of: "original-original", retry_count: 1 });
    store.setArchive([task]);

    const res = await request(app).post(`/tasks/${task.id}/retry`).send({});
    expect(res.status).toBe(201);
    // retry_of should point to the original, not the intermediate
    expect(res.body.retry_of).toBe("original-original");
    expect(res.body.retry_count).toBe(2);
  });

  it("resets execution state on retry", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({
      status: "failed",
      started_at: "2024-01-01T00:00:00.000Z",
      finished_at: "2024-01-01T01:00:00.000Z",
      exit_code: 1,
      pid: 12345,
      should_stop: true,
      should_checkpoint: true,
    });
    store.setArchive([task]);

    const res = await request(app).post(`/tasks/${task.id}/retry`).send({});
    expect(res.status).toBe(201);
    expect(res.body.started_at).toBeUndefined();
    expect(res.body.finished_at).toBeUndefined();
    expect(res.body.exit_code).toBeUndefined();
    expect(res.body.pid).toBeUndefined();
    expect(res.body.should_stop).toBe(false);
    expect(res.body.should_checkpoint).toBe(false);
    expect(res.body.log_buffer).toEqual([]);
  });
});

// ─── PATCH /tasks/:id ────────────────────────────────────────────────────────

describe("PATCH /tasks/:id", () => {
  it("returns 404 for unknown task", async () => {
    const app = makeApp();
    const res = await request(app).patch("/tasks/nonexistent").send({ priority: 9 });
    expect(res.status).toBe(404);
  });

  it("updates priority on global queue task", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "pending" });
    store.addToGlobalQueue(task);

    const res = await request(app).patch(`/tasks/${task.id}`).send({ priority: 9 });
    expect(res.status).toBe(200);
    expect(res.body.priority).toBe(9);
    expect(webNs.emit).toHaveBeenCalledWith("task.update", expect.objectContaining({ priority: 9 }));
  });

  it("updates name and display_name together", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "pending" });
    store.addToGlobalQueue(task);

    const res = await request(app).patch(`/tasks/${task.id}`).send({ name: "my-custom-name" });
    expect(res.body.name).toBe("my-custom-name");
    expect(res.body.display_name).toBe("my-custom-name");
  });

  it("returns 400 for unsupported status transition", async () => {
    const app = makeApp();
    const task = makeTask({ status: "pending" });
    store.addToGlobalQueue(task);

    const res = await request(app).patch(`/tasks/${task.id}`).send({ status: "completed" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported status transition/i);
  });

  it("sets should_stop as a cooperative SDK signal without starting the kill chain", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);

    const res = await request(app).patch(`/tasks/${task.id}`).send({ should_stop: true });

    expect(res.status).toBe(200);
    expect(res.body.should_stop).toBe(true);
    expect(initiateKillChain).not.toHaveBeenCalled();
    expect(reliableEmitToStub).toHaveBeenCalledWith(stub.id, "task.signal", {
      task_id: task.id,
      signal: "should_stop",
    });
    expect(store.getTask(stub.id, task.id)?.status).toBe("running");
  });

  it("kill via PATCH calls cancelGlobalTask for pending task with no stub", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "pending" });
    store.addToGlobalQueue(task);

    await request(app).patch(`/tasks/${task.id}`).send({ status: "killed" });
    expect(cancelGlobalTask).toHaveBeenCalledWith(task.id);
  });

  it("P1-2: kill via PATCH for running stub task returns updated task with should_stop=true", async () => {
    // Fix: PATCH status=killed on running stub task now returns the updated task
    // after initiateKillChain sets should_stop=true, instead of falling through.
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);

    // Make mock actually set destructive kill state (as the real initiateKillChain does)
    vi.mocked(initiateKillChain).mockImplementationOnce((stubId, taskId) => {
      store.updateTask(stubId, taskId, { should_stop: true, kill_requested: true });
    });

    const res = await request(app)
      .patch(`/tasks/${task.id}`)
      .send({ status: "killed" });

    // initiateKillChain IS called
    expect(initiateKillChain).toHaveBeenCalledWith(stub.id, task.id);
    expect(res.status).toBe(200);
    // The response should reflect should_stop=true set by initiateKillChain
    expect(res.body.should_stop).toBe(true);
  });

  it("P1-2: kill via PATCH for assigned stub task returns updated task", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "assigned" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);

    vi.mocked(initiateKillChain).mockImplementationOnce((stubId, taskId) => {
      store.updateTask(stubId, taskId, { should_stop: true, kill_requested: true });
    });

    const res = await request(app)
      .patch(`/tasks/${task.id}`)
      .send({ status: "killed" });

    expect(initiateKillChain).toHaveBeenCalledWith(stub.id, task.id);
    expect(res.status).toBe(200);
    expect(res.body.should_stop).toBe(true);
  });

  it("pauses a task on stub via PATCH", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "running" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);

    const paused = { ...task, status: "paused" as const };
    vi.mocked(pauseTask as any).mockReturnValueOnce(paused);

    const res = await request(app).patch(`/tasks/${task.id}`).send({ status: "paused" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paused");
  });

  it("resumes a paused task on stub via PATCH", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "paused" });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);

    const resumed = { ...task, status: "running" as const };
    vi.mocked(resumeTask as any).mockReturnValueOnce(resumed);

    const res = await request(app)
      .patch(`/tasks/${task.id}`)
      .send({ status: "running" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("running");
  });
});

// ─── P0-2: Fingerprint dedup bypasses kill_requested=true ─────────────────────

describe("P0-2: findActiveByFingerprint skips kill_requested=true tasks", () => {
  it("allows resubmit after destructive kill request bypasses fingerprint dedup", async () => {
    const app = makeApp();
    const body = { script: "/tmp/train.py", args: { "--seed": "42" } };

    // Submit first task
    const first = await request(app).post("/tasks").send(body);
    expect(first.status).toBe(201);

    // Mark it as kill_requested (simulating a destructive kill in progress)
    const taskId = first.body.id;
    store.updateGlobalQueueTask(taskId, { kill_requested: true });

    // Second submit with same fingerprint should succeed because first is being killed
    const second = await request(app).post("/tasks").send(body);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(taskId);
  });

  it("still rejects duplicate when should_stop=true but kill_requested=false", async () => {
    const app = makeApp();
    const body = { script: "/tmp/train.py", args: { "--seed": "99" } };

    const first = await request(app).post("/tasks").send(body);
    store.updateGlobalQueueTask(first.body.id, { should_stop: true, kill_requested: false });

    const second = await request(app).post("/tasks").send(body);
    expect(second.status).toBe(409);
  });

  it("store.findActiveByFingerprint returns undefined for kill_requested task", () => {
    const task = makeTask({ kill_requested: true, fingerprint: "fp-stop-test" });
    store.addToGlobalQueue(task);

    const result = store.findActiveByFingerprint("fp-stop-test");
    expect(result).toBeUndefined();
  });

  it("store.findActiveByFingerprint returns task_id for cooperative should_stop task", () => {
    const task = makeTask({ should_stop: true, kill_requested: false, fingerprint: "fp-active-test" });
    store.addToGlobalQueue(task);

    const result = store.findActiveByFingerprint("fp-active-test");
    expect(result).toBe(task.id);
  });
});

// ─── P1-1: POST /tasks/:id/reschedule ───────────────────────────────────────

describe("POST /tasks/:id/reschedule", () => {
  it("returns 404 for unknown task", async () => {
    const app = makeApp();
    const res = await request(app).post("/tasks/nonexistent/reschedule").send({});
    expect(res.status).toBe(404);
  });

  it("returns 400 for terminal task", async () => {
    const app = makeApp();
    const task = makeTask({ status: "completed" });
    store.setArchive([task]);

    const res = await request(app).post(`/tasks/${task.id}/reschedule`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/terminal/i);
  });

  it("reschedules a pending global queue task with new target_tags", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "pending", target_tags: ["gpu32"] });
    store.addToGlobalQueue(task);

    const res = await request(app)
      .post(`/tasks/${task.id}/reschedule`)
      .send({ target_tags: ["gpu35"] });

    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(task.id);
    expect(res.body.target_tags).toEqual(["gpu35"]);
    expect(res.body.status).toBe("pending");
    expect(res.body.script).toBe(task.script);
  });

  it("reschedules a running stub task: calls initiateKillChain + creates new task", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "running", target_tags: ["a40"] });
    const stub = makeStub({ tasks: [task] });
    store.setStub(stub);

    const res = await request(app)
      .post(`/tasks/${task.id}/reschedule`)
      .send({ target_tags: ["a100"] });

    expect(res.status).toBe(201);
    expect(initiateKillChain).toHaveBeenCalledWith(stub.id, task.id);
    expect(res.body.target_tags).toEqual(["a100"]);
  });

  it("preserves original config when no overrides given", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({
      status: "pending",
      script: "train.py",
      priority: 8,
      target_tags: ["a40"],
    });
    // Override script to ensure it propagates
    task.script = "train.py";
    store.addToGlobalQueue(task);

    const res = await request(app)
      .post(`/tasks/${task.id}/reschedule`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.script).toBe("train.py");
    expect(res.body.priority).toBe(8);
    // target_tags preserved from original when not overridden
    expect(res.body.target_tags).toEqual(["a40"]);
  });

  it("overrides priority when provided", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "pending", priority: 5 });
    store.addToGlobalQueue(task);

    const res = await request(app)
      .post(`/tasks/${task.id}/reschedule`)
      .send({ priority: 10 });

    expect(res.status).toBe(201);
    expect(res.body.priority).toBe(10);
  });
});

// ─── Fuzzing: malformed payloads, edge cases ────────────────────────────────

describe("Fuzzing: POST /tasks", () => {
  it("rejects null body gracefully", async () => {
    const app = makeApp();
    const res = await request(app).post("/tasks").send(null as any);
    expect(res.status).toBe(400);
  });

  it("rejects empty string script", async () => {
    const app = makeApp();
    const res = await request(app).post("/tasks").send({ script: "" });
    expect(res.status).toBe(400);
  });

  it("handles numeric priority edge values", async () => {
    const app = makeApp();
    const res = await request(app).post("/tasks").send({ script: "/tmp/train.py", priority: -999 });
    expect(res.status).toBe(201);
    expect(res.body.priority).toBe(-999);
  });

  it("handles very large priority", async () => {
    const app = makeApp();
    const res = await request(app).post("/tasks").send({ script: "/tmp/train.py", priority: Number.MAX_SAFE_INTEGER });
    expect(res.status).toBe(201);
  });

  it("handles args with empty object", async () => {
    const app = makeApp();
    const res = await request(app).post("/tasks").send({ script: "/tmp/train.py", args: {} });
    expect(res.status).toBe(201);
  });

  it("handles target_tags as empty array", async () => {
    const app = makeApp();
    const res = await request(app).post("/tasks").send({ script: "/tmp/train.py", target_tags: [] });
    expect(res.status).toBe(201);
    expect(res.body.target_tags).toEqual([]);
  });

  it("accepts 'tags' as alias for 'target_tags'", async () => {
    const app = makeApp();
    const res = await request(app).post("/tasks").send({ script: "/tmp/train.py", tags: ["a30", "jema-v2"] });
    expect(res.status).toBe(201);
    expect(res.body.target_tags).toEqual(["a30", "jema-v2"]);
  });

  it("prefers 'target_tags' over 'tags' when both are set", async () => {
    const app = makeApp();
    const res = await request(app).post("/tasks").send({ script: "/tmp/train.py", target_tags: ["a100"], tags: ["a30"] });
    expect(res.status).toBe(201);
    expect(res.body.target_tags).toEqual(["a100"]);
  });

  it("accepts string args in task creation", async () => {
    const app = makeApp();
    const res = await request(app).post("/tasks").send({
      script: "/tmp/eval.py",
      args: "--checkpoint /runs/ckpt.pt --seed 42",
    });
    expect(res.status).toBe(201);
    expect(res.body.command).toContain("--checkpoint /runs/ckpt.pt --seed 42");
  });

  it("handles extra unknown fields without error", async () => {
    const app = makeApp();
    const res = await request(app).post("/tasks").send({
      script: "/tmp/train.py",
      nonexistent_field: "ignored",
      deeply_nested: { a: { b: { c: 1 } } },
    });
    expect(res.status).toBe(201);
  });
});

describe("Task surgical update/replace", () => {
  it("replaces a task attempt and rewires downstream blocked dependencies without cancelling them", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const train = makeTask({
      id: "train-attempt-1",
      status: "pending",
      ref: "train",
      experiment_id: "exp-replace",
      script: "/tmp/train.py",
      raw_args: "--old-code",
    });
    const evalTask = makeTask({
      id: "eval-blocked",
      status: "blocked",
      ref: "eval",
      experiment_id: "exp-replace",
      script: "/tmp/eval.py",
      depends_on: [train.id],
      args_template: { "--checkpoint": "{{deps.train.exports.checkpoint}}" },
    });
    store.addToGlobalQueue(train);
    store.addToGlobalQueue(evalTask);
    store.setExperiment({
      id: "exp-replace",
      name: "replace test",
      criteria: {},
      grid_id: "grid-replace",
      status: "running",
      results: {},
      created_at: new Date().toISOString(),
      task_refs: { train: train.id, eval: evalTask.id },
    });

    const res = await request(app)
      .post(`/tasks/${train.id}/replace`)
      .send({ overrides: { raw_args: "--new-code", env: { PYTHONPATH: "/new" } }, cancel_old: true });

    expect(res.status).toBe(201);
    const replacement = res.body.task;
    expect(replacement.id).not.toBe(train.id);
    expect(replacement.raw_args).toBe("--new-code");
    expect(replacement.env).toEqual({ PYTHONPATH: "/new" });
    expect(replacement.ref).toBe("train");
    expect(replacement.replaces_task_id).toBe(train.id);
    expect(replacement.attempt).toBe(2);
    expect(store.findTask(train.id)?.task.status).toBe("cancelled");
    expect(store.findTask(evalTask.id)?.task.status).toBe("blocked");
    expect(store.findTask(evalTask.id)?.task.depends_on).toEqual([replacement.id]);
    expect(store.getExperiment("exp-replace")?.task_refs?.train).toBe(replacement.id);
  });

  it("creates replacement as pending when all of its dependencies are already completed", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const collector = makeTask({
      id: "collector-done",
      status: "completed",
      ref: "collector",
      script: "/tmp/collect.py",
      exports: { replay: "/runs/replay.npz" },
    });
    const train = makeTask({
      id: "train-with-done-dep",
      status: "running",
      ref: "train",
      script: "/tmp/train.py",
      depends_on: [collector.id],
    });
    const stub = makeStub({ id: "stub-running", tasks: [train] });
    train.stub_id = stub.id;
    store.setArchive([collector]);
    store.setStub(stub);

    const res = await request(app)
      .post(`/tasks/${train.id}/replace`)
      .send({ cancel_old: true });

    expect(res.status).toBe(201);
    expect(res.body.task.depends_on).toEqual([collector.id]);
    expect(res.body.task.status).toBe("pending");
    expect(store.findTask(res.body.task.id)?.task.status).toBe("pending");
  });

  it("updates a blocked task spec in place without changing dependency identity", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({
      id: "blocked-eval",
      status: "blocked",
      script: "/tmp/eval.py",
      depends_on: ["train-attempt-2"],
      env: { OLD: "1" },
      raw_args: "--old",
    });
    store.addToGlobalQueue(task);

    const res = await request(app)
      .patch(`/tasks/${task.id}`)
      .send({ raw_args: "--new", env: { NEW: "1" }, target_tags: ["a30", "slurm"] });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(task.id);
    expect(res.body.status).toBe("blocked");
    expect(res.body.depends_on).toEqual(["train-attempt-2"]);
    expect(res.body.raw_args).toBe("--new");
    expect(res.body.env).toEqual({ NEW: "1" });
    expect(res.body.target_tags).toEqual(["a30", "slurm"]);
    expect(res.body.command).toContain("--new");
  });
});

describe("Fuzzing: PATCH /tasks/:id", () => {
  it("handles empty body on existing task", async () => {
    const app = makeApp();
    const task = makeTask({ status: "pending" });
    store.addToGlobalQueue(task);

    const res = await request(app).patch(`/tasks/${task.id}`).send({});
    expect(res.status).toBe(200);
  });

  it("handles null priority", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "pending" });
    store.addToGlobalQueue(task);

    const res = await request(app).patch(`/tasks/${task.id}`).send({ priority: null });
    expect(res.status).toBe(200);
  });

  it("handles boolean status value", async () => {
    const app = makeApp();
    const task = makeTask({ status: "pending" });
    store.addToGlobalQueue(task);

    const res = await request(app).patch(`/tasks/${task.id}`).send({ status: true });
    expect(res.status).toBe(400);
  });

  it("handles non-string name", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "pending" });
    store.addToGlobalQueue(task);

    const res = await request(app).patch(`/tasks/${task.id}`).send({ name: 42 });
    // Should succeed (name is coerced or accepted as-is)
    expect(res.status).toBe(200);
  });
});

describe("Fuzzing: POST /tasks/batch", () => {
  it("handles empty task_ids array", async () => {
    const app = makeApp();
    const res = await request(app).post("/tasks/batch").send({ action: "kill", task_ids: [] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it("handles missing action field", async () => {
    const app = makeApp();
    const task = makeTask();
    store.addToGlobalQueue(task);

    const res = await request(app).post("/tasks/batch").send({ task_ids: [task.id] });
    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(false);
    expect(res.body.results[0].error).toMatch(/unknown action/i);
  });

  it("handles null in task_ids array", async () => {
    const app = makeApp();
    const res = await request(app).post("/tasks/batch").send({ action: "kill", task_ids: [null] });
    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(false);
  });
});

describe("Fuzzing: POST /tasks/:id/reschedule", () => {
  it("handles empty target_tags array", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "pending", target_tags: ["a40"] });
    store.addToGlobalQueue(task);

    const res = await request(app)
      .post(`/tasks/${task.id}/reschedule`)
      .send({ target_tags: [] });

    expect(res.status).toBe(201);
    expect(res.body.target_tags).toEqual([]);
  });

  it("handles non-array target_tags", async () => {
    const webNs = makeWebNamespace();
    const app = makeApp(undefined, webNs);
    const task = makeTask({ status: "pending" });
    store.addToGlobalQueue(task);

    const res = await request(app)
      .post(`/tasks/${task.id}/reschedule`)
      .send({ target_tags: "not-an-array" });

    // Currently no validation — documents behavior
    expect(res.status).toBe(201);
  });
});
