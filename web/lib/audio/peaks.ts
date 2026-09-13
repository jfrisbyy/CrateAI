// Drawing a waveform from the stored peaks, without decoding anything.
//
// Every rack row needs a waveform with its region marked, and a rack can be
// thirty rows long. Decoding thirty records to draw thirty thumbnails is
// exactly the memory mistake the direction document warns about, so the rows
// draw from `files.peaks` — the mono min/max pairs the analysis already stored
// (docs/CONTRACTS.md section 6) — and decode only what is actually played.
//
// Pure geometry, so it is asserted in node: the browser only puts the path in
// an <svg>.

import type { Peaks } from "@/lib/types/db";

export interface WaveGeometry {
  /** an SVG path: the top edge left to right, the bottom edge back again */
  path: string;
  /** how many columns were drawn */
  columns: number;
}

/** Peaks are stored as values in [-1, 1]; keep a hair of ink for silence. */
const MIN_INK = 0.012;

/**
 * A closed path for `peaks` in a `width` x `height` box, resampled to at most
 * `maxColumns` columns. Empty peaks give a flat line rather than nothing, so a
 * row that has not been analysed still has a shape to mark a region on.
 */
export function wavePath(peaks: Peaks | null | undefined, width: number, height: number, maxColumns = 240): WaveGeometry {
  const mid = height / 2;
  if (width <= 0 || height <= 0) return { path: "", columns: 0 };
  const min = peaks?.min ?? [];
  const max = peaks?.max ?? [];
  const points = Math.min(min.length, max.length);
  if (points === 0) {
    return { path: `M 0 ${round(mid - MIN_INK * mid)} L ${round(width)} ${round(mid - MIN_INK * mid)} L ${round(width)} ${round(mid + MIN_INK * mid)} L 0 ${round(mid + MIN_INK * mid)} Z`, columns: 0 };
  }
  const columns = Math.max(1, Math.min(maxColumns, points));
  const tops: string[] = [];
  const bottoms: string[] = [];
  for (let c = 0; c < columns; c++) {
    const from = Math.floor((c * points) / columns);
    const to = Math.max(from + 1, Math.floor(((c + 1) * points) / columns));
    let lo = 0;
    let hi = 0;
    for (let i = from; i < to && i < points; i++) {
      lo = Math.min(lo, min[i] as number);
      hi = Math.max(hi, max[i] as number);
    }
    const x = columns === 1 ? 0 : (c * width) / (columns - 1);
    const top = mid - Math.max(MIN_INK, Math.min(1, hi)) * mid;
    const bottom = mid - Math.max(-1, Math.min(-MIN_INK, lo)) * mid;
    tops.push(`${round(x)} ${round(top)}`);
    bottoms.unshift(`${round(x)} ${round(bottom)}`);
  }
  return { path: `M ${tops.join(" L ")} L ${bottoms.join(" L ")} Z`, columns };
}

/** Where a span of the file falls on a `width`-wide drawing of the whole file. */
export function spanBox(startS: number, endS: number, durationS: number | null | undefined, width: number): { x: number; width: number } {
  if (!durationS || durationS <= 0 || width <= 0) return { x: 0, width };
  const from = clamp01(startS / durationS) * width;
  const to = clamp01(endS / durationS) * width;
  return { x: Math.min(from, to), width: Math.max(1, Math.abs(to - from)) };
}

/** Where a moment in the file falls, for a playhead on a rack row. */
export function markerX(atS: number, durationS: number | null | undefined, width: number): number {
  if (!durationS || durationS <= 0) return 0;
  return clamp01(atS / durationS) * width;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
