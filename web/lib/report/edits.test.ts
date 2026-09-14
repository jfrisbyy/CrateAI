import { describe, expect, it } from "vitest";
import {
  applyEdit,
  compareRank,
  continuesEdit,
  editRequestSchema,
  loopPickCorrection,
  loopSpanCorrection,
  loopSpanPayload,
  LOOP_CORRECTION_FIELDS,
  predictedFor,
  SCORED_TERMS,
} from "./edits";
import { effective, emptyReport } from "./effective";

function report() {
  const beat = 0.5;
  const times = Array.from({ length: 16 }, (_, i) => i * beat);
  return emptyReport({
    tempo: { bpm: 120, confidence: 0.9, method: "librosa", alternates_bpm: [60, 240], notes: null },
    beats: {
      times_s: times,
      confidence: 0.9,
      method: "librosa",
      downbeats_s: times.filter((_, i) => i % 4 === 1),
      downbeat_phase: 1,
      downbeat_confidence: 0.5,
      downbeat_method: "lowband",
      meter: "4/4",
      notes: null,
    },
    key: { tonic: "A#", mode: "minor", confidence: 0.7, method: "ks", alternate: null, notes: null },
    structure: {
      sections: [
        { start_s: 0, end_s: 4, start_bar: 0, bars: 2, label: "A", energy: 0.5, confidence: 0.6 },
        { start_s: 4, end_s: 8, start_bar: 2, bars: 2, label: "B", energy: 0.7, confidence: 0.6 },
      ],
      loop_period_bars: 2,
      loop_period_confidence: 0.7,
      method: "ssm",
      notes: null,
    },
  });
}

describe("editRequestSchema", () => {
  it("accepts every field with a valid value", () => {
    expect(editRequestSchema.safeParse({ field: "tempo_bpm", value: 92 }).success).toBe(true);
    expect(editRequestSchema.safeParse({ field: "downbeat_phase", value: 2 }).success).toBe(true);
    expect(editRequestSchema.safeParse({ field: "first_downbeat_s", value: 0.512 }).success).toBe(true);
    expect(editRequestSchema.safeParse({ field: "key", value: { tonic: "F", mode: "minor" } }).success).toBe(true);
    expect(editRequestSchema.safeParse({ field: "meter", value: "6/8" }).success).toBe(true);
    expect(editRequestSchema.safeParse({ field: "section_labels", value: { "0": "hook" } }).success).toBe(true);
  });
  it("rejects bad values", () => {
    expect(editRequestSchema.safeParse({ field: "tempo_bpm", value: -1 }).success).toBe(false);
    expect(editRequestSchema.safeParse({ field: "key", value: { tonic: "Bb", mode: "minor" } }).success).toBe(false);
    expect(editRequestSchema.safeParse({ field: "meter", value: "waltz" }).success).toBe(false);
    expect(editRequestSchema.safeParse({ field: "section_labels", value: { a: "x" } }).success).toBe(false);
    expect(editRequestSchema.safeParse({ field: "nope", value: 1 }).success).toBe(false);
  });
});

describe("predictedFor", () => {
  it("returns the analyzed value, never the edited one", () => {
    const r = report();
    r.user_edits.tempo_bpm = 60;
    expect(predictedFor(r, { field: "tempo_bpm", value: 90 })).toBe(120);
    expect(predictedFor(r, { field: "downbeat_phase", value: 0 })).toBe(1);
    expect(predictedFor(r, { field: "first_downbeat_s", value: 0 })).toBe(0.5);
    expect(predictedFor(r, { field: "key", value: { tonic: "F", mode: "minor" } })).toEqual({ tonic: "A#", mode: "minor" });
    expect(predictedFor(r, { field: "meter", value: "3/4" })).toBe("4/4");
    expect(predictedFor(r, { field: "section_labels", value: { "1": "hook", "9": "x" } })).toEqual({ "1": "B", "9": null });
  });
  it("is null when the section was not measured", () => {
    const r = emptyReport();
    expect(predictedFor(r, { field: "tempo_bpm", value: 90 })).toBeNull();
    expect(predictedFor(r, { field: "key", value: { tonic: "F", mode: "minor" } })).toBeNull();
  });
});

describe("applyEdit", () => {
  it("merges into user_edits without touching analyzed values", () => {
    const r = report();
    const e = applyEdit(r, { field: "tempo_bpm", value: 240 }, "2026-09-13T00:00:00Z");
    expect(e.user_edits.tempo_bpm).toBe(240);
    expect(e.user_edits.edited_at).toBe("2026-09-13T00:00:00Z");
    expect(e.tempo?.bpm).toBe(120);
    expect(r.user_edits.tempo_bpm).toBeNull();
    expect(effective(e).tempo?.bpm).toBe(240);
    expect(effective(e).beats?.times_s.length).toBe(31);
  });
  it("a click anchor replaces a phase edit and vice versa", () => {
    let e = applyEdit(report(), { field: "downbeat_phase", value: 2 }, "t");
    e = applyEdit(e, { field: "first_downbeat_s", value: 1.5 }, "t");
    expect(e.user_edits.downbeat_phase).toBeNull();
    expect(e.user_edits.first_downbeat_s).toBe(1.5);
    expect(effective(e).beats?.downbeat_phase).toBe(3);
    e = applyEdit(e, { field: "downbeat_phase", value: 0 }, "t");
    expect(e.user_edits.first_downbeat_s).toBeNull();
    expect(effective(e).beats?.downbeats_s[0]).toBe(0);
  });
  it("accumulates section labels", () => {
    let e = applyEdit(report(), { field: "section_labels", value: { "0": "intro" } }, "t");
    e = applyEdit(e, { field: "section_labels", value: { "1": "hook" } }, "t");
    expect(e.user_edits.section_labels).toEqual({ "0": "intro", "1": "hook" });
    expect(effective(e).structure?.sections.map((s) => s.label)).toEqual(["intro", "hook"]);
  });
});

// ---------------------------------------------------------------------------
// loop corrections: what counts as one, and the shape it takes
// ---------------------------------------------------------------------------

describe("loop corrections", () => {
  const terms = { seam: 0.61, phrase: 0.8, stability: 0.95, novelty: 1, onset_lock: 1, recurrence: 0.5 };

  it("logs a drag that moved an edge, in the shape the migration pins", () => {
    expect(loopSpanCorrection({ start_s: 0, end_s: 8, bars: 4 }, { start_s: 0, end_s: 16, bars: 8 }, "edges")).toEqual({
      field: "loop_edges",
      predicted: { start_s: 0, end_s: 8, bars: 4 },
      corrected: { start_s: 0, end_s: 16, bars: 8 },
    });
  });

  it("does not log a drag that ended where it started", () => {
    const span = { start_s: 1.5, end_s: 9.5, bars: 4 };
    expect(loopSpanCorrection(span, { ...span }, "edges")).toBeNull();
    // and not a sub-millisecond one either: that is a click, not a correction
    expect(loopSpanCorrection(span, { ...span, end_s: 9.5004 }, "edges")).toBeNull();
    expect(loopSpanCorrection(span, { ...span, end_s: 9.52 }, "edges")).not.toBeNull();
  });

  it("logs a bar count said outright as loop_bars, and says nothing when it did not change", () => {
    expect(loopSpanCorrection({ start_s: 0, end_s: 8, bars: 4 }, { start_s: 0, end_s: 4, bars: 2 }, "bars")).toMatchObject({
      field: "loop_bars",
      corrected: { start_s: 0, end_s: 4, bars: 2 },
    });
    expect(loopSpanCorrection({ start_s: 0, end_s: 8, bars: 4 }, { start_s: 0, end_s: 8.4, bars: 4 }, "bars")).toBeNull();
  });

  it("leaves bars out rather than guessing at one", () => {
    expect(loopSpanPayload({ start_s: 0, end_s: 8, bars: null })).toEqual({ start_s: 0, end_s: 8 });
  });

  it("logs a pick with both rows' scored terms and neither row's anything else", () => {
    const components = { ...terms, weights: { seam: 0.3 }, reasons: ["lands on a 4-bar phrase line"], personalization: { delta: 0.02 } };
    expect(loopPickCorrection({ bars: 4, rank: 1, components }, { bars: 8, rank: 3, components })).toEqual({
      field: "loop_pick",
      predicted: { bars: 4, rank: 1, components: terms },
      corrected: { bars: 8, rank: 3, components: terms },
    });
  });

  it("does not log the producer agreeing with us", () => {
    expect(loopPickCorrection({ bars: 4, rank: 1, components: terms }, { bars: 4, rank: 1, components: terms })).toBeNull();
  });

  it("carries a pick from a row with no measured terms rather than dropping it", () => {
    expect(loopPickCorrection({ bars: 4, rank: 1, components: null }, { bars: 2, rank: 5, components: null })).toEqual({
      field: "loop_pick",
      predicted: { bars: 4, rank: 1 },
      corrected: { bars: 2, rank: 5 },
    });
  });

  it("ranks the rack the way GET /api/loops returns it: best score first, nulls last, ties by time", () => {
    const rack = [
      { score: null, start_s: 1 },
      { score: 0.7, start_s: 9 },
      { score: 0.9, start_s: 40 },
      { score: 0.7, start_s: 2 },
    ];
    expect([...rack].sort(compareRank).map((r) => r.start_s)).toEqual([40, 2, 9, 1]);
  });

  it("knows when an edit is the same edit continuing", () => {
    expect(continuesEdit({ start_s: 2, end_s: 10, bars: 4 }, { start_s: 2, end_s: 10, bars: 4 })).toBe(true);
    expect(continuesEdit({ start_s: 2, end_s: 10 }, { start_s: 2.0004, end_s: 10 })).toBe(true);
    expect(continuesEdit({ start_s: 2, end_s: 10 }, { start_s: 2.5, end_s: 10.5 })).toBe(false);
    expect(continuesEdit(null, { start_s: 2, end_s: 10 })).toBe(false);
    expect(continuesEdit({ bars: 4, rank: 1 }, { start_s: 2, end_s: 10 })).toBe(false);
  });

  it("reads back exactly the fields the ranker reads", () => {
    expect([...LOOP_CORRECTION_FIELDS]).toEqual(["loop_edges", "loop_bars", "loop_pick"]);
    expect([...SCORED_TERMS]).toEqual(["seam", "phrase", "stability", "novelty", "onset_lock", "recurrence"]);
  });
});
