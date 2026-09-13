import { describe, expect, it } from "vitest";
import { floorSeconds, formatBarsBeats, formatRulerBeat, formatSignedSeconds, snapSeconds, stepSeconds, toBarsBeats } from "./time";

describe("stepSeconds", () => {
  it("derives every step from 60 / bpm", () => {
    expect(stepSeconds(120, "beat")).toBeCloseTo(0.5, 9);
    expect(stepSeconds(120, "bar")).toBeCloseTo(2.0, 9);
    expect(stepSeconds(120, "16th")).toBeCloseTo(0.125, 9);
    expect(stepSeconds(90, "bar", 3)).toBeCloseTo(2.0, 9);
  });
  it("is null for free and for an unusable tempo", () => {
    expect(stepSeconds(120, "free")).toBeNull();
    expect(stepSeconds(0, "beat")).toBeNull();
    expect(stepSeconds(Number.NaN, "beat")).toBeNull();
  });
});

describe("snapSeconds / floorSeconds", () => {
  it("snaps to the nearest grid point in the mode", () => {
    expect(snapSeconds(0.6, 120, "beat")).toBeCloseTo(0.5, 9);
    expect(snapSeconds(0.76, 120, "beat")).toBeCloseTo(1.0, 9);
    expect(snapSeconds(0.7, 120, "16th")).toBeCloseTo(0.75, 9);
    expect(snapSeconds(2.9, 120, "bar")).toBeCloseTo(2.0, 9);
    expect(snapSeconds(-0.7, 120, "16th")).toBeCloseTo(-0.75, 9);
  });
  it("leaves free mode and a missing tempo untouched", () => {
    expect(snapSeconds(0.6123, 120, "free")).toBe(0.6123);
    expect(snapSeconds(0.6123, 0, "beat")).toBe(0.6123);
  });
  it("floors to the step at or before", () => {
    expect(floorSeconds(0.74, 120, "16th")).toBeCloseTo(0.625, 9);
    expect(floorSeconds(0.75, 120, "16th")).toBeCloseTo(0.75, 9);
    expect(floorSeconds(0.3, 120, "free")).toBe(0.3);
  });
});

describe("toBarsBeats / formatBarsBeats", () => {
  it("splits a positive time into bars, beats and 16ths at the tempo", () => {
    // 120 BPM: beat 0.5 s, bar 2 s, 16th 0.125 s. 2.75 s = 1 bar + 1 beat + 2 sixteenths
    expect(toBarsBeats(2.75, 120)).toEqual({ negative: false, bars: 1, beats: 1, sixteenths: 2, remainderS: 0 });
    expect(formatBarsBeats(2.75, 120)).toBe("1.1.2");
  });
  it("keeps the sign and marks a free remainder", () => {
    expect(formatBarsBeats(-0.5, 120)).toBe("-0.1.0");
    expect(formatBarsBeats(0, 120)).toBe("0.0.0");
    expect(formatBarsBeats(-0.0001, 120)).toBe("0.0.0");
    const free = toBarsBeats(0.7, 120);
    expect(free.sixteenths).toBe(1);
    expect(free.remainderS).toBeCloseTo(0.075, 9);
    expect(formatBarsBeats(0.7, 120)).toBe("0.1.1+");
  });
  it("tolerates floating error on the grid", () => {
    const t = 3 * (60 / 93 / 4); // three 16ths at 93 BPM, accumulated
    expect(formatBarsBeats(t, 93)).toBe("0.0.3");
    expect(formatBarsBeats(16 * (60 / 93 / 4) * 0.9999999, 93)).toBe("1.0.0");
  });
  it("honours beats per bar", () => {
    expect(formatBarsBeats(1.5, 120, 3)).toBe("1.0.0");
  });
  it("degrades without a tempo", () => {
    expect(toBarsBeats(1.5, 0)).toEqual({ negative: false, bars: 0, beats: 0, sixteenths: 0, remainderS: 1.5 });
  });
});

describe("formatSignedSeconds / formatRulerBeat", () => {
  it("has a fixed sign and width", () => {
    expect(formatSignedSeconds(0.75)).toBe("+0.750 s");
    expect(formatSignedSeconds(-0.5)).toBe("-0.500 s");
    expect(formatSignedSeconds(0)).toBe("+0.000 s");
    expect(formatSignedSeconds(Number.NaN)).toBe("—");
  });
  it("labels bars on the one and bar.beat elsewhere", () => {
    expect(formatRulerBeat(0)).toBe("1");
    expect(formatRulerBeat(1)).toBe("1.2");
    expect(formatRulerBeat(4)).toBe("2");
    expect(formatRulerBeat(7)).toBe("2.4");
  });
});
