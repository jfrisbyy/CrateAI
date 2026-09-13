// Readouts for the comparison: numbers in the mono face with the decimals the
// unit deserves, and the plain-words reason for each prerequisite the
// composer could not compare.

import type { ComparisonDelta, Json } from "@/lib/types/db";

const DIGITS_BY_UNIT: Record<string, number> = {
  bpm: 1,
  "%": 0,
  LU: 1,
  dB: 1,
  Hz: 0,
  s: 1,
  x: 1,
  bars: 0,
  chops: 0,
  sections: 0,
  chords: 0,
  semitones: 0,
  "hits/bar": 1,
};

/** Units whose values are measured floats: an integer there still reads with its decimals (92.0 BPM). */
const FLOAT_UNITS = new Set(["bpm", "LU", "dB", "s", "hits/bar"]);

export function digitsFor(unit: string): number {
  return DIGITS_BY_UNIT[unit] ?? 2;
}

export function formatValue(value: Json, unit: string): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return Number.isInteger(value) && !FLOAT_UNITS.has(unit) ? String(value) : value.toFixed(digitsFor(unit));
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value.replace(/_/g, " ");
  if (Array.isArray(value)) return value.length ? value.map((v) => formatValue(v, unit)).join(" ") : "—";
  return JSON.stringify(value);
}

export function formatDelta(delta: ComparisonDelta): string {
  if (delta.delta === null || delta.delta === undefined) return "";
  const d = delta.delta;
  if (delta.unit === "x") return `${d.toFixed(1)}x`;
  if (delta.metric === "kick_pattern_similarity") return `${Math.round(d * 100)}%`;
  const digits = digitsFor(delta.unit);
  const sign = d > 0 ? "+" : "";
  if (delta.unit === "%") return `${sign}${d.toFixed(digits)}%`;
  return `${sign}${d.toFixed(digits)}${delta.unit ? ` ${delta.unit}` : ""}`;
}

/** analysis/lockedgroove/breakdown/compare.py: the keys it appends to `missing`. */
const MISSING_EXPLANATIONS: Record<string, string> = {
  tempo: "tempo on both files",
  key: "key on both files",
  groove: "groove on both files",
  structure: "structure on both files",
  sample_use: "sample-use analysis on both files (the Phase 4 stages)",
  drums: "drum analysis on both files (separate stems on each)",
  stems: "stems on both files for the bass/sample overlap",
  chords: "chords on both files",
  loudness: "loudness on both files",
  spectral: "spectral balance on both files",
};

export function explainMissing(key: string): string {
  return MISSING_EXPLANATIONS[key] ?? `${key.replace(/_/g, " ")} on both files`;
}

export const COMPARE_SECTIONS: ReadonlyArray<{ key: ComparisonDelta["section"]; title: string }> = [
  { key: "vitals", title: "The vitals" },
  { key: "structure", title: "The structure" },
  { key: "sample", title: "The sample" },
  { key: "drums", title: "The drums" },
  { key: "bass", title: "The bass" },
  { key: "harmony", title: "The harmony" },
  { key: "mix", title: "The mix" },
];
