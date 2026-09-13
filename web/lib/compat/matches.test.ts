// The layer between the database's coarse candidate set and the panel: reading a
// file's effective vitals, comparing CLAP embeddings, and ranking.

import { describe as group, expect, it } from "vitest";
import { emptyReport } from "@/lib/report/effective";
import type { FileRow } from "@/lib/types/db";
import {
  buildMatches,
  cosine,
  fileName,
  measuredAxes,
  parseVector,
  rankMatches,
  timbreSimilarity,
  vitalsFromFile,
  type CompatMatch,
  type EmbeddingLike,
} from "./matches";

function file(id: string, report: Partial<NonNullable<FileRow["report"]>> = {}, extra: Partial<FileRow> = {}): FileRow {
  return {
    id,
    user_id: "u",
    sha256: id,
    original_filename: `${id}.wav`,
    storage_path: `library/u/${id}.wav`,
    size_bytes: 1,
    duration_s: 10,
    sample_rate: 44100,
    channels: 2,
    format: "wav",
    kind: "original",
    parent_file_id: null,
    status: "ready",
    analysis_version: 1,
    report: emptyReport({
      tempo: { bpm: 90, confidence: 0.9, method: "t", alternates_bpm: [45, 180], notes: null },
      key: { tonic: "C", mode: "minor", confidence: 0.8, method: "k", alternate: null, notes: null },
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

group("vitals", () => {
  it("reads tempo and key with their confidences", () => {
    const vitals = vitalsFromFile(file("a"));
    expect(vitals).toMatchObject({ bpm: 90, bpm_confidence: 0.9, tonic: "C", mode: "minor", key_confidence: 0.8 });
  });

  it("lets a user's correction win over the prediction", () => {
    const corrected = file("a", {
      user_edits: { tempo_bpm: 88, key: { tonic: "G", mode: "minor" }, downbeat_phase: null, first_downbeat_s: null, meter: null, section_labels: null, edited_at: null },
    });
    const vitals = vitalsFromFile(corrected);
    expect(vitals.bpm).toBe(88);
    expect(vitals.tonic).toBe("G");
  });

  it("reports a missing key as missing, not as C major", () => {
    const vitals = vitalsFromFile(file("break", { key: null }));
    expect(vitals.tonic).toBeNull();
    expect(vitals.key_confidence).toBeNull();
  });

  it("has no report at all before analysis", () => {
    expect(vitalsFromFile(file("x", {}, { report: null, status: "queued" })).bpm).toBeNull();
  });

  it("treats drum material as keyless, whatever its chroma read", () => {
    const tagged = file("break", { tags: [{ tag: "drums", confidence: 0.9, source: "model" }] });
    expect(vitalsFromFile(tagged).tonal).toBe(false);
    const stem = file("stem", {}, { kind: "stem", original_filename: "Drums.wav" });
    expect(vitalsFromFile(stem).tonal).toBe(false);
    expect(vitalsFromFile(file("rhodes")).tonal).toBe(true);
    const match = buildMatches(file("source"), [tagged], new Map())[0] as CompatMatch;
    expect(match.key.relationship).toBe("unknown");
    expect(match.reason).toBe("no key detected, tempo only");
    expect(match.key.note).toContain("non-tonal");
  });
});

group("timbre", () => {
  it("parses pgvector text and arrays, and refuses anything else", () => {
    expect(parseVector("[1, 2,3]")).toEqual([1, 2, 3]);
    expect(parseVector([0.5, -0.5])).toEqual([0.5, -0.5]);
    expect(parseVector("[]")).toBeNull();
    expect(parseVector("nope")).toBeNull();
    expect(parseVector(null)).toBeNull();
    expect(parseVector("[1,x]")).toBeNull();
  });

  it("is a cosine, bounded and length-checked", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 12);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 12);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 12);
    expect(cosine([1, 0], [1, 0, 0])).toBeNull();
    expect(cosine([0, 0], [1, 0])).toBeNull();
  });

  it("compares only vectors from the same model", () => {
    const rows: EmbeddingLike[] = [
      { file_id: "src", model: "clap-a", vector: "[1,0]" },
      { file_id: "same", model: "clap-a", vector: "[1,0]" },
      { file_id: "other", model: "clap-b", vector: "[1,0]" },
    ];
    const out = timbreSimilarity("src", rows);
    expect(out.get("same")).toBeCloseTo(1, 12);
    expect(out.has("other")).toBe(false);
  });

  it("gives a file with no embedding nothing, not a zero", () => {
    const out = timbreSimilarity("src", [{ file_id: "src", model: "m", vector: "[1,0]" }]);
    expect(out.size).toBe(0);
  });

  it("returns nothing at all when the source has no embedding", () => {
    expect(timbreSimilarity("src", [{ file_id: "b", model: "m", vector: "[1,0]" }]).size).toBe(0);
  });
});

group("building and ranking", () => {
  it("scores every candidate, drops the ones outside the bands, and explains the rest", () => {
    const source = file("source");
    const candidates = [
      file("same_key", {}),
      file("relative", { key: { tonic: "D#", mode: "major", confidence: 0.8, method: "k", alternate: null, notes: null } }),
      file("way_off", { tempo: { bpm: 140, confidence: 0.9, method: "t", alternates_bpm: [70, 280], notes: null } }),
      file("break", { key: null }),
    ];
    const matches = buildMatches(source, candidates, new Map());
    expect(matches.map((m) => m.file.id)).not.toContain("way_off");
    expect(matches[0]?.file.id).toBe("same_key");
    const relative = matches.find((m) => m.file.id === "relative") as CompatMatch;
    expect(relative.reason).toBe("relative major, same tempo");
    const drums = matches.find((m) => m.file.id === "break") as CompatMatch;
    expect(drums.reason).toBe("no key detected, tempo only");
    expect(drums.key.relationship).toBe("unknown");
  });

  it("puts a pair it could check on both axes above one it could only half check", () => {
    const source = file("source");
    // a keyless break at the same tempo scores 1.0, the same as an exact key match
    const candidates = [file("a_break", { key: null }), file("z_same_key")];
    const [first, second] = buildMatches(source, candidates, new Map());
    expect(first?.score).toBe(second?.score);
    expect(first?.file.id).toBe("z_same_key");
    expect(measuredAxes(first as CompatMatch)).toBe(2);
    expect(measuredAxes(second as CompatMatch)).toBe(1);
  });

  it("still lets timbre speak first inside a tie", () => {
    const source = file("source");
    const candidates = [file("a_break", { key: null }), file("z_same_key")];
    const matches = buildMatches(source, candidates, new Map([["a_break", 0.9], ["z_same_key", 0.1]]));
    expect(matches[0]?.file.id).toBe("a_break");
  });

  it("never matches a file with itself", () => {
    const source = file("source");
    expect(buildMatches(source, [source, file("other")], new Map()).map((m) => m.file.id)).toEqual(["other"]);
  });

  it("carries the confidence bound onto every row", () => {
    const source = file("source", { key: { tonic: "C", mode: "minor", confidence: 0.42, method: "k", alternate: null, notes: null } });
    const matches = buildMatches(source, [file("other")], new Map());
    expect(matches[0]?.confidence).toBe(0.42);
    expect(matches[0]?.confidence_bound_by).toBe("source_key");
    expect(matches[0]?.confidence_reason).toContain("this file's key");
  });

  it("lets timbre break a tie between equal scores", () => {
    const source = file("source");
    const candidates = [file("dull"), file("close")];
    const timbre = new Map([["dull", 0.2], ["close", 0.91]]);
    const matches = buildMatches(source, candidates, timbre);
    expect(matches.map((m) => m.file.id)).toEqual(["close", "dull"]);
    expect(matches[0]?.timbre).toBe(0.91);
    // without embeddings the tie falls back to the name, and nothing claims a similarity
    const plain = buildMatches(source, candidates, new Map());
    expect(plain.map((m) => m.file.id)).toEqual(["close", "dull"]);
    expect(plain[0]?.timbre).toBeNull();
  });

  it("does not let timbre outrank a better musical fit", () => {
    const source = file("source");
    const candidates = [
      file("exact"),
      file("parallel", { key: { tonic: "C", mode: "major", confidence: 0.8, method: "k", alternate: null, notes: null } }),
    ];
    const matches = buildMatches(source, candidates, new Map([["parallel", 0.99], ["exact", 0.01]]));
    expect(matches.map((m) => m.file.id)).toEqual(["exact", "parallel"]);
  });

  it("honours the caller's limit after ranking, not before", () => {
    const source = file("source");
    const candidates = [file("a"), file("b"), file("c")];
    const matches = buildMatches(source, candidates, new Map([["c", 0.99]]), { limit: 1 });
    expect(matches.map((m) => m.file.id)).toEqual(["c"]);
  });

  it("ranks a shorter stretch above a longer one at the same score bucket", () => {
    const base = { score: 0.9, timbre: null, key: { semitone_shift: 0 }, file: file("x") } as unknown as CompatMatch;
    const near = { ...base, tempo: { distance: 0.01 }, file: file("near") } as unknown as CompatMatch;
    const far = { ...base, tempo: { distance: 0.1 }, file: file("far") } as unknown as CompatMatch;
    expect(rankMatches([far, near]).map((m) => m.file.id)).toEqual(["near", "far"]);
  });

  it("names a file by its title when it has one", () => {
    expect(fileName(file("a", {}, { title: "  Rhodes loop  " }))).toBe("Rhodes loop");
    expect(fileName(file("a"))).toBe("a.wav");
  });
});
