// The panel's history and its divider. The layout rules from the direction
// document are here as assertions: one surface at a time, going back is a
// click and never a re-run, and the divider cannot squeeze either side out.

import { describe as group, expect, it } from "vitest";
import {
  canGoBack,
  canGoForward,
  clampSplit,
  closePanel,
  currentSurface,
  DEFAULT_SPLIT,
  EMPTY_STACK,
  goBack,
  goForward,
  goTo,
  isRoute,
  MAX_ENTRIES,
  MAX_SPLIT,
  MIN_SPLIT,
  openPanel,
  pushSurface,
  removeSurface,
  splitFromPointer,
  type StackState,
  type SurfaceEntry,
} from "./surfaceStack";

function file(id: string, title = id): SurfaceEntry {
  return { kind: "file", id, title };
}

function stackOf(...entries: SurfaceEntry[]): StackState {
  return entries.reduce(pushSurface, EMPTY_STACK);
}

group("one surface at a time, with history", () => {
  it("starts closed with nothing to show", () => {
    expect(currentSurface(EMPTY_STACK)).toBeNull();
    expect(EMPTY_STACK.open).toBe(false);
    expect(canGoBack(EMPTY_STACK)).toBe(false);
  });

  it("opens the panel when the first object appears", () => {
    const state = pushSurface(EMPTY_STACK, file("a"));
    expect(state.open).toBe(true);
    expect(currentSurface(state)).toEqual(file("a"));
  });

  it("goes back and forward without re-running anything", () => {
    const state = stackOf(file("a"), file("b"), { kind: "rack", id: "drums", title: "Drums that fit" });
    expect(currentSurface(state)?.id).toBe("drums");
    const back = goBack(goBack(state));
    expect(currentSurface(back)?.id).toBe("a");
    expect(back.entries).toHaveLength(3); // the history is intact, nothing was dropped
    expect(canGoForward(back)).toBe(true);
    expect(currentSurface(goForward(back))?.id).toBe("b");
  });

  it("truncates the forward history when a new object arrives, like a browser", () => {
    const state = goBack(stackOf(file("a"), file("b"), file("c")));
    expect(currentSurface(state)?.id).toBe("b");
    const next = pushSurface(state, file("d"));
    expect(next.entries.map((e) => e.id)).toEqual(["a", "b", "d"]);
    expect(canGoForward(next)).toBe(false);
  });

  it("does not stack the same surface twice when a route re-renders", () => {
    const state = stackOf(file("a"), file("a"), file("a"));
    expect(state.entries).toHaveLength(1);
  });

  it("updates a title in place rather than pushing a new entry", () => {
    const state = pushSurface(stackOf(file("a", "Untitled")), file("a", "Masquerade"));
    expect(state.entries).toHaveLength(1);
    expect(currentSurface(state)?.title).toBe("Masquerade");
  });

  it("tells two kinds of surface with the same id apart", () => {
    const state = stackOf({ kind: "file", id: "x", title: "file" }, { kind: "rack", id: "x", title: "rack" });
    expect(state.entries).toHaveLength(2);
  });

  it("keeps the history bounded", () => {
    let state = EMPTY_STACK;
    for (let i = 0; i < MAX_ENTRIES + 10; i++) state = pushSurface(state, file(`f${i}`));
    expect(state.entries).toHaveLength(MAX_ENTRIES);
    expect(currentSurface(state)?.id).toBe(`f${MAX_ENTRIES + 9}`);
    expect(state.index).toBe(MAX_ENTRIES - 1);
  });

  it("jumps straight to an earlier surface", () => {
    const state = goTo(stackOf(file("a"), file("b"), file("c")), 0);
    expect(currentSurface(state)?.id).toBe("a");
    expect(goTo(state, 99)).toBe(state); // out of range changes nothing
  });
});

group("dismissing the panel", () => {
  it("collapses to the full-width chat and comes back where it was", () => {
    const state = stackOf(file("a"), file("b"));
    const closed = closePanel(state);
    expect(closed.open).toBe(false);
    expect(currentSurface(closed)?.id).toBe("b"); // the history survives the dismissal
    expect(openPanel(closed).open).toBe(true);
  });

  it("stays closed when there has never been a surface", () => {
    expect(openPanel(EMPTY_STACK).open).toBe(false);
  });

  it("re-opens when a new object arrives while it is collapsed", () => {
    const closed = closePanel(stackOf(file("a")));
    expect(pushSurface(closed, file("b")).open).toBe(true);
  });

  it("drops a surface whose object is gone", () => {
    const state = removeSurface(stackOf(file("a"), file("b")), "file", "b");
    expect(state.entries.map((e) => e.id)).toEqual(["a"]);
    expect(currentSurface(state)?.id).toBe("a");
    const emptied = removeSurface(state, "file", "a");
    expect(emptied.entries).toEqual([]);
    expect(emptied.open).toBe(false);
  });

  it("keeps showing what it was showing when an older surface is dropped", () => {
    const state = removeSurface(stackOf(file("a"), file("b"), file("c")), "file", "a");
    expect(currentSurface(state)?.id).toBe("c");
  });
});

group("what the router renders", () => {
  it("knows which surfaces are route content", () => {
    expect(isRoute(file("a"))).toBe(true);
    expect(isRoute({ kind: "page", id: "/account", title: "Account" })).toBe(true);
    expect(isRoute({ kind: "rack", id: "drums", title: "Drums" })).toBe(false);
    expect(isRoute({ kind: "session", id: "session", title: "The session" })).toBe(false);
    expect(isRoute(null)).toBe(false);
  });

  it("keeps a page and a file as separate entries", () => {
    const state = stackOf(file("a"), { kind: "page", id: "/account", title: "Account" });
    expect(state.entries).toHaveLength(2);
    expect(currentSurface(state)?.kind).toBe("page");
  });
});

group("the divider", () => {
  it("cannot squeeze either side out", () => {
    expect(clampSplit(0.9)).toBe(MAX_SPLIT);
    expect(clampSplit(0.01)).toBe(MIN_SPLIT);
    expect(clampSplit(Number.NaN)).toBe(DEFAULT_SPLIT);
    expect(clampSplit(0.5)).toBe(0.5);
  });

  it("follows the pointer: dragging left widens the panel", () => {
    // an area 1000 wide starting at x = 200
    expect(splitFromPointer(700, 200, 1000)).toBeCloseTo(0.5, 9);
    expect(splitFromPointer(500, 200, 1000)).toBeCloseTo(0.7, 9);
    expect(splitFromPointer(1100, 200, 1000)).toBe(MIN_SPLIT);
    expect(splitFromPointer(100, 200, 1000)).toBe(MAX_SPLIT);
    expect(splitFromPointer(700, 200, 0)).toBe(DEFAULT_SPLIT);
  });
});
