// Hedging bands (BUILD_PACKET section 11; analysis/lockedgroove/report.py
// HEDGE_BANDS). Narration and the UI pick the word by band, never ad hoc.
//
//   >= 0.8   -> ""             state it plainly
//   0.6-0.8  -> "likely"
//   0.4-0.6  -> "roughly"
//   < 0.4    -> "I can't tell"
//   null     -> "not measured"

export const HEDGE_BANDS: ReadonlyArray<readonly [number, string]> = [
  [0.8, ""],
  [0.6, "likely"],
  [0.4, "roughly"],
  [0.0, "I can't tell"],
];

export function hedgeWord(confidence: number | null | undefined): string {
  if (confidence === null || confidence === undefined) return "not measured";
  for (const [floor, word] of HEDGE_BANDS) {
    if (confidence >= floor) return word;
  }
  return "I can't tell";
}

/**
 * Three visual levels for the confidence dot, aligned with the hedge bands:
 * `full` (>= 0.8, stated plainly), `half` (0.6-0.8, "likely"), `low`
 * (< 0.6, "roughly" or worse). `none` when the value was not measured.
 */
export type ConfidenceLevel = "full" | "half" | "low" | "none";

export function confidenceLevel(confidence: number | null | undefined): ConfidenceLevel {
  if (confidence === null || confidence === undefined || Number.isNaN(confidence)) return "none";
  if (confidence >= 0.8) return "full";
  if (confidence >= 0.6) return "half";
  return "low";
}

/** "likely F minor", "roughly 92 BPM", or the value alone when confident. */
export function hedged(value: string, confidence: number | null | undefined): string {
  const word = hedgeWord(confidence);
  if (word === "") return value;
  if (word === "not measured") return "not measured yet";
  if (word === "I can't tell") return `${value} (I can't tell)`;
  return `${word} ${value}`;
}
