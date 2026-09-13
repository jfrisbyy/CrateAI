import { describe, expect, it } from "vitest";
import type { AnalysisReport } from "@/lib/types/report";
import { beatsPerBar, effective, emptyReport, subdivide } from "./effective";

// Mirrors the `effective()` cases in analysis/tests/test_report_schema.py.

function reportWithGrid(): AnalysisReport {
  const beat = 60.0 / 90.0;
  const times = Array.from({ length: 32 }, (_, i) => i * beat);
  return emptyReport({
    tempo: { bpm: 90.0, confidence: 0.9, method: "librosa", alternates_bpm: [45.0, 180.0], notes: null },
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
    key: { tonic: "F", mode: "minor", confidence: 0.7, method: "ks", alternate: null, notes: null },
    structure: {
      sections: [{ start_s: 0, end_s: 10, start_bar: 0, bars: 4, label: "A", energy: 0.5, confidence: 0.6 }],
      loop_period_bars: 4,
      loop_period_confidence: 0.7,
      method: "ssm",
      notes: null,
    },
  });
}

describe("effective", () => {
  it("applies a tempo edit and marks the user method", () => {
    const r = reportWithGrid();
    r.user_edits.tempo_bpm = 180.0;
    const e = effective(r);
    expect(e.tempo?.bpm).toBe(180.0);
    expect(e.tempo?.method).toBe("user");
    expect(e.tempo?.confidence).toBe(1.0);
    expect(e.tempo?.alternates_bpm).toEqual([90, 360]);
    // doubling the tempo doubles the grid density
    expect(e.beats?.times_s.length).toBe(2 * (r.beats?.times_s.length ?? 0) - 1);
    // the stored report is untouched
    expect(r.tempo?.bpm).toBe(90.0);
    expect(r.tempo?.method).toBe("librosa");
  });

  it("halving thins the grid", () => {
    const r = reportWithGrid();
    r.user_edits.tempo_bpm = 45.0;
    const e = effective(r);
    expect(e.beats?.times_s.length).toBe(16);
    expect(e.beats?.times_s[1]).toBeCloseTo(2 * (60 / 90), 9);
  });

  it("a non-octave tempo edit leaves the grid alone", () => {
    const r = reportWithGrid();
    r.user_edits.tempo_bpm = 93.0;
    const e = effective(r);
    expect(e.beats?.times_s.length).toBe(32);
    expect(e.tempo?.bpm).toBe(93.0);
  });

  it("a tempo edit on a report without tempo creates a user tempo", () => {
    const r = reportWithGrid();
    r.tempo = null;
    r.user_edits.tempo_bpm = 120;
    const e = effective(r);
    expect(e.tempo).toEqual({ bpm: 120, confidence: 1, method: "user", alternates_bpm: [60, 240], notes: null });
  });

  it("applies a downbeat phase edit", () => {
    const r = reportWithGrid();
    r.user_edits.downbeat_phase = 2;
    const e = effective(r);
    expect(e.beats?.downbeat_phase).toBe(2);
    expect(e.beats?.downbeats_s[0]).toBeCloseTo(2 * (60 / 90), 9);
    expect(e.beats?.downbeat_method).toBe("user");
    expect(e.beats?.downbeat_confidence).toBe(1.0);
  });

  it("a first-downbeat click sets the phase from the nearest beat", () => {
    const r = reportWithGrid();
    const beat = 60 / 90;
    r.user_edits.first_downbeat_s = 3 * beat + 0.02; // click near beat 3
    const e = effective(r);
    expect(e.beats?.downbeat_phase).toBe(3);
    expect(e.beats?.downbeats_s[0]).toBeCloseTo(3 * beat, 9);
  });

  it("applies key and section label edits", () => {
    const r = reportWithGrid();
    r.user_edits.key = { tonic: "G#", mode: "major" };
    r.user_edits.section_labels = { "0": "hook", "7": "ignored", x: "ignored" };
    const e = effective(r);
    expect([e.key?.tonic, e.key?.mode, e.key?.method]).toEqual(["G#", "major", "user"]);
    expect(e.key?.confidence).toBe(1.0);
    expect(e.key?.alternate).toBeNull();
    expect(e.structure?.sections[0]?.label).toBe("hook");
    expect(e.structure?.sections[0]?.confidence).toBe(1.0);
  });

  it("a key edit on a report without key creates a user key", () => {
    const r = reportWithGrid();
    r.key = null;
    r.user_edits.key = { tonic: "A#", mode: "minor" };
    const e = effective(r);
    expect(e.key).toEqual({ tonic: "A#", mode: "minor", confidence: 1, method: "user", alternate: null, notes: null });
  });

  it("a meter edit regroups the downbeats", () => {
    const r = reportWithGrid();
    r.user_edits.meter = "3/4";
    r.user_edits.downbeat_phase = 0;
    const e = effective(r);
    expect(e.beats?.meter).toBe("3/4");
    expect(e.beats?.downbeats_s[1]).toBeCloseTo(3 * (60 / 90), 9);
  });

  it("a meter edit alone keeps the analyzed phase and regroups", () => {
    const r = reportWithGrid();
    r.user_edits.meter = "6/8"; // 2 dotted-quarter beats per bar
    const e = effective(r);
    expect(e.beats?.downbeat_phase).toBe(1);
    expect(e.beats?.downbeats_s[0]).toBeCloseTo(60 / 90, 9);
    expect(e.beats?.downbeats_s[1]).toBeCloseTo(3 * (60 / 90), 9);
  });

  it("does not mutate the input", () => {
    const r = reportWithGrid();
    const snapshot = JSON.stringify(r);
    r.user_edits.tempo_bpm = 180;
    r.user_edits.key = { tonic: "C", mode: "major" };
    effective(r);
    r.user_edits.tempo_bpm = null;
    r.user_edits.key = null;
    expect(JSON.stringify(r)).toBe(snapshot);
  });
});

describe("helpers", () => {
  it("beatsPerBar follows the python rules", () => {
    expect(beatsPerBar("4/4")).toBe(4);
    expect(beatsPerBar("3/4")).toBe(3);
    expect(beatsPerBar("6/8")).toBe(2);
    expect(beatsPerBar("12/8")).toBe(4);
    expect(beatsPerBar("5/4")).toBe(5);
    expect(beatsPerBar("7/8")).toBe(7);
    expect(beatsPerBar("nonsense")).toBe(4);
    expect(beatsPerBar(null)).toBe(4);
  });

  it("subdivide inserts evenly spaced beats", () => {
    expect(subdivide([0, 1, 2], 2)).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(subdivide([0, 1], 4)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(subdivide([5], 2)).toEqual([5]);
    expect(subdivide([], 2)).toEqual([]);
  });
});
