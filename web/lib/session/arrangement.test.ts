// Every edit a producer can make to the song, asserted without a DOM.
//
// The two that are easy to get subtly wrong, and that a producer hears rather
// than sees, get the most attention here: trimming the head moves `startS` and
// `offsetS` together while trimming the tail moves only `durationS`, and every
// edit carries the lineage through so a region that has been moved, trimmed,
// split and copied still knows which record it is bars of.

import { describe as group, expect, it } from "vitest";
import {
  addTrack,
  applyDrag,
  arrangementEnd,
  arrangementOf,
  deleteRegion,
  describeBar,
  dragIntentFor,
  duplicateRegion,
  emptyTrack,
  ephemeralOf,
  limitsOf,
  MIN_REGION_S,
  moveRegion,
  moveRegionToTrack,
  moveTrack,
  nextRegionId,
  nudgeRegion,
  previewDrag,
  regionById,
  regionsAt,
  regionsInBar,
  regionsOfTrack,
  removeTrack,
  renameTrack,
  sameRegion,
  setRegionGain,
  setTrackGain,
  setTrackMute,
  setTrackSolo,
  soundingSpan,
  splitRegion,
  startBarOf,
  trimHead,
  trimTail,
  withEphemeral,
  type Arrangement,
} from "./arrangement";
import { sourceBars, type RegionLineage } from "./lineage";
import type { Grid } from "./snap";
import type { SessionTempo } from "./time";
import type { SessionRegion, SessionTrack } from "./types";

const NINETY: SessionTempo = { bpm: 90, beatsPerBar: 4 };
const BAR = (60 / 90) * 4; // 2.6666…
const BARS: Grid = { tempo: NINETY, snap: "bar" };
const FREE: Grid = { tempo: NINETY, snap: "off" };

function lineage(overrides: Partial<RegionLineage> = {}): RegionLineage {
  return {
    fileId: "file-1",
    fileName: "Masquerade",
    parentFileId: null,
    kind: "loop",
    stem: "drums",
    separationModel: "separator-a",
    separationModelLabel: "the strong separator",
    takeStartS: 8,
    takeEndS: 8 + BAR * 4,
    downbeatS: 8,
    sourceDurationS: 180,
    sourceBpm: 90,
    sourceBeatsPerBar: 4,
    cents: 0,
    stretch: 1,
    candidateId: "loop:abc",
    reason: "4 bars on the grid",
    confidence: 0.82,
    ...overrides,
  };
}

function region(overrides: Partial<SessionRegion> = {}): SessionRegion {
  return { id: "r1", trackId: "t1", sourceId: "file-1", startS: 0, durationS: BAR * 4, offsetS: 8, gain: 1, lineage: lineage(), ...overrides };
}

function track(id: string, name = id, overrides: Partial<SessionTrack> = {}): SessionTrack {
  return { id, name, gain: 1, muted: false, soloed: false, fileId: "file-1", origin: "candidate", provenance: null, ...overrides };
}

function song(regions: SessionRegion[] = [region()], tracks: SessionTrack[] = [track("t1", "Drums")]): Arrangement {
  return { tracks, regions };
}

group("reading the song", () => {
  it("knows how long it is and what is sounding when", () => {
    const arrangement = song([region({ id: "a", startS: 0, durationS: 4 }), region({ id: "b", startS: 10, durationS: 6 })]);
    expect(arrangementEnd(arrangement)).toBe(16);
    expect(regionsAt(arrangement, 2).map((r) => r.id)).toEqual(["a"]);
    expect(regionsAt(arrangement, 8)).toEqual([]);
    expect(regionsAt(arrangement, 15.999).map((r) => r.id)).toEqual(["b"]);
  });

  it("answers what is in a bar, which is the query a blob could not", () => {
    const arrangement: Arrangement = {
      tracks: [track("t1", "Drums"), track("t2", "Horns")],
      regions: [region({ id: "a", trackId: "t1", startS: 0, durationS: BAR * 20 }), region({ id: "b", trackId: "t2", startS: BAR * 16, durationS: BAR * 4 })],
    };
    expect(regionsInBar(arrangement, 17, NINETY).map((r) => r.id)).toEqual(["a", "b"]);
    expect(regionsInBar(arrangement, 3, NINETY).map((r) => r.id)).toEqual(["a"]);
    expect(regionsInBar(arrangement, 30, NINETY)).toEqual([]);
    expect(describeBar(arrangement, 17, NINETY)).toBe("bar 17: Drums (Masquerade, drums), Horns (Masquerade, drums).");
    expect(describeBar(arrangement, 30, NINETY)).toBe("nothing is in bar 30.");
  });

  it("refuses to name a bar when the session has no tempo, instead of guessing one", () => {
    expect(regionsInBar(song(), 4, null)).toEqual([]);
    expect(describeBar(song(), 4, null)).toContain("no measured tempo");
    expect(startBarOf(region(), null)).toBeNull();
    expect(startBarOf(region({ startS: BAR * 16 }), NINETY)).toBe(17);
  });

  it("puts a lane's material in timeline order whatever order it is stored in", () => {
    const arrangement = song([region({ id: "b", startS: 20 }), region({ id: "a", startS: 4 })]);
    expect(regionsOfTrack(arrangement, "t1").map((r) => r.id)).toEqual(["a", "b"]);
  });
});

group("moving", () => {
  it("slides the same audio along the timeline: the offset does not move", () => {
    const moved = moveRegion(song(), "r1", BAR * 16, { grid: BARS });
    const r = regionById(moved, "r1");
    expect(r?.startS).toBeCloseTo(BAR * 16, 9);
    expect(r?.offsetS).toBe(8);
    expect(r?.durationS).toBeCloseTo(BAR * 4, 9);
    expect(soundingSpan(r as SessionRegion)).toEqual(soundingSpan(region()));
  });

  it("lands on the grid the producer chose, not where the pointer was", () => {
    const nudged = moveRegion(song(), "r1", BAR * 16 + 0.4, { grid: BARS });
    expect(regionById(nudged, "r1")?.startS).toBeCloseTo(BAR * 16, 9);
    const free = moveRegion(song(), "r1", BAR * 16 + 0.4, { grid: FREE });
    expect(regionById(free, "r1")?.startS).toBeCloseTo(BAR * 16 + 0.4, 9);
  });

  it("never goes before the start of the session", () => {
    expect(regionById(moveRegion(song(), "r1", -40, { grid: FREE }), "r1")?.startS).toBe(0);
  });

  it("moves to another lane, and refuses a lane that does not exist", () => {
    const two = { tracks: [track("t1"), track("t2")], regions: [region()] };
    expect(regionById(moveRegion(two, "r1", 0, { grid: FREE, toTrackId: "t2" }), "r1")?.trackId).toBe("t2");
    expect(moveRegion(two, "r1", 20, { grid: FREE, toTrackId: "nope" })).toBe(two);
    expect(regionById(moveRegionToTrack(two, "r1", "t2"), "r1")?.trackId).toBe("t2");
    expect(moveRegionToTrack(two, "r1", "t1")).toBe(two);
  });

  it("returns the arrangement it was given when nothing would change", () => {
    const arrangement = song();
    expect(moveRegion(arrangement, "r1", 0, { grid: FREE })).toBe(arrangement);
    expect(moveRegion(arrangement, "missing", 4, { grid: FREE })).toBe(arrangement);
  });

  it("nudges by whole grid steps without pulling an off-grid region onto the grid", () => {
    const offGrid = song([region({ startS: 0.37 })]);
    const later = nudgeRegion(offGrid, "r1", 1, { grid: BARS });
    expect(regionById(later, "r1")?.startS).toBeCloseTo(0.37 + BAR, 9);
    const back = nudgeRegion(later, "r1", -1, { grid: BARS });
    expect(regionById(back, "r1")?.startS).toBeCloseTo(0.37, 9);
    expect(nudgeRegion(offGrid, "r1", 0, { grid: BARS })).toBe(offGrid);
  });
});

group("trimming the head", () => {
  it("moves the start, the offset and the duration together, so the audio does not slide", () => {
    const trimmed = trimHead(song(), "r1", BAR, { grid: BARS });
    const r = regionById(trimmed, "r1") as SessionRegion;
    expect(r.startS).toBeCloseTo(BAR, 9);
    expect(r.offsetS).toBeCloseTo(8 + BAR, 9); // a bar further into the record
    expect(r.durationS).toBeCloseTo(BAR * 3, 9);
    // the audio that is left sounds at exactly the same session seconds as before
    const before = region();
    expect(r.startS + (r.offsetS - before.offsetS) * 0 + 0).toBeCloseTo(BAR, 9);
    expect(soundingSpan(r).endS).toBeCloseTo(soundingSpan(before).endS, 9);
  });

  it("says the region is now later bars of the record, because it is", () => {
    const trimmed = trimHead(song(), "r1", BAR, { grid: BARS });
    const r = regionById(trimmed, "r1") as SessionRegion;
    expect(sourceBars(r, r.lineage)?.fromBar).toBe(2);
    expect(sourceBars(region(), lineage())?.fromBar).toBe(1);
  });

  it("advances the offset by delta times the rate when the region is resampled", () => {
    const resampled = song([region({ rate: 0.5, durationS: 20, offsetS: 10 })]);
    const trimmed = trimHead(resampled, "r1", 4, { grid: FREE });
    const r = regionById(trimmed, "r1") as SessionRegion;
    expect(r.startS).toBe(4);
    expect(r.offsetS).toBe(12); // 4 session seconds at 0.5x is 2 seconds of the record
    expect(r.durationS).toBe(16);
  });

  it("will not trim past the end of the region", () => {
    const trimmed = trimHead(song(), "r1", 1000, { grid: FREE });
    const r = regionById(trimmed, "r1") as SessionRegion;
    expect(r.durationS).toBeCloseTo(MIN_REGION_S, 9);
    expect(r.startS).toBeCloseTo(BAR * 4 - MIN_REGION_S, 9);
  });

  it("will not reveal audio before the start of the record", () => {
    // the region begins 8 s into the file, so it can only grow 8 s to the left
    const arrangement = song([region({ startS: 20 })]);
    const grown = trimHead(arrangement, "r1", 0, { grid: FREE });
    const r = regionById(grown, "r1") as SessionRegion;
    expect(r.startS).toBe(12);
    expect(r.offsetS).toBe(0);
    expect(limitsOf(region({ startS: 20 })).minStartS).toBe(12);
  });

  it("can grow the head back out and land exactly where it started", () => {
    const trimmed = trimHead(song([region({ startS: BAR * 4 })]), "r1", BAR * 5, { grid: BARS });
    const grown = trimHead(trimmed, "r1", BAR * 4, { grid: BARS });
    expect(sameRegion(regionById(grown, "r1") as SessionRegion, region({ startS: BAR * 4 }))).toBe(true);
  });
});

group("trimming the tail", () => {
  it("changes only the duration: the start and the offset do not move", () => {
    const trimmed = trimTail(song(), "r1", BAR * 2, { grid: BARS });
    const r = regionById(trimmed, "r1") as SessionRegion;
    expect(r.startS).toBe(0);
    expect(r.offsetS).toBe(8);
    expect(r.durationS).toBeCloseTo(BAR * 2, 9);
    expect(soundingSpan(r).startS).toBe(8); // the same audio, stopping sooner
  });

  it("says the region is now earlier bars of the record", () => {
    const trimmed = trimTail(song(), "r1", BAR * 2, { grid: BARS });
    const r = regionById(trimmed, "r1") as SessionRegion;
    expect(sourceBars(r, r.lineage)).toMatchObject({ fromBar: 1, toBar: 2 });
  });

  it("will not reveal audio past the end of the record", () => {
    // the region starts 8 s into a 180 s file, so it can sound at most 172 s
    const grown = trimTail(song(), "r1", 500, { grid: FREE });
    const r = regionById(grown, "r1") as SessionRegion;
    expect(r.durationS).toBeCloseTo(172, 9);
    expect(soundingSpan(r).endS).toBeCloseTo(180, 9);
    expect(limitsOf(region()).maxEndS).toBeCloseTo(172, 9);
  });

  it("does not clamp the tail when the record's length was never measured", () => {
    const unknown = song([region({ lineage: lineage({ sourceDurationS: null }) })]);
    expect(limitsOf(unknown.regions[0] as SessionRegion).maxEndS).toBeNull();
    expect(regionById(trimTail(unknown, "r1", 500, { grid: FREE }), "r1")?.durationS).toBe(500);
  });

  it("will not trim below a sounding length", () => {
    const trimmed = trimTail(song(), "r1", -5, { grid: FREE });
    expect(regionById(trimmed, "r1")?.durationS).toBeCloseTo(MIN_REGION_S, 9);
  });

  it("is not the same edit as trimming the head, which is the whole point", () => {
    const head = regionById(trimHead(song(), "r1", BAR, { grid: BARS }), "r1") as SessionRegion;
    const tail = regionById(trimTail(song(), "r1", BAR * 3, { grid: BARS }), "r1") as SessionRegion;
    expect(head.durationS).toBeCloseTo(tail.durationS, 9); // both are three bars long
    expect(head.offsetS).not.toBeCloseTo(tail.offsetS, 6); // and they are different three bars
    expect(head.startS).not.toBeCloseTo(tail.startS, 6);
  });
});

group("splitting", () => {
  it("cuts in two with no gap and no repeat, so playing across the join sounds like nothing happened", () => {
    const split = splitRegion(song(), "r1", BAR * 2, { grid: BARS });
    const [left, right] = regionsOfTrack(split, "t1");
    expect(split.regions).toHaveLength(2);
    expect(left?.durationS).toBeCloseTo(BAR * 2, 9);
    expect(right?.startS).toBeCloseTo(BAR * 2, 9);
    expect(right?.offsetS).toBeCloseTo(8 + BAR * 2, 9);
    expect((left?.startS ?? 0) + (left?.durationS ?? 0)).toBeCloseTo(right?.startS ?? 0, 9);
    expect(soundingSpan(left as SessionRegion).endS).toBeCloseTo(soundingSpan(right as SessionRegion).startS, 9);
  });

  it("advances the right half's offset by the rate when the region is resampled", () => {
    const split = splitRegion(song([region({ rate: 2, durationS: 10, offsetS: 0 })]), "r1", 4, { grid: FREE });
    const right = regionsOfTrack(split, "t1")[1] as SessionRegion;
    expect(right.offsetS).toBe(8); // four session seconds at 2x is eight of the record
  });

  it("gives both halves the lineage, with a fresh id for the new one", () => {
    const split = splitRegion(song(), "r1", BAR * 2, { grid: BARS });
    const [left, right] = regionsOfTrack(split, "t1");
    expect(left?.id).toBe("r1");
    expect(right?.id).toBe("r1~2");
    expect(right?.lineage?.fileName).toBe("Masquerade");
    expect(right?.lineage?.candidateId).toBe("loop:abc");
    expect(sourceBars(right as SessionRegion, right?.lineage)).toMatchObject({ fromBar: 3, toBar: 4 });
  });

  it("refuses a cut at or outside the edges rather than making a region of nothing", () => {
    const arrangement = song();
    expect(splitRegion(arrangement, "r1", 0, { grid: FREE })).toBe(arrangement);
    expect(splitRegion(arrangement, "r1", BAR * 4, { grid: FREE })).toBe(arrangement);
    expect(splitRegion(arrangement, "r1", -4, { grid: FREE })).toBe(arrangement);
    expect(splitRegion(arrangement, "missing", 1, { grid: FREE })).toBe(arrangement);
  });
});

group("copying", () => {
  it("lands the copy immediately after the original, so four bars become eight", () => {
    const copied = duplicateRegion(song(), "r1", { grid: BARS });
    const [first, second] = regionsOfTrack(copied, "t1");
    expect(second?.startS).toBeCloseTo(BAR * 4, 9);
    expect(second?.durationS).toBeCloseTo(first?.durationS ?? 0, 9);
    expect(second?.offsetS).toBe(first?.offsetS);
    expect(arrangementEnd(copied)).toBeCloseTo(BAR * 8, 9);
  });

  it("keeps the lineage on the copy: this is the line a normal DAW loses", () => {
    const copied = duplicateRegion(song(), "r1", { grid: BARS });
    const copy = regionsOfTrack(copied, "t1")[1] as SessionRegion;
    expect(copy.lineage).toEqual(lineage());
    expect(sourceBars(copy, copy.lineage)).toMatchObject({ fromBar: 1, toBar: 4 });
  });

  it("can be dropped somewhere else, on the grid", () => {
    const copied = duplicateRegion(song(), "r1", { grid: BARS, atS: BAR * 16 + 0.3 });
    expect(regionsOfTrack(copied, "t1")[1]?.startS).toBeCloseTo(BAR * 16, 9);
  });

  it("gives every copy its own id", () => {
    const twice = duplicateRegion(duplicateRegion(song(), "r1", { grid: BARS }), "r1", { grid: BARS, atS: BAR * 8 });
    expect(twice.regions.map((r) => r.id)).toEqual(["r1", "r1~2", "r1~3"]);
    expect(new Set(twice.regions.map((r) => r.id)).size).toBe(3);
    expect(nextRegionId(twice, "r1~2")).toBe("r1~4");
  });
});

group("lineage survives the lot", () => {
  it("still names the record after a move, a trim, a split and a copy", () => {
    let arrangement = song();
    arrangement = moveRegion(arrangement, "r1", BAR * 8, { grid: BARS });
    arrangement = trimHead(arrangement, "r1", BAR * 9, { grid: BARS });
    arrangement = splitRegion(arrangement, "r1", BAR * 10, { grid: BARS });
    arrangement = duplicateRegion(arrangement, "r1~2", { grid: BARS });
    expect(arrangement.regions).toHaveLength(3);
    for (const r of arrangement.regions) {
      expect(r.lineage?.fileName).toBe("Masquerade");
      expect(r.lineage?.stem).toBe("drums");
      expect(r.lineage?.separationModel).toBe("separator-a");
      expect(r.lineage?.takeStartS).toBe(8); // the take never changes; the sounding span does
    }
    // and the bars it now claims are the bars it now is
    const [first, second, third] = regionsOfTrack(arrangement, "t1");
    expect(sourceBars(first as SessionRegion, first?.lineage)).toMatchObject({ fromBar: 2, toBar: 2 });
    expect(sourceBars(second as SessionRegion, second?.lineage)).toMatchObject({ fromBar: 3, toBar: 4 });
    expect(sourceBars(third as SessionRegion, third?.lineage)).toEqual(sourceBars(second as SessionRegion, second?.lineage));
  });
});

group("region level and removal", () => {
  it("sets a region's own trim, clamped", () => {
    expect(regionById(setRegionGain(song(), "r1", 0.5), "r1")?.gain).toBe(0.5);
    expect(regionById(setRegionGain(song(), "r1", -3), "r1")?.gain).toBe(0);
    expect(regionById(setRegionGain(song(), "r1", 99), "r1")?.gain).toBe(4);
    const arrangement = song();
    expect(setRegionGain(arrangement, "r1", 1)).toBe(arrangement);
  });

  it("takes a region out and leaves the lane", () => {
    const gone = deleteRegion(song(), "r1");
    expect(gone.regions).toEqual([]);
    expect(gone.tracks).toHaveLength(1);
    const arrangement = song();
    expect(deleteRegion(arrangement, "missing")).toBe(arrangement);
  });
});

group("lanes", () => {
  it("adds a lane with its material, and replaces it when the same id comes back", () => {
    const one = addTrack({ tracks: [], regions: [] }, track("t1", "Drums"), [region()]);
    expect(one.tracks).toHaveLength(1);
    expect(one.regions).toHaveLength(1);
    const again = addTrack(one, track("t1", "Drums again"), [region({ id: "r2" })]);
    expect(again.tracks).toHaveLength(1);
    expect(again.regions.map((r) => r.id)).toEqual(["r2"]);
  });

  it("takes a lane out and its material with it", () => {
    const two: Arrangement = { tracks: [track("t1"), track("t2")], regions: [region({ id: "a", trackId: "t1" }), region({ id: "b", trackId: "t2" })] };
    const gone = removeTrack(two, "t1");
    expect(gone.tracks.map((t) => t.id)).toEqual(["t2"]);
    expect(gone.regions.map((r) => r.id)).toEqual(["b"]);
    expect(removeTrack(two, "missing")).toBe(two);
  });

  it("mutes, solos, renames and levels a lane without touching its material", () => {
    const arrangement = song();
    expect(setTrackMute(arrangement, "t1", true).tracks[0]?.muted).toBe(true);
    expect(setTrackSolo(arrangement, "t1", true).tracks[0]?.soloed).toBe(true);
    expect(setTrackGain(arrangement, "t1", 0.25).tracks[0]?.gain).toBe(0.25);
    expect(renameTrack(arrangement, "t1", " Horns ").tracks[0]?.name).toBe("Horns");
    expect(setTrackMute(arrangement, "t1", true).regions).toBe(arrangement.regions);
    expect(renameTrack(arrangement, "t1", "  ")).toBe(arrangement);
    expect(setTrackMute(arrangement, "t1", false)).toBe(arrangement);
  });

  it("restacks the lanes", () => {
    const three: Arrangement = { tracks: [track("a"), track("b"), track("c")], regions: [] };
    expect(moveTrack(three, "c", 0).tracks.map((t) => t.id)).toEqual(["c", "a", "b"]);
    expect(moveTrack(three, "a", 99).tracks.map((t) => t.id)).toEqual(["b", "c", "a"]);
    expect(moveTrack(three, "a", 0)).toBe(three);
    expect(moveTrack(three, "missing", 0)).toBe(three);
  });

  it("makes an empty lane to drop material onto", () => {
    const lane = emptyTrack("t9", "New lane");
    expect(lane).toMatchObject({ id: "t9", name: "New lane", gain: 1, muted: false, soloed: false });
  });
});

group("dragging", () => {
  it("moves by the grab point, so the region does not jump to the pointer", () => {
    const arrangement = song([region({ startS: 10 })]);
    const intent = dragIntentFor(arrangement.regions[0] as SessionRegion, "move", 13); // grabbed 3 s in
    expect(intent.grabOffsetS).toBe(3);
    const dropped = applyDrag(arrangement, intent, 23, { grid: FREE });
    expect(regionById(dropped, "r1")?.startS).toBe(20);
  });

  it("trims from the pointer, and a trim drag has no grab offset", () => {
    const arrangement = song();
    const head = applyDrag(arrangement, { kind: "trim-head", regionId: "r1", grabOffsetS: 0 }, BAR, { grid: BARS });
    expect(regionById(head, "r1")?.startS).toBeCloseTo(BAR, 9);
    const tail = applyDrag(arrangement, { kind: "trim-tail", regionId: "r1", grabOffsetS: 0 }, BAR * 2, { grid: BARS });
    expect(regionById(tail, "r1")?.durationS).toBeCloseTo(BAR * 2, 9);
    expect(dragIntentFor(arrangement.regions[0] as SessionRegion, "trim-tail", 99).grabOffsetS).toBe(0);
  });

  it("previews one region without touching the rest, which is what keeps a drag cheap", () => {
    const many: Arrangement = { tracks: [track("t1")], regions: Array.from({ length: 200 }, (_, i) => region({ id: `r${i}`, startS: i * 4 })) };
    const preview = previewDrag(many, { kind: "move", regionId: "r7", grabOffsetS: 1 }, 101, { grid: FREE });
    expect(preview?.id).toBe("r7");
    expect(preview?.startS).toBe(100);
    expect(many.regions[7]?.startS).toBe(28); // the arrangement itself is untouched
    expect(previewDrag(many, { kind: "move", regionId: "missing", grabOffsetS: 0 }, 1, { grid: FREE })).toBeNull();
  });

  it("previews a drag onto another lane", () => {
    const two: Arrangement = { tracks: [track("t1"), track("t2")], regions: [region()] };
    const preview = previewDrag(two, { kind: "move", regionId: "r1", grabOffsetS: 0, toTrackId: "t2" }, 8, { grid: FREE });
    expect(preview?.trackId).toBe("t2");
    expect(preview?.startS).toBe(8);
  });
});

group("the audition lane is not part of the song", () => {
  const snapshot = {
    tracks: [track("t1", "Drums"), { ...track("audition", "Auditioning something"), ephemeral: true }],
    regions: [region({ id: "a", trackId: "t1" }), region({ id: "x", trackId: "audition" })],
  };

  it("is held out of the arrangement, so undo does not walk back through auditions", () => {
    const arrangement = arrangementOf(snapshot);
    expect(arrangement.tracks.map((t) => t.id)).toEqual(["t1"]);
    expect(arrangement.regions.map((r) => r.id)).toEqual(["a"]);
  });

  it("comes back when the arrangement is handed to the engine", () => {
    const ephemeral = ephemeralOf(snapshot);
    expect(ephemeral.tracks.map((t) => t.id)).toEqual(["audition"]);
    const merged = withEphemeral(arrangementOf(snapshot), ephemeral);
    expect(merged.tracks.map((t) => t.id)).toEqual(["t1", "audition"]);
    expect(merged.regions.map((r) => r.id)).toEqual(["a", "x"]);
  });

  it("leaves the arrangement alone when nothing is auditioning", () => {
    const plain = arrangementOf({ tracks: [track("t1")], regions: [region()] });
    expect(withEphemeral(plain, { tracks: [], regions: [] })).toBe(plain);
  });

  it("drops a region whose lane is gone rather than keeping an orphan", () => {
    const orphaned = arrangementOf({ tracks: [track("t1")], regions: [region({ id: "a", trackId: "t1" }), region({ id: "b", trackId: "gone" })] });
    expect(orphaned.regions.map((r) => r.id)).toEqual(["a"]);
  });
});
