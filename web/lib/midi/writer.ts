// A small MIDI writer on @tonejs/midi for the pads recorder (and any other
// note list the web produces). One note per event at its measured time; the
// tempo meta carries the file's effective BPM so a DAW imports it at the right
// speed. PPQ is raised to 960 because @tonejs/midi rounds times to whole
// ticks: at 90 BPM that is 0.69 ms per tick instead of 1.39 ms.

import { Midi } from "@tonejs/midi";
import type { PadHitInput } from "@/lib/api/midi";
import { placeHit } from "@/lib/pads/grid";

/** GM-style pads: pad 0 is C1 (36), the kick slot on most drum maps. */
export const PAD_BASE_PITCH = 36;
export const PPQ = 960;
export const DEFAULT_NOTE_LENGTH_S = 0.1;
export const DRUM_CHANNEL = 9;

export interface MidiNoteInput {
  pitch: number;
  time_s: number;
  duration_s: number;
  /** 0..1 */
  velocity: number;
}

export interface WriteMidiOptions {
  bpm: number;
  beatsPerBar?: number;
  /** track name (also the file name inside the header) */
  name?: string;
  /** put the notes on channel 10 so a DAW picks a drum instrument */
  drums?: boolean;
}

export function padPitch(pad: number): number {
  return PAD_BASE_PITCH + pad;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Encode `notes` as a one-track Standard MIDI File (format 1) with a tempo and time-signature meta. */
export function writeMidi(notes: MidiNoteInput[], opts: WriteMidiOptions): Uint8Array {
  if (!Number.isFinite(opts.bpm) || opts.bpm <= 0) throw new Error("bpm must be a positive number");
  const beatsPerBar = opts.beatsPerBar ?? 4;
  const midi = new Midi();
  // ppq has no setter; fromJSON is the supported way to change it.
  midi.header.fromJSON({ ...midi.header.toJSON(), ppq: PPQ });
  midi.header.setTempo(opts.bpm);
  midi.header.timeSignatures = [{ ticks: 0, timeSignature: [beatsPerBar, 4] }];
  midi.header.update();
  if (opts.name) midi.header.name = opts.name;

  const track = midi.addTrack();
  track.name = opts.name ?? "notes";
  if (opts.drums) track.channel = DRUM_CHANNEL;
  const sorted = [...notes].sort((a, b) => a.time_s - b.time_s);
  for (const n of sorted) {
    track.addNote({
      midi: clamp(Math.round(n.pitch), 0, 127),
      time: Math.max(0, n.time_s),
      duration: Math.max(1e-3, n.duration_s),
      velocity: clamp(n.velocity, 1 / 127, 1),
    });
  }
  return midi.toArray();
}

/** Parse bytes back (tests, and anything that wants to read what was written). */
export function readMidi(bytes: Uint8Array): Midi {
  return new Midi(bytes);
}

/**
 * A pads recording as notes: pitch 36 + pad, at the measured time. A hit
 * played a hair before the first step (an early "one") has a negative
 * `time_s`; MIDI cannot start before zero, so that note lands at 0 and the
 * measured offset survives in the notes JSON (`offset_ms`).
 */
export function padHitsToNotes(hits: PadHitInput[], noteLengthS = DEFAULT_NOTE_LENGTH_S): MidiNoteInput[] {
  return hits.map((h) => ({
    pitch: padPitch(h.pad),
    time_s: Math.max(0, h.time_s),
    duration_s: noteLengthS,
    velocity: h.velocity,
  }));
}

/** The `midi.notes` row shape compute writes (chops/midi.py NoteEvent.to_json), plus the pad and its chop. */
export interface PadNoteJson {
  pitch: number;
  start_s: number;
  end_s: number;
  /** 1..127 */
  velocity: number;
  pad: number;
  chop_file_id: string | null;
  bar: number;
  step: number;
  offset_ms: number;
}

export function padHitsToNotesJson(hits: PadHitInput[], bpm: number, beatsPerBar = 4, noteLengthS = DEFAULT_NOTE_LENGTH_S): PadNoteJson[] {
  return [...hits]
    .sort((a, b) => a.time_s - b.time_s)
    .map((h) => {
      const placed = placeHit(h.time_s, bpm, beatsPerBar);
      const start = Math.max(0, h.time_s);
      return {
        pitch: padPitch(h.pad),
        start_s: start,
        end_s: start + noteLengthS,
        velocity: clamp(Math.round(h.velocity * 127), 1, 127),
        pad: h.pad,
        chop_file_id: h.chop_file_id,
        bar: placed.bar,
        step: placed.step,
        offset_ms: placed.offset_ms,
      };
    });
}

/** Build the .mid bytes for a pads recording. */
export function writePadsMidi(hits: PadHitInput[], opts: { bpm: number; beatsPerBar?: number; name?: string }): Uint8Array {
  return writeMidi(padHitsToNotes(hits), { bpm: opts.bpm, beatsPerBar: opts.beatsPerBar, name: opts.name ?? "pads", drums: true });
}
