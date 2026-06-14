import { describe, it, expect, beforeEach } from "vitest";
import { store } from "../store";

describe("task mark store", () => {
  beforeEach(() => {
    store.reset();
  });

  it("set pinned true and get returns pinned true watched false actor/task_id", () => {
    const mark = store.setTaskMark("task-1", "akashi", { pinned: true });

    expect(mark.task_id).toBe("task-1");
    expect(mark.actor).toBe("akashi");
    expect(mark.pinned).toBe(true);
    expect(mark.watched).toBe(false);

    const fetched = store.getTaskMark("task-1", "akashi");
    expect(fetched).toMatchObject({
      task_id: "task-1",
      actor: "akashi",
      pinned: true,
      watched: false,
    });
  });

  it("set watched true preserves pinned true", () => {
    store.setTaskMark("task-1", "akashi", { pinned: true });
    const updated = store.setTaskMark("task-1", "akashi", { watched: true });

    expect(updated.pinned).toBe(true);
    expect(updated.watched).toBe(true);

    const fetched = store.getTaskMark("task-1", "akashi");
    expect(fetched?.pinned).toBe(true);
    expect(fetched?.watched).toBe(true);
  });

  it("set read_at for actor akashi; actor yuzhe remains independent", () => {
    const readAtAkashi = "2026-06-14T00:00:00.000Z";
    const readAtYuzhe = "2026-06-14T01:00:00.000Z";

    store.setTaskMark("task-1", "akashi", { read_at: readAtAkashi });
    store.setTaskMark("task-1", "yuzhe", { read_at: readAtYuzhe });

    const akashi = store.getTaskMark("task-1", "akashi");
    const yuzhe = store.getTaskMark("task-1", "yuzhe");

    expect(akashi?.read_at).toBe(readAtAkashi);
    expect(yuzhe?.read_at).toBe(readAtYuzhe);
    expect(akashi?.read_at).not.toBe(yuzhe?.read_at);
  });

  it("listTaskMarks(akashi) returns only akashi marks", () => {
    store.setTaskMark("task-1", "akashi", { pinned: true });
    store.setTaskMark("task-2", "akashi", { watched: true });
    store.setTaskMark("task-3", "yuzhe", { pinned: true });

    const marks = store.listTaskMarks("akashi");

    expect(marks).toHaveLength(2);
    expect(marks.every((mark) => mark.actor === "akashi")).toBe(true);
    expect(new Set(marks.map((mark) => mark.task_id))).toEqual(new Set(["task-1", "task-2"]));
  });
});
