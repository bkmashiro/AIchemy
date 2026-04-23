import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { backupState, listBackups, restoreFromBackup, pruneBackups } from "../store/backup";

// Helper: set up a temp dir and override STATE_FILE env var
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "alchemy-backup-test-"));
}

// ─── Backup / restore unit-style tests ───────────────────────────────────────

describe("Store backup/restore", () => {
  let tmpDir: string;
  let stateFile: string;
  let backupsDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateFile = path.join(tmpDir, "state.json");
    backupsDir = path.join(tmpDir, "backups");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("backup() creates a file in backups/", async () => {
    // Write a minimal state to the state file
    fs.writeFileSync(stateFile, JSON.stringify({ stubs: [], tokens: [] }));

    const { backupState } = await import("../store/backup");
    const filename = await backupState(stateFile, backupsDir);

    expect(filename).toMatch(/^state_\d+\.json$/);
    const fullPath = path.join(backupsDir, filename);
    expect(fs.existsSync(fullPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    expect(content.stubs).toBeDefined();
  });

  it("listBackups() returns metadata sorted newest first", async () => {
    fs.mkdirSync(backupsDir, { recursive: true });
    // Create some fake backup files
    const names = ["state_1000.json", "state_3000.json", "state_2000.json"];
    for (const n of names) {
      fs.writeFileSync(path.join(backupsDir, n), JSON.stringify({ stubs: [] }));
    }

    const { listBackups } = await import("../store/backup");
    const list = await listBackups(backupsDir);

    expect(list).toHaveLength(3);
    // Should be sorted by timestamp descending (filename encodes timestamp)
    expect(list[0].filename).toBe("state_3000.json");
    expect(list[1].filename).toBe("state_2000.json");
    expect(list[2].filename).toBe("state_1000.json");
    expect(list[0].size_bytes).toBeGreaterThan(0);
    expect(list[0].timestamp).toBeTypeOf("number");
  });

  it("listBackups() returns empty array when dir doesn't exist", async () => {
    const { listBackups } = await import("../store/backup");
    const list = await listBackups(path.join(tmpDir, "nonexistent"));
    expect(list).toEqual([]);
  });

  it("restoreFromBackup() reads the correct backup and returns parsed state", async () => {
    fs.mkdirSync(backupsDir, { recursive: true });
    const backupFile = "state_9999.json";
    const content = { stubs: [{ id: "restored-stub" }], tokens: [] };
    fs.writeFileSync(path.join(backupsDir, backupFile), JSON.stringify(content));

    const { restoreFromBackup } = await import("../store/backup");
    const state = await restoreFromBackup(backupsDir, backupFile);
    expect(state.stubs[0].id).toBe("restored-stub");
  });

  it("restoreFromBackup() throws for nonexistent file", async () => {
    const { restoreFromBackup } = await import("../store/backup");
    await expect(restoreFromBackup(backupsDir, "state_0.json")).rejects.toThrow();
  });

  it("pruneBackups() keeps only the N most recent", async () => {
    fs.mkdirSync(backupsDir, { recursive: true });
    // Create 10 backup files
    for (let i = 1; i <= 10; i++) {
      fs.writeFileSync(path.join(backupsDir, `state_${i * 1000}.json`), "{}");
    }

    const { pruneBackups } = await import("../store/backup");
    await pruneBackups(backupsDir, 3);

    const remaining = fs.readdirSync(backupsDir).filter((f) => f.endsWith(".json"));
    expect(remaining).toHaveLength(3);
    // Should keep the 3 newest (highest timestamps)
    expect(remaining.sort()).toEqual(["state_10000.json", "state_8000.json", "state_9000.json"].sort());
  });
});

// ─── API logic tests (direct, no HTTP) ───────────────────────────────────────

describe("Backup API logic (direct)", () => {
  let tmpDir: string;
  let stateFile: string;
  let backupsDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateFile = path.join(tmpDir, "state.json");
    backupsDir = path.join(tmpDir, "backups");
    fs.writeFileSync(stateFile, JSON.stringify({ stubs: [{ id: "s1" }], tokens: [] }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("backup endpoint logic: creates a file and returns filename", async () => {
    const filename = await backupState(stateFile, backupsDir);
    expect(filename).toMatch(/^state_\d+\.json$/);
    expect(fs.existsSync(path.join(backupsDir, filename))).toBe(true);
  });

  it("backups listing logic: returns list with metadata", async () => {
    await backupState(stateFile, backupsDir);
    const list = await listBackups(backupsDir);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].filename).toMatch(/^state_\d+\.json$/);
    expect(list[0].size_bytes).toBeGreaterThan(0);
    expect(list[0].timestamp).toBeTypeOf("number");
  });

  it("restore endpoint logic: loads correct state", async () => {
    const filename = await backupState(stateFile, backupsDir);
    const state = await restoreFromBackup(backupsDir, filename);
    expect(state.stubs[0].id).toBe("s1");
    expect(state.ok).toBeUndefined(); // not response shape
  });

  it("restore endpoint logic: rejects invalid filename", async () => {
    await expect(restoreFromBackup(backupsDir, "../../etc/passwd")).rejects.toThrow();
  });

  it("restore endpoint logic: rejects nonexistent file", async () => {
    await expect(restoreFromBackup(backupsDir, "state_0.json")).rejects.toThrow();
  });
});
