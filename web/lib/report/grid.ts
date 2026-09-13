// Beat-grid helpers for the working surface: snapping loop edges and cursor
// positions to the effective grid, and counting bars in a region.

import type { AnalysisReport } from "@/lib/types/report";
import { beatsPerBar } from "./effective";

export type SnapMode = "free" | "beat" | "16th" | "downbeat";

export const SNAP_MODES: ReadonlyArray<{ id: SnapMode; label: string }> = [
  { id: "free", label: "Free" },
  { id: "beat", label: "Beat" },
  { id: "16th", label: "16th" },
  { id: "downbeat", label: "Downbeat" },
];

export interface Grid {
  beats: number[];
  downbeats: number[];
  beatsPerBar: number;
  /** mean beat interval in seconds, or null when fewer than 2 beats */
  beatInterval: number | null;
}

export const EMPTY_GRID: Grid = { beats: [], downbeats: [], beatsPerBar: 4, beatInterval: null };

/** Build the grid from an EFFECTIVE report (apply `effective()` first). */
export function gridFromReport(report: AnalysisReport | null | undefined): Grid {
  const beats = report?.beats?.times_s ?? [];
  const downbeats = report?.beats?.downbeats_s ?? [];
  const bpb = beatsPerBar(report?.beats?.meter ?? "4/4");
  let beatInterval: number | null = null;
  if (beats.length >= 2) {
    beatInterval = ((beats[beats.length - 1] as number) - (beats[0] as number)) / (beats.length - 1);
  } else if (report?.tempo?.bpm) {
    beatInterval = 60 / report.tempo.bpm;
  }
  return { beats, downbeats, beatsPerBar: bpb, beatInterval };
}

/** Index of the nearest value in a sorted array (first index on ties). */
export function nearestIndex(sorted: number[], t: number): number {
  if (sorted.length === 0) return -1;
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) < t) lo = mid + 1;
    else hi = mid;
  }
  // lo is the first index with value >= t; compare with the one before
  if (lo > 0 && Math.abs((sorted[lo - 1] as number) - t) <= Math.abs((sorted[lo] as number) - t)) return lo - 1;
  return lo;
}

function nearestValue(sorted: number[], t: number): number | null {
  const i = nearestIndex(sorted, t);
  return i < 0 ? null : (sorted[i] as number);
}

/** Snap a time to the grid in the given mode. Free returns the input unchanged. */
export function snapTime(t: number, mode: SnapMode, grid: Grid): number {
  if (mode === "free") return t;
  if (mode === "downbeat") return nearestValue(grid.downbeats, t) ?? nearestValue(grid.beats, t) ?? t;
  if (mode === "beat") return nearestValue(grid.beats, t) ?? t;
  // 16th: quarter-beat subdivisions of the interval around t
  const beats = grid.beats;
  if (beats.length === 0) return t;
  if (beats.length === 1) return beats[0] as number;
  const i = nearestIndex(beats, t);
  const candidates: number[] = [];
  for (const j of [i - 1, i]) {
    if (j < 0 || j + 1 >= beats.length) continue;
    const a = beats[j] as number;
    const b = beats[j + 1] as number;
    const step = (b - a) / 4;
    for (let k = 0; k <= 4; k++) candidates.push(a + k * step);
  }
  if (candidates.length === 0) return beats[i] as number;
  let best = candidates[0] as number;
  for (const c of candidates) if (Math.abs(c - t) < Math.abs(best - t)) best = c;
  return best;
}

/**
 * Nearest zero crossing to `t` within ±maxMs, searching outward; a rising
 * crossing (negative to non-negative) is preferred, any sign change accepted.
 * Returns `t` unchanged when there is none in the window.
 */
export function nearestZeroCrossing(channel: Float32Array, sampleRate: number, t: number, maxMs = 2): number {
  const n = channel.length;
  if (n < 2 || sampleRate <= 0) return t;
  const center = Math.round(t * sampleRate);
  const radius = Math.max(1, Math.round((maxMs / 1000) * sampleRate));
  let anyCrossing: number | null = null;
  for (let d = 0; d <= radius; d++) {
    for (const i of d === 0 ? [center] : [center - d, center + d]) {
      if (i < 1 || i >= n) continue;
      const prev = channel[i - 1] as number;
      const cur = channel[i] as number;
      if (prev < 0 && cur >= 0) return i / sampleRate;
      if (anyCrossing === null && ((prev <= 0 && cur > 0) || (prev >= 0 && cur < 0))) anyCrossing = i;
    }
  }
  return anyCrossing === null ? t : anyCrossing / sampleRate;
}

/** Whole bars spanned by [start, end), from the local beat interval; null without a grid. */
export function barsInRange(startS: number, endS: number, grid: Grid): number | null {
  const interval = localBeatInterval(grid, startS);
  if (!interval || endS <= startS) return null;
  const beats = (endS - startS) / interval;
  return Math.max(1, Math.round(beats / grid.beatsPerBar));
}

/** Beat interval measured around `t` (falls back to the mean). */
export function localBeatInterval(grid: Grid, t: number): number | null {
  const beats = grid.beats;
  if (beats.length >= 2) {
    const i = Math.min(Math.max(nearestIndex(beats, t), 0), beats.length - 2);
    const d = (beats[i + 1] as number) - (beats[i] as number);
    if (d > 0) return d;
  }
  return grid.beatInterval;
}

/** The duration of `bars` bars starting at `startS`, following the grid where it exists. */
export function barsToSeconds(startS: number, bars: number, grid: Grid): number | null {
  const bpb = grid.beatsPerBar;
  const beats = grid.beats;
  if (beats.length >= 2) {
    const i = nearestIndex(beats, startS);
    const j = i + bars * bpb;
    const end = beats[j];
    if (end !== undefined) return end - (beats[i] as number);
  }
  const interval = localBeatInterval(grid, startS);
  return interval ? interval * bpb * bars : null;
}

/** Nudge a time by one 16th (sign gives the direction); free of the grid when absent. */
export function nudge(t: number, direction: 1 | -1, grid: Grid): number {
  const interval = localBeatInterval(grid, t) ?? 0.5;
  return Math.max(0, t + (direction * interval) / 4);
}
