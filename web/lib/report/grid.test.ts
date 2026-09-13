import { describe, expect, it } from "vitest";
import { barsInRange, barsToSeconds, gridFromReport, nearestIndex, nearestZeroCrossing, nudge, snapTime, type Grid } from "./grid";
import { emptyReport } from "./effective";

const beat = 0.5; // 120 BPM
const grid: Grid = {
  beats: Array.from({ length: 17 }, (_, i) => i * beat),
  downbeats: [0, 2, 4, 6, 8],
  beatsPerBar: 4,
  beatInterval: beat,
};

describe("nearestIndex", () => {
  it("finds the nearest sorted value, first on ties", () => {
    expect(nearestIndex([0, 1, 2], 0.4)).toBe(0);
    expect(nearestIndex([0, 1, 2], 0.5)).toBe(0);
    expect(nearestIndex([0, 1, 2], 0.6)).toBe(1);
    expect(nearestIndex([0, 1, 2], 9)).toBe(2);
    expect(nearestIndex([0, 1, 2], -9)).toBe(0);
    expect(nearestIndex([], 1)).toBe(-1);
  });
});

describe("snapTime", () => {
  it("leaves free mode alone", () => {
    expect(snapTime(1.234, "free", grid)).toBe(1.234);
  });
  it("snaps to beats, downbeats and 16ths", () => {
    expect(snapTime(1.2, "beat", grid)).toBe(1.0);
    expect(snapTime(1.3, "beat", grid)).toBe(1.5);
    expect(snapTime(1.3, "downbeat", grid)).toBe(2);
    expect(snapTime(0.9, "downbeat", grid)).toBe(0);
    expect(snapTime(1.1, "16th", grid)).toBeCloseTo(1.125, 9);
    expect(snapTime(1.3, "16th", grid)).toBeCloseTo(1.25, 9);
  });
  it("falls back sensibly without a grid", () => {
    const empty: Grid = { beats: [], downbeats: [], beatsPerBar: 4, beatInterval: null };
    expect(snapTime(1.3, "beat", empty)).toBe(1.3);
    expect(snapTime(1.3, "16th", empty)).toBe(1.3);
    expect(snapTime(1.3, "downbeat", empty)).toBe(1.3);
  });
});

describe("nearestZeroCrossing", () => {
  it("prefers a rising crossing inside the window", () => {
    const sr = 1000;
    const ch = new Float32Array(1000).fill(0.5);
    // falling crossing at sample 498, rising at 502
    ch[497] = 0.1;
    ch[498] = -0.1;
    ch[499] = -0.2;
    ch[500] = -0.2;
    ch[501] = -0.1;
    ch[502] = 0.1;
    expect(nearestZeroCrossing(ch, sr, 0.5, 5)).toBeCloseTo(0.502, 9);
  });
  it("accepts a falling crossing when there is no rising one", () => {
    const sr = 1000;
    const ch = new Float32Array(1000).fill(0.5);
    for (let i = 503; i < 1000; i++) ch[i] = -0.5;
    expect(nearestZeroCrossing(ch, sr, 0.5, 5)).toBeCloseTo(0.503, 9);
  });
  it("returns the input when nothing crosses within the window", () => {
    const ch = new Float32Array(1000).fill(0.5);
    expect(nearestZeroCrossing(ch, 1000, 0.5, 2)).toBe(0.5);
  });
});

describe("bars", () => {
  it("counts bars from the local beat interval", () => {
    expect(barsInRange(0, 2, grid)).toBe(1);
    expect(barsInRange(0, 8, grid)).toBe(4);
    expect(barsInRange(0.5, 4.4, grid)).toBe(2);
    expect(barsInRange(2, 1, grid)).toBeNull();
  });
  it("converts bars to seconds along the grid", () => {
    expect(barsToSeconds(0, 2, grid)).toBeCloseTo(4, 9);
    expect(barsToSeconds(1, 1, grid)).toBeCloseTo(2, 9);
    // past the end of the measured beats: fall back to the interval
    expect(barsToSeconds(7, 4, grid)).toBeCloseTo(8, 9);
  });
  it("nudges by a 16th", () => {
    expect(nudge(1, 1, grid)).toBeCloseTo(1.125, 9);
    expect(nudge(0.05, -1, grid)).toBe(0);
  });
});

describe("gridFromReport", () => {
  it("reads beats, downbeats and meter", () => {
    const r = emptyReport({
      beats: {
        times_s: [0, 0.5, 1, 1.5, 2, 2.5],
        confidence: 0.9,
        method: "librosa",
        downbeats_s: [0, 1.5],
        downbeat_phase: 0,
        downbeat_confidence: 0.6,
        downbeat_method: "lowband",
        meter: "3/4",
        notes: null,
      },
    });
    const g = gridFromReport(r);
    expect(g.beatsPerBar).toBe(3);
    expect(g.beatInterval).toBeCloseTo(0.5, 9);
    expect(g.downbeats).toEqual([0, 1.5]);
  });
  it("uses the tempo when there are no beats", () => {
    const r = emptyReport({ tempo: { bpm: 120, confidence: 0.9, method: "librosa", alternates_bpm: [60, 240], notes: null } });
    expect(gridFromReport(r).beatInterval).toBeCloseTo(0.5, 9);
    expect(gridFromReport(null).beatInterval).toBeNull();
  });
});
