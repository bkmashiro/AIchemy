/**
 * exec.test.ts — Tests for POST /api/stubs/:id/exec2 (Spec 3: Stub Remote Exec).
 *
 * The endpoint emits exec.request to the stub socket via native ack and
 * waits for the exec.response payload. Tests mock the socket's emit method
 * to simulate stub responses.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../scheduler", () => ({
  triggerSchedule: vi.fn(),
  maybeDispatch: vi.fn(),
  startScheduler: vi.fn(),
}));

vi.mock("../reliable", () => ({
  reliableEmitToStub: vi.fn(),
}));

vi.mock("../discord", () => ({
  notifySubmitted: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../socket/stub", () => ({
  initiateKillChain: vi.fn(),
}));

vi.mock("../task-actions", () => ({
  killTask: vi.fn(),
  killGlobalTask: vi.fn(),
  pauseTask: vi.fn(),
  resumeTask: vi.fn(),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { store } from "../store";
import { createStubsRouter } from "../api/stubs";
import { Stub } from "../types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    socket_id: "socket-123",
    ...overrides,
  };
}

/** Build a mock stub namespace with a socket that simulates exec.request/ack behaviour. */
function makeStubNsWithSocket(
  stubSocketId: string,
  execHandler?: (payload: any) => any,
) {
  const mockSocket = {
    id: stubSocketId,
    connected: true,
    emit: vi.fn((event: string, payload: any, cb: (r: any) => void) => {
      if (event === "exec.request" && execHandler) {
        // Simulate async stub response
        Promise.resolve(execHandler(payload)).then(cb);
      }
    }),
  };
  return {
    emit: vi.fn(),
    sockets: { get: (id: string) => (id === stubSocketId ? mockSocket : undefined) },
    _mockSocket: mockSocket,
  } as any;
}

function makeApp(stubNs: any) {
  const webNs = { emit: vi.fn() } as any;
  const app = express();
  app.use(express.json());
  app.use("/stubs", createStubsRouter(stubNs, webNs));
  return app;
}

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
});

// ─── POST /stubs/:id/exec2 ────────────────────────────────────────────────────

describe("POST /stubs/:id/exec2", () => {
  it("returns 404 for unknown stub", async () => {
    const stubNs = makeStubNsWithSocket("sock-1");
    const app = makeApp(stubNs);

    const res = await request(app).post("/stubs/nonexistent/exec2").send({ command: "ls" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/stub not found/i);
  });

  it("returns 503 when stub is offline", async () => {
    const stub = makeStub({ status: "offline", socket_id: undefined });
    store.setStub(stub);
    const stubNs = makeStubNsWithSocket("sock-1");
    const app = makeApp(stubNs);

    const res = await request(app).post(`/stubs/${stub.id}/exec2`).send({ command: "ls" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/offline/i);
  });

  it("returns 503 when stub socket is not connected", async () => {
    const stub = makeStub({ status: "online", socket_id: "sock-missing" });
    store.setStub(stub);
    // stubNs.sockets.get returns undefined for this socket id
    const stubNs = makeStubNsWithSocket("sock-different");
    const app = makeApp(stubNs);

    const res = await request(app).post(`/stubs/${stub.id}/exec2`).send({ command: "ls" });
    expect(res.status).toBe(503);
  });

  it("returns 400 when command is missing", async () => {
    const stub = makeStub({ status: "online", socket_id: "sock-1" });
    store.setStub(stub);
    const stubNs = makeStubNsWithSocket("sock-1");
    const app = makeApp(stubNs);

    const res = await request(app).post(`/stubs/${stub.id}/exec2`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/command required/i);
  });

  it("returns 400 when command is not a string", async () => {
    const stub = makeStub({ status: "online", socket_id: "sock-1" });
    store.setStub(stub);
    const stubNs = makeStubNsWithSocket("sock-1");
    const app = makeApp(stubNs);

    const res = await request(app).post(`/stubs/${stub.id}/exec2`).send({ command: 42 });
    expect(res.status).toBe(400);
  });

  it("returns exec result on success", async () => {
    const stub = makeStub({ status: "online", socket_id: "sock-1" });
    store.setStub(stub);
    const stubNs = makeStubNsWithSocket("sock-1", (_payload) => ({
      request_id: "exec_123",
      stdout: "file1\nfile2\n",
      stderr: "",
      exit_code: 0,
      truncated: false,
    }));
    const app = makeApp(stubNs);

    const res = await request(app)
      .post(`/stubs/${stub.id}/exec2`)
      .send({ command: "ls -la" });

    expect(res.status).toBe(200);
    expect(res.body.stdout).toBe("file1\nfile2\n");
    expect(res.body.stderr).toBe("");
    expect(res.body.exit_code).toBe(0);
    expect(res.body.truncated).toBe(false);
    // request_id should NOT be in response body
    expect(res.body.request_id).toBeUndefined();
  });

  it("returns 403 when stub rejects exec (exec_disabled)", async () => {
    const stub = makeStub({ status: "online", socket_id: "sock-1" });
    store.setStub(stub);
    const stubNs = makeStubNsWithSocket("sock-1", (_payload) => ({
      request_id: "exec_123",
      stdout: "",
      stderr: "",
      exit_code: -1,
      truncated: false,
      error: "exec_disabled",
    }));
    const app = makeApp(stubNs);

    const res = await request(app)
      .post(`/stubs/${stub.id}/exec2`)
      .send({ command: "ls" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/allow-exec/i);
  });

  it("returns truncated result when stub reports truncated=true", async () => {
    const stub = makeStub({ status: "online", socket_id: "sock-1" });
    store.setStub(stub);
    const stubNs = makeStubNsWithSocket("sock-1", (_payload) => ({
      request_id: "exec_123",
      stdout: "x".repeat(4096),
      stderr: "",
      exit_code: 0,
      truncated: true,
    }));
    const app = makeApp(stubNs);

    const res = await request(app)
      .post(`/stubs/${stub.id}/exec2`)
      .send({ command: "cat bigfile" });

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.stdout).toHaveLength(4096);
  });

  it("emits exec.request to the stub socket with correct payload", async () => {
    const stub = makeStub({ status: "online", socket_id: "sock-1" });
    store.setStub(stub);
    const stubNs = makeStubNsWithSocket("sock-1", (_payload) => ({
      request_id: "exec_123",
      stdout: "ok",
      stderr: "",
      exit_code: 0,
      truncated: false,
    }));
    const app = makeApp(stubNs);

    await request(app)
      .post(`/stubs/${stub.id}/exec2`)
      .send({ command: "nvidia-smi", timeout: 15000 });

    const socket = stubNs.sockets.get("sock-1");
    expect(socket.emit).toHaveBeenCalledWith(
      "exec.request",
      expect.objectContaining({ command: "nvidia-smi" }),
      expect.any(Function),
    );
  });

  it("timeout param is clamped to MAX_TIMEOUT_MS (60s)", async () => {
    const stub = makeStub({ status: "online", socket_id: "sock-1" });
    store.setStub(stub);
    const stubNs = makeStubNsWithSocket("sock-1", (_payload) => ({
      request_id: "exec_123",
      stdout: "",
      stderr: "",
      exit_code: 0,
      truncated: false,
    }));
    const app = makeApp(stubNs);

    await request(app)
      .post(`/stubs/${stub.id}/exec2`)
      .send({ command: "sleep 999", timeout: 999_000 });

    const socket = stubNs.sockets.get("sock-1");
    const emitCall = vi.mocked(socket.emit).mock.calls[0];
    const payload = emitCall[1] as any;
    // timeout_s should be clamped to 60
    expect(payload.timeout_s).toBeLessThanOrEqual(60);
  });

  it("returns 504 when stub times out (no ack received)", async () => {
    const stub = makeStub({ status: "online", socket_id: "sock-1" });
    store.setStub(stub);
    // Socket never calls the ack callback — simulates timeout
    const mockSocket = {
      id: "sock-1",
      connected: true,
      emit: vi.fn(), // never calls callback
    };
    const stubNs = {
      emit: vi.fn(),
      sockets: { get: (id: string) => (id === "sock-1" ? mockSocket : undefined) },
    } as any;
    const app = makeApp(stubNs);

    // Use minimum timeout (1000ms) so test doesn't hang; server adds 5s buffer
    // We fake timers to avoid waiting
    vi.useFakeTimers();
    const responsePromise = request(app)
      .post(`/stubs/${stub.id}/exec2`)
      .send({ command: "sleep 999", timeout: 1000 });

    // Advance timers past serverTimeoutMs (1000 + 5000 = 6000ms)
    await vi.advanceTimersByTimeAsync(7000);
    vi.useRealTimers();

    const res = await responsePromise;
    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/timed out/i);
  }, 10_000);

  it("non-zero exit_code is preserved in response", async () => {
    const stub = makeStub({ status: "online", socket_id: "sock-1" });
    store.setStub(stub);
    const stubNs = makeStubNsWithSocket("sock-1", (_payload) => ({
      request_id: "exec_123",
      stdout: "",
      stderr: "command not found\n",
      exit_code: 127,
      truncated: false,
    }));
    const app = makeApp(stubNs);

    const res = await request(app)
      .post(`/stubs/${stub.id}/exec2`)
      .send({ command: "nonexistent_cmd" });

    expect(res.status).toBe(200);
    expect(res.body.exit_code).toBe(127);
    expect(res.body.stderr).toBe("command not found\n");
  });
});
