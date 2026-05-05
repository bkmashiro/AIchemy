/**
 * tunnel.ts — Cloudflare tunnel subprocess manager.
 *
 * Manages a `cloudflared tunnel run --token <token>` subprocess.
 * Supports exponential backoff restart on failure (3s→6s→12s→24s→48s→60s cap).
 * Backoff resets after 60s of successful running.
 */

import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import { logger } from "./log";

export interface TunnelConfig {
  enabled: boolean;
  token: string;
  cloudflared: string;        // path to cloudflared binary
  restart_on_failure: boolean;
}

export interface TunnelManager {
  start(): void;
  stop(): Promise<void>;
  status(): { running: boolean; pid?: number; restarts: number; started_at?: string };
}

const BACKOFF_STEPS_MS = [3_000, 6_000, 12_000, 24_000, 48_000, 60_000];
const BACKOFF_RESET_AFTER_MS = 60_000;

export function createTunnelManager(config: TunnelConfig): TunnelManager {
  let proc: ChildProcess | null = null;
  let restarts = 0;
  let startedAt: string | undefined;
  let shuttingDown = false;
  let backoffStep = 0;
  let uptimeTimer: ReturnType<typeof setTimeout> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  function clearUptimeTimer(): void {
    if (uptimeTimer !== null) {
      clearTimeout(uptimeTimer);
      uptimeTimer = null;
    }
  }

  function spawnProc(): void {
    if (shuttingDown) return;

    proc = spawn(config.cloudflared, ["tunnel", "run", "--token", config.token], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    startedAt = new Date().toISOString();
    logger.info("tunnel.started", { pid: proc.pid, restarts });

    // Schedule backoff reset if process stays alive long enough
    clearUptimeTimer();
    uptimeTimer = setTimeout(() => {
      backoffStep = 0;
    }, BACKOFF_RESET_AFTER_MS);

    // Stream stdout line by line
    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => {
        logger.info("tunnel.stdout", { line });
      });
    }

    // Stream stderr line by line
    if (proc.stderr) {
      const rl = createInterface({ input: proc.stderr, crlfDelay: Infinity });
      rl.on("line", (line) => {
        logger.error("tunnel.stderr", { line });
      });
    }

    proc.on("exit", (code, signal) => {
      clearUptimeTimer();
      const wasProc = proc;
      proc = null;
      startedAt = undefined;

      logger.info("tunnel.exit", { code, signal, shuttingDown });

      if (shuttingDown) return;
      if (!config.restart_on_failure) return;

      // Exponential backoff restart
      const delay = BACKOFF_STEPS_MS[Math.min(backoffStep, BACKOFF_STEPS_MS.length - 1)];
      backoffStep = Math.min(backoffStep + 1, BACKOFF_STEPS_MS.length - 1);
      restarts += 1;

      logger.info("tunnel.restart_scheduled", { delay_ms: delay, restarts });
      restartTimer = setTimeout(() => {
        restartTimer = null;
        spawnProc();
      }, delay);
    });
  }

  return {
    start(): void {
      if (!config.enabled) {
        logger.info("tunnel.disabled");
        return;
      }
      if (proc !== null) {
        logger.info("tunnel.already_running", { pid: proc.pid });
        return;
      }
      shuttingDown = false;
      spawnProc();
    },

    stop(): Promise<void> {
      shuttingDown = true;

      // Cancel any pending restart
      if (restartTimer !== null) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      clearUptimeTimer();

      if (proc === null) return Promise.resolve();

      return new Promise((resolve) => {
        const target = proc!;

        const done = (): void => {
          proc = null;
          startedAt = undefined;
          resolve();
        };

        // Wait for exit or force-kill after 5s
        const killTimer = setTimeout(() => {
          logger.info("tunnel.sigkill", { pid: target.pid });
          target.kill("SIGKILL");
        }, 5_000);

        target.once("exit", () => {
          clearTimeout(killTimer);
          done();
        });

        logger.info("tunnel.sigterm", { pid: target.pid });
        target.kill("SIGTERM");
      });
    },

    status(): { running: boolean; pid?: number; restarts: number; started_at?: string } {
      const running = proc !== null && proc.exitCode === null;
      return {
        running,
        pid: running ? proc!.pid : undefined,
        restarts,
        started_at: startedAt,
      };
    },
  };
}
