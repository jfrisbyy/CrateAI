// Turning the timeline into an export request: what travels, what is derived,
// and what the panel can refuse before anything is queued.

import { describe, expect, it } from "vitest";
import type { RegionLineage } from "@/lib/session/lineage";
import type { SessionRegion, SessionTrack } from "@/lib/session/types";
import {
  buildExportRequest,
  bpmToken,
  estimateBytes,
  estimateExport,
  exportFolderName,
  exportZipName,
  exportedTracks,
  heldBackTracks,
  referencedFileIds,
  regionToWire,
  safeToken,
  songKeyOf,
  songLengthS,
  tracksToWire,
} from "./song";
import { EXPORT_CAP_BYTES } from "./types";

const FILE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FILE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function lineage(over: Partial<RegionLineage> = {}): RegionLineage {
  return {
    fileId: FILE_A,
    fileName: "Masquerade",
    parentFileId: null,
    kind: "stem",
    stem: "drums",
    separationModel: "roformer-x",
    separationModelLabel: "the strong separator",
    takeStartS: 24.13,
    takeEndS: 34.56,
    downbeatS: 0.31,
    sourceDurationS: 180,
    sourceBpm: 95.4,
    sourceBeatsPerBar: 4,
    cents: 0,
    stretch: 1,
    candidateId: "c1",
    reason: "relative minor, 2% faster",
    confidence: 0.86,
    ...over,
  };
}

function track(over: Partial<SessionTrack> = {}): SessionTrack {
  return { id: "t1", name: "Drums", gain: 0.8, muted: false, soloed: false, fileId: FILE_A, origin: "candidate", provenance: "Masquerade, drums", ...over };
}

function region(over: Partial<SessionRegion> = {}): SessionRegion {
  return { id: "r1", trackId: "t1", sourceId: FILE_A, startS: 0, durationS: 10.43, offsetS: 24.13, gain: 1, rate: 0.964, lineage: lineage(), ...over };
}

const arrangement = { tracks: [track()], regions: [region()] };

describe("what travels", () => {
  it("carries the region's lineage line, derived by lib/session/lineage", () => {
    const wire = regionToWire(region());
    expect(wire.lineage_line).toContain("Masquerade");
    expect(wire.lineage_line).toContain("drums");
    expect(wire.lineage_line).toContain("roformer-x");
    expect(wire.lineage?.separation_model).toBe("roformer-x");
    expect(wire.lineage?.take_start_s).toBe(24.13);
  });

  it("carries the record's own bars, recomputed from what is sounding now", () => {
    const bars = regionToWire(region()).source_bars;
    expect(bars).not.toBeNull();
    // 24.13 s into a 95.4 BPM record whose downbeat is at 0.31 s
    expect(bars!.from_bar).toBeGreaterThan(1);
    expect(bars!.to_bar).toBeGreaterThanOrEqual(bars!.from_bar);
  });

  it("a trim changes the bars the region claims", () => {
    const whole = regionToWire(region()).source_bars!;
    const trimmed = regionToWire(region({ offsetS: 24.13 + 2.5, durationS: 10.43 - 2.5 })).source_bars!;
    expect(trimmed.from_bar).toBeGreaterThan(whole.from_bar);
  });

  it("a region with no lineage says so instead of inventing one", () => {
    const wire = regionToWire(region({ lineage: undefined }));
    expect(wire.lineage).toBeNull();
    expect(wire.lineage_line).toBeNull();
    expect(wire.source_bars).toBeNull();
  });

  it("keeps the producer's lane order as the export's position", () => {
    const tracks = tracksToWire({
      tracks: [track({ id: "t2", name: "Bass" }), track({ id: "t1", name: "Drums" })],
      regions: [region({ id: "r2", trackId: "t2" }), region()],
    });
    expect(tracks.map((t) => [t.name, t.position])).toEqual([["Bass", 0], ["Drums", 1]]);
  });

  it("leaves the audition lane out of the song entirely", () => {
    const tracks = tracksToWire({
      tracks: [track(), track({ id: "audition", name: "Audition", ephemeral: true })],
      regions: [region(), region({ id: "r9", trackId: "audition" })],
    });
    expect(tracks.map((t) => t.id)).toEqual(["t1"]);
  });

  it("a region with no rate travels at 1, not undefined", () => {
    expect(regionToWire(region({ rate: undefined })).rate).toBe(1);
  });

  it("names every record the song is built from, once each", () => {
    const request = buildExportRequest({
      tracks: [track(), track({ id: "t2", name: "Horns", fileId: FILE_B })],
      regions: [region(), region({ id: "r2", trackId: "t2", sourceId: FILE_B }), region({ id: "r3", trackId: "t1" })],
    });
    expect(referencedFileIds(request.song)).toEqual([FILE_A, FILE_B]);
  });
});

describe("mute, solo and gain", () => {
  it("a muted lane is held back and named, not silently dropped", () => {
    const tracks = tracksToWire({
      tracks: [track(), track({ id: "t2", name: "Horns", muted: true })],
      regions: [region(), region({ id: "r2", trackId: "t2" })],
    });
    expect(exportedTracks(tracks).map((t) => t.name)).toEqual(["Drums"]);
    expect(heldBackTracks(tracks)).toEqual([{ track: tracks[1], reason: "muted" }]);
  });

  it("solo decides what is in the zip, and mute wins on its own lane", () => {
    const tracks = tracksToWire({
      tracks: [track({ soloed: true }), track({ id: "t2", name: "Bass" }), track({ id: "t3", name: "Horns", soloed: true, muted: true })],
      regions: [region(), region({ id: "r2", trackId: "t2" }), region({ id: "r3", trackId: "t3" })],
    });
    expect(exportedTracks(tracks).map((t) => t.name)).toEqual(["Drums"]);
    expect(heldBackTracks(tracks).map((h) => [h.track.name, h.reason])).toEqual([["Bass", "not soloed"], ["Horns", "muted"]]);
  });

  it("include_muted brings every lane back at its own fader", () => {
    const tracks = tracksToWire({
      tracks: [track(), track({ id: "t2", name: "Horns", muted: true, gain: 0.5 })],
      regions: [region(), region({ id: "r2", trackId: "t2" })],
    });
    expect(exportedTracks(tracks, true)).toHaveLength(2);
    expect(heldBackTracks(tracks, true)).toEqual([]);
    expect(exportedTracks(tracks, true)[1]!.gain).toBe(0.5);
  });

  it("lane gain travels clamped the way the fader clamps it", () => {
    expect(tracksToWire({ tracks: [track({ gain: 99 })], regions: [region()] })[0]!.gain).toBe(4);
    expect(tracksToWire({ tracks: [track({ gain: -1 })], regions: [region()] })[0]!.gain).toBe(0);
  });
});

describe("the key, attributed rather than asserted", () => {
  const keyOf = (id: string) => (id === FILE_A ? { tonic: "F", mode: "minor" as const } : null);

  it("takes the first exported lane with a measured key and says which record", () => {
    const tracks = tracksToWire(arrangement);
    expect(songKeyOf(tracks, keyOf)).toEqual({ tonic: "F", mode: "minor", from_file_id: FILE_A, from_file_name: "Masquerade" });
  });

  it("is null when no lane's record has a measured key", () => {
    expect(songKeyOf(tracksToWire(arrangement), () => null)).toBeNull();
    expect(songKeyOf(tracksToWire(arrangement))).toBeNull();
  });

  it("never reads a key off a lane that is not being exported", () => {
    const tracks = tracksToWire({
      tracks: [track({ id: "t2", name: "Horns", fileId: FILE_B }), track()],
      regions: [region({ id: "r2", trackId: "t2", sourceId: FILE_B, lineage: lineage({ fileName: "Moonlight" }) }), region()],
    });
    const request = buildExportRequest(
      { tracks: [track({ id: "t2", name: "Horns", muted: true }), track()], regions: [region({ id: "r2", trackId: "t2", sourceId: FILE_B }), region()] },
      { keyOf: (id) => (id === FILE_B ? { tonic: "C", mode: "major" } : { tonic: "F", mode: "minor" }) },
    );
    expect(tracks).toHaveLength(2);
    expect(request.song.key?.tonic).toBe("F");
  });
});

describe("naming", () => {
  it("names the folder and the zip after the song, its tempo and its key", () => {
    const song = { name: "Midnight Flip", bpm: 92, key: { tonic: "F", mode: "minor" as const, from_file_id: null, from_file_name: null } };
    expect(exportFolderName(song)).toBe("Midnight-Flip_92bpm_Fm");
    expect(exportZipName(song)).toBe("Midnight-Flip_92bpm_Fm_stems.zip");
  });

  it("leaves out a tempo or key nobody measured", () => {
    expect(exportFolderName({ name: "Sketch", bpm: null, key: null })).toBe("Sketch");
  });

  it("spells the key the way the rest of the product spells it", () => {
    expect(exportFolderName({ name: "S", bpm: null, key: { tonic: "D#", mode: "major", from_file_id: null, from_file_name: null } })).toBe("S_Eb");
    expect(exportFolderName({ name: "S", bpm: null, key: { tonic: "C#", mode: "minor", from_file_id: null, from_file_name: null } })).toBe("S_C#m");
  });

  it("prints a tempo that is not a whole number to one decimal", () => {
    expect(bpmToken(92)).toBe("92bpm");
    expect(bpmToken(92.5)).toBe("92.5bpm");
    expect(bpmToken(91.98)).toBe("92bpm");
  });

  it("makes a filename out of anything and never a path", () => {
    expect(safeToken("Horns / Trumpet (take 2)")).toBe("Horns-Trumpet-take-2");
    expect(safeToken("")).toBe("track");
    expect(safeToken("../../etc/passwd")).toBe("etc-passwd");
  });
});

describe("the estimate the panel shows", () => {
  const bigSong = (lanes: number, seconds: number) => ({
    tracks: Array.from({ length: lanes }, (_, i) => track({ id: `t${i}`, name: `L${i}` })),
    regions: Array.from({ length: lanes }, (_, i) => region({ id: `r${i}`, trackId: `t${i}`, durationS: seconds })),
  });

  it("agrees with the compute side's arithmetic", () => {
    // ten lanes, four minutes, 24-bit stereo at 44.1 kHz
    expect(estimateBytes(10, 240, 44100, 24, "wav")).toBe(635_040_000);
    expect(estimateBytes(10, 240, 44100, 24, "flac")).toBeLessThan(estimateBytes(10, 240, 44100, 24, "wav"));
    expect(estimateBytes(10, 240, 44100, 16, "flac")).toBeLessThan(estimateBytes(10, 240, 44100, 24, "flac"));
  });

  it("the hard case in the brief fits", () => {
    const request = buildExportRequest(bigSong(10, 240), { bpm: 92 });
    const estimate = estimateExport(request);
    expect(estimate.tracks).toBe(10);
    expect(estimate.length_s).toBe(240);
    expect(estimate.over_cap).toBe(false);
    expect(estimate.blocked).toBeNull();
    expect(estimate.bytes).toBeLessThan(EXPORT_CAP_BYTES);
  });

  it("blocks what the job would refuse, with the same reason", () => {
    const request = buildExportRequest(bigSong(20, 890), { bpm: 92, format: "wav" });
    const estimate = estimateExport(request);
    expect(estimate.over_cap).toBe(true);
    expect(estimate.blocked).toContain("cap is");
    expect(estimate.blocked).toContain("FLAC");
  });

  it("says there is nothing to export before anything is on the timeline", () => {
    expect(estimateExport(buildExportRequest({ tracks: [], regions: [] })).blocked).toContain("nothing on the timeline");
  });

  it("says when every lane is muted", () => {
    const request = buildExportRequest({ tracks: [track({ muted: true })], regions: [region()] });
    expect(estimateExport(request).blocked).toContain("Every lane is muted");
  });

  it("measures the song's length from the furthest region on any lane", () => {
    const tracks = tracksToWire({
      tracks: [track(), track({ id: "t2", name: "Horns" })],
      regions: [region({ durationS: 4 }), region({ id: "r2", trackId: "t2", startS: 20, durationS: 8 })],
    });
    expect(songLengthS(tracks)).toBe(28);
  });
});

describe("the request as a whole", () => {
  it("is the shape the route validates, with the defaults the product chose", () => {
    const request = buildExportRequest(arrangement, { name: "Midnight Flip", bpm: 92, masterGain: 0.8 });
    expect(request.format).toBe("flac");
    expect(request.bit_depth).toBe(24);
    expect(request.sample_rate).toBe(44100);
    expect(request.include_muted).toBe(false);
    expect(request.song.name).toBe("Midnight Flip");
    expect(request.song.bpm).toBe(92);
    expect(request.song.beats_per_bar).toBe(4);
    expect(request.song.master_gain).toBe(0.8);
  });

  it("a session with no tempo travels with a null bpm rather than a guess", () => {
    const request = buildExportRequest(arrangement, { bpm: null });
    expect(request.song.bpm).toBeNull();
  });

  it("an unnamed song still has a name", () => {
    expect(buildExportRequest(arrangement).song.name).toBe("Untitled song");
    expect(buildExportRequest(arrangement, { name: "   " }).song.name).toBe("Untitled song");
  });
});
