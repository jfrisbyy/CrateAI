// Lineage is the thing a normal DAW throws away, so these assertions are about
// survival: after a move, a trim, a split and a copy, can the region still say
// what it is — and does the part that an edit genuinely changed change with it?

import { describe as group, expect, it } from "vitest";
import {
  describeLineage,
  headroomS,
  laneProvenance,
  lineageFrom,
  lineageParts,
  rateCents,
  soundingSpan,
  sourceBars,
  type LineageSource,
  type RegionLineage,
} from "./lineage";
import type { SessionRegion } from "./types";

function source(overrides: Partial<LineageSource> = {}): LineageSource {
  return {
    id: "loop:abc",
    kind: "loop",
    audio: { fileId: "file-1", startS: 8, endS: 24, downbeatS: 8 },
    reason: "4 bars on the grid",
    confidence: 0.82,
    fileDurationS: 180,
    provenance: {
      fileId: "file-1",
      fileName: "Masquerade",
      parentFileId: null,
      stem: "drums",
      separationModel: "separator-a",
      separationModelLabel: "the strong separator",
    },
    ...overrides,
  };
}

function lineage(overrides: Partial<RegionLineage> = {}): RegionLineage {
  return { ...lineageFrom(source(), { sourceBpm: 90 }), ...overrides };
}

function region(overrides: Partial<SessionRegion> = {}): SessionRegion {
  return {
    id: "r1",
    trackId: "t1",
    sourceId: "file-1",
    startS: 0,
    durationS: 10.667,
    offsetS: 8,
    gain: 1,
    lineage: lineage(),
    ...overrides,
  };
}

group("what a region knows about itself", () => {
  it("carries the record, the stem, the separation and the take", () => {
    const l = lineageFrom(source(), { sourceBpm: 90 });
    expect(l.fileName).toBe("Masquerade");
    expect(l.stem).toBe("drums");
    expect(l.separationModel).toBe("separator-a");
    expect(l.takeStartS).toBe(8);
    expect(l.takeEndS).toBe(24);
    expect(l.downbeatS).toBe(8);
    expect(l.sourceDurationS).toBe(180);
    expect(l.candidateId).toBe("loop:abc");
    expect(l.reason).toBe("4 bars on the grid");
  });

  it("keeps the three transforms apart, because they are different things", () => {
    const l = lineageFrom(source(), { sourceBpm: 90, cents: 62, stretch: 0.964 });
    expect(l.cents).toBe(62);
    expect(l.stretch).toBe(0.964);
    // playback rate lives on the region, not here: it is resampling, not a render
    expect(Object.hasOwn(l, "rate")).toBe(false);
  });

  it("falls back to a plain file rather than inventing a kind", () => {
    expect(lineageFrom(source({ kind: "something-else" })).kind).toBe("file");
    expect(lineageFrom(source({ kind: "stem" })).kind).toBe("stem");
  });

  it("has no bars when the source has no measured tempo", () => {
    expect(sourceBars(region(), lineageFrom(source()))).toBeNull();
  });
});

group("which seconds of the record are sounding", () => {
  it("reads the offset and the duration, not the take", () => {
    expect(soundingSpan(region())).toEqual({ startS: 8, endS: 18.667 });
  });

  it("eats the source faster when the region is resampled", () => {
    // ten session seconds at 0.5x is five seconds of the record
    expect(soundingSpan({ startS: 0, durationS: 10, offsetS: 4, rate: 0.5 })).toEqual({ startS: 4, endS: 9 });
    expect(soundingSpan({ startS: 0, durationS: 10, offsetS: 4, rate: 2 })).toEqual({ startS: 4, endS: 24 });
  });

  it("reports the headroom a tail trim has left, and says nothing when the length is unknown", () => {
    expect(headroomS(region(), lineage())).toBeCloseTo(180 - 18.667, 6);
    expect(headroomS(region(), lineage({ sourceDurationS: null }))).toBeNull();
  });
});

group("naming the record's own bars", () => {
  // 90 BPM four-four: a bar is 2.6667 s. The take starts on the downbeat.
  it("counts bars from the downbeat, so bar 1 is the one", () => {
    const bars = sourceBars(region({ offsetS: 8, durationS: 10.6667 }), lineage());
    expect(bars).not.toBeNull();
    expect(bars?.fromBar).toBe(1);
    expect(bars?.toBar).toBe(4);
    expect(bars?.bars).toBe(4);
  });

  it("moves the bar numbers when the head is trimmed, because that is what changed", () => {
    // a bar off the front: offset advances one bar, duration loses one bar
    const trimmed = region({ offsetS: 8 + 2.6667, durationS: 10.6667 - 2.6667 });
    const bars = sourceBars(trimmed, lineage());
    expect(bars?.fromBar).toBe(2);
    expect(bars?.toBar).toBe(4);
    expect(bars?.bars).toBe(3);
  });

  it("does not move the bar numbers when the region is only moved", () => {
    const before = sourceBars(region({ startS: 0 }), lineage());
    const after = sourceBars(region({ startS: 96 }), lineage());
    expect(after).toEqual(before);
  });

  it("names a pickup honestly rather than clamping it to bar 1", () => {
    const pickup = region({ offsetS: 8 - 2.6667, durationS: 2.6667 });
    expect(sourceBars(pickup, lineage())?.fromBar).toBe(0);
  });

  it("counts bars of a record in a different metre", () => {
    const threeFour = lineage({ sourceBpm: 120, sourceBeatsPerBar: 3, downbeatS: 0 });
    // 120 BPM in three: a bar is 1.5 s. Four bars from the top.
    const bars = sourceBars({ startS: 0, durationS: 6, offsetS: 0 }, threeFour);
    expect(bars?.fromBar).toBe(1);
    expect(bars?.toBar).toBe(4);
  });
});

group("saying what it is", () => {
  it("puts the record, the stem, the bars and the separation in one line", () => {
    const line = describeLineage(region(), lineage());
    expect(line).toContain("Masquerade");
    expect(line).toContain("drums");
    expect(line).toContain("bars 1–4");
    expect(line).toContain("separated: separator-a");
  });

  it("reports the pitch a resample moves, in cents, the way the direction document asks", () => {
    const resampled = region({ rate: 0.964 });
    const parts = lineageParts(resampled, lineage());
    const rate = parts.find((p) => p.label.startsWith("×"));
    expect(rate?.label).toBe("×0.964");
    expect(rate?.detail).toContain("-63 cents");
  });

  it("reports a render's stretch and pitch separately from the resample", () => {
    const parts = lineageParts(region(), lineage({ cents: 62, stretch: 0.964 }));
    expect(parts.some((p) => p.label === "+62 cents")).toBe(true);
    expect(parts.some((p) => p.label === "stretched to 0.964")).toBe(true);
  });

  it("has a detail behind every label, so nothing is a bare number", () => {
    for (const part of lineageParts(region({ rate: 1.04 }), lineage({ cents: 5, stretch: 1.02 }))) {
      expect(part.detail.length).toBeGreaterThan(0);
    }
  });

  it("says so rather than pretending when a region has no lineage", () => {
    expect(describeLineage(region(), null)).toBe("no lineage");
  });

  it("gives the lane a line that a trim on one region cannot change", () => {
    expect(laneProvenance(lineage())).toBe("Masquerade, drums, separated: separator-a");
    expect(laneProvenance(null)).toBeNull();
  });
});

group("cents from a playback rate", () => {
  it("is zero at unity and an octave at double", () => {
    expect(rateCents(1)).toBe(0);
    expect(rateCents(2)).toBe(1200);
    expect(rateCents(0.5)).toBe(-1200);
    expect(rateCents(0)).toBe(0);
  });
});
