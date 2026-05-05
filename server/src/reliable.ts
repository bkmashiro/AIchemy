/**
 * reliable.ts — Reliable emit using socket.io native ack callbacks.
 *
 * Replaces the custom seq/ack/nack protocol with socket.io's built-in
 * callback acknowledgement. Each emit waits for the client's ack callback;
 * on timeout it retries up to MAX_RETRIES times.
 *
 * Stub→Server direction: stubs emit events directly (no wrapper),
 * server listens on named events. No receiver needed.
 */

import { Socket, Namespace } from "socket.io";
import { logger } from "./log";

const ACK_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 3_000;

// ─── Per-stub socket registry ────────────────────────────────────────────────

const stubSockets: Map<string, Socket> = new Map();
// Generation counter per stub — incremented on each new socket registration.
// Reliable emit aborts retries when the generation changes (reconnect happened).
const stubGeneration: Map<string, number> = new Map();

export function registerStubSocket(stubId: string, socket: Socket): void {
  stubSockets.set(stubId, socket);
  stubGeneration.set(stubId, (stubGeneration.get(stubId) ?? 0) + 1);
}

export function unregisterStubSocket(stubId: string, socketId?: string): void {
  if (socketId) {
    // Only delete if the current entry matches — prevents delayed disconnect from killing new socket
    const current = stubSockets.get(stubId);
    if (current && current.id === socketId) {
      stubSockets.delete(stubId);
    }
  } else {
    stubSockets.delete(stubId);
  }
}

export function getStubSocket(stubId: string): Socket | undefined {
  return stubSockets.get(stubId);
}

// ─── Reliable emit with native ack ───────────────────────────────────────────

function emitWithAck(socket: Socket, event: string, payload: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`ack timeout for ${event}`));
    }, ACK_TIMEOUT_MS);

    socket.emit(event, payload, (response: any) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

/**
 * Emit a reliable message to a stub. Retries on ack timeout.
 * Fire-and-forget from the caller's perspective (logs failures).
 */
export async function reliableEmitToStub(stubId: string, event: string, payload: any): Promise<void> {
  const socket = stubSockets.get(stubId);
  if (!socket || !socket.connected) {
    logger.warn("reliable.no_socket", { stubId, event });
    return;
  }

  // Bug 2 fix: Capture the generation at send time. If the stub reconnects
  // (generation increments), abort retries — the reconnected stub will
  // re-report its state, so replaying stale messages would cause a storm.
  const startGen = stubGeneration.get(stubId) ?? 0;

  let currentSocket = socket;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await emitWithAck(currentSocket, event, payload);
      return; // ack received
    } catch (err) {
      // Abort if stub reconnected since we started
      if ((stubGeneration.get(stubId) ?? 0) !== startGen) {
        logger.info("reliable.abort_stale", { stubId, event, attempt, reason: "stub_reconnected" });
        return;
      }
      if (attempt < MAX_RETRIES) {
        logger.info("reliable.retry", { stubId, event, attempt: attempt + 1 });
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        // Re-fetch socket — stub may have reconnected with a new socket
        const freshSocket = stubSockets.get(stubId);
        if (!freshSocket || !freshSocket.connected) {
          logger.warn("reliable.socket_gone", { stubId, event, attempt: attempt + 1 });
          return;
        }
        // Check generation again after delay
        if ((stubGeneration.get(stubId) ?? 0) !== startGen) {
          logger.info("reliable.abort_stale", { stubId, event, attempt: attempt + 1, reason: "stub_reconnected" });
          return;
        }
        currentSocket = freshSocket;
      } else {
        logger.error("reliable.gave_up", { stubId, event, attempts: MAX_RETRIES });
      }
    }
  }
}

// ─── Legacy exports (for migration — these are now no-ops) ───────────────────

/** @deprecated Use registerStubSocket instead */
export function getOrCreateEmitter(stubId: string, socket: Socket): { onResume: (seq: number) => void; emit: (event: string, payload: any) => number } {
  registerStubSocket(stubId, socket);
  return {
    onResume: (_seq: number) => { /* no-op: native ack doesn't need seq replay */ },
    emit: (event: string, payload: any) => {
      reliableEmitToStub(stubId, event, payload);
      return 0;
    },
  };
}

/** @deprecated Use unregisterStubSocket instead */
export function destroyEmitter(stubId: string): void {
  unregisterStubSocket(stubId);
}

/** @deprecated No longer needed */
export function getEmitter(stubId: string): any {
  return stubSockets.has(stubId) ? { onAck: () => {} } : undefined;
}
