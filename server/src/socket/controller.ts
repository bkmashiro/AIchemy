/**
 * socket/controller.ts — Controller socket.io namespace handler.
 *
 * The controller daemon runs on the SLURM login node and connects here.
 * It acts as a SLURM proxy: receives commands from the server and executes
 * sbatch / scancel / squeue / sinfo on the cluster.
 *
 * Namespace: /controller
 */

import { Namespace, Socket } from "socket.io";
import { logger } from "../log";

// ─── In-memory state ─────────────────────────────────────────────────────────

interface ControllerInfo {
  socket_id: string;
  hostname: string;
  users: string[];
  capabilities: string[];
  connected_at: string;
}

let _controllerInfo: ControllerInfo | null = null;
let _controllerSocket: Socket | null = null;
let _clusterStatus: any = null;

export function getClusterStatus(): any {
  return _clusterStatus;
}

export function getControllerInfo(): ControllerInfo | null {
  return _controllerInfo;
}

/** Emit a command to the controller and wait for ack (Promise). */
export function emitToController(event: string, payload: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!_controllerSocket || !_controllerSocket.connected) {
      reject(new Error("Controller not connected"));
      return;
    }
    const timeout = setTimeout(() => {
      reject(new Error("Controller ack timeout"));
    }, 30_000);

    _controllerSocket.emit(event, payload, (response: any) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

// ─── Setup ───────────────────────────────────────────────────────────────────

export function setupControllerNamespace(ns: Namespace, webNs: Namespace): void {
  ns.on("connection", (socket: Socket) => {
    logger.info("controller.connect", { socket_id: socket.id });

    // ─── controller.register ──────────────────────────────────────────
    socket.on("controller.register", (payload: any, ack?: Function) => {
      const { hostname, users, capabilities, token } = payload || {};

      // Basic auth check via token field (same token store as stubs)
      // Token validation is done at connection time via middleware if needed;
      // here we just log and record the controller.
      logger.info("controller.register", { hostname, users, capabilities });

      _controllerInfo = {
        socket_id: socket.id,
        hostname: hostname || "unknown",
        users: users || [],
        capabilities: capabilities || [],
        connected_at: new Date().toISOString(),
      };
      _controllerSocket = socket;

      // Notify web clients that controller is online
      webNs.emit("controller.online", {
        hostname: _controllerInfo.hostname,
        users: _controllerInfo.users,
        capabilities: _controllerInfo.capabilities,
        connected_at: _controllerInfo.connected_at,
      });

      if (ack) ack({ ok: true, message: "registered" });
    });

    // ─── cluster.status ───────────────────────────────────────────────
    socket.on("cluster.status", (payload: any) => {
      _clusterStatus = payload;
      logger.info("cluster.status", {
        partitions: payload?.partitions?.length ?? 0,
        jobs: payload?.jobs?.length ?? 0,
      });
      // Forward to web clients
      webNs.emit("cluster.status", payload);
    });

    // ─── Disconnect ───────────────────────────────────────────────────
    socket.on("disconnect", () => {
      logger.info("controller.disconnect", { socket_id: socket.id });
      if (_controllerSocket?.id === socket.id) {
        _controllerSocket = null;
        _controllerInfo = null;
        webNs.emit("controller.offline", {});
      }
    });
  });
}
