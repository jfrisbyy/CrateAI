import { describe, expect, it } from "vitest";
import type { PadHitInput } from "@/lib/api/midi";
import { acceptsHit, finalizeTake, placeTake, takeBars, type RecordingSettings } from "./recording";

const hit = (time_s: number, pad = 0): PadHitInput => ({ time_s, pad, chop_file_id: null, velocity: 1 });

describe("acceptsHit", () => {
  const fixed: RecordingSettings = { bpm: 120, beatsPerBar: 4, bars: 2 };
  it("takes hits from half a 16th before the start to the end of a fixed take", () => {
    expect(acceptsHit(-0.0624, fixed)).toBe(true);
    expect(acceptsHit(-0.0626, fixed)).toBe(false);
    expect(acceptsHit(0, fixed)).toBe(true);
    expect(acceptsHit(3.99, fixed)).toBe(true);
    expect(acceptsHit(4.0, fixed)).toBe(false);
  });
  it("has no end for an open take", () => {
    expect(acceptsHit(100, { ...fixed, bars: null })).toBe(true);
  });
});

describe("takeBars", () => {
  it("keeps the chosen length, else covers the hits or the elapsed time in whole bars", () => {
    expect(takeBars([hit(9)], { bpm: 120, beatsPerBar: 4, bars: 1 }, 20)).toBe(1);
    const open: RecordingSettings = { bpm: 120, beatsPerBar: 4, bars: null };
    expect(takeBars([], open, 0)).toBe(1);
    expect(takeBars([hit(1.9)], open, 2.5)).toBe(2);
    expect(takeBars([hit(4.5)], open, 1)).toBe(3);
  });
});

describe("placeTake", () => {
  it("places hits with bar, step and offset at 90 BPM", () => {
    const settings: RecordingSettings = { bpm: 90, beatsPerBar: 4, bars: 2 };
    const step = 60 / 90 / 4;
    const placed = placeTake([hit(step * 20 + 0.011, 4), hit(0.005, 1), hit(step * 7 - 0.02, 2)], settings, 2);
    expect(placed.map((h) => h.pad)).toEqual([1, 2, 4]);
    expect(placed[0]?.placement).toMatchObject({ bar: 0, step: 0, offset_ms: 5 });
    expect(placed[1]?.placement.step).toBe(7);
    expect(placed[1]?.placement.offset_ms).toBeCloseTo(-20, 6);
    expect(placed[2]?.placement).toMatchObject({ bar: 1, step: 4 });
    expect(placed[2]?.placement.offset_ms).toBeCloseTo(11, 6);
    expect(placed.every((h) => !h.wrapped)).toBe(true);
  });

  it("folds an early downbeat of the next repeat onto the first step, keeping it early", () => {
    const settings: RecordingSettings = { bpm: 120, beatsPerBar: 4, bars: 1 };
    const placed = placeTake([hit(1.98)], settings, 1); // 20 ms before the end of a 2 s bar
    expect(placed[0]?.wrapped).toBe(true);
    expect(placed[0]?.time_s).toBeCloseTo(-0.02, 9);
    expect(placed[0]?.placement).toMatchObject({ bar: 0, step: 0 });
    expect(placed[0]?.placement.offset_ms).toBeCloseTo(-20, 6);
  });

  it("marks a hit before the record start as wrapped but leaves its time", () => {
    const placed = placeTake([hit(-0.01)], { bpm: 120, beatsPerBar: 4, bars: 1 }, 1);
    expect(placed[0]?.wrapped).toBe(true);
    expect(placed[0]?.time_s).toBeCloseTo(-0.01, 9);
  });
});

describe("finalizeTake", () => {
  it("returns the bars and the placed hits", () => {
    const take = finalizeTake([hit(0.5), hit(2.25)], { bpm: 120, beatsPerBar: 4, bars: null }, 2.4);
    expect(take.bars).toBe(2);
    expect(take.hits[1]?.placement).toMatchObject({ bar: 1, step: 2, offset_ms: 0 });
  });
});
