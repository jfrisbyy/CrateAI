// Zoom and scroll, as arithmetic.
//
// A several-minute song at a readable zoom is tens of thousands of pixels wide
// and can hold hundreds of regions. Two things follow, and both are decided
// here rather than in the component:
//
//   Only what is on screen is drawn. `regionsInView` is the cull, and it is a
//   pure function so the component's render is a map over an already-short
//   list rather than a filter over everything on every pointer move.
//
//   Zoom holds the music still. Zooming with the pointer over bar 33 leaves
//   bar 33 under the pointer; the scroll is solved for, not accumulated, so
//   zooming in and back out returns to the same place instead of drifting.
//
// Seconds are the truth and pixels are the drawing. Every conversion goes
// through `timeToX` / `xToTime`, so there is exactly one place where the
// timeline could be off by a pixel.

import type { SessionRegion } from "./types";

export interface Viewport {
  /** the zoom */
  pxPerSecond: number;
  /** the session second at the left edge of the lane strip */
  scrollS: number;
  /** how wide the lane strip is, in pixels */
  widthPx: number;
}

/** Zoomed out far enough to see a seven-minute song at 1000 px. */
export const MIN_PX_PER_S = 2;
/** Zoomed in far enough to place a region on a single sixteenth by eye. */
export const MAX_PX_PER_S = 900;
/** A bar of a 90 BPM four-four song is about 128 px: a comfortable starting point. */
export const DEFAULT_PX_PER_S = 48;
/** One press of the zoom button. */
export const ZOOM_STEP = 1.6;

export const DEFAULT_VIEWPORT: Viewport = { pxPerSecond: DEFAULT_PX_PER_S, scrollS: 0, widthPx: 800 };

export function clampZoom(pxPerSecond: number): number {
  if (!Number.isFinite(pxPerSecond) || pxPerSecond <= 0) return DEFAULT_PX_PER_S;
  return Math.min(MAX_PX_PER_S, Math.max(MIN_PX_PER_S, pxPerSecond));
}

/** Where a session second is drawn, in pixels from the left edge of the strip. */
export function timeToX(sessionS: number, view: Viewport): number {
  return (sessionS - view.scrollS) * view.pxPerSecond;
}

/** The session second under a pixel offset into the strip. */
export function xToTime(x: number, view: Viewport): number {
  if (!(view.pxPerSecond > 0)) return view.scrollS;
  return view.scrollS + x / view.pxPerSecond;
}

/** How many seconds fit on screen at this zoom. */
export function visibleSeconds(view: Viewport): number {
  if (!(view.pxPerSecond > 0)) return 0;
  return view.widthPx / view.pxPerSecond;
}

export function visibleSpan(view: Viewport): { fromS: number; toS: number } {
  return { fromS: view.scrollS, toS: view.scrollS + visibleSeconds(view) };
}

/**
 * The scrollable length: the song plus a screen of room past the end, so a
 * region can always be dragged somewhere new. Never less than one screen.
 */
export function scrollableSeconds(contentEndS: number, view: Viewport): number {
  const visible = visibleSeconds(view);
  return Math.max(visible, Math.max(0, contentEndS) + visible * 0.5);
}

/** Keep the scroll inside the song. Negative scroll would put bar 1 off the left edge. */
export function clampViewport(view: Viewport, contentEndS: number): Viewport {
  const pxPerSecond = clampZoom(view.pxPerSecond);
  const bounded = { ...view, pxPerSecond };
  const max = Math.max(0, scrollableSeconds(contentEndS, bounded) - visibleSeconds(bounded));
  const scrollS = Number.isFinite(view.scrollS) ? Math.min(max, Math.max(0, view.scrollS)) : 0;
  return { pxPerSecond, scrollS, widthPx: Math.max(0, view.widthPx) };
}

/**
 * Zoom by a factor, keeping the second under `anchorX` where it is. Passing
 * the pointer's x is what makes a wheel zoom feel attached to the music; pass
 * half the width for the buttons and it zooms around the middle of the screen.
 */
export function zoomBy(view: Viewport, factor: number, anchorX: number, contentEndS: number): Viewport {
  if (!Number.isFinite(factor) || factor <= 0) return view;
  const anchorS = xToTime(anchorX, view);
  const pxPerSecond = clampZoom(view.pxPerSecond * factor);
  const scrollS = anchorS - anchorX / pxPerSecond;
  return clampViewport({ pxPerSecond, scrollS, widthPx: view.widthPx }, contentEndS);
}

/** Fit the whole song on screen, with a little air after the last region. */
export function zoomToFit(view: Viewport, contentEndS: number): Viewport {
  const length = Math.max(1, contentEndS * 1.04);
  const pxPerSecond = view.widthPx > 0 ? clampZoom(view.widthPx / length) : view.pxPerSecond;
  return clampViewport({ pxPerSecond, scrollS: 0, widthPx: view.widthPx }, contentEndS);
}

export function scrollTo(view: Viewport, sessionS: number, contentEndS: number): Viewport {
  return clampViewport({ ...view, scrollS: sessionS }, contentEndS);
}

export function scrollBy(view: Viewport, deltaS: number, contentEndS: number): Viewport {
  return clampViewport({ ...view, scrollS: view.scrollS + deltaS }, contentEndS);
}

/**
 * Bring a second into view if it is not already, leaving a margin so the
 * playhead does not sit welded to the edge. Returns the same object when
 * nothing needs to move, so a caller can compare by identity and skip the
 * re-render — which is the difference between following the playhead and
 * re-rendering the timeline sixty times a second.
 */
export function scrollToShow(view: Viewport, sessionS: number, contentEndS: number, margin = 0.15): Viewport {
  const visible = visibleSeconds(view);
  if (!(visible > 0)) return view;
  const pad = visible * Math.min(0.45, Math.max(0, margin));
  if (sessionS >= view.scrollS + pad && sessionS <= view.scrollS + visible - pad) return view;
  const next = clampViewport({ ...view, scrollS: sessionS - pad }, contentEndS);
  return Math.abs(next.scrollS - view.scrollS) < 1e-9 ? view : next;
}

// --- culling -------------------------------------------------------------------

/** Does this region put any ink on screen? `padS` keeps a part-visible region drawn. */
export function inView(region: SessionRegion, view: Viewport, padS = 0): boolean {
  const { fromS, toS } = visibleSpan(view);
  return region.startS < toS + padS && region.startS + region.durationS > fromS - padS;
}

/**
 * The regions worth drawing, in timeline order. A song with four hundred
 * regions draws the twenty that are on screen; scrolling changes which twenty.
 */
export function regionsInView(regions: readonly SessionRegion[], view: Viewport, padS = 0): SessionRegion[] {
  const out: SessionRegion[] = [];
  for (const region of regions) if (inView(region, view, padS)) out.push(region);
  out.sort((a, b) => a.startS - b.startS);
  return out;
}

/**
 * The seconds one label's width covers, for `rulerTicks`. The ruler asks the
 * viewport how much room it has rather than the other way round, so the tick
 * density is decided once and both the ruler and the lane grid use it.
 */
export function minTickSpacingS(view: Viewport, minSpacingPx = 56): number {
  if (!(view.pxPerSecond > 0)) return Infinity;
  return minSpacingPx / view.pxPerSecond;
}

/** A region narrower than this is drawn as a sliver; its edges stop being grabbable. */
export const MIN_GRABBABLE_PX = 18;

/** How wide the trim handle is, in pixels, for a region of this width. */
export function handleWidthPx(regionWidthPx: number): number {
  return Math.max(2, Math.min(8, regionWidthPx / 4));
}
