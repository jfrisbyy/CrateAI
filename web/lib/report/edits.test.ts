import { describe, expect, it } from "vitest";
import { applyEdit, editRequestSchema, predictedFor } from "./edits";
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
