import { Namespace, Socket } from "socket.io";
import { store } from "../store";

export function setupWebNamespace(ns: Namespace): void {
  ns.on("connection", (socket: Socket) => {
    console.log(`[web] Dashboard connected: ${socket.id}`);

    // Send full state on connect
    const stubs = store.getAllStubs().map(sanitizeStub);
    socket.emit("stubs.update", stubs);

    socket.on("disconnect", () => {
      console.log(`[web] Dashboard disconnected: ${socket.id}`);
    });
  });
}

function sanitizeStub(stub: import("../types").Stub) {
  const { socket_id, ...rest } = stub;
  return rest;
}
