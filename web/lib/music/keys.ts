// Key spelling. The report keeps sharps (CLAUDE.md conventions); the UI shows
// the spelling producers use for that mode (OPEN_QUESTIONS C.13): F minor,
// Bb major, C# minor, Db major. The other enharmonic is available for hover.

import type { Mode } from "@/lib/types/report";

export const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
export type PitchClass = (typeof PITCH_CLASSES)[number];

const FLAT_OF: Record<string, string> = { "C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb" };
const SHARP_OF: Record<string, PitchClass> = {
  Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#",
  // theoretical spellings that people still type
  Cb: "B", Fb: "E", "E#": "F", "B#": "C",
};

// The conventional spelling of each black key, per mode. Major keys lean flat
// (Db, Eb, Ab, Bb) except F#; minor keys lean sharp (C#, F#, G#) except Eb and Bb.
const CONVENTIONAL: Record<Mode, Record<string, string>> = {
  major: { "C#": "Db", "D#": "Eb", "F#": "F#", "G#": "Ab", "A#": "Bb" },
  minor: { "C#": "C#", "D#": "Eb", "F#": "F#", "G#": "G#", "A#": "Bb" },
};

export function isPitchClass(s: string): s is PitchClass {
  return (PITCH_CLASSES as readonly string[]).includes(s);
}

/** "A#" + "minor" -> "Bb"; "C#" + "minor" -> "C#"; naturals pass through. */
export function displayTonic(tonic: string, mode: Mode): string {
  return CONVENTIONAL[mode]?.[tonic] ?? tonic;
}

/** "F minor", "Bb major", "C# minor", "Db major". */
export function displayKey(tonic: string, mode: Mode): string {
  return `${displayTonic(tonic, mode)} ${mode}`;
}

/** The enharmonic that is not shown, for hover: "A# minor" behind "Bb minor". Null for naturals. */
export function otherSpelling(tonic: string, mode: Mode): string | null {
  const shown = displayTonic(tonic, mode);
  const flat = FLAT_OF[tonic];
  if (!flat) return null;
  const other = shown === tonic ? flat : tonic;
  return `${other} ${mode}`;
}

/** Short token for export names (OPEN_QUESTIONS D.18): "Fm", "Bb", "C#m". */
export function keyToken(tonic: string, mode: Mode): string {
  return `${displayTonic(tonic, mode)}${mode === "minor" ? "m" : ""}`;
}

/**
 * Normalize any typed tonic to the report's sharp spelling: "bb" -> "A#",
 * "Db" -> "C#", "e#" -> "F", "f" -> "F". Accepts ♯/♭. Returns null when the
 * text is not a note name.
 */
export function normalizeTonic(input: string): PitchClass | null {
  const m = /^\s*([a-gA-G])\s*(#|♯|b|♭)?\s*$/.exec(input);
  if (!m) return null;
  const letter = (m[1] as string).toUpperCase();
  const acc = m[2] === "♯" ? "#" : m[2] === "♭" ? "b" : (m[2] ?? "");
  const spelled = `${letter}${acc}`;
  if (isPitchClass(spelled)) return spelled;
  const sharp = SHARP_OF[spelled];
  return sharp ?? null;
}

/**
 * Parse free text a producer would type: "f minor", "fm", "F#m", "bb major",
 * "Bbmaj", "Ebmin", "c# min", "a minor". Bare note names without a mode are
 * not a key (too ambiguous inside a search box). Returns the sharp spelling.
 */
export function parseKeyText(text: string): { tonic: PitchClass; mode: Mode; match: string } | null {
  const re = /(?:^|[\s,;(])([a-gA-G])(#|♯|b|♭)?\s*-?\s*(minor|major|min|maj|m)(?=$|[\s,;)])/;
  const m = re.exec(text);
  if (!m) return null;
  const tonic = normalizeTonic(`${m[1]}${m[2] ?? ""}`);
  if (!tonic) return null;
  const modeWord = (m[3] as string).toLowerCase();
  const mode: Mode = modeWord.startsWith("maj") ? "major" : "minor";
  const match = m[0].replace(/^[\s,;(]/, "");
  return { tonic, mode, match };
}
