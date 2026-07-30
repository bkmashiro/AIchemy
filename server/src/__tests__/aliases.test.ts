import { beforeEach, describe, expect, it } from "vitest";
import { generateMnemonicAlias } from "../aliases";
import { store } from "../store";
import type { Experiment, Task } from "../types";

function makeTask(id: string): Task {
  return {
    id,
    seq: store.nextSeq(),
    fingerprint: `fp-${id}`,
    display_name: "alias task",
    script: "train.py",
    command: "python train.py",
    status: "pending",
    priority: 0,
    created_at: "2026-07-30T00:00:00.000Z",
    log_buffer: [],
    retry_count: 0,
    max_retries: 0,
    should_stop: false,
    should_checkpoint: false,
  };
}

function makeExperiment(id: string): Experiment {
  return {
    id,
    name: "alias experiment",
    criteria: {},
    grid_id: `grid-${id}`,
    status: "running",
    results: {},
    created_at: "2026-07-30T00:00:00.000Z",
  };
}

beforeEach(() => {
  store.reset();
});

describe("mnemonic aliases", () => {
  it("generates a deterministic type-prefixed mnemonic alias", () => {
    const first = generateMnemonicAlias("experiment", "76f65100-0473-49e0-aadd-63ef19695323");
    const second = generateMnemonicAlias("experiment", "76f65100-0473-49e0-aadd-63ef19695323");

    expect(first).toBe(second);
    expect(first).toMatch(/^exp-[a-z]+-[a-z]+-[2-9a-z]{6}$/);
  });

  it("persists one immutable alias for an experiment and resolves it", () => {
    const exp = makeExperiment("76f65100-0473-49e0-aadd-63ef19695323");
    store.setExperiment(exp);

    const stored = store.getExperiment(exp.id)!;
    expect(stored.alias).toMatch(/^exp-/);
    expect(store.getExperiment(stored.alias!)).toEqual(stored);

    store.setExperiment({ ...stored, name: "renamed" });
    expect(store.getExperiment(exp.id)?.alias).toBe(stored.alias);
  });

  it("persists and resolves task aliases without changing canonical ids", () => {
    const task = makeTask("8730382b-bd75-4124-a3d0-a792a05c4acd");
    store.addToGlobalQueue(task);

    const stored = store.findTask(task.id)!.task;
    expect(stored.alias).toMatch(/^task-/);
    expect(store.findTask(stored.alias!)?.task.id).toBe(task.id);
    expect(stored.id).toBe(task.id);
  });

  it("returns canonical ref metadata for ids and aliases", () => {
    const exp = makeExperiment("d878fc0b-81c0-4a08-962f-da110804154c");
    store.setExperiment(exp);
    const alias = store.getExperiment(exp.id)!.alias!;

    expect(store.resolveObjectRef(exp.id, "experiment")).toMatchObject({
      id: exp.id,
      alias,
      kind: "experiment",
    });
    expect(store.resolveObjectRef(alias)).toMatchObject({
      id: exp.id,
      alias,
      kind: "experiment",
    });
  });
});
