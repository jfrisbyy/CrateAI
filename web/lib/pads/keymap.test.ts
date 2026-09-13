import { describe, expect, it } from "vitest";
import { PAD_COUNT, PAD_KEYS, isPadNumber, keyForPad, padForKey } from "./keymap";

describe("pad keymap", () => {
  it("maps 1–8 to pads 1–8 and Q–I to pads 9–16 (K.34, same as lib/keys/commands.ts)", () => {
    const expected: Record<string, number> = {
      "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8,
      q: 9, w: 10, e: 11, r: 12, t: 13, y: 14, u: 15, i: 16,
    };
    for (const [key, pad] of Object.entries(expected)) {
      expect(padForKey(key)).toBe(pad);
      expect(padForKey(key.toUpperCase())).toBe(pad);
    }
    expect(PAD_KEYS).toHaveLength(PAD_COUNT);
    expect(new Set(PAD_KEYS).size).toBe(PAD_COUNT);
  });

  it("ignores keys that are not pads", () => {
    for (const key of ["9", "0", "o", "p", "a", " ", "[", "Enter", ""]) expect(padForKey(key)).toBeNull();
  });

  it("labels pads with their key, uppercase for letters", () => {
    expect(keyForPad(1)).toBe("1");
    expect(keyForPad(8)).toBe("8");
    expect(keyForPad(9)).toBe("Q");
    expect(keyForPad(16)).toBe("I");
    expect(() => keyForPad(17)).toThrow(RangeError);
    expect(() => keyForPad(0)).toThrow(RangeError);
  });

  it("round-trips every pad", () => {
    for (let pad = 1; pad <= PAD_COUNT; pad++) expect(padForKey(keyForPad(pad))).toBe(pad);
    expect(isPadNumber(16)).toBe(true);
    expect(isPadNumber(17)).toBe(false);
    expect(isPadNumber(1.5)).toBe(false);
  });
});
