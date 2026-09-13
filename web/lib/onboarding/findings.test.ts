import { describe, expect, it } from "vitest";
import { emptyReport } from "@/lib/report/effective";
import type { AnalysisReport } from "@/lib/types/report";
import { findingsHeadline, firstFindings, unmeasured } from "./findings";

const full = (patch: Partial<AnalysisReport> = {}): AnalysisReport =>
  emptyReport({
    tempo: { bpm: 92.04, confidence: 0.91, method: "tempogram", alternates_bpm: [46.02, 184.08], notes: null },
    key: { tonic: "F", mode: "minor", confidence: 0.64, method: "krumhansl", alternate: { tonic: "G#", mode: "major", correlation: 0.883 }, notes: null },
    beats: {
      times_s: [0, 0.65, 1.3],
      confidence: 0.85,
      method: "beat_track",
      downbeats_s: [0.512, 3.12, 5.73],
      downbeat_phase: 0,
      downbeat_confidence: 0.42,
      downbeat_method: "low-band",
      meter: "4/4",
      notes: null,
    },
    structure: {
      sections: [
        { start_s: 0, end_s: 16, start_bar: 1, bars: 8, label: "A", energy: 0.5, confidence: 0.7 },
        { start_s: 16, end_s: 32, start_bar: 9, bars: 8, label: "B", energy: 0.7, confidence: 0.6 },
      ],
      loop_period_bars: 8,
      loop_period_confidence: 0.72,
      method: "novelty",
      notes: null,
    },
    groove: {
      swing_pct: 58.4,
      timing_deviation_ms: { mean: 11.7, std: 4.2 },
      feel: "swung",
      method: "onset-grid",
      confidence: 0.66,
    },
    loudness: { integrated_lufs: -9.42, true_peak_dbtp: -0.31, loudness_range_lu: 6.1, method: "pyloudnorm" },
    spectral: {
      centroid_hz_mean: 2400,
      stereo_width: 0.4,
      low_high_ratio_db: 12,
      method: "stft",
      bandwidth: { value: 15700, confidence: 0.9, method: "rolloff", notes: null },
    },
    ...patch,
  });

describe("the first record's findings", () => {
  it("reads the vitals a producer asks for first, in that order", () => {
    expect(firstFindings(full()).map((f) => f.id)).toEqual([
      "tempo",
      "key",
      "downbeats",
      "structure",
      "groove",
      "bandwidth",
      "loudness",
    ]);
  });

  it("carries the confidence the report measured, so the dot and the hedge agree", () => {
    const by = new Map(firstFindings(full()).map((f) => [f.id, f]));
    expect(by.get("tempo")?.confidence).toBe(0.91);
    expect(by.get("key")?.confidence).toBe(0.64);
    expect(by.get("downbeats")?.confidence).toBe(0.42);
    // measurements with no confidence of their own carry none rather than a made-up one
    expect(by.get("structure")?.confidence).toBeNull();
    expect(by.get("loudness")?.confidence).toBeNull();
  });

  it("names the alternate it nearly chose instead of stating one answer", () => {
    const by = new Map(firstFindings(full()).map((f) => [f.id, f]));
    expect(by.get("tempo")?.value).toBe("92.0 BPM");
    expect(by.get("tempo")?.note).toContain("46.0 half-time");
    expect(by.get("tempo")?.note).toContain("184.1 double-time");
    expect(by.get("key")?.value).toBe("F minor");
    expect(by.get("key")?.note).toBe("or Ab major, which correlated 0.88");
  });

  it("offers the correction on the values a producer corrects", () => {
    const by = new Map(firstFindings(full()).map((f) => [f.id, f]));
    expect(by.get("tempo")?.note).toContain("halve, double or tap");
    expect(by.get("downbeats")?.note).toContain("press D");
    expect(by.get("downbeats")?.value).toBe("0:00.512");
    expect(by.get("downbeats")?.note).toContain("3 bars");
  });

  it("hedges the loop period with its own confidence rather than the row's", () => {
    const by = new Map(firstFindings(full()).map((f) => [f.id, f]));
    expect(by.get("structure")?.value).toBe("2");
    expect(by.get("structure")?.note).toBe("likely it repeats on 8 bars");
  });

  it("says what a limited source costs, without blaming the processing", () => {
    const by = new Map(firstFindings(full()).map((f) => [f.id, f]));
    expect(by.get("bandwidth")?.value).toBe("15.7 kHz");
    expect(by.get("bandwidth")?.note).toContain("a limit of the source");

    const wide = firstFindings(
      full({ spectral: { centroid_hz_mean: 3000, stereo_width: 0.5, low_high_ratio_db: 8, method: "stft", bandwidth: { value: 20500, confidence: 0.9, method: "rolloff", notes: null } } }),
    ).find((f) => f.id === "bandwidth");
    expect(wide?.note).toContain("full band");
  });

  it("leaves out what was not measured instead of showing a blank", () => {
    const partial = firstFindings(emptyReport({ tempo: { bpm: 90, confidence: 0.5, method: "m", alternates_bpm: [], notes: null } }));
    expect(partial.map((f) => f.id)).toEqual(["tempo"]);
    expect(partial[0]?.note).toBeNull();
    expect(firstFindings(null)).toEqual([]);
  });

  it("headlines with the two values a producer checks, hedged by their bands", () => {
    expect(findingsHeadline(full())).toBe("92.0 BPM, likely F minor");
    expect(findingsHeadline(emptyReport())).toBeNull();
  });

  it("can name what it has nothing for", () => {
    expect(unmeasured(emptyReport())).toEqual(["tempo", "key", "beats", "sections", "groove"]);
    expect(unmeasured(full())).toEqual([]);
  });
});
