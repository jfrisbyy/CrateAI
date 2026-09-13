import { describe, expect, it } from "vitest";
import { DRUM_CHANNEL, PPQ, padHitsToNotes, padHitsToNotesJson, padPitch, readMidi, writeMidi, writePadsMidi } from "./writer";
import type { PadHitInput } from "@/lib/api/midi";

const hits: PadHitInput[] = [
  { time_s: 0, pad: 0, chop_file_id: "a", velocity: 1 },
  { time_s: 0.6789, pad: 3, chop_file_id: "b", velocity: 1 },
  { time_s: 1.3333, pad: 15, chop_file_id: null, velocity: 0.5 },
  { time_s: 2.0125, pad: 7, chop_file_id: "c", velocity: 1 },
];

describe("writeMidi", () => {
  it("round-trips note times through @tonejs/midi within one tick and keeps the tempo meta", () => {
    const bpm = 90;
    const bytes = writePadsMidi(hits, { bpm });
    expect(bytes[0]).toBe(0x4d); // "M" of MThd
    const midi = readMidi(bytes);
    expect(midi.header.ppq).toBe(PPQ);
    expect(midi.header.tempos).toHaveLength(1);
    expect(midi.header.tempos[0]?.bpm).toBeCloseTo(bpm, 3);
    expect(midi.header.timeSignatures[0]?.timeSignature).toEqual([4, 4]);
    expect(midi.tracks).toHaveLength(1);
    const track = midi.tracks[0]!;
    expect(track.channel).toBe(DRUM_CHANNEL);
    expect(track.notes).toHaveLength(hits.length);
    const tick = 60 / bpm / PPQ;
    const sorted = [...hits].sort((a, b) => a.time_s - b.time_s);
    track.notes.forEach((note, i) => {
      const hit = sorted[i]!;
      expect(note.midi).toBe(padPitch(hit.pad));
      expect(Math.abs(note.time - hit.time_s)).toBeLessThanOrEqual(tick / 2 + 1e-9);
      expect(note.velocity).toBeCloseTo(hit.velocity, 2);
    });
  });

  it("is exact for times on tick boundaries", () => {
    const bpm = 120;
    const tick = 60 / bpm / PPQ;
    const times = [0, 100 * tick, 12345 * tick];
    const bytes = writeMidi(
      times.map((t) => ({ pitch: 60, time_s: t, duration_s: 0.1, velocity: 0.8 })),
      { bpm },
    );
    const notes = readMidi(bytes).tracks[0]!.notes;
    notes.forEach((n, i) => expect(n.time).toBeCloseTo(times[i]!, 9));
    expect(notes[0]?.duration).toBeCloseTo(0.1, 3);
  });

  it("puts the pad on GM-style pitches from 36 and clamps early hits to time zero", () => {
    expect(padPitch(0)).toBe(36);
    expect(padPitch(15)).toBe(51);
    const notes = padHitsToNotes([{ time_s: -0.02, pad: 2, chop_file_id: null, velocity: 1 }]);
    expect(notes[0]?.time_s).toBe(0);
    expect(notes[0]?.pitch).toBe(38);
  });

  it("carries bar, step and offset in the notes JSON", () => {
    const json = padHitsToNotesJson(hits, 120);
    // at 120 BPM a 16th is 0.125 s; 0.6789 s is step 5 (0.625) + 53.9 ms
    const second = json[1]!;
    expect(second.bar).toBe(0);
    expect(second.step).toBe(5);
    expect(second.offset_ms).toBeCloseTo(53.9, 6);
    expect(second.velocity).toBe(127);
    expect(json[2]?.velocity).toBe(64);
    // 2.0125 s -> global step 16 -> bar 1, step 0, +12.5 ms
    const last = json[3]!;
    expect(last.bar).toBe(1);
    expect(last.step).toBe(0);
    expect(last.offset_ms).toBeCloseTo(12.5, 6);
    expect(last.chop_file_id).toBe("c");
  });

  it("refuses a bad tempo", () => {
    expect(() => writeMidi([], { bpm: 0 })).toThrow();
  });
});
