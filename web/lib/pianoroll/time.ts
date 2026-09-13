// Time on a tempo grid: snapping to bars, beats and 16ths at a BPM, and the
// bars.beats.16ths readout. Shared by the Layers lanes (offset drag) and the
// piano roll (note edits). Pure arithmetic: 60 / bpm seconds per beat,
// `beatsPerBar` beats per bar (4 unless the caller says otherwise).

export type GridSnap = "bar" | "beat" | "16th" | "free";

export const GRID_SNAPS: ReadonlyArray<{ id: GridSnap; label: string }> = [
  { id: "bar", label: "Bar" },
  { id: "beat", label: "Beat" },
  { id: "16th", label: "16th" },
  { id: "free", label: "Free" },
];

const EPS_S = 0.001;

export function beatSeconds(bpm: number): number {
  return 60 / bpm;
}

/** Seconds per snap step, or null for free (or a tempo that is not usable). */
export function stepSeconds(bpm: number, snap: GridSnap, beatsPerBar = 4): number | null {
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  const beat = 60 / bpm;
  switch (snap) {
    case "bar":
      return beat * beatsPerBar;
    case "beat":
      return beat;
    case "16th":
      return beat / 4;
    default:
      return null;
  }
}

/** Nearest grid point in the snap mode; free (or no usable tempo) returns `t` unchanged. */
export function snapSeconds(t: number, bpm: number, snap: GridSnap, beatsPerBar = 4): number {
  const step = stepSeconds(bpm, snap, beatsPerBar);
  if (step === null) return t;
  return Math.round(t / step) * step;
}

/** The grid point at or before `t` (used when adding a note where the pointer landed). */
export function floorSeconds(t: number, bpm: number, snap: GridSnap, beatsPerBar = 4): number {
  const step = stepSeconds(bpm, snap, beatsPerBar);
  if (step === null) return t;
  return Math.floor(t / step + 1e-9) * step;
}

export interface BarsBeats {
  negative: boolean;
  bars: number;
  beats: number;
  sixteenths: number;
  /** what is left after the whole 16ths, in seconds (0 when the time sits on the grid) */
  remainderS: number;
}

/** Split a duration into whole bars, beats and 16ths at `bpm` (zero-based counts, sign kept). */
export function toBarsBeats(t: number, bpm: number, beatsPerBar = 4): BarsBeats {
  const negative = t < 0;
  const a = Math.abs(t);
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(a)) {
    return { negative, bars: 0, beats: 0, sixteenths: 0, remainderS: a };
  }
  const sixteenth = 60 / bpm / 4;
  const nearest = Math.round(a / sixteenth);
  let total = Math.abs(a - nearest * sixteenth) < EPS_S ? nearest : Math.floor(a / sixteenth);
  const remainderS = Math.max(0, a - total * sixteenth);
  const perBar = beatsPerBar * 4;
  const bars = Math.floor(total / perBar);
  total -= bars * perBar;
  const beats = Math.floor(total / 4);
  const sixteenths = total - beats * 4;
  return { negative, bars, beats, sixteenths, remainderS: remainderS < EPS_S ? 0 : remainderS };
}

/** "1.2.3" for one bar, two beats and three 16ths; "-0.1.0" a beat early; a trailing "+" marks a free remainder. */
export function formatBarsBeats(t: number, bpm: number, beatsPerBar = 4): string {
  const b = toBarsBeats(t, bpm, beatsPerBar);
  const sign = b.negative && (b.bars || b.beats || b.sixteenths || b.remainderS) ? "-" : "";
  return `${sign}${b.bars}.${b.beats}.${b.sixteenths}${b.remainderS > 0 ? "+" : ""}`;
}

/** "+0.750 s" / "-0.512 s", fixed width for a readout that changes while dragging. */
export function formatSignedSeconds(t: number, digits = 3): string {
  if (!Number.isFinite(t)) return "—";
  const sign = t < 0 ? "-" : "+";
  return `${sign}${Math.abs(t).toFixed(digits)} s`;
}

/** Beat position (1-based bar and beat) for a ruler at `bpm`: 0 s -> "1.1". */
export function formatRulerBeat(beatIndex: number, beatsPerBar = 4): string {
  const bar = Math.floor(beatIndex / beatsPerBar) + 1;
  const beat = (beatIndex % beatsPerBar) + 1;
  return beat === 1 ? String(bar) : `${bar}.${beat}`;
}
