// The effective 16th grid for the pads recorder: where a wall-clock hit lands
// (bar, step) and how far from the step it was. Positive offsets are late,
// matching `offset_ms` in the drum patterns and chops/midi.py.

export const STEPS_PER_BEAT = 4;

export interface HitPlacement {
  /** 0-based bar */
  bar: number;
  /** 0-based step within the bar, 0..(beatsPerBar * 4 - 1) */
  step: number;
  /** 0-based step from the record start */
  global_step: number;
  /** measured minus grid, in ms; positive is late */
  offset_ms: number;
}

function requireBpm(bpm: number): void {
  if (!Number.isFinite(bpm) || bpm <= 0) throw new Error("bpm must be a positive number");
}

export function beatSeconds(bpm: number): number {
  requireBpm(bpm);
  return 60 / bpm;
}

export function stepSeconds(bpm: number): number {
  return beatSeconds(bpm) / STEPS_PER_BEAT;
}

export function barSeconds(bpm: number, beatsPerBar = 4): number {
  return beatSeconds(bpm) * beatsPerBar;
}

export function stepsPerBar(beatsPerBar = 4): number {
  return beatsPerBar * STEPS_PER_BEAT;
}

/** Place a hit at `timeS` (seconds from the record start) on the nearest 16th. */
export function placeHit(timeS: number, bpm: number, beatsPerBar = 4): HitPlacement {
  const step = stepSeconds(bpm);
  const perBar = stepsPerBar(beatsPerBar);
  const globalStep = Math.max(0, Math.round(timeS / step));
  const offsetMs = (timeS - globalStep * step) * 1000;
  return {
    bar: Math.floor(globalStep / perBar),
    step: globalStep % perBar,
    global_step: globalStep,
    offset_ms: Math.round(offsetMs * 1000) / 1000,
  };
}

/** Whole bars needed to hold `lengthS` seconds (at least one). */
export function barsCovering(lengthS: number, bpm: number, beatsPerBar = 4): number {
  const bar = barSeconds(bpm, beatsPerBar);
  return Math.max(1, Math.ceil((Math.max(0, lengthS) - 1e-6) / bar));
}

/** The count-in is one bar of beats. */
export function countInSeconds(bpm: number, beatsPerBar = 4): number {
  return barSeconds(bpm, beatsPerBar);
}

/** The beat times (seconds from `startS`) of `bars` bars, for the click. */
export function beatTimes(startS: number, bpm: number, bars: number, beatsPerBar = 4): number[] {
  const beat = beatSeconds(bpm);
  const out: number[] = [];
  for (let i = 0; i < bars * beatsPerBar; i++) out.push(startS + i * beat);
  return out;
}
