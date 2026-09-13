// The scheduler: what to start, when, from where.
//
// This is the whole of the transport's musical timing, and it is a pure
// function. `planWindow` takes the transport, the regions and a window of
// clock time, and returns one instruction per buffer source the backend
// should start in that window. Nothing here touches Web Audio, so the
// behaviour that matters — a loop wrapping inside a region, a seek landing in
// the middle of one, a track whose audio arrives late — is asserted in node.
//
// Timing accuracy comes from two rules:
//
//  1. Every piece carries an absolute clock time. The backend hands it to
//     `AudioBufferSourceNode.start(when)`, which the audio thread honours to
//     the sample. The timer that calls this function only has to be *early*,
//     never punctual: it runs every 60 ms and schedules 250 ms ahead, so a
//     tick can be late by 190 ms and still lose nothing.
//  2. Each piece is emitted exactly once. The key is the region and the pass
//     of the loop, so a tick that overlaps the last one re-derives the same
//     keys and the caller drops them. Nothing is double-started, and a piece
//     the caller could not play (its audio had not decoded) simply has no key
//     recorded and comes back on the next tick, trimmed to join in progress.

import { segmentsInWindow, type Segment } from "./time";
import { EPS, MIN_PIECE_S, type ScheduledPlay, type SessionRegion, type SourceId, type TransportState } from "./types";

export interface PlanInput {
  transport: TransportState;
  regions: readonly SessionRegion[];
  /** clock seconds; normally "now" */
  fromWall: number;
  /** clock seconds; normally now + LOOKAHEAD_S */
  toWall: number;
  /** keys already started — pieces whose key is in here are skipped */
  scheduled: ReadonlySet<string>;
  /** false for a source whose samples are not in memory yet; it is reported, not played */
  isReady?: (sourceId: SourceId) => boolean;
}

export interface PlanResult {
  plays: ScheduledPlay[];
  /** sources a region needed in this window and could not get. The caller decodes these. */
  waiting: SourceId[];
}

/** One piece of one region on one pass. A region can only sound once per pass. */
export function planKey(regionId: string, pass: number): string {
  return `${regionId}|${pass}`;
}

/** A region's playback rate; 1 when it is not resampled. */
export function rateOf(region: SessionRegion): number {
  const rate = region.rate;
  return rate === undefined || !Number.isFinite(rate) || rate <= 0 ? 1 : rate;
}

/** The region's last session second (exclusive). */
export function regionEnd(region: SessionRegion): number {
  return region.startS + region.durationS;
}

/**
 * The piece of `region` that sounds during `segment`, or null when they do not
 * overlap. The offset advances with the clipped start, which is what makes a
 * seek into the middle of a region, and a loop that wraps inside one, play the
 * right samples rather than restarting the region.
 *
 * The start is bounded by the window — that is what decides whether a piece is
 * due yet — but the end is bounded by the *pass*, not the window. A four-bar
 * region scheduled inside a 250 ms lookahead is one node four bars long, not
 * the first 250 ms of one.
 */
export function pieceFor(region: SessionRegion, segment: Segment): ScheduledPlay | null {
  const startS = Math.max(region.startS, segment.startS);
  if (startS >= segment.endS - EPS) return null; // not due in this window
  const endS = Math.min(regionEnd(region), segment.limitS);
  const durationS = endS - startS;
  if (durationS <= MIN_PIECE_S) return null;
  const rate = rateOf(region);
  return {
    key: planKey(region.id, segment.pass),
    regionId: region.id,
    trackId: region.trackId,
    sourceId: region.sourceId,
    whenWall: segment.startWall + (startS - segment.startS),
    offsetS: region.offsetS + (startS - region.startS) * rate,
    durationS,
    sessionStartS: startS,
    pass: segment.pass,
    gain: region.gain,
    rate,
    joined: startS > region.startS + EPS,
  };
}

/**
 * Everything that should start in `[fromWall, toWall)`. Deterministic: the
 * same inputs give the same plan, which is why the same tick can run twice
 * without consequence and why the tests can assert exact sample positions.
 */
export function planWindow(input: PlanInput): PlanResult {
  const { transport, regions, fromWall, toWall, scheduled } = input;
  const isReady = input.isReady;
  const plays: ScheduledPlay[] = [];
  const waiting = new Set<SourceId>();
  for (const segment of segmentsInWindow(transport, fromWall, toWall)) {
    for (const region of regions) {
      const piece = pieceFor(region, segment);
      if (!piece) continue;
      if (scheduled.has(piece.key)) continue;
      if (isReady && !isReady(region.sourceId)) {
        waiting.add(region.sourceId);
        continue;
      }
      plays.push(piece);
    }
  }
  plays.sort((a, b) => a.whenWall - b.whenWall || (a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : 0));
  return { plays, waiting: [...waiting] };
}

/** Every source the regions need; what the decode cache is asked to hold. */
export function sourcesOf(regions: readonly SessionRegion[]): SourceId[] {
  return [...new Set(regions.map((r) => r.sourceId))];
}

/** The last session second any region sounds on: the end of the material. */
export function contentEnd(regions: readonly SessionRegion[]): number {
  let end = 0;
  for (const region of regions) end = Math.max(end, regionEnd(region));
  return end;
}
