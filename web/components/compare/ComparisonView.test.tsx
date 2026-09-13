import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ComparisonContent, ComparisonDelta } from "@/lib/types/db";
import { ComparisonView } from "./ComparisonView";
import { explainMissing, formatDelta, formatValue } from "./format";

function delta(over: Partial<ComparisonDelta> & Pick<ComparisonDelta, "section" | "metric" | "text" | "source">): ComparisonDelta {
  return { a: null, b: null, delta: null, unit: "", confidence: null, hedge: "", ...over };
}

const content: ComparisonContent = {
  schema_version: "1.0",
  file_a_id: "a",
  file_b_id: "b",
  a_name: "mine",
  b_name: "the reference",
  generated_at: "2026-09-13T08:00:00+00:00",
  deltas: [
    delta({ section: "vitals", metric: "tempo_bpm", text: "Mine runs at 92 BPM, the reference at 88 BPM (+4.0).", source: "tempo.bpm", a: 92.0, b: 88.0, delta: 4.0, unit: "bpm", confidence: 0.72, hedge: "likely" }),
    delta({ section: "vitals", metric: "swing_pct", text: "Mine swings 52 against the reference's 58.", source: "groove.swing_pct", a: 52.1, b: 58.4, delta: -6.3, unit: "%", confidence: 0.55, hedge: "roughly" }),
    delta({ section: "drums", metric: "hat_density", text: "Mine's hats are 2.0x as dense as the reference's.", source: "drums.patterns[0].hat", a: 16, b: 8, delta: 2.0, unit: "x", confidence: 0.84 }),
    delta({ section: "drums", metric: "kick_pattern_similarity", text: "The kick patterns share 50 percent of their placements.", source: "drums.patterns[0].kick", a: [0, 10], b: [0, 8], delta: 0.5, unit: "", confidence: 0.84 }),
    delta({ section: "mix", metric: "low_high_ratio_db", text: "Mine is 3.0 dB heavier in the low end than the reference.", source: "spectral.low_high_ratio_db", a: 7.5, b: 4.5, delta: 3.0, unit: "dB" }),
    delta({ section: "bass", metric: "sample_bass_overlap", text: "Mine's sample sits in the same range as the bass; the reference's doesn't.", source: "stems.other.spectral.low_high_ratio_db", a: true, b: false, unit: "", confidence: 0.6, hedge: "likely" }),
  ],
  missing: ["chords", "stems"],
};

describe("ComparisonView", () => {
  it("groups the deltas by section with the values in the mono face and the source on hover", () => {
    const html = renderToStaticMarkup(<ComparisonView content={content} aTitle="my_beat.wav" bTitle="reference.wav" />);
    const order = ["The vitals", "The drums", "The bass", "The mix"].map((t) => html.indexOf(`aria-label="${t}"`));
    expect(order.every((p) => p >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain('aria-label="The harmony"');
    expect(html).toContain("Mine runs at 92 BPM, the reference at 88 BPM (+4.0).");
    expect(html).toContain(">92.0</td>");
    expect(html).toContain(">88.0</td>");
    expect(html).toContain(">+4.0 bpm</td>");
    expect(html).toContain('data-source="tempo.bpm"');
    expect(html).toContain('title="from tempo.bpm, confidence 0.72 (likely)"');
    expect(html).toContain("my_beat.wav");
    expect(html).toContain("reference.wav");
    expect(html).toContain(">yes</td>");
    expect(html).toContain(">no</td>");
    expect(html).toContain(">0 10</td>");
    expect(html).toContain(">50%</td>");
    expect(html).toContain(">16</td>");
    expect(html).toContain(">8</td>");
    expect(html).toContain(">2.0x</td>");
    expect(html).toContain(">-6%</td>");
  });

  it("lists the prerequisites that were missing in plain words", () => {
    const html = renderToStaticMarkup(<ComparisonView content={content} aTitle="a" bTitle="b" />);
    expect(html).toContain("stems on both files for the bass/sample overlap");
    expect(html).toContain("chords on both files");
  });
});

describe("compare readouts", () => {
  it("formats values by unit", () => {
    expect(formatValue(92, "bpm")).toBe("92.0");
    expect(formatValue(52.1, "%")).toBe("52");
    expect(formatValue(-14.2, "LU")).toBe("-14.2");
    expect(formatValue(4, "bars")).toBe("4");
    expect(formatValue(16, "x")).toBe("16");
    expect(formatValue([0, 10], "")).toBe("0 10");
    expect(formatValue(0.22, "")).toBe("0.22");
    expect(formatValue("sampled_break", "")).toBe("sampled break");
    expect(formatValue(null, "bpm")).toBe("—");
  });

  it("formats deltas with a sign and the unit", () => {
    expect(formatDelta(delta({ section: "mix", metric: "m", text: "", source: "s", delta: -3.04, unit: "dB" }))).toBe("-3.0 dB");
    expect(formatDelta(delta({ section: "vitals", metric: "m", text: "", source: "s", delta: 4, unit: "bpm" }))).toBe("+4.0 bpm");
    expect(formatDelta(delta({ section: "vitals", metric: "m", text: "", source: "s", delta: null }))).toBe("");
    expect(explainMissing("stems")).toBe("stems on both files for the bass/sample overlap");
    expect(explainMissing("something_else")).toBe("something else on both files");
  });
});
