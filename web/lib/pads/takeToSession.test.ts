import { describe, expect, it } from "vitest";
import { finalizeTake, type RecordingSettings, type TakeHit } from "./recording";
import { describeTakeLanding, regionsForTake, takeStartFor, trackForTake, type TakeSlice } from "./takeToSession";

const SETTINGS: RecordingSettings = { bpm: 120, beatsPerBar: 4, bars: 1 }; // a bar is 2 s

const hit = (time_s: number, pad: number, extra: Partial<TakeHit> = {}): TakeHit => ({ time_s, pad, chop_file_id: `f${pad}`, velocity: 1, ...extra });

const slices = new Map<number, TakeSlice>([
  [0, { fileId: "f0", label: "kick", durationS: 0.4, parentFileId: "record", startS: 1, endS: 1.4 }],
  [1, { fileId: "f1", label: "snare", durationS: 0.6 }],
]);

const placement = { trackId: "take-1", startS: 8, settings: SETTINGS, slices, sourceName: "Masquerade", sourceFileId: "record" };

describe("where a take lands", () => {
  it("lands on the next bar line, so it sits in time with what is already playing", () => {
    expect(takeStartFor(0, 120)).toMatchObject({ startS: 0 });
    expect(takeStartFor(3.5, 120).startS).toBe(4);
    expect(takeStartFor(4, 120).startS).toBe(4);
    expect(takeStartFor(4.0000000001, 120).startS).toBe(4);
    expect(takeStartFor(3.5, 120).note).toContain("bar 3");
  });

  it("lands at the playhead and says so when the session has no measured tempo", () => {
    const where = takeStartFor(3.7, null);
    expect(where.startS).toBeCloseTo(3.7, 9);
    expect(where.note).toContain("no measured tempo");
  });
});

describe("a take as regions", () => {
  it("is one region per hit, at the second it was played", () => {
    const take = finalizeTake([hit(0, 0), hit(0.5, 1)], SETTINGS, 2);
    const { regions, skipped, note } = regionsForTake(take, placement);
    expect(skipped).toBe(0);
    expect(regions).toHaveLength(2);
    expect(regions[0]).toMatchObject({ trackId: "take-1", sourceId: "f0", startS: 8, durationS: 0.4, offsetS: 0, rate: 1 });
    expect(regions[1]?.startS).toBeCloseTo(8.5, 9);
    expect(note).toContain("2 hits on one lane");
  });

  it("gives a gated hit the length the key was held, and a one-shot the slice's own", () => {
    const take = finalizeTake([hit(0, 0, { length_s: 0.15 }), hit(0.5, 1)], SETTINGS, 2);
    const { regions } = regionsForTake(take, placement);
    expect(regions[0]?.durationS).toBeCloseTo(0.15, 9);
    expect(regions[1]?.durationS).toBeCloseTo(0.6, 9);
  });

  it("never makes a region too short to be a sound", () => {
    const take = finalizeTake([hit(0, 0, { length_s: 0.0001 })], SETTINGS, 2);
    expect(regionsForTake(take, placement).regions[0]?.durationS).toBe(0.02);
  });

  it("carries note mode onto the timeline as the region's rate, and shortens it to match", () => {
    const take = finalizeTake([hit(0, 0, { semitones: 12 })], SETTINGS, 2);
    const region = regionsForTake(take, placement).regions[0];
    expect(region?.rate).toBeCloseTo(2, 12);
    expect(region?.durationS).toBeCloseTo(0.2, 9);
    expect(region?.lineage?.reason).toContain("+12 semitones");
  });

  it("keeps the lineage back to the record and the slice", () => {
    const take = finalizeTake([hit(0, 0)], SETTINGS, 2);
    const lineage = regionsForTake(take, placement).regions[0]?.lineage;
    expect(lineage).toMatchObject({ fileId: "f0", fileName: "kick", parentFileId: "record", kind: "chop", sourceBpm: 120, cents: 0, stretch: 1 });
    expect(lineage?.takeStartS).toBe(1);
  });

  it("leaves out a hit whose slice has not decoded, and counts it", () => {
    const take = finalizeTake([hit(0, 0), hit(0.5, 5)], SETTINGS, 2);
    const { regions, skipped, note } = regionsForTake(take, placement);
    expect(regions).toHaveLength(1);
    expect(skipped).toBe(1);
    expect(note).toContain("had no decoded slice");
  });

  it("never puts a region before the start of the session", () => {
    const take = finalizeTake([hit(-0.02, 0)], SETTINGS, 2);
    expect(regionsForTake(take, { ...placement, startS: 0 }).regions[0]?.startS).toBe(0);
  });

  it("makes a lane that carries the file it came from", () => {
    const track = trackForTake("take-1", "Masquerade take", { fileId: "record", provenance: "16 chops, 2 bars at 120 BPM" });
    expect(track).toMatchObject({ id: "take-1", gain: 1, muted: false, soloed: false, fileId: "record", origin: "file" });
  });

  it("says plainly when the session's tempo and the take's are not the same", () => {
    const take = finalizeTake([hit(0, 0)], SETTINGS, 2);
    expect(describeTakeLanding(take, placement, 120)).not.toContain("its own tempo");
    const line = describeTakeLanding(take, placement, 92);
    expect(line).toContain("92.0 BPM");
    expect(line).toContain("unstretched");
  });
});
