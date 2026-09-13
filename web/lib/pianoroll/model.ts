// The piano roll's editing model. Notes are the `midi.notes` JSON the
// compute writes (analysis/lockedgroove/chops/midi.py NoteEvent: pitch,
// start_s, end_s, velocity, plus optional cls/bar/step/offset_ms), given a
// client id so edits can address them. Every operation returns a new array;
// nothing here touches the DOM. `toNotesJson` is exactly what the revoice
// job reads back as params.notes (midi_result_from_notes in symbolic.py).

import { floorSeconds, snapSeconds, stepSeconds } from "./time";

export interface RollNote {
  id: string;
  pitch: number;
  start_s: number;
  end_s: number;
  velocity: number;
}

export interface NoteJson {
  pitch: number;
  start_s: number;
  end_s: number;
  velocity: number;
}

export interface EditOptions {
  bpm: number;
  /** snap starts and ends to 16ths at `bpm`; false is the free mode */
  snap: boolean;
}

export const MIN_NOTE_S = 0.03;
export const DEFAULT_VELOCITY = 100;
export const DEFAULT_LOW = 48;
export const DEFAULT_HIGH = 72;

let counter = 0;

export function newNoteId(): string {
  counter += 1;
  return `n${counter}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Rows from the midi row's notes JSON; anything that is not a note is skipped. Sorted by start. */
export function fromNotesJson(raw: unknown): RollNote[] {
  if (!Array.isArray(raw)) return [];
  const out: RollNote[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const pitch = num(rec.pitch);
    const start = num(rec.start_s);
    const end = num(rec.end_s);
    if (pitch === null || start === null || end === null) continue;
    const velocity = num(rec.velocity) ?? DEFAULT_VELOCITY;
    out.push({
      id: newNoteId(),
      pitch: clamp(Math.round(pitch), 0, 127),
      start_s: Math.max(0, start),
      end_s: Math.max(Math.max(0, start) + MIN_NOTE_S, end),
      velocity: clamp(Math.round(velocity), 1, 127),
    });
  }
  return sortNotes(out);
}

/** What the compute renders: pitch, start_s, end_s, velocity, sorted, without client ids. */
export function toNotesJson(notes: RollNote[]): NoteJson[] {
  return sortNotes(notes).map((n) => ({
    pitch: n.pitch,
    start_s: round6(n.start_s),
    end_s: round6(n.end_s),
    velocity: n.velocity,
  }));
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

export function sortNotes(notes: RollNote[]): RollNote[] {
  return [...notes].sort((a, b) => a.start_s - b.start_s || a.pitch - b.pitch || a.end_s - b.end_s);
}

function sixteenth(opts: EditOptions): number {
  return stepSeconds(opts.bpm, "16th") ?? 0.125;
}

/** Move a note in time by `deltaS` (snapped when the mode says so) and in pitch by `deltaPitch`. Length is kept. */
export function moveNote(notes: RollNote[], id: string, deltaS: number, deltaPitch: number, opts: EditOptions): RollNote[] {
  const n = notes.find((x) => x.id === id);
  if (!n) return notes;
  const len = n.end_s - n.start_s;
  let start = n.start_s + deltaS;
  if (opts.snap) start = snapSeconds(start, opts.bpm, "16th");
  start = Math.max(0, start);
  const pitch = clamp(Math.round(n.pitch + deltaPitch), 0, 127);
  return notes.map((x) => (x.id === id ? { ...x, start_s: start, end_s: start + len, pitch } : x));
}

/** Move the right edge to `endS`; never shorter than one 16th when snapping, MIN_NOTE_S when free. */
export function resizeNote(notes: RollNote[], id: string, endS: number, opts: EditOptions): RollNote[] {
  const n = notes.find((x) => x.id === id);
  if (!n) return notes;
  let end = opts.snap ? snapSeconds(endS, opts.bpm, "16th") : endS;
  const minLen = opts.snap ? sixteenth(opts) : MIN_NOTE_S;
  if (end < n.start_s + minLen) end = n.start_s + minLen;
  return notes.map((x) => (x.id === id ? { ...x, end_s: end } : x));
}

export interface NewNote {
  pitch: number;
  start_s: number;
  length_s?: number;
  velocity?: number;
}

/** Add a note where the pointer landed: the start floors to the 16th when snapping; the default length is one 16th. */
export function addNote(notes: RollNote[], at: NewNote, opts: EditOptions): { notes: RollNote[]; id: string } {
  const step = sixteenth(opts);
  const start = Math.max(0, opts.snap ? floorSeconds(at.start_s, opts.bpm, "16th") : at.start_s);
  const length = Math.max(MIN_NOTE_S, at.length_s ?? step);
  const id = newNoteId();
  const note: RollNote = {
    id,
    pitch: clamp(Math.round(at.pitch), 0, 127),
    start_s: start,
    end_s: start + length,
    velocity: clamp(Math.round(at.velocity ?? DEFAULT_VELOCITY), 1, 127),
  };
  return { notes: sortNotes([...notes, note]), id };
}

export function deleteNotes(notes: RollNote[], ids: Iterable<string>): RollNote[] {
  const set = new Set(ids);
  return notes.filter((n) => !set.has(n.id));
}

export function setVelocity(notes: RollNote[], id: string, velocity: number): RollNote[] {
  const v = clamp(Math.round(velocity), 1, 127);
  return notes.map((n) => (n.id === id ? { ...n, velocity: v } : n));
}

/** The pitch rows to draw: the notes' range padded, at least `minSpan` semitones, inside 0..127. */
export function pitchBounds(notes: RollNote[], pad = 2, minSpan = 24): { low: number; high: number } {
  if (notes.length === 0) return { low: DEFAULT_LOW, high: DEFAULT_HIGH };
  let low = clamp(Math.min(...notes.map((n) => n.pitch)) - pad, 0, 127);
  let high = clamp(Math.max(...notes.map((n) => n.pitch)) + pad, 0, 127);
  while (high - low < minSpan && (low > 0 || high < 127)) {
    if (low > 0) low -= 1;
    if (high - low < minSpan && high < 127) high += 1;
  }
  return { low, high };
}

/** Beats to draw: the last note end padded to whole bars, at least `minBars` bars. */
export function totalBeats(notes: RollNote[], bpm: number, beatsPerBar = 4, minBars = 4, padBars = 1): number {
  const beat = 60 / bpm;
  const endS = notes.length ? Math.max(...notes.map((n) => n.end_s)) : 0;
  const bars = Math.max(minBars, Math.ceil(endS / beat / beatsPerBar) + padBars);
  return bars * beatsPerBar;
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** MIDI 60 -> "C4". */
export function noteName(pitch: number): string {
  const p = clamp(Math.round(pitch), 0, 127);
  return `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;
}

export function isBlackKey(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12);
}
