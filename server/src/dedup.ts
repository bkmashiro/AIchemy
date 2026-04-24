/**
 * dedup.ts — Task fingerprint calculation and write lock table.
 *
 * Fingerprint: sha256(script + args + param_overrides + cwd)[:16]
 * Write lock table: Map<normalized_path, task_id> for run_dir conflict detection.
 */

import { createHash } from "crypto";
import path from "path";
import { Task, TaskStatus } from "./types";

// ─── Fingerprint ─────────────────────────────────────────────────────────────

function sortKeys(obj: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.keys(obj)
      .sort()
      .map((k) => [k, obj[k]])
  );
}

export interface FingerprintInput {
  script: string;
  args?: Record<string, string>;
  raw_args?: string;
  param_overrides?: Record<string, any>;
  cwd?: string;
}

export function computeFingerprint(input: FingerprintInput): string {
  const parts = [
    input.script,
    JSON.stringify(sortKeys(input.args || {})),
    input.raw_args || "",
    JSON.stringify(sortKeys(input.param_overrides || {})),
    input.cwd || "",
  ];
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

// ─── Active statuses for dedup check ─────────────────────────────────────────

const ACTIVE_STATUSES: TaskStatus[] = ["pending", "queued", "dispatched", "running", "paused"];

export function isActiveStatus(status: TaskStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

// ─── Write Lock Table ─────────────────────────────────────────────────────────

/**
 * Normalize a path for write lock comparison.
 * Resolves .., removes trailing slash, lowercases on case-insensitive filesystems.
 */
export function normalizeLockPath(p: string): string {
  // Resolve relative to root to normalize .. etc, but keep as-is if absolute
  const normalized = path.normalize(p).replace(/\/$/, "");
  return normalized;
}

/**
 * Check if two paths conflict (one is prefix of the other or they are equal).
 */
export function pathsConflict(a: string, b: string): boolean {
  const na = normalizeLockPath(a);
  const nb = normalizeLockPath(b);
  if (na === nb) return true;
  // Prefix match: a/sub conflicts with a
  const sep = path.sep;
  return na.startsWith(nb + sep) || nb.startsWith(na + sep);
}

class WriteLockTable {
  private table: Map<string, string> = new Map(); // normalized_path → task_id

  /**
   * Try to acquire a write lock for the given path.
   * Returns null on success, or the conflicting task_id on failure.
   */
  acquire(runDir: string, taskId: string): string | null {
    const norm = normalizeLockPath(runDir);
    // Check for exact match or prefix conflict
    for (const [lockedPath, lockedTaskId] of this.table) {
      if (pathsConflict(norm, lockedPath)) {
        return lockedTaskId;
      }
    }
    this.table.set(norm, taskId);
    return null;
  }

  release(runDir: string): void {
    const norm = normalizeLockPath(runDir);
    this.table.delete(norm);
  }

  has(runDir: string): boolean {
    const norm = normalizeLockPath(runDir);
    for (const lockedPath of this.table.keys()) {
      if (pathsConflict(norm, lockedPath)) return true;
    }
    return false;
  }

  getTaskId(runDir: string): string | undefined {
    const norm = normalizeLockPath(runDir);
    for (const [lockedPath, taskId] of this.table) {
      if (pathsConflict(norm, lockedPath)) return taskId;
    }
    return undefined;
  }

  /**
   * Rebuild the write lock table from the current set of running/dispatched tasks.
   * Called after server restart when stubs resume.
   */
  rebuild(tasks: Task[]): void {
    this.table.clear();
    for (const task of tasks) {
      if (task.run_dir && isActiveStatus(task.status)) {
        this.table.set(normalizeLockPath(task.run_dir), task.id);
      }
    }
  }

  clear(): void {
    this.table.clear();
  }

  getAll(): Map<string, string> {
    return new Map(this.table);
  }
}

export const writeLockTable = new WriteLockTable();

// ─── Idempotency Key Cache ────────────────────────────────────────────────────

interface IdempotencyEntry {
  task_id: string;
  created_at: number;
}

class IdempotencyCache {
  private cache: Map<string, IdempotencyEntry> = new Map();
  private readonly TTL_MS = 60_000;

  set(key: string, taskId: string): void {
    this.cache.set(key, { task_id: taskId, created_at: Date.now() });
  }

  get(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.created_at > this.TTL_MS) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.task_id;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.created_at > this.TTL_MS) {
        this.cache.delete(key);
      }
    }
  }
}

export const idempotencyCache = new IdempotencyCache();

// Periodic cleanup of expired idempotency keys
setInterval(() => idempotencyCache.cleanup(), 60_000);
