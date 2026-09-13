// Where the playhead is, and how the clock's time maps onto the timeline when
// the transport is looping.
//
// The playhead is never stored and never stepped: it is a function of the
// anchor and the clock. Two consequences that matter. Playback and the drawn
// playhead cannot drift apart, because both read this. And the loop wrap is
// exact — the wrap point is computed in seconds from the anchor, not
// accumulated a tick at a time, so a loop that runs for an hour lands on the
// same sample as the first pass.
//
// The loop rule, stated once: a playhead before the end locator runs to the
// end locator and wraps to the start locator, for ever. A playhead already
// past the end locator (a seek beyond the loop) runs straight through and
// never wraps — the loop is behind it. Seek back inside and it loops again.

import { EPS, MIN_LOOP_S, type TransportLoop, type TransportState } from "./types";

/** A usable loop, or null: locators that are missing, inverted or hair-thin are no loop. */
export function activeLoop(transport: TransportState): TransportLoop | null {
  const loop = transport.loop;
  if (!loop) return null;
  if (!Number.isFinite(loop.startS) || !Number.isFinite(loop.endS)) return null;
  if (loop.endS - loop.startS < MIN_LOOP_S) return null;
  return loop;
}

/** Does the transport wrap at all? False once the playhead is past the end locator. */
export function loopApplies(transport: TransportState): boolean {
  const loop = activeLoop(transport);
  return loop !== null && transport.anchorS < loop.endS - EPS;
}

/** Session seconds elapsed since the anchor; zero before it (the start lead-in). */
export function elapsedAt(transport: TransportState, wall: number): number {
  return Math.max(0, wall - transport.anchorWall);
}

/**
 * How far into a pass a time `over` seconds past the end locator is.
 *
 * `over % length` is the answer except at a wrap, where the arithmetic that
 * produced `over` — a sum of loop lengths — can land a float hair *short* of a
 * whole number of passes. The remainder then comes back as very nearly a whole
 * loop, which reads as the last nanosecond of the old pass instead of the first
 * of the new one. That is the difference between the segment walk in
 * `segmentsInWindow` advancing a whole loop and advancing 7e-15 of a second,
 * and it is why a wrap could be missed entirely (see `wrapsExactly` in the
 * tests). A remainder within EPS of the length is a wrap that has happened.
 */
function restOfPass(over: number, length: number): number {
  const rest = over % length;
  return length - rest < EPS ? 0 : rest;
}

/** Session position at a clock time. Paused transports sit on their anchor. */
export function positionAt(transport: TransportState, wall: number): number {
  if (!transport.playing) return transport.anchorS;
  const linear = transport.anchorS + elapsedAt(transport, wall);
  const loop = activeLoop(transport);
  if (!loop || !loopApplies(transport)) return linear;
  if (linear < loop.endS - EPS) return linear;
  const length = loop.endS - loop.startS;
  // `linear` can land a float hair *below* the end locator and still be past
  // it by the comparison above — the wrap times are themselves sums of these
  // numbers. Clamping the overshoot to zero makes that case land exactly on
  // the start locator instead of a hair below the end one, which would leave
  // the walk in `segmentsInWindow` making 1e-14 of progress at a time.
  const over = Math.max(0, linear - loop.endS);
  return loop.startS + restOfPass(over, length);
}

/** How many times the loop has wrapped at a clock time. 0 on the first pass. */
export function passAt(transport: TransportState, wall: number): number {
  if (!transport.playing) return 0;
  const loop = activeLoop(transport);
  if (!loop || !loopApplies(transport)) return 0;
  const linear = transport.anchorS + elapsedAt(transport, wall);
  if (linear < loop.endS - EPS) return 0;
  const length = loop.endS - loop.startS;
  const over = Math.max(0, linear - loop.endS);
  // Counted off the remainder rather than off `over / length`, and for the
  // same reason `positionAt` snaps: `%` is an exact remainder while a division
  // can round *up* to a whole number the remainder says was not reached. Mixing
  // the two numbers a wrap boundary as the pass after the one `positionAt`
  // puts it in, and the piece scheduled for that pass is then never planned.
  const rest = over % length;
  const whole = Math.round((over - rest) / length);
  return whole + 1 + (length - rest < EPS ? 1 : 0);
}

/**
 * A run of the timeline the clock crosses without wrapping: session time
 * advances one second per second from `startS` to `endS` while the clock goes
 * from `startWall` to `endWall`. A window with no loop in it is one segment; a
 * window containing two wraps is three.
 */
export interface Segment {
  pass: number;
  startWall: number;
  endWall: number;
  startS: number;
  endS: number;
  /**
   * The session second this pass actually ends at — the end locator, or
   * Infinity with no loop. `endS` is only where the *window* stopped looking.
   * The difference matters: a piece may start inside the window and must be
   * scheduled to its natural end, not chopped at the edge of a 250 ms
   * lookahead and silently dropped for the rest of the pass.
   */
  limitS: number;
}

/** Guard against a window so long, or a loop so short, that the walk never ends. */
const MAX_SEGMENTS = 4096;

/**
 * The segments covering `[fromWall, toWall)`. Empty when the transport is not
 * playing or the window is empty. Segments are contiguous, in order, and their
 * clock spans exactly tile the window.
 */
export function segmentsInWindow(transport: TransportState, fromWall: number, toWall: number): Segment[] {
  if (!transport.playing || toWall <= fromWall) return [];
  const loop = activeLoop(transport);
  const segments: Segment[] = [];
  // Never plan before the anchor. `play()` sets the anchor a few milliseconds
  // ahead so the first pieces are scheduled rather than chased, and the
  // playhead reads as parked on the anchor until then; planning through that
  // lead-in would start the first region early and put every later repeat a
  // lead-in out of step with it.
  let cursor = Math.max(fromWall, transport.anchorWall);
  if (cursor >= toWall - EPS) return [];
  let guard = 0;
  while (cursor < toWall - EPS && guard++ < MAX_SEGMENTS) {
    const startS = positionAt(transport, cursor);
    const pass = passAt(transport, cursor);
    // When the transport wraps, the next boundary is the end locator.
    const wraps = loop !== null && loopApplies(transport);
    const limitS = wraps && loop ? loop.endS : Infinity;
    const wrapWall = wraps && loop ? cursor + (loop.endS - startS) : Infinity;
    const endWall = Math.min(toWall, wrapWall);
    if (endWall - cursor > EPS) {
      segments.push({ pass, startWall: cursor, endWall, startS, endS: startS + (endWall - cursor), limitS });
    }
    if (endWall >= toWall - EPS) break;
    // Always advance. `positionAt` snaps a hair-short wrap to the start of the
    // next pass, so this should already be a whole loop; the floor is here so
    // that no arrangement of floats can leave the walk marking time and
    // burning its guard instead of reaching the rest of the window.
    cursor = Math.max(endWall, cursor + EPS);
  }
  return segments;
}

/** Clock time a session position is reached at, or null when it is behind the playhead. */
export function wallForPosition(transport: TransportState, sessionS: number, fromWall: number, horizonS = 600): number | null {
  if (!transport.playing) return null;
  for (const seg of segmentsInWindow(transport, fromWall, fromWall + horizonS)) {
    if (sessionS >= seg.startS - EPS && sessionS < seg.endS - EPS) {
      return seg.startWall + (sessionS - seg.startS);
    }
  }
  return null;
}

/** Keep a position inside the loop when there is one; used when the locators move under the playhead. */
export function clampToLoop(positionS: number, loop: TransportLoop | null): number {
  if (!loop || loop.endS - loop.startS < MIN_LOOP_S) return positionS;
  if (positionS < loop.startS || positionS >= loop.endS) return loop.startS;
  return positionS;
}

// --- bars ---------------------------------------------------------------------

/**
 * The session's musical frame. The session timeline starts at bar 1, second
 * zero: every candidate the rack lays down is tiled from the locators, so the
 * grid is the session's own, not any one record's. Without a tempo there are
 * no bars, and a command that needs them has to say so rather than guess.
 */
export interface SessionTempo {
  bpm: number;
  beatsPerBar: number;
}

export function secondsPerBar(tempo: SessionTempo): number {
  if (!(tempo.bpm > 0) || !(tempo.beatsPerBar > 0)) return 0;
  return (60 / tempo.bpm) * tempo.beatsPerBar;
}

/** Bar 1 is second zero. Bars below 1 clamp to the start of the session. */
export function barToSeconds(bar: number, tempo: SessionTempo): number {
  const length = secondsPerBar(tempo);
  if (length <= 0) return 0;
  return Math.max(0, (bar - 1) * length);
}

/** The locators for "loop bars 9 to 16", or null when the session has no tempo. */
export function loopForBars(fromBar: number, toBar: number, tempo: SessionTempo | null): TransportLoop | null {
  if (!tempo || secondsPerBar(tempo) <= 0 || toBar <= fromBar) return null;
  return { startS: barToSeconds(fromBar, tempo), endS: barToSeconds(toBar, tempo) };
}

/** Which bar a session second falls in, 1-based; null without a tempo. */
export function barAt(sessionS: number, tempo: SessionTempo | null): number | null {
  if (!tempo) return null;
  const length = secondsPerBar(tempo);
  if (length <= 0) return null;
  return Math.floor(Math.max(0, sessionS) / length) + 1;
}
