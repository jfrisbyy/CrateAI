// Undo. Arrangement without it is a trap, so the stack is asserted rather than
// clicked: what comes back, in what order, what names the step, and what a run
// of keyboard nudges collapses into.

import { describe as group, expect, it } from "vitest";
import {
  canRedo,
  canUndo,
  COALESCE_MS,
  depth,
  initHistory,
  MAX_HISTORY,
  present,
  record,
  redo,
  redoLabel,
  replacePresent,
  undo,
  undoLabel,
  type History,
} from "./history";

function chain(...steps: Array<[string, string]>): History<string> {
  return steps.reduce((h, [state, label], i) => record(h, state, label, { at: i * 10_000 }), initHistory("start"));
}

group("going back and forward", () => {
  it("starts with nothing to undo", () => {
    const h = initHistory("a");
    expect(present(h)).toBe("a");
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(undoLabel(h)).toBeNull();
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });

  it("walks back through the edits in the order they were made", () => {
    const h = chain(["a", "move"], ["b", "trim the head"], ["c", "duplicate"]);
    expect(present(h)).toBe("c");
    expect(present(undo(h))).toBe("b");
    expect(present(undo(undo(h)))).toBe("a");
    expect(present(undo(undo(undo(h))))).toBe("start");
    expect(canUndo(undo(undo(undo(h))))).toBe(false);
  });

  it("names the edit it is about to undo, and the one it would put back", () => {
    const h = chain(["a", "move"], ["b", "trim the head"]);
    expect(undoLabel(h)).toBe("trim the head");
    const back = undo(h);
    expect(undoLabel(back)).toBe("move");
    expect(redoLabel(back)).toBe("trim the head");
  });

  it("redoes what it undid, and no further", () => {
    const h = chain(["a", "move"], ["b", "trim"]);
    const back = undo(undo(h));
    expect(present(redo(back))).toBe("a");
    expect(present(redo(redo(back)))).toBe("b");
    expect(redo(redo(redo(back)))).toEqual(redo(redo(back)));
  });

  it("drops the forward history when a new edit is made, the way a browser does", () => {
    const h = chain(["a", "move"], ["b", "trim"]);
    const back = undo(h);
    expect(canRedo(back)).toBe(true);
    const branched = record(back, "c", "split", { at: 99_000 });
    expect(canRedo(branched)).toBe(false);
    expect(present(branched)).toBe("c");
    expect(present(undo(branched))).toBe("a");
  });
});

group("a run of edits is one edit", () => {
  it("collapses nudges that share a key and arrive together", () => {
    let h = initHistory("0");
    h = record(h, "1", "nudge", { coalesceKey: "nudge:r1", at: 0 });
    h = record(h, "2", "nudge", { coalesceKey: "nudge:r1", at: 100 });
    h = record(h, "3", "nudge", { coalesceKey: "nudge:r1", at: 200 });
    expect(present(h)).toBe("3");
    expect(depth(h)).toBe(1);
    expect(present(undo(h))).toBe("0"); // one undo gets the whole run back
  });

  it("starts a new entry once the run has paused", () => {
    let h = initHistory("0");
    h = record(h, "1", "nudge", { coalesceKey: "nudge:r1", at: 0 });
    h = record(h, "2", "nudge", { coalesceKey: "nudge:r1", at: COALESCE_MS + 1 });
    expect(depth(h)).toBe(2);
    expect(present(undo(h))).toBe("1");
  });

  it("does not collapse a nudge on one region into a nudge on another", () => {
    let h = initHistory("0");
    h = record(h, "1", "nudge", { coalesceKey: "nudge:r1", at: 0 });
    h = record(h, "2", "nudge", { coalesceKey: "nudge:r2", at: 10 });
    expect(depth(h)).toBe(2);
  });

  it("never collapses an edit that asked to stand alone", () => {
    let h = initHistory("0");
    h = record(h, "1", "move", { at: 0 });
    h = record(h, "2", "move", { at: 1 });
    expect(depth(h)).toBe(2);
  });
});

group("bounds and non-edits", () => {
  it("keeps the stack shallow enough to be an undo stack, not an archive", () => {
    let h = initHistory("0");
    for (let i = 1; i <= MAX_HISTORY + 20; i++) h = record(h, String(i), "move", { at: i * 10_000 });
    expect(depth(h)).toBe(MAX_HISTORY);
    expect(present(h)).toBe(String(MAX_HISTORY + 20));
  });

  it("can replace the present without making an undo step out of it", () => {
    const h = chain(["a", "move"]);
    const swapped = replacePresent(h, "a-with-a-decoded-lane");
    expect(present(swapped)).toBe("a-with-a-decoded-lane");
    expect(depth(swapped)).toBe(depth(h));
    expect(present(undo(swapped))).toBe("start");
  });
});
