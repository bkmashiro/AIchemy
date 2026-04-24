/**
 * socket/web.ts — Web (dashboard) socket.io namespace.
 *
 * Sends snapshot on connect, then incremental updates via events.
 */

import { Namespace, Socket } from "socket.io";
import { store } from "../store";
import { logger } from "../log";
import { reliableEmitToStub } from "../reliable";

export function setupWebNamespace(ns: Namespace): void {
  ns.on("connection", (socket: Socket) => {
    logger.info("web.connect", { socket_id: socket.id });

    // Send full state snapshot on connect
    const stubs = store.getAllStubs().map(sanitizeStub);
    socket.emit("stubs.snapshot", stubs);

    // ─── Shell relay: web → stub ──────────────────────────────────────────
    socket.on("shell.exec", ({ stub_id, command, timeout }: { stub_id: string; command: string; timeout?: number }) => {
      if (!stub_id || !command) return;
      const stub = store.getStub(stub_id);
      if (!stub || stub.status !== "online") {
        socket.emit("shell.done", { request_id: `${socket.id}_err`, exit_code: -1, error: "Stub offline" });
        return;
      }
      const requestId = `${socket.id}_${Date.now()}`;
      reliableEmitToStub(stub_id, "shell.exec", {
        request_id: requestId,
        command,
        timeout: timeout ?? 30,
      });
      // Echo back the request_id so client knows which request this is
      socket.emit("shell.request_id", { request_id: requestId, stub_id });
    });

    socket.on("disconnect", () => {
      logger.info("web.disconnect", { socket_id: socket.id });
    });
  });
}

function sanitizeStub(stub: import("../types").Stub) {
  const { socket_id, ...rest } = stub;
  return rest;
}
