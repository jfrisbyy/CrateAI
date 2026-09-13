// The body of `POST /api/export/song`, validated.
//
// The song arrives from the browser, so every id in it is caller input. The
// schema below bounds the shape; the route bounds the *ownership*, by looking
// every file id up through the caller's own RLS client before the job row is
// written. Compute then checks a third time with the row's `user_id` and its
// storage prefix, because a `files` row is a pointer and a pointer can be
// written by hand (principle 6; see docs/HANDOFF_export.md).

import { z } from "zod";
import { UUID_RE } from "@/lib/http";
import {
  EXPORT_BIT_DEPTHS,
  EXPORT_FORMATS,
  EXPORT_MAX_LENGTH_S,
  EXPORT_MAX_TRACKS,
  EXPORT_SAMPLE_RATES,
} from "./types";

/** Mirrors MAX_REGIONS in analysis/lockedgroove/export/bundle's song module. */
export const MAX_REGIONS = 4000;
/** Mirrors MIN_REGION_S in lib/session/arrangement.ts: shorter is a click, not a sound. */
export const MIN_REGION_S = 0.02;
export const MAX_MIDI_IDS = 64;

const finite = (max: number) => z.number().finite().min(0).max(max);

const lineageSchema = z
  .object({
    file_id: z.string().max(64).nullable(),
    file_name: z.string().max(200).nullable(),
    parent_file_id: z.string().max(64).nullable(),
    kind: z.string().max(32).nullable(),
    stem: z.string().max(32).nullable(),
    separation_model: z.string().max(64).nullable(),
    separation_model_label: z.string().max(200).nullable(),
    take_start_s: z.number().finite().nullable(),
    take_end_s: z.number().finite().nullable(),
    downbeat_s: z.number().finite(),
    source_duration_s: z.number().finite().nullable(),
    source_bpm: z.number().finite().nullable(),
    source_beats_per_bar: z.number().int().min(1).max(16),
    cents: z.number().finite(),
    stretch: z.number().finite(),
    candidate_id: z.string().max(64).nullable(),
    reason: z.string().max(400).nullable(),
    confidence: z.number().finite().nullable(),
  })
  .nullable();

const regionSchema = z.object({
  id: z.string().min(1).max(64),
  file_id: z.string().regex(UUID_RE, "region.file_id must be a library file id"),
  start_s: finite(EXPORT_MAX_LENGTH_S),
  duration_s: z.number().finite().min(MIN_REGION_S).max(EXPORT_MAX_LENGTH_S),
  offset_s: finite(24 * 60 * 60),
  gain: z.number().finite().min(0).max(8).default(1),
  rate: z.number().finite().min(0.05).max(8).default(1),
  lineage_line: z.string().max(400).nullable().default(null),
  lineage: lineageSchema.default(null),
  source_bars: z
    .object({ from_bar: z.number().int(), to_bar: z.number().int(), bars: z.number().finite() })
    .nullable()
    .default(null),
});

const trackSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(120),
  position: z.number().int().min(0).max(EXPORT_MAX_TRACKS),
  gain: z.number().finite().min(0).max(4).default(1),
  muted: z.boolean().default(false),
  soloed: z.boolean().default(false),
  provenance: z.string().max(400).nullable().default(null),
  regions: z.array(regionSchema).max(MAX_REGIONS),
});

export const exportSongSchema = z.object({
  song: z.object({
    name: z.string().max(120),
    bpm: z.number().finite().min(20).max(400).nullable().default(null),
    beats_per_bar: z.number().int().min(1).max(16).default(4),
    key: z
      .object({
        tonic: z.string().max(8),
        mode: z.enum(["major", "minor"]),
        from_file_id: z.string().max(64).nullable().default(null),
        from_file_name: z.string().max(200).nullable().default(null),
      })
      .nullable()
      .default(null),
    master_gain: z.number().finite().min(0).max(4).default(1),
    tracks: z.array(trackSchema).min(1).max(EXPORT_MAX_TRACKS),
  }),
  format: z.enum(EXPORT_FORMATS).default("flac"),
  bit_depth: z
    .union([z.literal(EXPORT_BIT_DEPTHS[0]), z.literal(EXPORT_BIT_DEPTHS[1])])
    .default(24),
  sample_rate: z
    .union([z.literal(EXPORT_SAMPLE_RATES[0]), z.literal(EXPORT_SAMPLE_RATES[1])])
    .default(44100),
  include_muted: z.boolean().default(false),
  midi_ids: z.array(z.string().regex(UUID_RE)).max(MAX_MIDI_IDS).default([]),
});

export type ExportSongBody = z.infer<typeof exportSongSchema>;

/** Distinct library file ids the song references, in the order they are met. */
export function fileIdsOf(body: ExportSongBody): string[] {
  const seen = new Set<string>();
  for (const track of body.song.tracks) for (const region of track.regions) seen.add(region.file_id);
  return [...seen];
}

export function songLengthS(body: ExportSongBody): number {
  let end = 0;
  for (const track of body.song.tracks) {
    for (const region of track.regions) end = Math.max(end, region.start_s + region.duration_s);
  }
  return end;
}

export function regionCount(body: ExportSongBody): number {
  return body.song.tracks.reduce((n, t) => n + t.regions.length, 0);
}
