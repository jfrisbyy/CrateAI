// A take belongs on a track in the session, not in a separate toy.
//
// One region per hit: the slice the pad played, at the second it was played,
// for as long as it sounded — the gate length when the producer held the key,
// the slice's own length when they did not. Note mode rides along as the
// region's `rate`, which is the same field the rack uses when it resamples a
// break to fit, so the timeline plays exactly what the pads played.
//
// This file reads lib/session/** and changes nothing in it: it produces the
// SessionTrack and SessionRegion values the session's own `edit` takes.

import type { RegionLineage } from "@/lib/session/lineage";
import type { SessionRegion, SessionTrack } from "@/lib/session/types";
import { barSeconds } from "./grid";
import { rateForSemitones } from "./note";
import type { RecordingSettings, Take } from "./recording";

/** Shorter than this and a region is a click, not a sound (the session's own floor). */
export const MIN_TAKE_REGION_S = 0.02;

export interface TakeSlice {
  /** the library file the pad played */
  fileId: string;
  label: string;
  /** the decoded length of that file, when it is known */
  durationS: number | null;
  /** the record the slice was cut from, for the lineage */
  parentFileId?: string | null;
  /** the span of the parent the slice covers, when it is known */
  startS?: number;
  endS?: number;
}

export interface TakePlacement {
  trackId: string;
  /** session seconds the take's first bar sits at */
  startS: number;
  settings: RecordingSettings;
  /** pad (0-based, as the recorder stores it) -> what it played */
  slices: ReadonlyMap<number, TakeSlice>;
  /** the record this take was played over, named for the lane */
  sourceName?: string;
  sourceFileId?: string | null;
}

/**
 * Where a take should land: the next bar line at or after the playhead, so a
 * take sits in time with everything else instead of wherever the producer
 * happened to press stop. Without a tempo there are no bars and the take lands
 * where the playhead is — stated, not guessed.
 */
export function takeStartFor(positionS: number, bpm: number | null, beatsPerBar = 4): { startS: number; note: string } {
  if (!bpm || !Number.isFinite(bpm) || bpm <= 0) {
    return { startS: Math.max(0, positionS), note: "The session has no measured tempo, so the take lands at the playhead." };
  }
  const bar = barSeconds(bpm, beatsPerBar);
  const index = Math.ceil(Math.max(0, positionS) / bar - 1e-9);
  const startS = round6(index * bar) || 0;
  return { startS, note: `The take lands on bar ${index + 1}, the next bar line at ${bpm.toFixed(1)} BPM.` };
}

export function trackForTake(trackId: string, name: string, options: { fileId?: string | null; provenance?: string | null } = {}): SessionTrack {
  return {
    id: trackId,
    name,
    gain: 1,
    muted: false,
    soloed: false,
    fileId: options.fileId ?? null,
    origin: "file",
    provenance: options.provenance ?? null,
  };
}

/** One region per hit. Hits whose pad has no slice, or no decoded length, are left out and counted. */
export function regionsForTake(take: Take, placement: TakePlacement): { regions: SessionRegion[]; skipped: number; note: string } {
  const regions: SessionRegion[] = [];
  let skipped = 0;
  take.hits.forEach((hit, i) => {
    const slice = placement.slices.get(hit.pad);
    if (!slice || slice.durationS === null || slice.durationS <= 0) {
      skipped++;
      return;
    }
    const rate = rateForSemitones(hit.semitones ?? 0);
    const sounding = slice.durationS / rate;
    const durationS = Math.max(MIN_TAKE_REGION_S, Math.min(sounding, hit.length_s !== undefined ? Math.max(MIN_TAKE_REGION_S, hit.length_s) : sounding));
    const startS = Math.max(0, round6(placement.startS + hit.time_s));
    regions.push({
      id: `${placement.trackId}-hit-${i}`,
      trackId: placement.trackId,
      sourceId: slice.fileId,
      startS,
      durationS: round6(durationS),
      offsetS: 0,
      gain: clamp01(hit.velocity),
      rate,
      lineage: lineageFor(hit, slice, placement),
    });
  });
  const note =
    skipped === 0
      ? `${regions.length} ${regions.length === 1 ? "hit" : "hits"} on one lane, at the times you played them.`
      : `${regions.length} on the lane; ${skipped} ${skipped === 1 ? "hit" : "hits"} had no decoded slice and were left out.`;
  return { regions, skipped, note };
}

function lineageFor(hit: Take["hits"][number], slice: TakeSlice, placement: TakePlacement): RegionLineage {
  const semitones = hit.semitones ?? 0;
  return {
    fileId: slice.fileId,
    fileName: slice.label,
    parentFileId: slice.parentFileId ?? placement.sourceFileId ?? null,
    kind: "chop",
    stem: null,
    separationModel: null,
    separationModelLabel: null,
    takeStartS: slice.startS ?? 0,
    takeEndS: slice.endS ?? slice.durationS ?? 0,
    downbeatS: slice.startS ?? 0,
    sourceDurationS: slice.durationS,
    sourceBpm: placement.settings.bpm,
    sourceBeatsPerBar: placement.settings.beatsPerBar,
    cents: 0,
    stretch: 1,
    candidateId: null,
    reason: `Played on pad ${hit.pad + 1}${semitones === 0 ? "" : `, ${semitones > 0 ? "+" : ""}${semitones} semitones`} at ${placement.settings.bpm.toFixed(1)} BPM.`,
    confidence: null,
  };
}

/** One line for the echo: what landed where, and at what tempo. */
export function describeTakeLanding(take: Take, placement: TakePlacement, sessionBpm: number | null): string {
  const lines: string[] = [];
  lines.push(`${take.hits.length} ${take.hits.length === 1 ? "hit" : "hits"} over ${take.bars} ${take.bars === 1 ? "bar" : "bars"} on a lane of their own.`);
  if (sessionBpm !== null && Math.abs(sessionBpm - placement.settings.bpm) > 0.05) {
    lines.push(`The session runs at ${sessionBpm.toFixed(1)} BPM and this take was played at ${placement.settings.bpm.toFixed(1)}; it lands at its own tempo, unstretched.`);
  }
  return lines.join(" ");
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
