import { describe, expect, it } from "vitest";
import { cleanTake, collapseFlams, describeCleanup, flagHits, looseness, tightenHits } from "./cleanup";
import { finalizeTake, type RecordingSettings, type TakeHit } from "./recording";

const SETTINGS: RecordingSettings = { bpm: 120, beatsPerBar: 4, bars: 2 }; // a 16th is 0.125 s

const hit = (time_s: number, pad = 0, velocity = 1): TakeHit => ({ time_s, pad, chop_file_id: `f${pad}`, velocity });

function take(hits: TakeHit[], bars = 2) {
  return finalizeTake(hits, { ...SETTINGS, bars }, bars * 2);
}

describe("tightening", () => {
  it("moves a hit the fraction of the way to the grid it was asked for, and no further", () => {
    const played = take([hit(0.16)]); // 35 ms late of the 0.125 step
    const half = tightenHits(played.hits, SETTINGS, 0.5);
    expect(half[0]?.time_s).toBeCloseTo(0.1425, 6);
    const all = tightenHits(played.hits, SETTINGS, 1);
    expect(all[0]?.time_s).toBeCloseTo(0.125, 6);
    const none = tightenHits(played.hits, SETTINGS, 0);
    expect(none[0]?.time_s).toBeCloseTo(0.16, 9);
  });

  it("keeps the feel: a take tightened halfway is still off the grid", () => {
    const played = take([hit(0.1), hit(0.52, 1), hit(1.04, 2)]);
    const cleaned = cleanTake(played, SETTINGS, { tighten: 0.5, collapseFlamsMs: null, flagOutliers: false });
    expect(cleaned.hits.every((h) => Math.abs(h.placement.offset_ms) > 0)).toBe(true);
    expect(looseness(cleaned)).toBeLessThan(looseness(played));
  });
});

describe("flams", () => {
  it("collapses two hits of one pad inside the window into the first of them", () => {
    const played = take([hit(0.5), hit(0.52), hit(0.9, 1)]);
    const { hits, dropped } = collapseFlams(played.hits, 30);
    expect(hits).toHaveLength(2);
    expect(dropped).toHaveLength(1);
    expect(hits[0]?.time_s).toBeCloseTo(0.5, 9);
  });

  it("keeps the louder of the two, at the earlier time", () => {
    const played = take([hit(0.5, 0, 0.4), hit(0.51, 0, 1)]);
    const { hits } = collapseFlams(played.hits, 30);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.velocity).toBe(1);
    expect(hits[0]?.time_s).toBeCloseTo(0.5, 9);
  });

  it("leaves two different pads alone, however close they are", () => {
    const played = take([hit(0.5, 0), hit(0.502, 1)]);
    expect(collapseFlams(played.hits, 30).hits).toHaveLength(2);
  });
});

describe("flagging", () => {
  it("flags a hit that landed most of the way to the next step, and says how far", () => {
    const played = take([hit(0.0625 + 0.001)]); // all but dead between step 0 and step 1
    const flags = flagHits(played.hits, SETTINGS);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.note).toContain("62 ms from the nearest 16th");
    // A hit is always placed on the nearest step, so a flag at "half a 16th" could never fire.
    expect(flagHits(take([hit(0.125 + 0.03)]).hits, SETTINGS)).toEqual([]);
  });

  it("flags the pad that appears exactly once in a busy take", () => {
    const hits = [0, 0.25, 0.5, 0.75, 1, 1.25].map((t) => hit(t, 0));
    hits.push(hit(1.5, 7));
    const flags = flagHits(take(hits).hits, SETTINGS);
    expect(flags.some((f) => f.note.includes("only hit on this pad"))).toBe(true);
  });

  it("flags nothing in a tidy take", () => {
    const played = take([hit(0), hit(0.5), hit(1), hit(1.5)]);
    expect(flagHits(played.hits, SETTINGS)).toEqual([]);
  });
});

describe("the whole pass", () => {
  it("is never destructive: the played take comes back beside the cleaned one", () => {
    const played = take([hit(0.16), hit(0.5), hit(0.52)]);
    const cleaned = cleanTake(played, SETTINGS, { tighten: 1, collapseFlamsMs: 30 });
    expect(cleaned.source).toBe(played);
    expect(cleaned.source.hits).toHaveLength(3);
    expect(cleaned.hits).toHaveLength(2);
    expect(played.hits[0]?.time_s).toBeCloseTo(0.16, 9);
  });

  it("says what it did, hit by hit", () => {
    const played = take([hit(0.16), hit(0.5), hit(0.52)]);
    const cleaned = cleanTake(played, SETTINGS, { tighten: 1, collapseFlamsMs: 30, flagOutliers: false });
    const kinds = cleaned.changes.map((c) => c.kind);
    expect(kinds).toContain("collapsed");
    expect(kinds).toContain("tightened");
    expect(cleaned.changes.find((c) => c.kind === "tightened")?.note).toContain("toward the grid");
    expect(describeCleanup(cleaned)).toContain("The take you played is still here.");
  });

  it("has nothing to say about a take that is already on the grid", () => {
    const played = take([hit(0), hit(0.5)]);
    const cleaned = cleanTake(played, SETTINGS, { tighten: 1, collapseFlamsMs: 30 });
    expect(cleaned.changes).toEqual([]);
    expect(describeCleanup(cleaned)).toContain("Nothing to clean up");
  });

  it("keeps the take's bars and every hit's pad", () => {
    const played = take([hit(0.1, 0), hit(2.05, 3), hit(3.9, 5)], 2);
    const cleaned = cleanTake(played, SETTINGS, { tighten: 0.4 });
    expect(cleaned.bars).toBe(2);
    expect(cleaned.hits.map((h) => h.pad)).toEqual([0, 3, 5]);
  });
});
