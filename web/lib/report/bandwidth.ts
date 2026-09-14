// What the file's measured bandwidth means for a producer.
//
// `report.spectral.bandwidth` is the highest frequency still carrying real
// energy (analysis/lockedgroove/quality/bandwidth.py). A 320 kbps encode stops
// around 20 kHz, a 128 kbps one around 16, a rip off a cassette far lower. The
// uploads in the first real sessions measured 12.0 to 15.7 kHz — which is most
// of why the layers built from them sounded muffled.
//
// Nothing downstream puts back what the file never had. The processing chain
// already knows this (it refuses to boost above the measured edge, moves.ts);
// the producer was never told, so a dull flip read as our fault rather than as
// the record's. This says it out loud.

import type { Estimate } from "@/lib/types/report";

export type SourceGrade = "full" | "lossy" | "limited" | "unclear";

export interface SourceFidelity {
  hz: number;
  khz: string;
  grade: SourceGrade;
  /** one sentence, in the second person, that a producer can act on */
  verdict: string;
  confidence: number;
  /**
   * The measurement's own caveat, in its words — that the file's sample rate
   * was the limit rather than the record, or that it was measured on a working
   * copy. Read it out rather than re-deriving it here: the `nyquist_limited`
   * flag never reaches the report, so any grade based on that would be this
   * side sniffing Python's prose, which rots the first time the prose changes.
   */
  note: string | null;
}

/** Above this the file carries everything a release would; below it something was thrown away. */
export const FULL_BAND_HZ = 19_000;
/**
 * Below this the loss is audible on anything bright.
 *
 * The real uploads in the first sessions measured 12.0, 13.5 and 15.7 kHz, and
 * every layer built from them sounded muffled — so 15.7 belongs on the wrong
 * side of this line, not the right one.
 */
export const LOSSY_HZ = 16_500;

/**
 * Below this confidence the measurement is not saying anything.
 *
 * The same floor as `hedgeWord`'s "I can't tell" band. It is load-bearing: a
 * measurement taken on a downsampled working copy reports the copy's own
 * ceiling (11.0 kHz at confidence 0.2) with a note saying to re-measure on the
 * upload. Grading that would tell a producer their source is the problem when
 * the file may be perfect.
 */
export const RELIABLE_CONFIDENCE = 0.4;

/**
 * Read the estimate, or null when nothing measured it.
 *
 * Null is not "fine": a file analysed before this was measured has no number,
 * and inventing a grade for it would be a claim from nothing.
 */
export function sourceFidelity(bandwidth: Estimate | null | undefined): SourceFidelity | null {
  if (!bandwidth || bandwidth.value === null || !Number.isFinite(bandwidth.value) || bandwidth.value <= 0) return null;
  const hz = bandwidth.value;
  const khz = (hz / 1000).toFixed(1);
  const reliable = bandwidth.confidence >= RELIABLE_CONFIDENCE;
  const grade: SourceGrade = !reliable ? "unclear" : hz >= FULL_BAND_HZ ? "full" : hz >= LOSSY_HZ ? "lossy" : "limited";
  const verdict = {
    full: `This file carries its full top end (${khz} kHz). Nothing here is holding the sound back.`,
    lossy: `This file stops at ${khz} kHz, which is a lossy encode. Stems off it will sound softer than the record does, and no EQ puts that back.`,
    limited: `This file stops at ${khz} kHz. That is well short of a release, so it will sound dull however it is separated — a cleaner source is the only fix.`,
    unclear: `The top end could not be measured reliably here (${khz} kHz at confidence ${bandwidth.confidence.toFixed(2)}), so nothing is being claimed about this file's quality.`,
  }[grade];
  return { hz, khz, grade, verdict, confidence: bandwidth.confidence, note: bandwidth.notes };
}

/** True when a producer should be told before they blame the separation. */
export function limitsTheFlip(fidelity: SourceFidelity | null): boolean {
  return fidelity !== null && (fidelity.grade === "lossy" || fidelity.grade === "limited");
}
