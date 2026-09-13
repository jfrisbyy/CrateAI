import { describe, expect, it } from "vitest";
import { emptyReport } from "@/lib/report/effective";
import type { AnalysisReport, DrumHit } from "@/lib/types/report";
import { bindPads } from "./bindings";
import type { ChopWithFile } from "@/lib/api/chops";
import { classifySlices, describeOrdering, orderCorrections, orderKit, slicesFromBindings, type KitSlice } from "./kitOrder";

const hit = (step: number, frequency: number, velocity = 0.8): DrumHit => ({ step, velocity, frequency, offset_ms: 0 });

/** 120 BPM: a 16th is 0.125 s, so step 4 is 0.5 s. */
function drumReport(): AnalysisReport {
  return emptyReport({
    tempo: { bpm: 120, confidence: 0.9, method: "librosa", alternates_bpm: [60, 240], notes: null },
    beats: {
      times_s: [0, 0.5, 1, 1.5],
      confidence: 0.9,
      method: "beats",
      downbeats_s: [0],
      downbeat_phase: 0,
      downbeat_confidence: 0.8,
      downbeat_method: "downbeats",
      meter: "4/4",
      notes: null,
    },
    structure: {
      sections: [{ start_s: 0, end_s: 8, start_bar: 0, bars: 4, label: "loop", energy: 0.5, confidence: 0.6 }],
      loop_period_bars: 1,
      loop_period_confidence: 0.6,
      method: "segmenter",
      notes: null,
    },
    drums: {
      source_estimate: "sampled_break",
      source_confidence: 0.8,
      patterns: [
        {
          section_index: 0,
          kick: [hit(0, 1), hit(8, 0.75)],
          snare: [hit(4, 0.9), hit(12, 0.85)],
          hat: [hit(0, 0.5), hit(2, 0.95), hit(6, 0.6)],
          other: [],
          accents: [0, 4],
          density_per_bar: 8,
          hat_open_ratio: 0.1,
          ghost_notes: [],
        },
      ],
      layered_kick: null,
      method: "onset classifier",
      notes: null,
    },
  });
}

const slice = (index: number, startS: number, label: string): KitSlice => ({ index, label, startS, endS: startS + 0.25, fileId: `f${index}` });

const SLICES: KitSlice[] = [
  slice(0, 0, "one"), // step 0  -> kick (1.0 beats the hat's 0.5)
  slice(1, 0.25, "two"), // step 2 -> hat
  slice(2, 0.5, "three"), // step 4 -> snare
  slice(3, 1.0, "four"), // step 8 -> kick
  slice(4, 1.5, "five"), // step 12 -> snare
];

describe("classifying a slice", () => {
  it("reads the class off the measured pattern step, with how often that step is that class", () => {
    const classes = classifySlices(SLICES, drumReport());
    expect(classes.get(0)).toMatchObject({ hitClass: "kick", confidence: 1 });
    expect(classes.get(1)?.hitClass).toBe("hat");
    expect(classes.get(2)?.hitClass).toBe("snare");
    expect(classes.get(0)?.note).toContain("100% of that section's bars");
    expect(classes.get(0)?.method).toContain("onset classifier");
  });

  it("says it cannot classify rather than guessing", () => {
    const classes = classifySlices(SLICES, emptyReport());
    expect(classes.get(0)).toMatchObject({ hitClass: null, confidence: 0, method: "none" });
    expect(classes.get(0)?.note).toContain("No drum pattern is measured");
    const noGrid = classifySlices(SLICES, emptyReport({ drums: drumReport().drums }));
    expect(noGrid.get(0)?.note).toContain("No beat grid");
  });
});

describe("which key gets what", () => {
  it("puts the kicks together, then the snares, then the hats", () => {
    const ordering = orderKit(SLICES, "hit-class", { report: drumReport(), padCount: 8 });
    expect(ordering.order.slice(0, 5)).toEqual([0, 3, 2, 4, 1]);
    expect(ordering.order.slice(5)).toEqual([-1, -1, -1]);
    expect(ordering.reasons[0]).toContain("kick");
    expect(ordering.method).toBe("onset classifier");
    expect(describeOrdering(ordering)).toBe("Hit class: 5 slices laid out from onset classifier.");
  });

  it("stays in file order, and says why, when nothing can be classified", () => {
    const ordering = orderKit(SLICES, "hit-class", { report: emptyReport(), padCount: 8 });
    expect(ordering.order.slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(ordering.notes[0]).toContain("No slice could be put on a measured drum step");
    expect(ordering.method).toBe("none");
  });

  it("sorts melodic slices by the chord measured under them, low to high", () => {
    const report = emptyReport({
      chords: {
        segments: [
          { start_s: 0, end_s: 1, label: "G", confidence: 0.6 },
          { start_s: 1, end_s: 2, label: "C", confidence: 0.6 },
          { start_s: 2, end_s: 3, label: "Eb", confidence: 0.6 },
        ],
        method: "chroma templates",
        notes: null,
      },
    });
    const slices = [slice(0, 0.1, "g"), slice(1, 1.1, "c"), slice(2, 2.1, "eb")];
    const ordering = orderKit(slices, "pitch", { report, padCount: 4 });
    expect(ordering.order.slice(0, 3)).toEqual([1, 2, 0]); // C, Eb, G
    expect(ordering.reasons[0]).toContain("C");
  });

  it("sorts by position and by length when that is what the producer wants", () => {
    const jumbled = [slice(0, 2, "late"), slice(1, 0.5, "early"), slice(2, 1, "middle")];
    expect(orderKit(jumbled, "position", { padCount: 3 }).order).toEqual([1, 2, 0]);
    const lengths: KitSlice[] = [
      { index: 0, label: "long", startS: 0, endS: 4, fileId: "a" },
      { index: 1, label: "short", startS: 0, endS: 0.2, fileId: "b" },
    ];
    expect(orderKit(lengths, "length", { padCount: 2 }).order).toEqual([1, 0]);
  });

  it("always returns exactly one entry per pad", () => {
    for (const padCount of [3, 5, 8, 16]) {
      const ordering = orderKit(SLICES, "hit-class", { report: drumReport(), padCount });
      expect(ordering.order).toHaveLength(padCount);
      const placed = ordering.order.filter((i) => i >= 0);
      expect(new Set(placed).size).toBe(placed.length);
    }
  });

  it("logs a drag against what the machine proposed (principle 7)", () => {
    const ordering = orderKit(SLICES, "hit-class", { report: drumReport(), padCount: 5 });
    const dragged = [...ordering.order];
    const first = dragged[0] as number;
    dragged[0] = dragged[1] as number;
    dragged[1] = first;
    const corrections = orderCorrections(ordering, dragged);
    expect(corrections).toHaveLength(2);
    expect(corrections[0]).toMatchObject({ field: "kit.pad_assignment", pad: 1, predicted_slice: 0, corrected_slice: 3, strategy: "hit-class" });
    expect(corrections[0]?.reason).toContain("kick");
    expect(orderCorrections(ordering, ordering.order)).toEqual([]);
  });

  it("builds its slices straight from the pads' bindings", () => {
    const chop = (index: number, fileId: string): ChopWithFile => ({
      id: `chop-${index}`,
      user_id: "u",
      source_file_id: "src",
      start_s: index * 0.5,
      end_s: index * 0.5 + 0.5,
      index,
      name: `slice ${index}`,
      chop_file_id: fileId,
      created_at: "2026-09-13T00:00:00Z",
      file: null,
    });
    const chops = [chop(0, "f0"), chop(1, "f1")];
    const bindings = bindPads(chops, [], 4);
    const spans = new Map(chops.map((c) => [c.id, { startS: c.start_s, endS: c.end_s }]));
    const slices = slicesFromBindings(bindings, spans);
    expect(slices).toHaveLength(2);
    expect(slices[1]).toMatchObject({ index: 1, label: "slice 1", startS: 0.5, endS: 1, fileId: "f1" });
  });
});
