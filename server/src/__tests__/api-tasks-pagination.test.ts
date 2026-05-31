/**
 * api-tasks-pagination.test.ts — Tests for Bug 6 fix.
 *
 * Covers:
 *   - offset-based pagination (?offset=N&limit=M)
 *   - page-based pagination backward compat (?page=N&limit=M)
 *   - sort by seq and created_at, asc/desc order
 *   - default limit=100, max limit=500
 *   - response shape includes {tasks, total, offset, limit, page, counts}
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("../discord", () => ({
  notifySubmitted: vi.fn().mockResolvedValue(undefined),
  notifyTaskMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../scheduler", () => ({
  triggerSchedule: vi.fn(),
  maybeDispatch: vi.fn(),
  startScheduler: vi.fn(),
}));

vi.mock("../socket/stub", () => ({
  initiateKillChain: vi.fn(),
}));

vi.mock("../task-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../task-actions")>();
  return {
    ...actual,
    killTask: vi.fn(),
    killGlobalTask: vi.fn(),
    pauseTask: vi.fn(),
    resumeTask: vi.fn(),
  };
});

vi.mock("../reliable", () => ({
  reliableEmitToStub: vi.fn(),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { store } from "../store";
import { createGlobalTasksRouter } from "../api/tasks";
import { writeLockTable } from "../dedup";
import { Task } from "../types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  const ns = { emit: vi.fn(), sockets: { get: vi.fn() } } as any;
  app.use("/tasks", createGlobalTasksRouter(ns, ns));
  return app;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Math.random().toString(36).slice(2, 10)}`,
    seq: store.nextSeq(),
    fingerprint: `fp-${Math.random().toString(36).slice(2, 10)}`,
    display_name: "test task",
    script: "/abs/train.py",
    command: "python train.py",
    status: "pending",
    priority: 5,
    created_at: new Date().toISOString(),
    log_buffer: ["log line"],
    retry_count: 0,
    max_retries: 0,
    should_stop: false,
    should_checkpoint: false,
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

// ─── Response shape ───────────────────────────────────────────────────────────

describe("GET /tasks response shape", () => {
  it("includes tasks, total, offset, limit, page, counts", async () => {
    const t = makeTask();
    store.addToGlobalQueue(t);
    const app = makeApp();
    const res = await request(app).get("/tasks");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("tasks");
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("offset");
    expect(res.body).toHaveProperty("limit");
    expect(res.body).toHaveProperty("page");
    expect(res.body).toHaveProperty("counts");
  });

  it("strips log_buffer by default", async () => {
    const t = makeTask();
    store.addToGlobalQueue(t);
    const app = makeApp();
    const res = await request(app).get("/tasks");
    expect(res.body.tasks[0]).not.toHaveProperty("log_buffer");
  });

  it("includes log_buffer when ?logs=true", async () => {
    const t = makeTask();
    store.addToGlobalQueue(t);
    const app = makeApp();
    const res = await request(app).get("/tasks?logs=true");
    expect(res.body.tasks[0]).toHaveProperty("log_buffer");
  });
});

// ─── Default limit ────────────────────────────────────────────────────────────

describe("default limit", () => {
  it("defaults to limit=100", async () => {
    const app = makeApp();
    const res = await request(app).get("/tasks");
    expect(res.body.limit).toBe(100);
  });

  it("caps limit at 500", async () => {
    const app = makeApp();
    const res = await request(app).get("/tasks?limit=9999");
    expect(res.body.limit).toBe(500);
  });

  it("treats limit=0 as invalid and falls back to default 100", async () => {
    const app = makeApp();
    // limit=0 is parsed as 0 which is falsy, so the || 100 fallback kicks in
    const res = await request(app).get("/tasks?limit=0");
    expect(res.body.limit).toBe(100);
  });
});

// ─── Offset-based pagination ──────────────────────────────────────────────────

describe("offset-based pagination", () => {
  beforeEach(() => {
    // Add 5 tasks with distinct seqs
    for (let i = 0; i < 5; i++) {
      store.addToGlobalQueue(makeTask());
    }
  });

  it("offset=0 returns first page", async () => {
    const app = makeApp();
    const res = await request(app).get("/tasks?offset=0&limit=2");
    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBe(2);
    expect(res.body.offset).toBe(0);
    expect(res.body.limit).toBe(2);
    expect(res.body.total).toBe(5);
  });

  it("offset=2 skips first 2 tasks", async () => {
    const app = makeApp();
    const res0 = await request(app).get("/tasks?offset=0&limit=2");
    const res2 = await request(app).get("/tasks?offset=2&limit=2");
    const ids0 = res0.body.tasks.map((t: any) => t.id);
    const ids2 = res2.body.tasks.map((t: any) => t.id);
    // No overlap
    expect(ids0.filter((id: string) => ids2.includes(id))).toHaveLength(0);
  });

  it("offset beyond total returns empty tasks array", async () => {
    const app = makeApp();
    const res = await request(app).get("/tasks?offset=100&limit=10");
    expect(res.body.tasks).toHaveLength(0);
    expect(res.body.total).toBe(5);
    expect(res.body.offset).toBe(100);
  });

  it("offset takes precedence over page", async () => {
    const app = makeApp();
    // page=2&limit=2 would give offset=2, but explicit offset=0 wins
    const res = await request(app).get("/tasks?page=2&offset=0&limit=2");
    expect(res.body.offset).toBe(0);
    expect(res.body.tasks.length).toBe(2);
  });
});

// ─── Page-based pagination (backward compat) ──────────────────────────────────

describe("page-based pagination (backward compat)", () => {
  beforeEach(() => {
    for (let i = 0; i < 5; i++) {
      store.addToGlobalQueue(makeTask());
    }
  });

  it("page=1 returns first page", async () => {
    const app = makeApp();
    const res = await request(app).get("/tasks?page=1&limit=3");
    expect(res.body.tasks.length).toBe(3);
    expect(res.body.page).toBe(1);
    expect(res.body.offset).toBe(0);
  });

  it("page=2 returns next page", async () => {
    const app = makeApp();
    const res1 = await request(app).get("/tasks?page=1&limit=3");
    const res2 = await request(app).get("/tasks?page=2&limit=3");
    const ids1 = res1.body.tasks.map((t: any) => t.id);
    const ids2 = res2.body.tasks.map((t: any) => t.id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);
    expect(res2.body.offset).toBe(3);
  });
});

// ─── Sort and order ───────────────────────────────────────────────────────────

describe("sort and order", () => {
  beforeEach(() => {
    // Add tasks with distinct created_at timestamps
    const base = Date.now();
    for (let i = 0; i < 4; i++) {
      const t = makeTask({
        created_at: new Date(base + i * 1000).toISOString(),
      });
      store.addToGlobalQueue(t);
    }
  });

  it("default sort=seq order=desc (newest seq first)", async () => {
    const app = makeApp();
    const res = await request(app).get("/tasks");
    const seqs: number[] = res.body.tasks.map((t: any) => t.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
  });

  it("sort=seq order=asc (oldest seq first)", async () => {
    const app = makeApp();
    const res = await request(app).get("/tasks?sort=seq&order=asc");
    const seqs: number[] = res.body.tasks.map((t: any) => t.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("sort=created_at order=desc (newest first)", async () => {
    const app = makeApp();
    const res = await request(app).get("/tasks?sort=created_at&order=desc");
    const dates: string[] = res.body.tasks.map((t: any) => t.created_at);
    const sorted = [...dates].sort((a, b) => b.localeCompare(a));
    expect(dates).toEqual(sorted);
  });

  it("sort=created_at order=asc (oldest first)", async () => {
    const app = makeApp();
    const res = await request(app).get("/tasks?sort=created_at&order=asc");
    const dates: string[] = res.body.tasks.map((t: any) => t.created_at);
    const sorted = [...dates].sort((a, b) => a.localeCompare(b));
    expect(dates).toEqual(sorted);
  });

  it("unknown sort field falls back to seq", async () => {
    const app = makeApp();
    const resDefault = await request(app).get("/tasks?order=desc");
    const resUnknown = await request(app).get("/tasks?sort=invalid&order=desc");
    // Both should produce the same seq-sorted order
    const seqsDefault = resDefault.body.tasks.map((t: any) => t.seq);
    const seqsUnknown = resUnknown.body.tasks.map((t: any) => t.seq);
    expect(seqsDefault).toEqual(seqsUnknown);
  });
});

// ─── Status filter + counts ───────────────────────────────────────────────────

describe("status filter and counts", () => {
  it("counts reflect all tasks regardless of filter", async () => {
    const t1 = makeTask({ status: "pending" });
    const t2 = makeTask({ status: "pending" });
    store.addToGlobalQueue(t1);
    store.addToGlobalQueue(t2);
    const app = makeApp();
    const res = await request(app).get("/tasks?status=pending");
    expect(res.body.tasks.length).toBe(2);
    expect(res.body.counts.pending).toBe(2);
    expect(res.body.total).toBe(2);
  });
});
