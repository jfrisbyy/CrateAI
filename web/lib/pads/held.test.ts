import { describe, expect, it } from "vitest";
import { HeldPads } from "./held";

describe("HeldPads", () => {
  it("starts once and calls every repeat a repeat, whether or not the browser flags it", () => {
    const held = new HeldPads();
    expect(held.press(3)).toBe("start");
    expect(held.press(3, true)).toBe("repeat");
    expect(held.press(3, true)).toBe("repeat");
    // Some browsers do not set `repeat` at all; the pad is still held.
    expect(held.press(3)).toBe("repeat");
    expect(held.size).toBe(1);
  });

  it("plays again after the key really comes up", () => {
    const held = new HeldPads();
    held.press(1);
    expect(held.release(1)).toBe(true);
    expect(held.release(1)).toBe(false);
    expect(held.press(1)).toBe("start");
  });

  it("takes a repeat for a pad it never saw go down as the start, so focus mid-hold is not a dead key", () => {
    const held = new HeldPads();
    expect(held.press(5, true)).toBe("start");
    expect(held.has(5)).toBe(true);
  });

  it("releases everything at once and says what was held", () => {
    const held = new HeldPads();
    held.press(1);
    held.press(2);
    held.press(9);
    expect(held.releaseAll().sort((a, b) => a - b)).toEqual([1, 2, 9]);
    expect(held.size).toBe(0);
    expect(held.releaseAll()).toEqual([]);
  });

  it("remembers the most keys held at once, for the polyphony readout", () => {
    const held = new HeldPads();
    held.press(1);
    held.press(2);
    held.press(3);
    held.release(3);
    expect(held.peakHeld).toBe(3);
    held.resetPeak();
    expect(held.peakHeld).toBe(2);
  });
});
