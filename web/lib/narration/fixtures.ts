// A BreakdownContent the way analysis/lockedgroove/breakdown/compose.py
// writes one for a loop-based hip-hop record: the texts, sources, hedges and
// values follow the composer's exact formats so the tests exercise the same
// shapes the routes see. Variants: chords not measured (section-14 fixture),
// an identified track with cited context.

import type { BreakdownContent, BreakdownFact, BreakdownSection, BreakdownSectionKey } from "@/lib/types/db";

type FactInit = Partial<BreakdownFact> & Pick<BreakdownFact, "text" | "source">;

export function fact(init: FactInit): BreakdownFact {
  return {
    confidence: null,
    hedge: "",
    value: null,
    time_s: null,
    end_s: null,
    bar: null,
    citation: null,
    ...init,
  };
}

export function section(key: BreakdownSectionKey, title: string, facts: BreakdownFact[], missing: BreakdownSection["missing"] = []): BreakdownSection {
  return { key, title, facts, missing };
}

export interface FixtureOptions {
  /** false: the harmony section is not measured (chords null), with the job to run it */
  chords?: boolean;
  /** true: the track is identified and the context section carries a cited world fact */
  identified?: boolean;
}

export function sampleContent(options: FixtureOptions = {}): BreakdownContent {
  const chords = options.chords ?? true;
  const identified = options.identified ?? false;
  const verseStart = 20.87;
  const verseEnd = 62.6;

  const harmony = chords
    ? section("harmony", "The harmony", [
        fact({
          text: "Likely verse: Fm – Bbm – Db.",
          source: "stems.other.chords.segments",
          confidence: 0.62,
          hedge: "likely",
          value: ["Fm", "Bbm", "Db"],
          time_s: verseStart,
          end_s: verseEnd,
          bar: 8,
        }),
        fact({ text: "The sample and the song share a key.", source: "stems.other.key", confidence: 0.8, hedge: "", value: true }),
      ])
    : section("harmony", "The harmony", [], [{ field: "chords", text: "Chords weren't measured yet.", job: "analyze:chords" }]);

  const context = identified
    ? section("context", "The context", [
        fact({
          text: "Produced by Test Producer in a home studio.",
          source: "web_context.findings[0]",
          value: "producer",
          citation: { url: "https://example.com/interview", title: "Interview with Test Producer" },
        }),
      ])
    : section("context", "The context", [], [
        { field: "context", text: "Identify the track and I can add what's been documented about it.", job: "identify_context" },
      ]);

  return {
    schema_version: "1.0",
    file_id: "00000000-0000-4000-8000-000000000001",
    generated_at: "2026-09-13T08:00:00+00:00",
    analysis_version: 2,
    identified,
    title: identified ? "Test Track" : null,
    artist: identified ? "Test Artist" : null,
    requires: chords ? [] : ["analyze:other"],
    sections: [
      section("vitals", "The vitals", [
        fact({
          text: "Likely it sits at 92 BPM, though it could be 46 or 184 depending on how you count it.",
          source: "tempo.bpm",
          confidence: 0.72,
          hedge: "likely",
          value: 92.0,
          time_s: 0,
        }),
        fact({ text: "The key is F minor.", source: "key", confidence: 0.86, hedge: "", value: { tonic: "F", mode: "minor" } }),
        fact({ text: "It's in 4/4.", source: "beats.meter", value: "4/4" }),
        fact({
          text: "Roughly the feel is swung, about 58 percent.",
          source: "groove",
          confidence: 0.55,
          hedge: "roughly",
          value: { feel: "swung", swing_pct: 58.2 },
        }),
      ]),
      section("structure", "The structure", [
        fact({
          text: "Bars 1 to 8: intro, 8 bars.",
          source: "structure.sections[0]",
          confidence: 0.7,
          hedge: "likely",
          value: { label: "intro", bars: 8, energy: 0.31 },
          time_s: 0,
          end_s: verseStart,
          bar: 0,
        }),
        fact({
          text: "Bars 9 to 24: verse, 16 bars.",
          source: "structure.sections[1]",
          confidence: 0.7,
          hedge: "likely",
          value: { label: "verse", bars: 16, energy: 0.58 },
          time_s: verseStart,
          end_s: verseEnd,
          bar: 8,
        }),
        fact({
          text: "Energy rises going into bar 9 (verse).",
          source: "structure.sections[1].energy",
          confidence: 0.7,
          hedge: "likely",
          value: 0.27,
          time_s: verseStart,
          bar: 8,
        }),
        fact({ text: "The whole thing sits on a 4-bar loop.", source: "structure.loop_period_bars", confidence: 0.83, hedge: "", value: 4 }),
      ]),
      section("sample", "The sample", [
        fact({ text: "It's loop-based, on a 4-bar phrase.", source: "sample_use.is_loop_based", confidence: 0.81, hedge: "", value: true }),
        fact({
          text: "4 chops, played in the order 1-2-1-3.",
          source: "sample_use.chop_count_estimate",
          confidence: 0.81,
          hedge: "",
          value: { count: 4, reordered: true },
        }),
        fact({
          text: "Likely the sample is pitched up 1 semitone from the source.",
          source: "sample_use.pitch_shift_semitones_estimate",
          confidence: 0.65,
          hedge: "likely",
          value: 1,
        }),
      ]),
      section("drums", "The drums", [
        fact({
          text: "The drums are a sampled break: the hits drift against the grid and vary in tone the way a played break does.",
          source: "stems.drums.drums.source_estimate",
          confidence: 0.84,
          hedge: "",
          value: "sampled_break",
        }),
        fact({
          text: "In verse: Kick on the one and the and of three. Snare on the two and the four. Hats on 8ths.",
          source: "stems.drums.drums.patterns[1]",
          confidence: 0.84,
          hedge: "",
          value: { section_index: 1, density_per_bar: 12.0 },
          time_s: verseStart,
          bar: 8,
        }),
        fact({ text: "Roughly swing is 58 percent.", source: "groove.swing_pct", confidence: 0.55, hedge: "roughly", value: 58.2 }),
      ]),
      section("bass", "The bass", [
        fact({ text: "There's a bass part.", source: "stems.bass.loudness", confidence: 0.9, hedge: "", value: true }),
        fact({ text: "Likely the bass follows the sample's roots.", source: "stems.bass.chords", confidence: 0.7, hedge: "likely", value: true }),
      ]),
      harmony,
      section("melodic", "The melodic layer", [
        fact({ text: "No vocal.", source: "stems.vocals.loudness", confidence: 0.9, hedge: "", value: false }),
        fact({ text: "The harmonic layer centers around 1450 Hz.", source: "stems.other.spectral.centroid_hz_mean", value: 1450.3 }),
      ]),
      section("arrangement", "The arrangement", [
        fact({
          text: "Likely bass enters at bar 9.",
          source: "instrumentation.per_section[1].entries",
          confidence: 0.75,
          hedge: "likely",
          value: { instrument: "bass", bar: 8 },
          time_s: verseStart,
          bar: 8,
        }),
      ]),
      section("mix", "The mix", [
        fact({
          text: "It's -14.2 LUFS integrated, -0.8 dBTP peak, with 6.1 LU of range.",
          source: "loudness",
          value: { integrated_lufs: -14.2, true_peak_dbtp: -0.8, loudness_range_lu: 6.1 },
        }),
        fact({
          text: "It's heavy on the low end (+7.5 dB low against high) and narrow in the stereo field.",
          source: "spectral",
          value: { centroid_hz_mean: 1810.4, stereo_width: 0.22, low_high_ratio_db: 7.5 },
        }),
        fact({
          text: "Likely there's sidechain ducking on the kick, about 3.0 dB deep.",
          source: "effects_estimates.sidechain_ducking",
          confidence: 0.62,
          hedge: "likely",
          value: 3.0,
        }),
        fact({
          text: "Roughly the reverb tail is around 1.2 s (rough).",
          source: "effects_estimates.reverb_tail_s",
          confidence: 0.4,
          hedge: "roughly",
          value: 1.2,
        }),
      ]),
      context,
      section("recipe", "The recipe", [
        fact({ text: "Find a 4-bar loop around 92 in F minor.", source: "tempo.bpm" }),
        fact({ text: "Chop it in 4 and play them 1-2-1-3.", source: "sample_use.chop_count_estimate" }),
        fact({
          text: "Lay a live-feeling break under it, swung 58 percent with the kick on the one and the and of three.",
          source: "drums.patterns[0]",
        }),
        fact({ text: "Add a bass part under the loop.", source: "stems.bass.loudness" }),
        fact({ text: "Low-pass the loop so the break carries the top end.", source: "spectral.low_high_ratio_db" }),
        fact({ text: "Duck the sample 3.0 dB on the kick.", source: "effects_estimates.sidechain_ducking" }),
        fact({ text: "Aim the mix at about -14 LUFS.", source: "loudness.integrated_lufs" }),
      ]),
    ],
  };
}

/** A narration a careful mentor would write from `sampleContent()`: nothing beyond the facts, every hedge kept. */
export const FAITHFUL_NARRATION = [
  "The vitals. Likely it sits at 92 BPM, though it could read as 46 or 184 depending on how you count it, and the key is F minor in 4/4. Roughly, the feel is swung at about 58 percent.",
  "The structure. Bars 1 to 8 are the intro, 8 bars, then bars 9 to 24 are the verse, 16 bars; the energy rises going into bar 9. The whole thing sits on a 4-bar loop.",
  "The sample. It's loop-based on a 4-bar phrase, cut into 4 chops played 1-2-1-3, and likely pitched up 1 semitone from the source.",
  "The drums. A sampled break: the hits drift against the grid and vary in tone the way a played break does. In the verse the kick lands on the one and the and of three, the snare on the two and the four, hats on 8ths. Roughly, the swing is 58 percent.",
  "The bass. There's a bass part, and it likely follows the sample's roots.",
  "The harmony. Likely the verse runs Fm – Bbm – Db, and the sample and the song share a key.",
  "The melodic layer. No vocal; the harmonic layer centers around 1450 Hz.",
  "The arrangement. Likely the bass enters at bar 9.",
  "The mix. It's -14.2 LUFS integrated with a -0.8 dBTP peak and 6.1 LU of range, heavy on the low end (+7.5 dB low against high) and narrow in the stereo field. Likely there's sidechain ducking on the kick, about 3.0 dB deep, and roughly a 1.2 s reverb tail (rough).",
  "The context. The track hasn't been identified yet; identify it and I can add what's been documented about it.",
  "The recipe.\n1. Find a 4-bar loop around 92 in F minor.\n2. Chop it in 4 and play them 1-2-1-3.\n3. Lay a live-feeling break under it, swung 58 percent with the kick on the one and the and of three.\n4. Add a bass part under the loop.\n5. Low-pass the loop so the break carries the top end.\n6. Duck the sample 3.0 dB on the kick.\n7. Aim the mix at about -14 LUFS.",
].join("\n\n");
