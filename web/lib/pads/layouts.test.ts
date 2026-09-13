import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAYOUT_ID,
  KEY_ROWS,
  LAYOUTS,
  keyForPadIn,
  layoutById,
  layoutOr,
  padCountOf,
  padForKeyIn,
  rowsOf,
  shortcutsTakenBy,
} from "./layouts";
import { PAD_COUNT, PAD_KEYS, keyForPad, padForKey } from "./keymap";

describe("layout presets", () => {
  it("offers 8, 16, 24, 32 and the full keyboard", () => {
    expect(LAYOUTS.map((l) => l.id)).toEqual(["8", "16", "24", "32", "full"]);
    expect(LAYOUTS.map((l) => padCountOf(l))).toEqual([8, 16, 24, 32, 40]);
    expect(DEFAULT_LAYOUT_ID).toBe("16");
  });

  it("never repeats a key inside a layout and never leaves a gap", () => {
    for (const layout of LAYOUTS) {
      expect(new Set(layout.keys).size).toBe(layout.keys.length);
      for (let pad = 1; pad <= layout.keys.length; pad++) {
        expect(padForKeyIn(layout, keyForPadIn(layout, pad))).toBe(pad);
        expect(padForKeyIn(layout, keyForPadIn(layout, pad).toUpperCase())).toBe(pad);
      }
    }
  });

  it("is the same mapping the Phase 3 keymap ships, so the grid and the engine cannot disagree", () => {
    const sixteen = layoutOr("16");
    expect(sixteen.keys).toEqual(PAD_KEYS);
    expect(PAD_COUNT).toBe(16);
    for (let pad = 1; pad <= 16; pad++) {
      expect(keyForPadIn(sixteen, pad).toUpperCase()).toBe(keyForPad(pad));
      expect(padForKeyIn(sixteen, keyForPad(pad))).toBe(padForKey(keyForPad(pad)));
    }
    expect(padForKey("r")).toBe(12);
    expect(padForKeyIn(sixteen, "r")).toBe(12);
  });

  it("puts R on pad 12 in every layout that has the top row, because a key means one thing", () => {
    for (const id of ["16", "24", "32"] as const) {
      expect(padForKeyIn(layoutOr(id), "r")).toBe(12);
    }
    expect(padForKeyIn(layoutOr("full"), "r")).toBe(14); // ten to a row, so the letters move
    expect(padForKeyIn(layoutOr("8"), "r")).toBeNull();
  });

  it("draws rows the way the keys sit under the hands", () => {
    expect(rowsOf(layoutOr("16"))).toEqual([
      ["1", "2", "3", "4"],
      ["5", "6", "7", "8"],
      ["q", "w", "e", "r"],
      ["t", "y", "u", "i"],
    ]);
    expect(rowsOf(layoutOr("24"))).toEqual([KEY_ROWS.digits.slice(0, 8), KEY_ROWS.top.slice(0, 8), KEY_ROWS.home.slice(0, 8)]);
    expect(rowsOf(layoutOr("full"))).toHaveLength(4);
  });

  it("ignores keys that are not pads, and anything that is not one key", () => {
    const sixteen = layoutOr("16");
    for (const key of ["9", "0", "o", "p", "a", " ", "[", "Enter", "", "Shift"]) expect(padForKeyIn(sixteen, key)).toBeNull();
  });

  it("says which single-key shortcuts a layout takes over", () => {
    expect(shortcutsTakenBy(layoutOr("16"))).toEqual([]);
    expect(shortcutsTakenBy(layoutOr("24")).map((s) => s.key)).toEqual(["d"]);
    expect(shortcutsTakenBy(layoutOr("32")).map((s) => s.key)).toEqual(["d", ","]);
    expect(shortcutsTakenBy(layoutOr("full")).map((s) => s.key)).toEqual(["l", "d", ",", "."]);
  });

  it("falls back to the default rather than throwing on an unknown id", () => {
    expect(layoutById("99")).toBeNull();
    expect(layoutOr("99").id).toBe("16");
    expect(layoutOr(null).id).toBe("16");
    expect(() => keyForPadIn(layoutOr("8"), 9)).toThrow(RangeError);
  });
});
