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

export function registerStubSocket(stubId: string, socket: Socket): void {
  stubSockets.set(stubId, socket);
}

export function unregisterStubSocket(stubId: string): void {
  stubSockets.delete(stubId);
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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await emitWithAck(socket, event, payload);
      return; // ack received
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        logger.info("reliable.retry", { stubId, event, attempt: attempt + 1 });
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        // Re-check socket is still valid
        const current = stubSockets.get(stubId);
        if (!current || !current.connected) {
          logger.warn("reliable.socket_gone", { stubId, event, attempt: attempt + 1 });
          return;
        }
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
