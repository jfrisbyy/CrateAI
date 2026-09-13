// The rack's contract, and the arithmetic behind "play this underneath what I
// already have". The tiling is the part a producer hears: if it is wrong the
// candidate comes in late, or drifts a little every bar, and the rack is worse
// than the ranked table it replaced.

import { describe as group, expect, it } from "vitest";
import { compatibility } from "@/lib/compat/theory";
import { emptyReport } from "@/lib/report/effective";
import type { FileRow, LoopRow, StemRow } from "@/lib/types/db";
import type { CompatMatch } from "@/lib/compat/matches";
import {
  AUDITION_TRACK_ID,
  auditionTrack,
  candidateFromLoop,
  candidateFromMatch,
  candidateLength,
  candidatesFromLoops,
  candidateAt,
  candidatesFromMatches,
  correctionFor,
  downbeatOf,
  fileLabel,
  fitTo,
  rackFromSearch,
  stepCandidate,
  tileCandidate,
  trackFromCandidate,
  vitalsOf,
  type RackCandidate,
} from "./rack";
import { contentEnd } from "./schedule";

function file(id: string, report: Partial<NonNullable<FileRow["report"]>> = {}, extra: Partial<FileRow> = {}): FileRow {
  return {
    id,
    user_id: "u",
    sha256: id,
    original_filename: `${id}.wav`,
    storage_path: `library/u/${id}.wav`,
    size_bytes: 1,
    duration_s: 180,
    sample_rate: 44100,
    channels: 2,
    format: "wav",
    kind: "original",
    parent_file_id: null,
    status: "ready",
    analysis_version: 1,
    report: emptyReport({
      tempo: { bpm: 92, confidence: 0.88, method: "onset autocorrelation", alternates_bpm: [46, 184], notes: null },
      key: { tonic: "F", mode: "minor", confidence: 0.74, method: "chroma profile", alternate: null, notes: null },
      beats: { times_s: [0.5, 1.15, 1.8, 2.45, 3.1], downbeats_s: [0.5, 3.1], meter: "4/4", confidence: 0.8, method: "beat tracker", notes: null, downbeat_phase: 0, downbeat_confidence: 0.7, downbeat_method: "beat tracker" },
      ...report,
    }),
    peaks: null,
    title: null,
    artist: null,
    created_at: "2026-09-13T00:00:00Z",
    updated_at: "2026-09-13T00:00:00Z",
    ...extra,
  };
}

function loop(id: string, partial: Partial<LoopRow> = {}): LoopRow {
  return {
    id,
    user_id: "u",
    file_id: "rec",
    start_s: 8,
    end_s: 16,
    bars: 4,
    score: 0.81,
    origin: "finder",
    components: { percussive: 0.72, loudness: 0.55 },
    name: null,
    render_file_id: null,
    created_at: "2026-09-13T00:00:00Z",
    ...partial,
  };
}

function stem(fileId: string, name = "drums", model = "bs_roformer"): StemRow {
  return { id: `s-${fileId}`, user_id: "u", file_id: "parent", stem: name, model, stem_file_id: fileId, created_at: "2026-09-13T00:00:00Z" };
}

function candidate(partial: Partial<RackCandidate> = {}): RackCandidate {
  return {
    id: "c1",
    title: "a break",
    kind: "loop",
    audio: { fileId: "rec", startS: 0, endS: 8, downbeatS: 2 },
    reason: "4 bars on the grid",
    confidence: 0.8,
    confidenceReason: null,
    measurements: [],
    provenance: { fileId: "rec", fileName: "rec", startS: 0, endS: 8, kind: "original", stem: null, separationModel: null, separationModelLabel: null, parentFileId: null },
    peaks: null,
    fileDurationS: 180,
    sourceBpm: null,
    fit: null,
    rank: 1,
    ...partial,
  };
}

group("where a candidate starts", () => {
  it("starts on the first downbeat, not at the file's zero", () => {
    expect(downbeatOf(file("rec"))).toBe(0.5);
  });

  it("takes the first downbeat at or after a span's start", () => {
    expect(downbeatOf(file("rec"), 1)).toBe(3.1);
  });

  it("falls back to a beat, then to the span's start, when there are no downbeats", () => {
    const noDownbeats = file("rec", { beats: { times_s: [0.9, 1.4], downbeats_s: [], meter: "4/4", confidence: 0.5, method: "m", notes: null, downbeat_phase: 0, downbeat_confidence: 0.2, downbeat_method: "none" } });
    expect(downbeatOf(noDownbeats)).toBe(0.9);
    expect(downbeatOf(file("rec", { beats: null }), 4)).toBe(4);
  });

  it("uses the loop's own start, which the finder already put on the grid", () => {
    const c = candidateFromLoop(file("rec"), loop("l1"), 1);
    expect(c.audio.downbeatS).toBe(8);
    expect(c.audio.endS).toBe(16);
  });
});

group("what a row says for itself", () => {
  it("carries the measurement, the confidence and the provenance of a found loop", () => {
    const c = candidateFromLoop(file("rec"), loop("l1"), 2, null, stem("rec"));
    expect(c.reason).toBe("4 bars on the grid");
    expect(c.confidence).toBe(0.81);
    expect(c.measurements.map((m) => m.label)).toEqual(["92.0 BPM", "loop score 0.81", "percussive 0.72", "loudness 0.55"]);
    expect(c.measurements[0]?.confidence).toBe(0.88);
    expect(c.provenance).toMatchObject({ fileId: "rec", startS: 8, endS: 16, stem: "drums", separationModel: "bs_roformer" });
    expect(c.provenance.separationModelLabel).toContain("BS-RoFormer");
    expect(c.rank).toBe(2);
  });

  it("ranks found loops by the finder's score and numbers them from one", () => {
    const rows = candidatesFromLoops(file("rec"), [loop("a", { score: 0.4 }), loop("b", { score: 0.9 }), loop("c", { score: 0.6 })]);
    expect(rows.map((r) => r.id)).toEqual(["loop:b", "loop:c", "loop:a"]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("turns a Fits-with match into a playable row with the same words the panel uses", () => {
    const source = vitalsOf(file("open"));
    const other = file("other", { tempo: { bpm: 96, confidence: 0.8, method: "m", alternates_bpm: [], notes: null } });
    const c: CompatMatch = { ...compatibility(source, vitalsOf(other)), file: other, timbre: 0.62 };
    const row = candidateFromMatch(c, 1);
    expect(row.reason).toBe(c.reason);
    expect(row.confidence).toBe(c.confidence);
    expect(row.confidenceReason).toBe(c.confidence_reason);
    expect(row.measurements.some((m) => m.label.includes("96.0 BPM"))).toBe(true);
    expect(row.measurements.some((m) => m.label.includes("% to fit"))).toBe(true);
    expect(row.measurements.some((m) => m.label === "62% alike")).toBe(true);
    expect(row.audio.downbeatS).toBe(0.5); // the other record's downbeat, not its zero
    expect(row.fit?.rate).toBeCloseTo(92 / 96, 9);
  });

  it("numbers a whole rack of matches in the order the ranking gave", () => {
    const source = vitalsOf(file("open"));
    const matches = ["a", "b", "c"].map((id) => ({ ...compatibility(source, vitalsOf(file(id))), file: file(id), timbre: null }) as CompatMatch);
    expect(candidatesFromMatches(matches, [stem("b")]).map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(candidatesFromMatches(matches, [stem("b")])[1]?.provenance.separationModel).toBe("bs_roformer");
  });

  it("names a file by its title and artist when it has them", () => {
    expect(fileLabel(file("x", {}, { title: "Masquerade", artist: "the band" }))).toBe("the band — Masquerade");
    expect(fileLabel(file("x", {}, { original_filename: "break loop.wav" }))).toBe("break loop");
  });
});

group("the crate as a rack", () => {
  it("turns a search hit into a row that says what matched", () => {
    const hit = { file: file("break", { tags: [{ tag: "drums", confidence: 0.9, source: "model" as const }] }), matched: { tags: ["drums"], has_drums: true, similarity: 0.71 } };
    const rack = rackFromSearch("drums", [hit], null, "vector", null);
    expect(rack.origin).toBe("search");
    expect(rack.title).toContain("drums");
    expect(rack.candidates).toHaveLength(1);
    const row = rack.candidates[0]!;
    expect(row.reason).toBe("drums · has drums");
    expect(row.confidence).toBe(0.71);
    expect(row.confidenceReason).toContain("similarity");
    expect(row.measurements.some((m) => m.label === "71% alike")).toBe(true);
    expect(row.audio.downbeatS).toBe(0.5);
  });

  it("fits every row to the session when the session has a tempo", () => {
    const session = { bpm: 96, bpm_confidence: 0.9, tonic: null, mode: null, key_confidence: null };
    const rack = rackFromSearch("drums", [{ file: file("break"), matched: {} }], null, "filters", session);
    expect(rack.candidates[0]?.fit?.rate).toBeCloseTo(96 / 92, 9);
    expect(rack.candidates[0]?.measurements.some((m) => m.label.includes("% to fit"))).toBe(true);
  });

  it("says a hit matched the filters when nothing else explains it", () => {
    const rack = rackFromSearch("", [{ file: file("x"), matched: {} }], "no embeddings yet", "filters");
    expect(rack.candidates[0]?.reason).toBe("in the crate");
    expect(rack.note).toBe("no embeddings yet");
    expect(rack.method).toContain("filters");
  });
});

group("stepping through a rack", () => {
  it("walks forward and back, and stops at the ends", () => {
    const rack = rackFromSearch("drums", ["a", "b", "c"].map((id) => ({ file: file(id), matched: {} })), null, "filters");
    const first = rack.candidates[0]!;
    expect(stepCandidate(rack, null, 1)?.id).toBe(first.id);
    expect(stepCandidate(rack, first, 1)?.id).toBe(rack.candidates[1]!.id);
    expect(stepCandidate(rack, rack.candidates[2]!, 1)).toBeNull();
    expect(stepCandidate(rack, first, -1)).toBeNull();
    expect(candidateAt(rack, 3)?.id).toBe(rack.candidates[2]!.id);
    expect(candidateAt(rack, 9)).toBeNull();
    expect(candidateAt(null, 1)).toBeNull();
  });
});

group("fitting to the session", () => {
  it("says plainly when nothing has to change", () => {
    const fit = fitTo({ bpm: 92, bpm_confidence: 0.9, tonic: null, mode: null, key_confidence: null }, vitalsOf(file("rec")));
    expect(fit.rate).toBeCloseTo(1, 9);
    expect(fit.note).toBe("already in tempo");
  });

  it("gives the ratio and the percentage a producer reads", () => {
    const fit = fitTo({ bpm: 96, bpm_confidence: 0.9, tonic: null, mode: null, key_confidence: null }, vitalsOf(file("rec")));
    expect(fit.rate).toBeCloseTo(96 / 92, 9);
    expect(fit.note).toBe("+4.3% to fit");
  });

  it("counts a half-time record as the same grid", () => {
    const fit = fitTo({ bpm: 174, bpm_confidence: 0.9, tonic: null, mode: null, key_confidence: null }, { bpm: 87, bpm_confidence: 0.8, tonic: null, mode: null, key_confidence: null });
    expect(fit.rate).toBeCloseTo(1, 9); // 87 doubled is 174: no stretch at all
  });

  it("does not invent a fit when either side has no tempo", () => {
    const fit = fitTo(null, vitalsOf(file("rec")));
    expect(fit.rate).toBe(1);
    expect(fit.note).toBe("plays at its own tempo");
    expect(fit.quality).toBe("unknown");
  });
});

group("tiling a candidate under the session", () => {
  it("fills the loop from the candidate's downbeat, with the last repeat cut at the locator", () => {
    const plan = tileCandidate({ candidate: candidate(), trackId: AUDITION_TRACK_ID, span: { startS: 0, endS: 16 } });
    expect(plan.cycleS).toBe(6); // 8 s of file from a downbeat at 2 s
    expect(plan.repeats).toBe(3);
    expect(plan.regions.map((r) => r.startS)).toEqual([0, 6, 12]);
    expect(plan.regions.map((r) => r.durationS)).toEqual([6, 6, 4]);
    expect(new Set(plan.regions.map((r) => r.offsetS))).toEqual(new Set([2])); // every repeat from the downbeat
    expect(contentEnd(plan.regions)).toBe(16); // exactly the loop, no overhang
  });

  it("leaves no gap between repeats", () => {
    const plan = tileCandidate({ candidate: candidate(), trackId: "t", span: { startS: 4, endS: 20 } });
    for (let i = 1; i < plan.regions.length; i++) {
      const previous = plan.regions[i - 1]!;
      expect(plan.regions[i]!.startS).toBeCloseTo(previous.startS + previous.durationS, 9);
    }
    expect(plan.regions[0]?.startS).toBe(4);
  });

  it("shortens the cycle when the candidate is resampled to fit", () => {
    const c = candidate({ fit: { rate: 2, note: "double-time", quality: "transparent", semitones: 0, confidence: 0.8 } });
    expect(candidateLength(c)).toBe(3);
    const plan = tileCandidate({ candidate: c, trackId: "t", span: { startS: 0, endS: 6 } });
    expect(plan.cycleS).toBe(3);
    expect(plan.regions.every((r) => r.rate === 2)).toBe(true);
  });

  it("can be told to play the candidate raw, whatever the fit says", () => {
    const c = candidate({ fit: { rate: 1.5, note: "+50%", quality: "out_of_range", semitones: 0, confidence: 0.5 } });
    const plan = tileCandidate({ candidate: c, trackId: "t", span: { startS: 0, endS: 12 }, rate: 1 });
    expect(plan.cycleS).toBe(6);
    expect(plan.regions.every((r) => r.rate === 1)).toBe(true);
  });

  it("produces nothing for an empty span or an empty candidate", () => {
    expect(tileCandidate({ candidate: candidate(), trackId: "t", span: { startS: 4, endS: 4 } }).regions).toEqual([]);
    const empty = candidate({ audio: { fileId: "rec", startS: 0, endS: 2, downbeatS: 2 } });
    expect(tileCandidate({ candidate: empty, trackId: "t", span: { startS: 0, endS: 8 } }).regions).toEqual([]);
  });

  it("gives every region a distinct id on the lane it was asked for", () => {
    const plan = tileCandidate({ candidate: candidate(), trackId: AUDITION_TRACK_ID, span: { startS: 0, endS: 16 } });
    expect(new Set(plan.regions.map((r) => r.id)).size).toBe(plan.regions.length);
    expect(plan.regions.every((r) => r.trackId === AUDITION_TRACK_ID)).toBe(true);
    expect(plan.regions.every((r) => r.sourceId === "rec")).toBe(true);
  });
});

group("committing and correcting", () => {
  it("makes a lane that still knows where its audio came from", () => {
    const c = candidateFromLoop(file("rec", {}, { title: "Masquerade" }), loop("l1"), 1, null, stem("rec"));
    const track = trackFromCandidate(c, "track-1");
    expect(track.origin).toBe("candidate");
    expect(track.fileId).toBe("rec");
    expect(track.provenance).toBe("Masquerade, drums, 0:08–0:16");
  });

  it("keeps the audition lane ephemeral and always the same lane", () => {
    const a = auditionTrack(candidate({ id: "one" }));
    const b = auditionTrack(candidate({ id: "two" }));
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(AUDITION_TRACK_ID);
    expect(a.ephemeral).toBe(true);
    expect(a.origin).toBe("audition");
  });

  it("records picking the third row over the first as a correction", () => {
    const c = candidate({ id: "c3", rank: 3 });
    expect(correctionFor(c, "commit", "2026-09-13T12:00:00Z")).toEqual({ candidateId: "c3", predictedRank: 3, action: "commit", topRank: 1, at: "2026-09-13T12:00:00Z" });
  });
});
