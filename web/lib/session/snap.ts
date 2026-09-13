// The grid the session is in, and what "snap" means on it.
//
// Musical time, not pixel time. A drag on the timeline never lands where the
// pointer happened to be: it lands on the division the producer chose, and the
// choice is theirs — bars, beats, eighths, sixteenths, or free. Everything
// here is arithmetic over seconds, so the same function decides where a mouse
// drop goes, where a keyboard nudge goes and where the sentence "move it to
// bar 17" goes. They cannot disagree, because there is only one of them.
//
// The maths is not reinvented: bars come from `time.ts` (bar 1 is second
// zero, which is the session's own frame) and the beat and sixteenth
// arithmetic comes from `lib/pads/grid.ts`, which the pads recorder already
// uses so that a recorded take and a dragged region agree about where the
// sixteenth is.

import { beatSeconds, stepSeconds } from "@/lib/pads/grid";
import { barAt, barToSeconds, secondsPerBar, type SessionTempo } from "./time";

export type SnapUnit = "bar" | "beat" | "eighth" | "sixteenth" | "off";

/** In the order the toolbar shows them: coarsest first, free last. */
export const SNAP_UNITS: readonly SnapUnit[] = ["bar", "beat", "eighth", "sixteenth", "off"];

/** The grid an edit happens on: the session's tempo, and the producer's choice of division. */
export interface Grid {
  tempo: SessionTempo | null;
  snap: SnapUnit;
}

export const FREE_GRID: Grid = { tempo: null, snap: "off" };

export function snapLabel(unit: SnapUnit): string {
  switch (unit) {
    case "bar":
      return "bars";
    case "beat":
      return "beats";
    case "eighth":
      return "1/8";
    case "sixteenth":
      return "1/16";
    case "off":
      return "free";
  }
}

/** A sentence's word for a division: "snap to sixteenths", "no snap". */
export function snapUnitFrom(word: string): SnapUnit | null {
  const w = word.trim().toLowerCase().replace(/s$/, "");
  if (w === "bar") return "bar";
  if (w === "beat" || w === "quarter") return "beat";
  if (w === "eighth" || w === "1/8" || w === "8th") return "eighth";
  if (w === "sixteenth" || w === "1/16" || w === "16th") return "sixteenth";
  if (w === "off" || w === "free" || w === "nothing" || w === "none") return "off";
  return null;
}

/**
 * How long one division is, in seconds, or null when there is nothing to snap
 * to. Null is the honest answer twice over: when the producer turned snapping
 * off, and when the session has no measured tempo and therefore has no bars —
 * `loopForBars` refuses to invent one and so does this.
 */
export function divisionSeconds(grid: Grid): number | null {
  if (grid.snap === "off") return null;
  const tempo = grid.tempo;
  if (!tempo || !(tempo.bpm > 0) || !(tempo.beatsPerBar > 0)) return null;
  switch (grid.snap) {
    case "bar":
      return secondsPerBar(tempo);
    case "beat":
      return beatSeconds(tempo.bpm);
    case "eighth":
      return beatSeconds(tempo.bpm) / 2;
    case "sixteenth":
      return stepSeconds(tempo.bpm);
  }
}

/** Is this grid actually going to move anything? */
export function snaps(grid: Grid): boolean {
  return divisionSeconds(grid) !== null;
}

/** The nearest division to a session second. Unsnapped grids return the second unchanged. */
export function snapTime(sessionS: number, grid: Grid): number {
  const division = divisionSeconds(grid);
  if (division === null || !(division > 0) || !Number.isFinite(sessionS)) return sessionS;
  return Math.round(sessionS / division) * division;
}

/** The division at or before a second (a region's start when it may not grow). */
export function snapFloor(sessionS: number, grid: Grid): number {
  const division = divisionSeconds(grid);
  if (division === null || !(division > 0) || !Number.isFinite(sessionS)) return sessionS;
  return Math.floor(sessionS / division + 1e-9) * division;
}

/** The division at or after a second. */
export function snapCeil(sessionS: number, grid: Grid): number {
  const division = divisionSeconds(grid);
  if (division === null || !(division > 0) || !Number.isFinite(sessionS)) return sessionS;
  return Math.ceil(sessionS / division - 1e-9) * division;
}

/**
 * One step of the grid, for a keyboard nudge. With snapping off a nudge still
 * has to be worth something, so it falls back to a sixteenth when the session
 * has a tempo and to a tenth of a second when it does not — a nudge that did
 * nothing would be worse than a nudge that is approximate, and the readout
 * says what it did.
 */
export function nudgeSeconds(grid: Grid): number {
  const division = divisionSeconds(grid);
  if (division !== null && division > 0) return division;
  const tempo = grid.tempo;
  if (tempo && tempo.bpm > 0) return stepSeconds(tempo.bpm);
  return 0.1;
}

// --- the ruler -----------------------------------------------------------------

export type TickKind = "bar" | "beat" | "sixteenth" | "second";

export interface Tick {
  atS: number;
  kind: TickKind;
  /** the label the ruler draws, or null for an unlabelled subdivision */
  label: string | null;
}

/** The most ticks worth walking for one screen; past this the ruler is a smear. */
const MAX_TICKS = 600;

/**
 * The ruler over `[fromS, toS)`, at whatever resolution actually fits.
 *
 * `minSpacingS` is the caller's zoom expressed in time: the seconds one
 * comfortable label width covers at the current pixels-per-second. Divisions
 * finer than that are not emitted at all, which is what keeps a four-minute
 * song zoomed out from producing ten thousand sixteenth lines nobody can see.
 *
 * Without a tempo the ruler is in seconds. That is deliberate: the timeline has
 * to be usable before anything with a measured tempo has been committed, and
 * inventing a tempo to draw bars with would be a lie the whole product is
 * built on not telling.
 */
export function rulerTicks(fromS: number, toS: number, tempo: SessionTempo | null, minSpacingS: number): Tick[] {
  if (!(toS > fromS)) return [];
  const from = Math.max(0, fromS);
  if (!tempo || !(tempo.bpm > 0) || !(tempo.beatsPerBar > 0)) return secondTicks(from, toS, minSpacingS);

  const barS = secondsPerBar(tempo);
  const beatS = beatSeconds(tempo.bpm);
  const sixteenthS = stepSeconds(tempo.bpm);
  if (!(barS > 0)) return secondTicks(from, toS, minSpacingS);

  // Bars get labelled; when even bars are too close, label every 2nd, 4th,
  // 8th... so the numbers stay readable all the way out to a whole song.
  let barStride = 1;
  while (barS * barStride < minSpacingS && barStride < 1024) barStride *= 2;

  const ticks: Tick[] = [];
  const firstBar = Math.max(1, (barAt(from, tempo) ?? 1));
  const startBar = firstBar - ((firstBar - 1) % barStride);
  for (let bar = startBar; ticks.length < MAX_TICKS; bar += barStride) {
    const atS = barToSeconds(bar, tempo);
    if (atS >= toS) break;
    if (atS >= from - 1e-9) ticks.push({ atS, kind: "bar", label: String(bar) });
  }

  // Beats and sixteenths only when they are far enough apart to be seen, and
  // only when bars are drawn one at a time (a beat line under a 4-bar stride
  // is noise).
  if (barStride === 1 && beatS >= minSpacingS) {
    pushSubdivisions(ticks, from, toS, beatS, barS, "beat");
    if (sixteenthS >= minSpacingS) pushSubdivisions(ticks, from, toS, sixteenthS, beatS, "sixteenth");
  }
  ticks.sort((a, b) => a.atS - b.atS);
  return ticks;
}

function pushSubdivisions(ticks: Tick[], fromS: number, toS: number, stepS: number, skipMultipleOf: number, kind: TickKind): void {
  if (!(stepS > 0)) return;
  const first = Math.ceil(fromS / stepS - 1e-9);
  const last = Math.floor((toS - 1e-9) / stepS);
  for (let i = first; i <= last && ticks.length < MAX_TICKS; i++) {
    const atS = i * stepS;
    // the coarser line is already there; do not draw two on the same second
    if (Math.abs(atS / skipMultipleOf - Math.round(atS / skipMultipleOf)) < 1e-6) continue;
    ticks.push({ atS, kind, label: null });
  }
}

/** 1, 2, 5, 10, 15, 30, 60 seconds: the steps a stopwatch uses. */
const SECOND_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

function secondTicks(fromS: number, toS: number, minSpacingS: number): Tick[] {
  const step = SECOND_STEPS.find((s) => s >= minSpacingS) ?? SECOND_STEPS[SECOND_STEPS.length - 1] ?? 60;
  const ticks: Tick[] = [];
  const first = Math.max(0, Math.ceil(fromS / step - 1e-9));
  const last = Math.floor((toS - 1e-9) / step);
  for (let i = first; i <= last && ticks.length < MAX_TICKS; i++) {
    const atS = i * step;
    ticks.push({ atS, kind: "second", label: fmtSeconds(atS) });
  }
  return ticks;
}

function fmtSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  if (s < 10 && !Number.isInteger(s)) return `${rest.toFixed(1)}s`;
  return `${m}:${String(Math.round(rest)).padStart(2, "0")}`;
}

/** "bar 17", or the clock when the session has no bars yet. Used in every echo. */
export function positionLabel(sessionS: number, tempo: SessionTempo | null): string {
  const bar = barAt(sessionS, tempo);
  if (bar === null || !tempo) return `${sessionS.toFixed(2)}s`;
  const barS = secondsPerBar(tempo);
  const into = sessionS - barToSeconds(bar, tempo);
  // The epsilon is in beats: sixteen bars of 90 BPM accumulated in floating
  // point lands a hair under the beat it is exactly on, and "bar 17" reading
  // as "bar 16.4" would be a lie about where the playhead is.
  const beat = Math.floor((into / barS) * tempo.beatsPerBar + 1e-6) + 1;
  return beat === 1 ? `bar ${bar}` : `bar ${bar}.${beat}`;
}
