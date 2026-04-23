/**
 * Backup/restore helpers for Alchemy state.
 * All functions are pure utilities operating on explicit file paths — no
 * singleton state — so they can be unit-tested without spinning up a server.
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";

export interface BackupMeta {
  filename: string;
  timestamp: number;
  size_bytes: number;
}

/** Parse the timestamp embedded in a backup filename (state_<ts>.json). */
function parseTimestamp(filename: string): number {
  const m = filename.match(/^state_(\d+)\.json$/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Copy the current state file into the backups directory.
 * Returns the backup filename (not full path).
 */
export async function backupState(stateFile: string, backupsDir: string): Promise<string> {
  await fsp.mkdir(backupsDir, { recursive: true });

  const timestamp = Date.now();
  const filename = `state_${timestamp}.json`;
  const dest = path.join(backupsDir, filename);

  await fsp.copyFile(stateFile, dest);
  return filename;
}

/**
 * List all backups in `backupsDir`, sorted newest first.
 */
export async function listBackups(backupsDir: string): Promise<BackupMeta[]> {
  try {
    const files = await fsp.readdir(backupsDir);
    const backupFiles = files.filter((f) => /^state_\d+\.json$/.test(f));

    const metas: BackupMeta[] = await Promise.all(
      backupFiles.map(async (f) => {
        const fullPath = path.join(backupsDir, f);
        const stat = await fsp.stat(fullPath);
        return {
          filename: f,
          timestamp: parseTimestamp(f),
          size_bytes: stat.size,
        };
      })
    );

    // Sort newest first
    metas.sort((a, b) => b.timestamp - a.timestamp);
    return metas;
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Read and parse a specific backup file.
 */
export async function restoreFromBackup(backupsDir: string, filename: string): Promise<any> {
  // Validate filename to prevent path traversal
  if (!filename || !/^state_\d+\.json$/.test(filename)) {
    throw new Error(`Invalid backup filename: ${filename}`);
  }
  const fullPath = path.join(backupsDir, filename);
  const raw = await fsp.readFile(fullPath, "utf-8");
  return JSON.parse(raw);
}

/**
 * Delete old backups, keeping only the `keepCount` most recent.
 */
export async function pruneBackups(backupsDir: string, keepCount: number): Promise<void> {
  const backups = await listBackups(backupsDir);
  const toDelete = backups.slice(keepCount); // already sorted newest-first
  await Promise.all(toDelete.map((b) => fsp.unlink(path.join(backupsDir, b.filename)).catch(() => {})));
}
