import { describe, expect, it } from "vitest";
import { effective } from "@/lib/report/effective";
import { fakeFile } from "./fakes";
import { bpmText, compactReport, explainReport, fileContextLine, notAnalyzed, stepName, stepsPhrase, vitalsOf } from "./report";

describe("producer vocabulary", () => {
  it("names steps like words.py", () => {
    expect(stepName(0)).toBe("the one");
    expect(stepName(2)).toBe("the and of one");
    expect(stepName(10)).toBe("the and of three");
    expect(stepName(11)).toBe("the a of three");
    expect(stepName(13)).toBe("the e of four");
    expect(stepsPhrase([10, 0])).toBe("the one and the and of three");
    expect(stepsPhrase([0, 4, 8])).toBe("the one, the two and the three");
    expect(stepsPhrase([])).toBe("nowhere");
    expect(bpmText(92)).toBe("92");
    expect(bpmText(92.04)).toBe("92");
    expect(bpmText(92.4)).toBe("92.4");
  });
});

describe("compactReport / explainReport", () => {
  const file = fakeFile(
    { original_filename: "beat.wav", duration_s: 60 },
    {
      groove: { swing_pct: 58, timing_deviation_ms: { mean: 3, std: 8 }, feel: "swung", method: "onsets", confidence: 0.85 },
      structure: {
        sections: [
          { start_s: 0, end_s: 10.4, start_bar: 0, bars: 4, label: "intro", energy: 0.3, confidence: 0.9 },
          { start_s: 10.4, end_s: 52, start_bar: 4, bars: 16, label: "verse", energy: 0.7, confidence: 0.55 },
        ],
        loop_period_bars: 4,
        loop_period_confidence: 0.7,
        method: "recurrence",
        notes: null,
      },
      drums: {
        source_estimate: "sampled_break",
        source_confidence: 0.72,
        layered_kick: false,
        method: "stem",
        notes: null,
        patterns: [
          {
            section_index: 1,
            kick: [{ step: 0, velocity: 0.9, frequency: 1, offset_ms: -2 }, { step: 10, velocity: 0.8, frequency: 0.9, offset_ms: 12 }, { step: 6, velocity: 0.3, frequency: 0.2, offset_ms: 0 }],
            snare: [{ step: 4, velocity: 0.9, frequency: 1, offset_ms: 5 }, { step: 12, velocity: 0.9, frequency: 1, offset_ms: 5 }],
            hat: Array.from({ length: 8 }, (_, i) => ({ step: i * 2, velocity: 0.5, frequency: 1, offset_ms: 0 })),
            other: [],
            accents: [0],
            density_per_bar: 12,
            hat_open_ratio: 0.1,
            ghost_notes: [11],
          },
        ],
      },
      chords: null,
    },
  );
  const eff = effective(file.report!);

  it("puts the vitals first with hedges and lists null sections", () => {
    const c = compactReport(file, eff) as { vitals: { tempo: { bpm: number; hedge: string }; key: { key: string; hedge: string } }; not_analyzed: string[]; drums: { patterns: Array<{ kick: string; snare: string; ghost_notes: string[] }> }; chords: string };
    expect(c.vitals.tempo).toMatchObject({ bpm: 92, hedge: "" });
    expect(c.vitals.key).toMatchObject({ key: "F minor", hedge: "likely" });
    expect(c.not_analyzed).toEqual(["chords", "onsets", "sample_use", "instrumentation", "loudness", "spectral", "effects_estimates"]);
    expect(c.chords).toBe("not analyzed yet");
    expect(c.drums.patterns[0]).toMatchObject({ kick: "the one and the and of three", snare: "the two and the four", ghost_notes: ["the a of three"] });
  });

  it("filters to the requested sections but always keeps the vitals", () => {
    const c = compactReport(file, eff, ["drums"]);
    expect(Object.keys(c).sort()).toEqual(["drums", "file", "not_analyzed", "vitals"]);
  });

  it("explains in producer language with every hedge attached", () => {
    const text = explainReport(file, eff);
    expect(text).toContain("Tempo: 92 BPM (confidence 0.91; alternates 46 / 184)");
    expect(text).toContain("Key: likely F minor (confidence 0.70; alternate Ab major)");
    expect(text).toContain("Feel: swung 58 percent");
    expect(text).toContain("intro 4 bars from bar 1; roughly verse 16 bars from bar 5");
    expect(text).toContain("Sits on likely a 4-bar loop");
    expect(text).toContain("Drums: likely a sampled break (confidence 0.72). section 2: kick on the one and the and of three, snare on the two and the four, hats on 8ths, ghost notes on the a of three");
    expect(text).toContain("Chords: not analyzed yet");
    expect(text).toContain("Loudness: not analyzed yet");
    expect(text).toContain("Not analyzed yet: chords, onsets, sample_use, instrumentation, loudness, spectral, effects_estimates");
  });

  it("vitals and the context line carry confidence", () => {
    const v = vitalsOf(file, eff);
    expect(v).toMatchObject({ bpm: 92, bpm_hedge: "", key: "F minor", key_hedge: "likely", meter: "4/4", feel: "swung 58%", status: "ready" });
    const line = fileContextLine(file, eff, true);
    expect(line).toContain("[open] beat.wav");
    expect(line).toContain(`id ${file.id}`);
    expect(line).toContain("92 BPM (0.91)");
    expect(line).toContain("likely F minor (0.70)");
    expect(notAnalyzed(eff)).toContain("chords");
  });
});
