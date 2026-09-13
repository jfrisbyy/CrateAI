import { describe, expect, it } from "vitest";
import { emptyReport } from "@/lib/report/effective";
import type { AnalysisReport } from "@/lib/types/report";
import {
  addSlicePoint,
  describeProposal,
  markersFor,
  moveSlicePoint,
  proposeSlicePoints,
  removeSlicePoint,
  sliceCorrections,
  suggestMaterial,
} from "./slices";

function breakReport(): AnalysisReport {
  return emptyReport({
    tempo: { bpm: 90, confidence: 0.9, method: "librosa", alternates_bpm: [45, 180], notes: null },
    beats: {
      times_s: [0, 0.667, 1.333, 2],
      confidence: 0.8,
      method: "beat tracker",
      downbeats_s: [0, 2],
      downbeat_phase: 0,
      downbeat_confidence: 0.7,
      downbeat_method: "downbeats",
      meter: "4/4",
      notes: null,
    },
    onsets: { times_s: [0, 0.25, 0.667, 0.68, 1.333, 2], method: "spectral flux", count: 6 },
    drums: { source_estimate: "sampled_break", source_confidence: 0.82, patterns: [], layered_kick: null, method: "drums", notes: null },
  });
}

function melodicReport(): AnalysisReport {
  return emptyReport({
    chords: {
      segments: [
        { start_s: 0, end_s: 2, label: "Fm7", confidence: 0.72 },
        { start_s: 2, end_s: 4, label: "Bb7", confidence: 0.64 },
      ],
      method: "chroma templates",
      notes: null,
    },
    onsets: { times_s: [0.02, 2.03, 3.5], method: "spectral flux", count: 3 },
  });
}

function phraseReport(): AnalysisReport {
  const report = emptyReport({
    structure: {
      sections: [
        { start_s: 0, end_s: 16, start_bar: 0, bars: 8, label: "intro", energy: 0.3, confidence: 0.66 },
        { start_s: 16, end_s: 48, start_bar: 8, bars: 16, label: "verse", energy: 0.6, confidence: 0.71 },
        { start_s: 48, end_s: 80, start_bar: 24, bars: 16, label: "chorus", energy: 0.9, confidence: 0.8 },
      ],
      loop_period_bars: 8,
      loop_period_confidence: 0.5,
      method: "segmenter",
      notes: null,
    },
  });
  report.file.duration_s = 80;
  return report;
}

describe("what the material is", () => {
  it("reads a measured break as a break, and says which measurement said so", () => {
    const guess = suggestMaterial(breakReport(), 4);
    expect(guess.material).toBe("break");
    expect(guess.why).toContain("sampled break");
    expect(guess.confidence).toBeCloseTo(0.82, 6);
  });

  it("reads a long record with sections as a phrase", () => {
    expect(suggestMaterial(phraseReport(), 80).material).toBe("phrase");
  });

  it("reads chords with no break as melodic", () => {
    expect(suggestMaterial(melodicReport(), 4).material).toBe("melodic");
  });

  it("says so plainly when nothing has been measured", () => {
    const guess = suggestMaterial(null);
    expect(guess.confidence).toBe(0);
    expect(guess.why).toContain("Nothing is measured");
    expect(proposeSlicePoints(null).points).toEqual([]);
  });
});

describe("where the cuts go", () => {
  it("cuts a break on its onsets, and says which land on a measured beat", () => {
    const proposal = proposeSlicePoints(breakReport(), { material: "break", minGapS: 0.04 });
    expect(proposal.method).toBe("spectral flux");
    expect(proposal.points.map((p) => p.timeS)).toEqual([0, 0.25, 0.667, 1.333, 2]);
    expect(proposal.points[0]?.reason).toContain("downbeat");
    expect(proposal.points[2]?.reason).toContain("beat");
    expect(proposal.points[2]?.confidence).toBeCloseTo(0.8, 6);
    expect(proposal.points[1]?.confidence).toBe(0.5);
    expect(proposal.notes.join(" ")).toContain("closer than 40 ms");
  });

  it("cuts melodic material where the notes change, snapped to the note start", () => {
    const proposal = proposeSlicePoints(melodicReport(), { material: "melodic" });
    expect(proposal.points).toHaveLength(2);
    expect(proposal.points[0]?.timeS).toBe(0.02);
    expect(proposal.points[0]?.reason).toContain("Fm7");
    expect(proposal.points[0]?.method).toContain("onsets");
    expect(proposal.points[1]?.confidence).toBeCloseTo(0.64, 6);
  });

  it("cuts a long record at its section edges, naming the section and the bar", () => {
    const proposal = proposeSlicePoints(phraseReport(), { material: "phrase" });
    expect(proposal.points.map((p) => p.timeS)).toEqual([0, 16, 48]);
    expect(proposal.points[2]?.reason).toBe("chorus starts at 48.000 s, bar 25");
    expect(proposal.points[2]?.confidence).toBeCloseTo(0.8, 6);
  });

  it("falls back with a note rather than inventing a cut", () => {
    const noStructure = proposeSlicePoints(breakReport(), { material: "phrase" });
    expect(noStructure.notes[0]).toContain("No sections are measured");
    expect(noStructure.points.length).toBeGreaterThan(0);
    const nothing = proposeSlicePoints(emptyReport(), { material: "break" });
    expect(nothing.points).toEqual([]);
    expect(nothing.notes[0]).toContain("No onsets");
  });

  it("keeps only as many cuts as there are keys, strongest first, and says it dropped the rest", () => {
    const proposal = proposeSlicePoints(breakReport(), { material: "break", maxPoints: 2, minGapS: 0 });
    expect(proposal.points).toHaveLength(2);
    expect(proposal.notes.join(" ")).toContain("the 2 strongest are here");
  });

  it("only proposes inside the span it was given", () => {
    const proposal = proposeSlicePoints(breakReport(), { material: "break", fromS: 0.5, toS: 1.5 });
    expect(proposal.points.map((p) => p.timeS)).toEqual([0.667, 1.333]);
    expect(proposal.notes.join(" ")).toContain("outside the span");
  });
});

describe("a cut is editable", () => {
  it("drags a cut without letting it cross its neighbours", () => {
    const proposal = proposeSlicePoints(breakReport(), { material: "break", minGapS: 0.04 });
    const moved = moveSlicePoint(proposal, proposal.points[1]?.id as string, 5, { minGapS: 0.04 });
    expect(moved.points[1]?.timeS).toBeCloseTo(0.627, 6);
    expect(moved.points[1]?.origin).toBe("moved");
    const back = moveSlicePoint(moved, moved.points[1]?.id as string, -3, { minGapS: 0.04 });
    expect(back.points[1]?.timeS).toBeCloseTo(0.04, 6);
    expect(moveSlicePoint(proposal, "nope", 1)).toBe(proposal);
  });

  it("adds and removes cuts by hand, keeping them in time order", () => {
    const proposal = proposeSlicePoints(breakReport(), { material: "break" });
    const added = addSlicePoint(proposal, 1.5);
    expect(added.points.map((p) => p.timeS)).toEqual([0, 0.25, 0.667, 1.333, 1.5, 2]);
    expect(added.points[4]?.method).toBe("user");
    expect(addSlicePoint(added, 1.5).points).toHaveLength(added.points.length);
    const removed = removeSlicePoint(added, added.points[0]?.id as string);
    expect(removed.points).toHaveLength(added.points.length - 1);
  });

  it("hands the manual chopper the markers it already takes", () => {
    const proposal = proposeSlicePoints(breakReport(), { material: "break" });
    expect(markersFor(proposal)).toEqual([0, 0.25, 0.667, 1.333, 2]);
  });

  it("logs a moved cut as a correction against what was proposed (principle 7)", () => {
    const proposal = proposeSlicePoints(breakReport(), { material: "break" });
    const moved = moveSlicePoint(proposal, proposal.points[2]?.id as string, 0.7);
    const corrections = sliceCorrections(proposal, moved);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({ field: "chop.slice_point", predicted_s: 0.667, corrected_s: 0.7, method: "spectral flux" });
    expect(sliceCorrections(proposal, proposal)).toEqual([]);
  });

  it("has one line for the panel and the chat", () => {
    const proposal = proposeSlicePoints(breakReport(), { material: "break" });
    expect(describeProposal(proposal)).toBe("5 break cuts from spectral flux.");
    expect(describeProposal(moveSlicePoint(proposal, proposal.points[0]?.id as string, 0.01))).toContain("1 moved by hand");
  });
});
