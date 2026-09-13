// Note mode: one slice played across the keys, the way a sampler does it.
//
//   playbackRate = 2 ** (semitones / 12)
//
// Pitch and duration stay coupled. That is not a compromise: it is the sound
// of a sampler speeding up a tape, and it is what a producer expects when they
// play a stab up the keyboard. Real pitch-with-duration-held is a render on
// the compute side, never a playback trick (the same line the session
// transport draws for time-stretching).

/** Two octaves either side of the root is as far as a slice stays recognisable. */
export const MAX_SEMITONES = 24;
/** Web Audio will resample further than this; past it a slice is not a sound any more. */
export const MIN_RATE = 2 ** (-MAX_SEMITONES / 12);
export const MAX_RATE = 2 ** (MAX_SEMITONES / 12);

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function clampSemitones(semitones: number): number {
  if (!Number.isFinite(semitones)) return 0;
  return Math.max(-MAX_SEMITONES, Math.min(MAX_SEMITONES, Math.round(semitones)));
}

/** The sampler's rate for a transposition. 0 semitones is exactly 1. */
export function rateForSemitones(semitones: number): number {
  return 2 ** (clampSemitones(semitones) / 12);
}

/** How much longer (>1) or shorter (<1) the slice sounds at that transposition. */
export function durationScaleFor(semitones: number): number {
  return 1 / rateForSemitones(semitones);
}

/** The root sits in the middle of the layout so there is room either side. */
export function defaultRootPad(padCount: number): number {
  if (padCount <= 1) return 1;
  return Math.max(1, Math.ceil(padCount / 2));
}

/** Semitones from the root for a pad, counting up the layout one key at a time. */
export function semitonesForPad(pad: number, rootPad: number): number {
  return clampSemitones(pad - rootPad);
}

/** A name for the interval, for the key cap and the readout: "root", "+3", "-5". */
export function intervalLabel(semitones: number): string {
  if (semitones === 0) return "root";
  return semitones > 0 ? `+${semitones}` : String(semitones);
}

/**
 * The note a pad plays when the root note is known (from the file's measured
 * key, or a root the producer sets). Without one there is no note name to give
 * and the interval is all we honestly have.
 */
export function noteNameFor(rootNote: string | null, semitones: number): string | null {
  const base = noteIndex(rootNote);
  if (base === null) return null;
  const n = (((base + clampSemitones(semitones)) % 12) + 12) % 12;
  return NAMES[n] as string;
}

const NATURALS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Pitch class of a note name, sharps or flats; null when it is not a note. */
export function noteIndex(note: string | null | undefined): number | null {
  const text = (note ?? "").trim();
  if (text.length === 0) return null;
  const base = NATURALS[text[0]!.toUpperCase()];
  if (base === undefined) return null;
  let shift = 0;
  for (const ch of text.slice(1)) {
    if (ch === "#" || ch === "\u266f") shift += 1;
    else if (ch === "b" || ch === "\u266d") shift -= 1;
    else return null;
  }
  return (((base + shift) % 12) + 12) % 12;
}
