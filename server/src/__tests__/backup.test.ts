import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { gunzip, gzip } from "zlib";
import { describe, expect, it } from "vitest";

import { backupState, listBackups, pruneBackups, restoreFromBackup, writeStateBackup } from "../store/backup";

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "alchemy-backup-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("backup helpers", () => {
  it("writes compressed state backups and restores them", async () => {
    await withTempDir(async (dir) => {
      const state = { tasks: [{ id: "task-1", status: "running" }], seq_counter: 7 };
      const filename = await writeStateBackup(dir, state);

      expect(filename).toMatch(/^state_\d+\.json\.gz$/);
      const compressed = await readFile(path.join(dir, filename));
      expect(compressed.length).toBeLessThan(Buffer.byteLength(JSON.stringify(state, null, 2)));
      expect(JSON.parse((await gunzipAsync(compressed)).toString("utf-8"))).toEqual(state);
      await expect(restoreFromBackup(dir, filename)).resolves.toEqual(state);
    });
  });

  it("compresses existing state files via backupState", async () => {
    await withTempDir(async (dir) => {
      const statePath = path.join(dir, "state.json");
      await writeFile(statePath, JSON.stringify({ ok: true }, null, 2));
      const backupsDir = path.join(dir, "backups");

      const filename = await backupState(statePath, backupsDir);

      expect(filename).toMatch(/^state_\d+\.json\.gz$/);
      await expect(restoreFromBackup(backupsDir, filename)).resolves.toEqual({ ok: true });
    });
  });

  it("lists, restores, and prunes legacy .json and new .json.gz backups together", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "state_1000.json"), JSON.stringify({ n: 1 }));
      await writeFile(path.join(dir, "state_2000.json.gz"), await gzipAsync(Buffer.from(JSON.stringify({ n: 2 }))));
      await writeFile(path.join(dir, "state_3000.json.gz"), await gzipAsync(Buffer.from(JSON.stringify({ n: 3 }))));
      await writeFile(path.join(dir, "not-a-backup.json"), "{}");

      expect((await listBackups(dir)).map((b) => b.filename)).toEqual([
        "state_3000.json.gz",
        "state_2000.json.gz",
        "state_1000.json",
      ]);
      await expect(restoreFromBackup(dir, "state_1000.json")).resolves.toEqual({ n: 1 });
      await expect(restoreFromBackup(dir, "state_2000.json.gz")).resolves.toEqual({ n: 2 });

      await pruneBackups(dir, 2);

      expect((await readdir(dir)).sort()).toEqual([
        "not-a-backup.json",
        "state_2000.json.gz",
        "state_3000.json.gz",
      ]);
    });
  });

  it("rejects path traversal restore filenames", async () => {
    await withTempDir(async (dir) => {
      await expect(restoreFromBackup(dir, "../state_1.json.gz")).rejects.toThrow("Invalid backup filename");
    });
  });
});
