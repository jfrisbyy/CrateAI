import { describe, expect, it } from "vitest";
import { classLabel, correctionsOf, effectiveClass, hitsOf, setCorrection, stepViewFromHits, type BeatboxHit } from "./stepview";

const hits: BeatboxHit[] = [
  { time_s: 0.0, cls: "kick", confidence: 0.9, velocity: 1.0, bar: 0, step: 0, offset_ms: 0 },
  { time_s: 0.66, cls: "snare", confidence: 0.8, velocity: 0.7, bar: 0, step: 4, offset_ms: -6.5 },
  { time_s: 0.67, cls: "hat", confidence: 0.6, velocity: 0.3, bar: 0, step: 4, offset_ms: 3.1 },
  { time_s: 2.9, cls: "kick", confidence: 0.95, velocity: 0.9, bar: 1, step: 8, offset_ms: 12 },
];

describe("stepViewFromHits", () => {
  it("lays hits into bars × 16 steps and keeps the hit index", () => {
    const rows = stepViewFromHits(hits);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.steps).toHaveLength(16);
    expect(rows[0]!.steps[0]!.hits.map((h) => h.hit_index)).toEqual([0]);
    expect(rows[0]!.steps[4]!.hits.map((h) => h.cls)).toEqual(["snare", "hat"]);
    expect(rows[1]!.steps[8]!.hits[0]!.offset_ms).toBe(12);
    expect(rows[0]!.steps[1]!.hits).toEqual([]);
  });
  it("applies corrections by hit index", () => {
    const rows = stepViewFromHits(hits, [{ hit_index: 2, corrected_class: "snare" }]);
    const cell = rows[0]!.steps[4]!;
    expect(cell.hits[1]!.corrected_class).toBe("snare");
    expect(effectiveClass(cell.hits[1]!)).toBe("snare");
    expect(effectiveClass(cell.hits[0]!)).toBe("snare");
    expect(cell.hits[0]!.corrected_class).toBeNull();
  });
  it("returns no rows for no hits and clamps a step past the bar", () => {
    expect(stepViewFromHits([])).toEqual([]);
    const rows = stepViewFromHits([{ ...hits[0]!, step: 40 }]);
    expect(rows[0]!.steps[15]!.hits).toHaveLength(1);
  });
});

describe("setCorrection", () => {
  it("adds, replaces and clears", () => {
    let c = setCorrection([], 2, "snare", "hat");
    expect(c).toEqual([{ hit_index: 2, corrected_class: "snare" }]);
    c = setCorrection(c, 0, "snare", "kick");
    expect(c.map((x) => x.hit_index)).toEqual([0, 2]);
    c = setCorrection(c, 2, "kick", "hat");
    expect(c.find((x) => x.hit_index === 2)!.corrected_class).toBe("kick");
    c = setCorrection(c, 2, "hat", "hat");
    expect(c).toEqual([{ hit_index: 0, corrected_class: "snare" }]);
  });
});

describe("hitsOf / correctionsOf", () => {
  it("reads the compute's notes JSON and drops what it cannot use", () => {
    const notes = {
      notes: [],
      hits: [hits[0], { cls: 3 }, null, { cls: "hat", bar: "x" }],
      corrections: [{ hit_index: 1, corrected_class: "kick" }, { hit_index: "1" }, 5],
    };
    const parsed = hitsOf(notes);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]).toMatchObject({ cls: "hat", bar: 0, step: 0, velocity: 1 });
    expect(correctionsOf(notes)).toEqual([{ hit_index: 1, corrected_class: "kick" }]);
    expect(hitsOf(null)).toEqual([]);
    expect(hitsOf([1, 2])).toEqual([]);
    expect(correctionsOf({})).toEqual([]);
  });
});

describe("classLabel", () => {
  it("abbreviates", () => {
    expect(classLabel("kick")).toBe("K");
    expect(classLabel("open_hat")).toBe("OH");
    expect(classLabel("cowbell")).toBe("CO");
  });
});
