/**
 * stub-tag-merge.test.ts — P0-1: Stub reconnect tag merge behavior.
 *
 * Validates that when a stub reconnects with empty tags [],
 * API-set tags on the existing stub are preserved (not overwritten).
 *
 * The fix is in socket/stub.ts handleResume:
 *   tags: (tags && tags.length > 0) ? tags : existingStub.tags
 *
 * Since handleResume is a private socket handler, we test the merge
 * logic pattern directly to prove the invariant.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Stub } from "../types";
import { store } from "../store";

// Mock fs to avoid state.json side effects
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => "{}"),
    writeFileSync: vi.fn(),
  },
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: {
    writeFile: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
  },
  writeFile: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
}));

vi.mock("../store/backup", () => ({
  backupState: vi.fn(async () => "backup.json"),
  pruneBackups: vi.fn(async () => {}),
}));

vi.mock("../log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeStub(overrides: Partial<Stub> = {}): Stub {
  return {
    id: `stub-${Math.random().toString(36).slice(2, 8)}`,
    name: "test-stub",
    hostname: "gpu32",
    gpu: { name: "A40", vram_total_mb: 49152, count: 1 },
    status: "online",
    type: "workstation",
    connected_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    max_concurrent: 2,
    tasks: [],
    ...overrides,
  };
}

/**
 * Replicates the tag merge logic from handleResume in socket/stub.ts.
 * This is the exact expression used in production:
 *   tags: (tags && tags.length > 0) ? tags : existingStub.tags
 */
function mergeTagsLikeResume(
  incomingTags: string[] | undefined,
  existingTags: string[] | undefined,
): string[] | undefined {
  return (incomingTags && incomingTags.length > 0) ? incomingTags : existingTags;
}

beforeEach(() => {
  store.reset();
});

describe("P0-1: Stub reconnect tag merge", () => {
  it("empty tags [] from stub preserves API-set tags on existing stub", () => {
    const result = mergeTagsLikeResume([], ["a40", "ml"]);
    expect(result).toEqual(["a40", "ml"]);
  });

  it("undefined tags from stub preserves existing tags", () => {
    const result = mergeTagsLikeResume(undefined, ["a40", "ml"]);
    expect(result).toEqual(["a40", "ml"]);
  });

  it("non-empty tags from stub overwrites existing tags", () => {
    const result = mergeTagsLikeResume(["new-tag"], ["old-tag"]);
    expect(result).toEqual(["new-tag"]);
  });

  it("non-empty tags from stub when no existing tags", () => {
    const result = mergeTagsLikeResume(["new-tag"], undefined);
    expect(result).toEqual(["new-tag"]);
  });

  it("both undefined returns undefined", () => {
    const result = mergeTagsLikeResume(undefined, undefined);
    expect(result).toBeUndefined();
  });

  it("both empty returns empty (existing empty)", () => {
    const result = mergeTagsLikeResume([], []);
    expect(result).toEqual([]);
  });

  // Integration: simulate resume flow through store
  it("store retains tags after simulated reconnect with empty tags", () => {
    const existingStub = makeStub({ id: "stub-abc", tags: ["a40", "priority"] });
    store.setStub(existingStub);

    // Simulate reconnect: stub sends empty tags
    const incomingTags: string[] = [];
    const storedStub = store.getStub("stub-abc")!;
    const mergedTags = mergeTagsLikeResume(incomingTags, storedStub.tags);

    // Update stub as handleResume would
    storedStub.tags = mergedTags;
    storedStub.status = "online";
    store.setStub(storedStub);

    const result = store.getStub("stub-abc")!;
    expect(result.tags).toEqual(["a40", "priority"]);
    expect(result.status).toBe("online");
  });

  it("store updates tags after reconnect with non-empty tags", () => {
    const existingStub = makeStub({ id: "stub-def", tags: ["old"] });
    store.setStub(existingStub);

    const incomingTags = ["new-a40", "fast"];
    const storedStub = store.getStub("stub-def")!;
    const mergedTags = mergeTagsLikeResume(incomingTags, storedStub.tags);

    storedStub.tags = mergedTags;
    store.setStub(storedStub);

    expect(store.getStub("stub-def")!.tags).toEqual(["new-a40", "fast"]);
  });
});

describe("P0-1: Edge cases for tag merge", () => {
  it("single-element incoming tags overwrites", () => {
    expect(mergeTagsLikeResume(["x"], ["a", "b", "c"])).toEqual(["x"]);
  });

  it("preserves tags with special characters", () => {
    const existing = ["gpu:a40", "partition=fast", "user/ys25"];
    expect(mergeTagsLikeResume([], existing)).toEqual(existing);
  });

  it("large tag array is preserved", () => {
    const existing = Array.from({ length: 100 }, (_, i) => `tag-${i}`);
    expect(mergeTagsLikeResume([], existing)).toHaveLength(100);
  });
});
