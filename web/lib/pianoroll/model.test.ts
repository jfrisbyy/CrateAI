import { describe, expect, it } from "vitest";
import {
  addNote,
  deleteNotes,
  fromNotesJson,
  isBlackKey,
  MIN_NOTE_S,
  moveNote,
  noteName,
  pitchBounds,
  resizeNote,
  setVelocity,
  toNotesJson,
  totalBeats,
  type EditOptions,
  type RollNote,
} from "./model";

const snapped: EditOptions = { bpm: 120, snap: true }; // 16th = 0.125 s
const free: EditOptions = { bpm: 120, snap: false };

function notes(): RollNote[] {
  return [
    { id: "a", pitch: 60, start_s: 0.5, end_s: 1.0, velocity: 100 },
    { id: "b", pitch: 64, start_s: 1.0, end_s: 1.25, velocity: 90 },
  ];
}

describe("fromNotesJson / toNotesJson", () => {
  it("reads the compute's notes JSON, keeps only what the renderer reads back, and sorts", () => {
    const raw = [
      { pitch: 64, start_s: 1.0, end_s: 1.5, velocity: 90, cls: "kick", bar: 0, step: 8, offset_ms: 3.2 },
      { pitch: 60, start_s: 0.25, end_s: 0.75 },
      { nonsense: true },
      null,
    ];
    const rolled = fromNotesJson(raw);
    expect(rolled).toHaveLength(2);
    expect(rolled[0]?.pitch).toBe(60);
    expect(rolled[0]?.velocity).toBe(100);
    expect(new Set(rolled.map((n) => n.id)).size).toBe(2);
    expect(toNotesJson(rolled)).toEqual([
      { pitch: 60, start_s: 0.25, end_s: 0.75, velocity: 100 },
      { pitch: 64, start_s: 1.0, end_s: 1.5, velocity: 90 },
    ]);
  });
  it("clamps pitch and velocity and enforces a minimum length", () => {
    const rolled = fromNotesJson([{ pitch: 140, start_s: 1, end_s: 1, velocity: 300 }, { pitch: -3, start_s: -1, end_s: 0.5, velocity: 0 }]);
    expect(rolled.map((n) => n.pitch)).toEqual([0, 127]);
    expect(rolled.map((n) => n.velocity)).toEqual([1, 127]);
    expect(rolled[1]!.end_s - rolled[1]!.start_s).toBeCloseTo(MIN_NOTE_S, 9);
    expect(rolled[0]!.start_s).toBe(0);
  });
  it("returns nothing for a shape that is not a list", () => {
    expect(fromNotesJson({ notes: [] })).toEqual([]);
    expect(fromNotesJson(undefined)).toEqual([]);
  });
});

describe("moveNote", () => {
  it("moves in time on the 16th grid and keeps the length", () => {
    const out = moveNote(notes(), "a", 0.2, 0, snapped);
    const a = out.find((n) => n.id === "a")!;
    expect(a.start_s).toBeCloseTo(0.75, 9);
    expect(a.end_s - a.start_s).toBeCloseTo(0.5, 9);
    expect(out.find((n) => n.id === "b")).toEqual(notes()[1]);
  });
  it("moves freely when snapping is off", () => {
    const a = moveNote(notes(), "a", 0.2, 0, free).find((n) => n.id === "a")!;
    expect(a.start_s).toBeCloseTo(0.7, 9);
  });
  it("changes pitch by whole semitones inside 0..127 and never starts before zero", () => {
    const a = moveNote(notes(), "a", -5, 70, snapped).find((n) => n.id === "a")!;
    expect(a.start_s).toBe(0);
    expect(a.pitch).toBe(127);
    const b = moveNote(notes(), "b", 0, -100, free).find((n) => n.id === "b")!;
    expect(b.pitch).toBe(0);
  });
  it("ignores an unknown id", () => {
    const before = notes();
    expect(moveNote(before, "zzz", 1, 1, snapped)).toBe(before);
  });
});

describe("resizeNote", () => {
  it("snaps the end and never goes under one 16th when snapping", () => {
    const a = resizeNote(notes(), "a", 1.31, snapped).find((n) => n.id === "a")!;
    expect(a.end_s).toBeCloseTo(1.25, 9);
    const tiny = resizeNote(notes(), "a", 0.5, snapped).find((n) => n.id === "a")!;
    expect(tiny.end_s).toBeCloseTo(0.625, 9);
  });
  it("uses the minimum note length in free mode", () => {
    const a = resizeNote(notes(), "a", 0.4, free).find((n) => n.id === "a")!;
    expect(a.end_s).toBeCloseTo(0.5 + MIN_NOTE_S, 9);
    const b = resizeNote(notes(), "b", 1.777, free).find((n) => n.id === "b")!;
    expect(b.end_s).toBeCloseTo(1.777, 9);
  });
});

describe("addNote / deleteNotes / setVelocity", () => {
  it("adds a one-16th note floored to the grid with a fresh id", () => {
    const { notes: out, id } = addNote(notes(), { pitch: 67, start_s: 0.7 }, snapped);
    const added = out.find((n) => n.id === id)!;
    expect(added.start_s).toBeCloseTo(0.625, 9);
    expect(added.end_s - added.start_s).toBeCloseTo(0.125, 9);
    expect(added.velocity).toBe(100);
    expect(out).toHaveLength(3);
    expect(out.map((n) => n.start_s)).toEqual([...out.map((n) => n.start_s)].sort((x, y) => x - y));
  });
  it("adds where the pointer is in free mode, with the given length and velocity", () => {
    const { notes: out, id } = addNote(notes(), { pitch: 67, start_s: 0.7, length_s: 0.3, velocity: 40 }, free);
    const added = out.find((n) => n.id === id)!;
    expect(added.start_s).toBeCloseTo(0.7, 9);
    expect(added.end_s).toBeCloseTo(1.0, 9);
    expect(added.velocity).toBe(40);
  });
  it("deletes by id and clamps velocity", () => {
    expect(deleteNotes(notes(), ["a"]).map((n) => n.id)).toEqual(["b"]);
    expect(deleteNotes(notes(), []).length).toBe(2);
    expect(setVelocity(notes(), "a", 500).find((n) => n.id === "a")!.velocity).toBe(127);
    expect(setVelocity(notes(), "a", 0).find((n) => n.id === "a")!.velocity).toBe(1);
    expect(setVelocity(notes(), "a", 64.4).find((n) => n.id === "a")!.velocity).toBe(64);
  });
});

describe("layout helpers", () => {
  it("pads the pitch range to a readable span", () => {
    expect(pitchBounds([])).toEqual({ low: 48, high: 72 });
    const b = pitchBounds(notes());
    expect(b.high - b.low).toBeGreaterThanOrEqual(24);
    expect(b.low).toBeLessThanOrEqual(58);
    expect(b.high).toBeGreaterThanOrEqual(66);
    const top = pitchBounds([{ id: "x", pitch: 127, start_s: 0, end_s: 1, velocity: 1 }]);
    expect(top.high).toBe(127);
    expect(top.high - top.low).toBe(24);
  });
  it("draws whole bars past the last note, at least four", () => {
    expect(totalBeats([], 120)).toBe(16);
    expect(totalBeats(notes(), 120)).toBe(16);
    expect(totalBeats([{ id: "x", pitch: 60, start_s: 9, end_s: 10.1, velocity: 1 }], 120)).toBe(28); // 5.05 bars -> 6 + 1 pad
  });
  it("names pitches", () => {
    expect(noteName(60)).toBe("C4");
    expect(noteName(61)).toBe("C#4");
    expect(noteName(21)).toBe("A0");
    expect(isBlackKey(61)).toBe(true);
    expect(isBlackKey(60)).toBe(false);
  });
});
