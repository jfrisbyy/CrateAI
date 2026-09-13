// Compatibility: what in the crate works with this file.
//
// Faithful port of analysis/lockedgroove/analysis/compat.py, which is the source
// of truth for the thresholds, the relationship names, the scores and the
// confidence rule. The Python docstring carries the reasoning; this file carries
// the same arithmetic so the panel can say why a file fits without a round trip,
// and so the wording on a row is produced in exactly one place.
//
// analysis/tests/test_compat.py and theory.test.ts hold the same cases. Keep them
// in step: supabase/migrations/20260913000500_compat.sql implements the coarse
// filter with the same five relationships and the same fold.

import type { Mode } from "@/lib/types/report";

export type { Mode };

export const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

// --- tempo ---
export const TRANSPARENT_MAX = 0.06;
export const USABLE_MAX = 0.14;
export const MAX_OCTAVES = 1;
export const OCTAVE_PENALTY = 0.03;
export const NO_TEMPO_SCORE = 0.5;

// --- key ---
export const MAX_SHIFT = 6;
export const CHARACTER_SHIFT = 2;
/** compat.NON_TONAL_TAGS / align.py; the same list app/api/layers/vitals.ts uses. */
export const NON_TONAL_TAGS: ReadonlySet<string> = new Set(["drums", "drum", "break", "percussion", "hats", "kick", "snare", "beatbox"]);
export const SHIFT_PENALTY = 0.12;
export const NO_KEY_SCORE = 1.0;
export const RELATIONSHIP_STRENGTH: Record<string, number> = {
  same: 1.0,
  relative: 0.9,
  dominant: 0.8,
  subdominant: 0.8,
  parallel: 0.7,
};

// --- combination ---
export const TEMPO_WEIGHT = 0.5;
export const KEY_WEIGHT = 0.5;

export type TempoFold = "none" | "half" | "double";
export type StretchQuality = "transparent" | "usable" | "out_of_range" | "unknown";
export type KeyRelationship = "same" | "relative" | "dominant" | "subdominant" | "parallel" | "unknown";
export type ConfidenceBound = "source_tempo" | "candidate_tempo" | "source_key" | "candidate_key" | "";

export const TEMPO_METHOD = `octave-folded tempo ratio, transparent <= ${Math.round(TRANSPARENT_MAX * 100)}%, usable <= ${Math.round(USABLE_MAX * 100)}%, fold up to ${MAX_OCTAVES} octave`;
export const KEY_METHOD = `key relationship (same, relative, fifth up or down, parallel), smallest pitch shift up to ${MAX_SHIFT} semitones`;
export const METHOD = `${TEMPO_METHOD}; ${KEY_METHOD}`;

/** What a compatibility question needs to know about one file: its effective values. */
export interface TrackVitals {
  file_id?: string | null;
  bpm: number | null;
  bpm_confidence: number | null;
  tonic: string | null;
  mode: Mode | null;
  key_confidence: number | null;
  /** false for drums and other non-tonal material: whatever the chroma read, it has no key */
  tonal?: boolean;
}

/**
 * Does this material have a key at all? The rule align.py's `AlignItem.is_tonal`
 * uses and the layer render obeys. The key stage always returns a best profile,
 * so a drum break reads as a key at about 0.37 confidence -- a number about the
 * chroma, not about the music.
 */
export function isTonal(kind = "original", tags: readonly string[] = [], filename = ""): boolean {
  if (kind === "stem" && filename.toLowerCase().includes("drums")) return false;
  return !tags.some((t) => NON_TONAL_TAGS.has(t.trim().toLowerCase()));
}

export interface TempoMatch {
  source_bpm: number | null;
  candidate_bpm: number | null;
  /** the candidate's tempo after the octave fold: what it is counted as here */
  folded_bpm: number | null;
  octave_factor: number;
  fold: TempoFold;
  /** source / folded candidate: what the candidate's playback rate is multiplied by */
  ratio: number | null;
  /** (ratio - 1) * 100, signed: +2 means the candidate plays 2 % faster */
  percent: number | null;
  /** max(ratio, 1/ratio) - 1: how far the stretch is from transparent, either direction */
  distance: number | null;
  quality: StretchQuality;
  compatible: boolean;
  score: number;
  confidence: number | null;
  method: string;
  note: string;
}

export interface KeyMatch {
  source_tonic: string | null;
  source_mode: Mode | null;
  candidate_tonic: string | null;
  candidate_mode: Mode | null;
  relationship: KeyRelationship;
  /** semitones the candidate is shifted by to reach the relationship; 0 for the five direct ones */
  semitone_shift: number;
  shifts_character: boolean;
  compatible: boolean;
  score: number;
  confidence: number | null;
  method: string;
  note: string;
}

export interface Compatibility {
  score: number;
  confidence: number;
  confidence_bound_by: ConfidenceBound;
  confidence_reason: string;
  method: string;
  compatible: boolean;
  reason: string;
  tempo: TempoMatch;
  key: KeyMatch;
}

const FLAT_TO_SHARP: Record<string, string> = {
  DB: "C#", EB: "D#", GB: "F#", AB: "G#", BB: "A#", CB: "B", FB: "E", "E#": "F", "B#": "C",
};

/**
 * Six decimals, matching Python's `round(x, 6)`. `toFixed` rounds the decimal
 * expansion of the double itself; `Math.round(n * 1e6)` amplifies the binary
 * error first and disagrees with the Python on values that land near a half.
 */
function round6(n: number): number {
  return Number(n.toFixed(6));
}

function clampUnit(value: number | null | undefined): number {
  // a present measurement with no recorded confidence is a 0, not a 1 (principle 2)
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function hasTempo(v: TrackVitals): boolean {
  return typeof v.bpm === "number" && Number.isFinite(v.bpm) && v.bpm > 0;
}

export function hasKey(v: TrackVitals): boolean {
  return v.tonal !== false && !!v.tonic && (v.mode === "major" || v.mode === "minor");
}

// ---------------------------------------------------------------------------
// tempo
// ---------------------------------------------------------------------------

/** `[octaveFactor, ratio]`: the power of two that brings the candidate nearest, and what is left. */
export function foldTempo(sourceBpm: number, candidateBpm: number, maxOctaves = MAX_OCTAVES): [number, number] {
  if (!(sourceBpm > 0) || !(candidateBpm > 0)) throw new Error("tempos must be positive");
  const exact = Math.log2(sourceBpm / candidateBpm);
  const exponent = Math.max(-maxOctaves, Math.min(maxOctaves, Math.round(exact)));
  const factor = 2 ** exponent;
  return [factor, sourceBpm / (candidateBpm * factor)];
}

/** How far a stretch ratio is from transparent, in either direction: `max(r, 1/r) - 1`. */
export function stretchDistance(ratio: number): number {
  if (!(ratio > 0)) throw new Error("ratio must be positive");
  return Math.max(ratio, 1 / ratio) - 1;
}

function pairConfidence(a: number | null, b: number | null): number | null {
  const values = [a, b].filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
  if (values.length === 0) return null;
  return Math.min(...values.map((v) => Math.max(0, Math.min(1, v))));
}

function foldName(factor: number): TempoFold {
  if (factor > 1) return "double";
  if (factor < 1) return "half";
  return "none";
}

/** Python's `%g`: six significant digits, trailing zeros dropped. */
function trimNumber(n: number): string {
  return String(Number(n.toPrecision(6)));
}

export function compareTempo(
  source: TrackVitals,
  candidate: TrackVitals,
  opts: { tolerance?: number; maxOctaves?: number } = {},
): TempoMatch {
  const tolerance = Math.max(0, opts.tolerance ?? USABLE_MAX);
  const maxOctaves = opts.maxOctaves ?? MAX_OCTAVES;
  const confidence = pairConfidence(source.bpm_confidence, candidate.bpm_confidence);
  if (!hasTempo(source) || !hasTempo(candidate)) {
    const side = !hasTempo(source) && !hasTempo(candidate) ? "neither file" : !hasTempo(source) ? "this file" : "the other file";
    return {
      source_bpm: source.bpm, candidate_bpm: candidate.bpm, folded_bpm: null, octave_factor: 1,
      fold: "none", ratio: null, percent: null, distance: null, quality: "unknown", compatible: true,
      score: NO_TEMPO_SCORE, confidence: null, method: TEMPO_METHOD,
      note: `no tempo measured on ${side}; tempo says nothing either way`,
    };
  }
  const sourceBpm = source.bpm as number;
  const candidateBpm = candidate.bpm as number;
  const [factor, ratio] = foldTempo(sourceBpm, candidateBpm, maxOctaves);
  const distance = stretchDistance(ratio);
  const quality: StretchQuality = distance <= TRANSPARENT_MAX ? "transparent" : distance <= tolerance ? "usable" : "out_of_range";
  const score = Math.max(0, 1 - distance / (2 * USABLE_MAX)) * (1 - OCTAVE_PENALTY) ** Math.abs(Math.round(Math.log2(factor)));
  const fold = foldName(factor);
  const folded = candidateBpm * factor;
  let note = `${trimNumber(candidateBpm)} BPM`;
  if (fold !== "none") note += ` counted ${fold}-time as ${trimNumber(folded)}`;
  note += `, stretched x${ratio.toFixed(4)} onto ${trimNumber(sourceBpm)} BPM (${quality.replace(/_/g, " ")})`;
  return {
    source_bpm: sourceBpm, candidate_bpm: candidateBpm, folded_bpm: folded, octave_factor: factor, fold,
    ratio, percent: (ratio - 1) * 100, distance, quality, compatible: quality !== "out_of_range",
    score: round6(score), confidence, method: TEMPO_METHOD, note,
  };
}

// ---------------------------------------------------------------------------
// key
// ---------------------------------------------------------------------------

/** 0-11 for a tonic spelled with sharps or flats; null when it is not a note name. */
export function pitchClass(tonic: string | null | undefined): number | null {
  if (!tonic) return null;
  const text = tonic.trim().replace(/♯/g, "#").replace(/♭/g, "b");
  const letter = text.charAt(0).toUpperCase();
  if (!/^[A-G]$/.test(letter)) return null;
  const accidental = text.slice(1).trim();
  let spelled: string;
  if (accidental === "" || accidental === "#") spelled = letter + accidental;
  else if (accidental.toLowerCase() === "b") spelled = `${letter}b`;
  else return null;
  const direct = (PITCH_CLASSES as readonly string[]).indexOf(spelled);
  if (direct >= 0) return direct;
  const sharp = FLAT_TO_SHARP[spelled.toUpperCase()];
  return sharp ? (PITCH_CLASSES as readonly string[]).indexOf(sharp) : null;
}

/**
 * One of the five no-shift relationships, or null. The fifths require the same
 * mode: G major over C minor is a B natural against a B flat.
 */
export function directRelationship(sourcePc: number, sourceMode: Mode, candidatePc: number, candidateMode: Mode): string | null {
  const interval = (((candidatePc - sourcePc) % 12) + 12) % 12;
  if (candidateMode === sourceMode) {
    if (interval === 0) return "same";
    if (interval === 7) return "dominant";
    if (interval === 5) return "subdominant";
    return null;
  }
  if (interval === 0) return "parallel";
  // the relative minor sits 9 semitones above its major (A minor over C major)
  if (sourceMode === "major" && candidateMode === "minor" && interval === 9) return "relative";
  if (sourceMode === "minor" && candidateMode === "major" && interval === 3) return "relative";
  return null;
}

/**
 * The smallest shift of the candidate that lands on a relationship. Shift 0 is
 * tried first, so a pair that already works is never pitched; within one shift
 * size the stronger relationship wins and an upward shift beats a downward one.
 */
export function keyRelationship(
  sourceTonic: string | null,
  sourceMode: Mode | null,
  candidateTonic: string | null,
  candidateMode: Mode | null,
  maxShift = MAX_SHIFT,
): { relationship: string | null; shift: number } {
  const src = pitchClass(sourceTonic);
  const cand = pitchClass(candidateTonic);
  if (src === null || cand === null || !sourceMode || !candidateMode) return { relationship: null, shift: 0 };
  for (let size = 0; size <= Math.max(0, Math.trunc(maxShift)); size++) {
    const found: Array<{ strength: number; shift: number; relationship: string }> = [];
    for (const shift of size === 0 ? [0] : [size, -size]) {
      const relationship = directRelationship(src, sourceMode, (((cand + shift) % 12) + 12) % 12, candidateMode);
      if (relationship !== null) found.push({ strength: RELATIONSHIP_STRENGTH[relationship] as number, shift, relationship });
    }
    if (found.length > 0) {
      found.sort((a, b) => b.strength - a.strength || b.shift - a.shift);
      const best = found[0] as { strength: number; shift: number; relationship: string };
      return { relationship: best.relationship, shift: best.shift };
    }
  }
  return { relationship: null, shift: 0 };
}

/** The relationship as a producer would say it: "relative minor", "a fifth up". */
export function relationshipWords(relationship: string, candidateMode: Mode | null): string {
  switch (relationship) {
    case "same":
      return "same key";
    case "relative":
      return `relative ${candidateMode ?? "key"}`;
    case "dominant":
      return "a fifth up";
    case "subdominant":
      return "a fifth down";
    case "parallel":
      return `parallel ${candidateMode ?? "key"}`;
    default:
      return "no key detected";
  }
}

export function compareKey(source: TrackVitals, candidate: TrackVitals, opts: { maxSemitones?: number } = {}): KeyMatch {
  const confidence = pairConfidence(source.key_confidence, candidate.key_confidence);
  const base = {
    source_tonic: source.tonic, source_mode: source.mode,
    candidate_tonic: candidate.tonic, candidate_mode: candidate.mode,
    method: KEY_METHOD,
  };
  if (!hasKey(source) || !hasKey(candidate)) {
    const side = !hasKey(source) && !hasKey(candidate) ? "neither file" : !hasKey(source) ? "this file" : "the other file";
    const why = source.tonal === false || candidate.tonal === false ? "drum or other non-tonal material" : "no key measured";
    return {
      ...base, relationship: "unknown", semitone_shift: 0, shifts_character: false, compatible: true,
      score: NO_KEY_SCORE, confidence: null,
      note: `${why} on ${side}; nothing to clash, so it fits anything on that axis`,
    };
  }
  const limit = Math.max(0, Math.trunc(opts.maxSemitones ?? MAX_SHIFT));
  const { relationship, shift } = keyRelationship(source.tonic, source.mode, candidate.tonic, candidate.mode, limit);
  if (relationship === null) {
    const widest = keyRelationship(source.tonic, source.mode, candidate.tonic, candidate.mode, MAX_SHIFT);
    return {
      ...base, relationship: "unknown", semitone_shift: widest.shift,
      shifts_character: Math.abs(widest.shift) > CHARACTER_SHIFT, compatible: false, score: 0, confidence,
      note: `${candidate.tonic} ${candidate.mode} against ${source.tonic} ${source.mode} needs ${Math.abs(widest.shift)} semitones to reach ${widest.relationship}, past the ${limit} allowed`,
    };
  }
  const score = (RELATIONSHIP_STRENGTH[relationship] as number) * Math.max(0, 1 - SHIFT_PENALTY * Math.abs(shift));
  const words = relationshipWords(relationship, candidate.mode);
  const note = shift === 0
    ? `${candidate.tonic} ${candidate.mode} is the ${words} of ${source.tonic} ${source.mode}`
    : `${candidate.tonic} ${candidate.mode} shifted ${shift > 0 ? "+" : ""}${shift} semitones is the ${words} of ${source.tonic} ${source.mode}`;
  return {
    ...base, relationship: relationship as KeyRelationship, semitone_shift: shift,
    shifts_character: Math.abs(shift) > CHARACTER_SHIFT, compatible: true, score: round6(score), confidence, note,
  };
}

// ---------------------------------------------------------------------------
// confidence: a claim is never surer than what it is built on (principle 2)
// ---------------------------------------------------------------------------

const LABELS: Record<Exclude<ConfidenceBound, "">, string> = {
  source_tempo: "this file's tempo",
  candidate_tempo: "the other file's tempo",
  source_key: "this file's key",
  candidate_key: "the other file's key",
};

function boundConfidence(
  tempo: TempoMatch,
  key: KeyMatch,
  source: TrackVitals,
  candidate: TrackVitals,
): { confidence: number; boundBy: ConfidenceBound; reason: string } {
  const used: Array<[Exclude<ConfidenceBound, "">, number]> = [];
  if (tempo.quality !== "unknown") {
    used.push(["source_tempo", clampUnit(source.bpm_confidence)]);
    used.push(["candidate_tempo", clampUnit(candidate.bpm_confidence)]);
  }
  if (key.relationship !== "unknown") {
    used.push(["source_key", clampUnit(source.key_confidence)]);
    used.push(["candidate_key", clampUnit(candidate.key_confidence)]);
  }
  if (used.length === 0) {
    return { confidence: 0, boundBy: "", reason: "nothing was measured on either file, so this is a guess and not offered as more" };
  }
  let best = used[0] as [Exclude<ConfidenceBound, "">, number];
  for (const entry of used) if (entry[1] < best[1]) best = entry;
  return {
    confidence: best[1],
    boundBy: best[0],
    reason: `${LABELS[best[0]]} was measured at ${best[1].toFixed(2)}, and no claim built on it can be surer than that`,
  };
}

// ---------------------------------------------------------------------------
// the pair
// ---------------------------------------------------------------------------

export interface CompatibilityOptions {
  stretchTolerance?: number;
  maxSemitones?: number;
  maxOctaves?: number;
}

export function compatibility(source: TrackVitals, candidate: TrackVitals, opts: CompatibilityOptions = {}): Compatibility {
  const tempo = compareTempo(source, candidate, { tolerance: opts.stretchTolerance, maxOctaves: opts.maxOctaves });
  const key = compareKey(source, candidate, { maxSemitones: opts.maxSemitones });
  let score: number;
  let method: string;
  if (key.relationship === "unknown" && key.compatible) {
    score = tempo.score;
    method = `${TEMPO_METHOD}; no key on one side, so tempo alone`;
  } else if (tempo.quality === "unknown") {
    score = key.score;
    method = `${KEY_METHOD}; no tempo on one side, so key alone`;
  } else {
    score = TEMPO_WEIGHT * tempo.score + KEY_WEIGHT * key.score;
    method = METHOD;
  }
  const bound = boundConfidence(tempo, key, source, candidate);
  return {
    score: round6(Math.min(1, Math.max(0, score))),
    confidence: round6(bound.confidence),
    confidence_bound_by: bound.boundBy,
    confidence_reason: bound.reason,
    method,
    compatible: tempo.compatible && key.compatible,
    reason: describeMatch(tempo, key),
    tempo,
    key,
  };
}

function tempoWords(tempo: TempoMatch): string {
  if (tempo.quality === "unknown") return "no tempo detected";
  const parts: string[] = [];
  if (tempo.fold !== "none") parts.push(`needs ${tempo.fold}-time`);
  const percent = tempo.percent ?? 0;
  if (Math.abs(percent) < 0.05) {
    if (parts.length === 0) parts.push("same tempo");
  } else {
    const rounded = Math.round(Math.abs(percent) * 10) / 10;
    const shown = Math.abs(rounded - Math.round(rounded)) < 0.05 ? rounded.toFixed(0) : rounded.toFixed(1);
    parts.push(`${shown}% ${percent > 0 ? "faster" : "slower"}`);
  }
  return parts.join(" and ");
}

/**
 * The row's plain line: "relative minor, 2% faster", "same key, needs half-time",
 * "no key detected, tempo only". Nothing in it is generated: every clause names a
 * measured value or the move it implies.
 */
export function describeMatch(tempo: TempoMatch, key: KeyMatch): string {
  if (key.relationship === "unknown" && key.compatible) {
    let words = tempoWords(tempo);
    if (words === "same tempo") words = "tempo only";
    return `no key detected, ${words}`;
  }
  if (key.relationship === "unknown") {
    return `${key.candidate_tonic} ${key.candidate_mode} does not fit, ${tempoWords(tempo)}`;
  }
  let words = relationshipWords(key.relationship, key.candidate_mode);
  if (key.semitone_shift) {
    const direction = key.semitone_shift > 0 ? "up" : "down";
    const size = Math.abs(key.semitone_shift);
    words += ` ${direction} ${size} semitone${size === 1 ? "" : "s"}`;
  }
  return `${words}, ${tempoWords(tempo)}`;
}

/** describeMatch for a finished Compatibility; the same string as its `reason`. */
export function describe(c: Compatibility): string {
  return describeMatch(c.tempo, c.key);
}
