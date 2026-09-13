// Clean up a take — the third of the four places the AI helps.
//
// The recorder keeps real timing, so cleanup is a pass over it and never a
// re-record: tighten toward the grid by a chosen amount rather than all or
// nothing, collapse a flam into one hit, flag the hit that was obviously a
// mistake. It is never destructive. `CleanedTake` carries the played take
// beside the cleaned one and a line for every change, so a producer can read
// what was done and keep the original if the machine was wrong.
//
// Pure arithmetic over the grid in grid.ts. No model call: "tighten by 40%"
// is a number, not an opinion.

import { stepSeconds, stepsPerBar } from "./grid";
import { placeTake, type RecordedHit, type RecordingSettings, type Take } from "./recording";

export interface CleanupOptions {
  /** 0 keeps the take as played, 1 puts every hit exactly on the 16th */
  tighten: number;
  /** two hits of the same pad closer than this become one; null leaves flams alone */
  collapseFlamsMs: number | null;
  /** flag hits that are further from the grid than half a 16th, and one-off pads */
  flagOutliers: boolean;
}

export const CLEANUP_DEFAULTS: CleanupOptions = { tighten: 0.5, collapseFlamsMs: 30, flagOutliers: true };

export type ChangeKind = "tightened" | "collapsed" | "flagged";

export interface TakeChange {
  kind: ChangeKind;
  pad: number;
  /** where the hit was, seconds from the take's start */
  fromS: number;
  /** where it is now; the same as `fromS` for a flag, which moves nothing */
  toS: number;
  /** one line in the producer's words */
  note: string;
}

export interface CleanedTake extends Take {
  /** the take exactly as played; cleanup never overwrites it */
  source: Take;
  changes: TakeChange[];
  options: CleanupOptions;
  /** the hits a human should look at, by index into `hits` */
  flagged: number[];
}

/**
 * Tighten by `amount`: each hit moves that fraction of the way to its nearest
 * 16th. 0.4 is the amount a producer usually wants — the feel survives, the
 * accident does not.
 */
export function tightenHits(hits: readonly RecordedHit[], settings: RecordingSettings, amount: number): RecordedHit[] {
  const a = Math.max(0, Math.min(1, amount));
  if (a === 0) return [...hits];
  const step = stepSeconds(settings.bpm);
  return hits.map((h) => {
    const grid = Math.round(h.time_s / step) * step;
    const time = h.time_s + (grid - h.time_s) * a;
    return { ...h, time_s: round6(time) };
  });
}

/** A flam is one hit played twice by two fingers; keep the first and the loudest. */
export function collapseFlams(hits: readonly RecordedHit[], windowMs: number): { hits: RecordedHit[]; dropped: RecordedHit[] } {
  const window = Math.max(0, windowMs) / 1000;
  const sorted = [...hits].sort((a, b) => a.time_s - b.time_s);
  const kept: RecordedHit[] = [];
  const dropped: RecordedHit[] = [];
  for (const hit of sorted) {
    const prev = [...kept].reverse().find((k) => k.pad === hit.pad);
    if (prev && hit.time_s - prev.time_s <= window) {
      if (hit.velocity > prev.velocity) {
        kept[kept.indexOf(prev)] = { ...hit, time_s: prev.time_s };
        dropped.push(prev);
      } else {
        dropped.push(hit);
      }
      continue;
    }
    kept.push(hit);
  }
  return { hits: kept, dropped };
}

/**
 * A hit is worth flagging when it is more than a third of a 16th from its
 * step — it is most of the way to the next one, so which step it meant is a
 * coin toss — or when its pad appears exactly once in a take of more than a
 * handful of hits, which is usually a finger on the wrong key. A hit is always
 * placed on the *nearest* step, so "further than half a 16th" is impossible by
 * construction and would be a flag that never fires.
 *
 * Flagging moves nothing. The producer decides.
 */
export const FLAG_FRACTION_OF_STEP = 1 / 3;

export function flagHits(hits: readonly RecordedHit[], settings: RecordingSettings): Array<{ index: number; note: string }> {
  const limit = stepSeconds(settings.bpm) * FLAG_FRACTION_OF_STEP * 1000;
  const counts = new Map<number, number>();
  for (const h of hits) counts.set(h.pad, (counts.get(h.pad) ?? 0) + 1);
  const out: Array<{ index: number; note: string }> = [];
  hits.forEach((h, index) => {
    const off = Math.abs(h.placement.offset_ms);
    if (off > limit) {
      out.push({ index, note: `${Math.round(off)} ms from the nearest 16th: most of the way to the next one, so which step it meant is a guess.` });
      return;
    }
    if (hits.length >= 6 && (counts.get(h.pad) ?? 0) === 1) {
      out.push({ index, note: `The only hit on this pad in the whole take.` });
    }
  });
  return out;
}

/** The whole pass. The played take comes back untouched in `source`. */
export function cleanTake(take: Take, settings: RecordingSettings, options: Partial<CleanupOptions> = {}): CleanedTake {
  const opts: CleanupOptions = { ...CLEANUP_DEFAULTS, ...options };
  const changes: TakeChange[] = [];
  let working: RecordedHit[] = [...take.hits];

  if (opts.collapseFlamsMs !== null) {
    const { hits, dropped } = collapseFlams(working, opts.collapseFlamsMs);
    for (const d of dropped) {
      changes.push({ kind: "collapsed", pad: d.pad, fromS: d.time_s, toS: d.time_s, note: `Two hits on this pad ${Math.round(opts.collapseFlamsMs)} ms apart or less: collapsed into one.` });
    }
    working = hits;
  }

  if (opts.tighten > 0) {
    const before = working;
    working = tightenHits(working, settings, opts.tighten);
    before.forEach((h, i) => {
      const after = working[i] as RecordedHit;
      if (Math.abs(after.time_s - h.time_s) < 1e-6) return;
      changes.push({
        kind: "tightened",
        pad: h.pad,
        fromS: h.time_s,
        toS: after.time_s,
        note: `Moved ${Math.round(Math.abs(after.time_s - h.time_s) * 1000)} ms toward the grid (${Math.round(opts.tighten * 100)}% of the way).`,
      });
    });
  }

  const placed = placeTake(working, settings, take.bars);
  const flagged: number[] = [];
  if (opts.flagOutliers) {
    for (const f of flagHits(placed, settings)) {
      flagged.push(f.index);
      const hit = placed[f.index] as RecordedHit;
      changes.push({ kind: "flagged", pad: hit.pad, fromS: hit.time_s, toS: hit.time_s, note: f.note });
    }
  }

  return { bars: take.bars, hits: placed, source: take, changes, options: opts, flagged };
}

/** One line for the panel and the chat, in the same words. */
export function describeCleanup(cleaned: CleanedTake): string {
  const moved = cleaned.changes.filter((c) => c.kind === "tightened").length;
  const collapsed = cleaned.changes.filter((c) => c.kind === "collapsed").length;
  const flagged = cleaned.changes.filter((c) => c.kind === "flagged").length;
  const parts: string[] = [];
  if (moved > 0) parts.push(`${moved} ${moved === 1 ? "hit" : "hits"} tightened ${Math.round(cleaned.options.tighten * 100)}% toward the grid`);
  if (collapsed > 0) parts.push(`${collapsed} ${collapsed === 1 ? "flam" : "flams"} collapsed`);
  if (flagged > 0) parts.push(`${flagged} flagged to look at`);
  if (parts.length === 0) return "Nothing to clean up: every hit is already where it was played and on a step.";
  return `${parts.join(", ")}. The take you played is still here.`;
}

/** The average distance from the grid, in ms; how loose the take is. */
export function looseness(take: Take): number {
  if (take.hits.length === 0) return 0;
  const total = take.hits.reduce((sum, h) => sum + Math.abs(h.placement.offset_ms), 0);
  return Math.round((total / take.hits.length) * 100) / 100;
}

/** The steps a take covers, for the pattern work and the readouts. */
export function takeSteps(take: Take, settings: RecordingSettings): number {
  return take.bars * stepsPerBar(settings.beatsPerBar);
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
