import { describe, expect, it } from "vitest";
import { MAX_SEMITONES, clampSemitones, defaultRootPad, durationScaleFor, intervalLabel, noteNameFor, rateForSemitones, semitonesForPad } from "./note";

describe("note mode", () => {
  it("is the sampler's rate: 2 ** (semitones / 12)", () => {
    expect(rateForSemitones(0)).toBe(1);
    expect(rateForSemitones(12)).toBeCloseTo(2, 12);
    expect(rateForSemitones(-12)).toBeCloseTo(0.5, 12);
    expect(rateForSemitones(7)).toBeCloseTo(1.4983070768766815, 12);
    expect(rateForSemitones(-5)).toBeCloseTo(0.7491535384383408, 12);
  });

  it("couples duration to pitch, the way a sampler does", () => {
    expect(durationScaleFor(12)).toBeCloseTo(0.5, 12);
    expect(durationScaleFor(-12)).toBeCloseTo(2, 12);
    expect(durationScaleFor(0)).toBe(1);
  });

  it("keeps the transposition inside two octaves and survives nonsense", () => {
    expect(clampSemitones(99)).toBe(MAX_SEMITONES);
    expect(clampSemitones(-99)).toBe(-MAX_SEMITONES);
    expect(clampSemitones(Number.NaN)).toBe(0);
    expect(clampSemitones(3.4)).toBe(3);
    expect(rateForSemitones(1000)).toBeCloseTo(2 ** 2, 12);
  });

  it("puts the root in the middle of the layout so there is room either side", () => {
    expect(defaultRootPad(16)).toBe(8);
    expect(defaultRootPad(8)).toBe(4);
    expect(defaultRootPad(24)).toBe(12);
    expect(defaultRootPad(40)).toBe(20);
    expect(defaultRootPad(1)).toBe(1);
    expect(defaultRootPad(0)).toBe(1);
  });

  it("counts semitones up the layout one key at a time from the root", () => {
    expect(semitonesForPad(8, 8)).toBe(0);
    expect(semitonesForPad(9, 8)).toBe(1);
    expect(semitonesForPad(1, 8)).toBe(-7);
    expect(semitonesForPad(16, 8)).toBe(8);
    expect(intervalLabel(0)).toBe("root");
    expect(intervalLabel(4)).toBe("+4");
    expect(intervalLabel(-4)).toBe("-4");
  });

  it("names the note only when a root note is actually known", () => {
    expect(noteNameFor(null, 3)).toBeNull();
    expect(noteNameFor("C", 0)).toBe("C");
    expect(noteNameFor("C", 4)).toBe("E");
    expect(noteNameFor("A", 3)).toBe("C");
    expect(noteNameFor("Bb", 2)).toBe("C");
    expect(noteNameFor("F#", -1)).toBe("F");
    expect(noteNameFor("H", 1)).toBeNull();
  });
});
