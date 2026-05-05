/**
 * reliable.test.ts — Unit tests for reliable.ts
 *
 * Covers: socket registration/unregistration, stale socket guard,
 * retry logic (ack timeout → retry → fresh socket re-fetch → give-up).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock logger ───────────────────────────────────────────────────────────────
vi.mock("../src/log", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from "../src/log";
import {
  registerStubSocket,
  unregisterStubSocket,
  getStubSocket,
  reliableEmitToStub,
} from "../src/reliable";

// ─── Socket factory ────────────────────────────────────────────────────────────

function makeSocket(id: string, connected = true) {
  const emitFn = vi.fn();
  return {
    id,
    connected,
    emit: emitFn,
  } as any;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("registerStubSocket / unregisterStubSocket / getStubSocket", () => {
  beforeEach(() => {
    // Clean up any leftover registrations between tests by re-importing is
    // impractical with vitest module caching; instead always use unique stub IDs.
  });

  it("registers and retrieves a socket", () => {
    const sock = makeSocket("s1");
    registerStubSocket("stub-reg-1", sock);
    expect(getStubSocket("stub-reg-1")).toBe(sock);
  });

  it("unregisterStubSocket without socketId removes entry unconditionally", () => {
    const sock = makeSocket("s2");
    registerStubSocket("stub-reg-2", sock);
    unregisterStubSocket("stub-reg-2");
    expect(getStubSocket("stub-reg-2")).toBeUndefined();
  });

  it("unregisterStubSocket with matching socketId removes entry", () => {
    const sock = makeSocket("s3");
    registerStubSocket("stub-reg-3", sock);
    unregisterStubSocket("stub-reg-3", "s3");
    expect(getStubSocket("stub-reg-3")).toBeUndefined();
  });

  it("unregisterStubSocket with NON-matching socketId does NOT remove entry (prevents race)", () => {
    const sock = makeSocket("s4-new");
    registerStubSocket("stub-reg-4", sock);
    // Simulate a delayed disconnect from the OLD socket
    unregisterStubSocket("stub-reg-4", "s4-old");
    expect(getStubSocket("stub-reg-4")).toBe(sock); // new socket stays
  });

  it("re-registering with a new socket overwrites the old one", () => {
    const sockA = makeSocket("sA");
    const sockB = makeSocket("sB");
    registerStubSocket("stub-reg-5", sockA);
    registerStubSocket("stub-reg-5", sockB);
    expect(getStubSocket("stub-reg-5")).toBe(sockB);
  });
});

describe("reliableEmitToStub", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns early (no emit) when no socket is registered", async () => {
    await reliableEmitToStub("stub-no-sock", "test.event", {});
    expect(logger.warn).toHaveBeenCalledWith(
      "reliable.no_socket",
      expect.objectContaining({ stubId: "stub-no-sock", event: "test.event" })
    );
  });

  it("returns early when socket is disconnected", async () => {
    const sock = makeSocket("disc", false /* connected=false */);
    registerStubSocket("stub-disc", sock);
    await reliableEmitToStub("stub-disc", "test.event", {});
    expect(logger.warn).toHaveBeenCalledWith("reliable.no_socket", expect.anything());
    expect(sock.emit).not.toHaveBeenCalled();
  });

  it("succeeds when socket acks immediately", async () => {
    const sock = makeSocket("ack-ok");
    // socket.emit(event, payload, callback) — call callback with { ok: true }
    sock.emit.mockImplementation((_event: string, _payload: any, cb: Function) => {
      cb({ ok: true });
    });
    registerStubSocket("stub-ack-ok", sock);

    const promise = reliableEmitToStub("stub-ack-ok", "resume_response", { data: 1 });
    // Flush microtasks (the ack callback is called synchronously in the mock)
    await promise;

    expect(sock.emit).toHaveBeenCalledTimes(1);
    expect(sock.emit).toHaveBeenCalledWith("resume_response", { data: 1 }, expect.any(Function));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("retries on ack timeout and succeeds on second attempt", async () => {
    const sock = makeSocket("retry-ok");
    let callCount = 0;
    sock.emit.mockImplementation((_event: string, _payload: any, cb: Function) => {
      callCount++;
      if (callCount === 1) {
        // First call: never invoke cb → will timeout
        // (don't call cb — timer fires after ACK_TIMEOUT_MS)
      } else {
        // Second call: ack immediately
        cb({ ok: true });
      }
    });
    registerStubSocket("stub-retry-ok", sock);

    const promise = reliableEmitToStub("stub-retry-ok", "task.kill", { task_id: "t1" });

    // Advance past ACK_TIMEOUT_MS (10 000ms) to trigger first timeout
    await vi.advanceTimersByTimeAsync(10_001);
    // Advance past RETRY_DELAY_MS (3 000ms)
    await vi.advanceTimersByTimeAsync(3_001);

    await promise;

    expect(sock.emit).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      "reliable.retry",
      expect.objectContaining({ event: "task.kill", attempt: 1 })
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs reliable.socket_gone when socket disappears during retry delay", async () => {
    const sock = makeSocket("gone");
    // First emit: never ack
    sock.emit.mockImplementation(() => {});
    registerStubSocket("stub-gone", sock);

    const promise = reliableEmitToStub("stub-gone", "task.kill", { task_id: "t2" });

    // Advance past ACK_TIMEOUT_MS
    await vi.advanceTimersByTimeAsync(10_001);

    // Socket disappears during retry delay
    unregisterStubSocket("stub-gone");

    // Advance past RETRY_DELAY_MS
    await vi.advanceTimersByTimeAsync(3_001);

    await promise;

    expect(logger.warn).toHaveBeenCalledWith(
      "reliable.socket_gone",
      expect.objectContaining({ stubId: "stub-gone", event: "task.kill" })
    );
  });

  it("gives up after MAX_RETRIES and logs reliable.gave_up", async () => {
    const MAX_RETRIES = 10;
    const ACK_TIMEOUT_MS = 10_000;
    const RETRY_DELAY_MS = 3_000;

    const sock = makeSocket("giveup");
    // Never ack
    sock.emit.mockImplementation(() => {});
    registerStubSocket("stub-giveup", sock);

    const promise = reliableEmitToStub("stub-giveup", "resume_response", {});

    // Exhaust all retries: (MAX_RETRIES + 1) attempts, each timing out
    for (let i = 0; i <= MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1);
      if (i < MAX_RETRIES) {
        await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 1);
      }
    }

    await promise;

    expect(logger.error).toHaveBeenCalledWith(
      "reliable.gave_up",
      expect.objectContaining({ stubId: "stub-giveup", event: "resume_response" })
    );
    expect(sock.emit).toHaveBeenCalledTimes(MAX_RETRIES + 1);
  });

  it("aborts retry when stub reconnects mid-retry (generation change)", async () => {
    const ACK_TIMEOUT_MS = 10_000;
    const RETRY_DELAY_MS = 3_000;

    const oldSock = makeSocket("old-reconnect");
    // Old socket never acks
    oldSock.emit.mockImplementation(() => {});
    registerStubSocket("stub-reconnect", oldSock);

    const promise = reliableEmitToStub("stub-reconnect", "task.kill", { task_id: "t3" });

    // First attempt times out
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1);

    // During the retry delay, stub reconnects with a new socket (bumps generation)
    const newSock = makeSocket("new-reconnect");
    newSock.emit.mockImplementation((_event: string, _payload: any, cb: Function) => {
      cb({ ok: true });
    });
    registerStubSocket("stub-reconnect", newSock);

    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 1);

    await promise;

    // Retry loop should abort — not re-send on the new socket
    // (reconnected stub re-reports its state, so stale messages are dropped)
    expect(newSock.emit).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
