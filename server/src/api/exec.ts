/**
 * api/exec.ts — Stub remote exec via WebSocket (Spec 3).
 *
 * Mounted at /api/stubs/:id/exec2 (see stubs.ts)
 *   POST /  Body: { command: string, timeout?: number }  (timeout in ms, default 30s, max 60s)
 *   Response: { stdout, stderr, exit_code, truncated }
 *
 * Server emits exec.request to the target stub's socket and waits for an
 * exec.response ack. The stub must have been started with --allow-exec or
 * the request is rejected with 403.
 *
 * Error codes:
 *   400 — bad request (missing/invalid command)
 *   403 — stub rejected exec (--allow-exec not set)
 *   503 — stub offline
 *   504 — exec timed out
 */

import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { Namespace } from "socket.io";
import { store } from "../store";
import { logger } from "../log";
import { ExecRequestPayload, ExecResponsePayload } from "../types";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;

function parseExecAckResponse(args: any[], fallbackRequestId: string): ExecResponsePayload {
  const candidateResponse = args
    .map((arg) => {
      if (arg == null) {
        return undefined;
      }
      if (typeof arg === "string") {
        try {
          const parsed = JSON.parse(arg);
          return typeof parsed === "object" && parsed !== null ? parsed : undefined;
        } catch {
          return undefined;
        }
      }
      if (typeof arg === "object" && !Array.isArray(arg) && Object.getPrototypeOf(arg) === Object.prototype) {
        return arg;
      }
      return undefined;
    })
    .find((value) => {
      if (!value) {
        return false;
      }
      return (
        typeof (value as any).stdout === "string" ||
        typeof (value as any).stderr === "string" ||
        typeof (value as any).exit_code !== "undefined" ||
        typeof (value as any).request_id === "string" ||
        typeof (value as any).truncated === "boolean" ||
        typeof (value as any).error === "string"
      );
    }) as Record<string, any> | undefined;

  if (!candidateResponse) {
    throw new Error("invalid stub ack payload");
  }

  const exitCode = Number((candidateResponse as any).exit_code);
  return {
    request_id:
      typeof (candidateResponse as any).request_id === "string" &&
      (candidateResponse as any).request_id.length > 0
        ? String((candidateResponse as any).request_id)
        : fallbackRequestId,
    stdout: typeof (candidateResponse as any).stdout === "string" ? String((candidateResponse as any).stdout) : "",
    stderr: typeof (candidateResponse as any).stderr === "string" ? String((candidateResponse as any).stderr) : "",
    exit_code: Number.isFinite(exitCode) ? exitCode : -1,
    truncated: typeof (candidateResponse as any).truncated === "boolean" ? Boolean((candidateResponse as any).truncated) : false,
    ...(typeof (candidateResponse as any).error === "string" ? { error: String((candidateResponse as any).error) } : {}),
  };
}

export function createExecRouter(stubNs: Namespace): Router {
  const router = Router({ mergeParams: true });

  // POST /api/stubs/:id/exec2
  router.post("/", async (req: Request, res: Response) => {
    const stubId = req.params.id;
    const stub = store.getStub(stubId);

    if (!stub) {
      res.status(404).json({ error: "Stub not found" });
      return;
    }

    if (stub.status !== "online" || !stub.socket_id) {
      res.status(503).json({ error: "Stub offline" });
      return;
    }

    const { command, timeout } = req.body;

    if (!command || typeof command !== "string") {
      res.status(400).json({ error: "command required" });
      return;
    }

    // Parse and clamp timeout: body is in ms
    const timeoutMs = Math.min(
      Math.max(Number.isFinite(Number(timeout)) ? Number(timeout) : DEFAULT_TIMEOUT_MS, 1000),
      MAX_TIMEOUT_MS,
    );
    const timeoutS = Math.ceil(timeoutMs / 1000);

    const socket = stubNs.sockets.get(stub.socket_id);
    if (!socket || !socket.connected) {
      res.status(503).json({ error: "Stub socket not connected" });
      return;
    }

    const requestId = `exec_${stubId}_${uuidv4().slice(0, 8)}`;
    const payload: ExecRequestPayload = {
      request_id: requestId,
      command,
      timeout_s: timeoutS,
    };

    logger.info("exec.request", { stub: stub.name, stub_id: stubId, request_id: requestId, command: command.slice(0, 200) });

    // Add a small buffer on top of stub timeout to let the stub respond before we time out
    const serverTimeoutMs = timeoutMs + 5_000;

    try {
      const result = await new Promise<ExecResponsePayload>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("timeout"));
        }, serverTimeoutMs);

        socket.emit("exec.request", payload, (...ackArgs: any[]) => {
          clearTimeout(timer);
          try {
            const response = parseExecAckResponse(ackArgs, requestId);
            resolve(response);
          } catch (err) {
            reject(err);
          }
        });
      });

      // Stub rejected exec (--allow-exec not set)
      if (result.error === "exec_disabled") {
        logger.warn("exec.rejected", { stub: stub.name, request_id: requestId, reason: "exec_disabled" });
        res.status(403).json({ error: "Exec disabled on this stub (start with --allow-exec)" });
        return;
      }

      logger.info("exec.response", {
        stub: stub.name,
        request_id: requestId,
        exit_code: result.exit_code,
        truncated: result.truncated,
      });

      const { request_id: _rid, error: _err, ...body } = result;
      res.json(body);
    } catch (err: any) {
      if (err.message === "timeout") {
        logger.warn("exec.timeout", { stub: stub.name, request_id: requestId, timeout_ms: serverTimeoutMs });
        res.status(504).json({ error: "Exec timed out" });
      } else if (String(err.message).toLowerCase().includes("invalid stub ack payload")) {
        logger.warn("exec.invalid_ack", {
          stub: stub.name,
          request_id: requestId,
          error: String(err),
          ack_error: true,
        });
        res.status(500).json({ error: "Invalid stub ack payload" });
      } else {
        logger.error("exec.error", { stub: stub.name, request_id: requestId, error: String(err) });
        res.status(500).json({ error: "Internal error" });
      }
    }
  });

  return router;
}
