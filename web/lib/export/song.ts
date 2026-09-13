// Turning what is on the timeline into what compute is asked to render.
//
// This is the browser half of the export: it reads the arrangement the
// producer is looking at (`lib/session/arrangement.ts`) and produces the
// request body. Two decisions live here rather than on the compute side, and
// both are about honesty:
//
// **The lineage lines are derived here.** `lib/session/lineage.ts` is the one
// place in the product that knows how to say what a region is — which record,
// which bars of it, which separator, what was done to it — and a second
// implementation in Python would be a second truth. So `describeLineage` runs
// here and the line travels with the region. The structured lineage goes too,
// so the readme is never blank if a line is missing.
//
// **The song's key is attributed, not asserted.** A session has a tempo but no
// key: the records have keys. `songKeyOf` takes the first exported lane whose
// record has a measured key and records *which record it came from*, so the
// readme can say "F minor (measured on Masquerade)" instead of claiming the
// arrangement was measured. Lanes that disagree are listed, never averaged.
//
// Pure, framework-free and asserted in node like the rest of lib/session.

import { describeLineage, sourceBars, type RegionLineage } from "@/lib/session/lineage";
import { anySoloed, audible, clampGain } from "@/lib/session/mix";
import type { SessionRegion, SessionTrack } from "@/lib/session/types";
import { keyToken } from "@/lib/music/keys";
import type { Mode } from "@/lib/types/report";
import {
  DEFAULT_EXPORT_BIT_DEPTH,
  DEFAULT_EXPORT_FORMAT,
  DEFAULT_EXPORT_SAMPLE_RATE,
  EXPORT_CAP_BYTES,
  EXPORT_CHANNELS,
  EXPORT_MAX_LENGTH_S,
  EXPORT_MAX_TRACKS,
  FORMAT_RATIO,
  type ExportBitDepth,
  type ExportEstimate,
  type ExportFormat,
  type ExportLineage,
  type ExportRegion,
  type ExportSong,
  type ExportSongKey,
  type ExportSongRequest,
  type ExportTrack,
} from "./types";

export interface ArrangementLike {
  tracks: readonly SessionTrack[];
  regions: readonly SessionRegion[];
}

export interface ExportOptions {
  name?: string;
  bpm?: number | null;
  beatsPerBar?: number;
  masterGain?: number;
  format?: ExportFormat;
  bitDepth?: ExportBitDepth;
  includeMuted?: boolean;
  midiIds?: string[];
  /** measured key per library file, so a lane can be attributed to its record */
  keyOf?: (fileId: string) => { tonic: string; mode: Mode } | null;
  /** what a producer calls a file, when a region has no lineage to ask */
  nameOf?: (fileId: string) => string | null;
}

function round(value: number, places = 6): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function rateOf(region: SessionRegion): number {
  const rate = region.rate;
  return rate === undefined || !Number.isFinite(rate) || rate <= 0 ? 1 : rate;
}

export function lineageToWire(lineage: RegionLineage): ExportLineage {
  return {
    file_id: lineage.fileId,
    file_name: lineage.fileName,
    parent_file_id: lineage.parentFileId,
    kind: lineage.kind,
    stem: lineage.stem,
    separation_model: lineage.separationModel,
    separation_model_label: lineage.separationModelLabel,
    take_start_s: lineage.takeStartS,
    take_end_s: lineage.takeEndS,
    downbeat_s: lineage.downbeatS,
    source_duration_s: lineage.sourceDurationS,
    source_bpm: lineage.sourceBpm,
    source_beats_per_bar: lineage.sourceBeatsPerBar,
    cents: lineage.cents,
    stretch: lineage.stretch,
    candidate_id: lineage.candidateId,
    reason: lineage.reason,
    confidence: lineage.confidence,
  };
}

export function regionToWire(region: SessionRegion): ExportRegion {
  const lineage = region.lineage ?? null;
  const bars = sourceBars(region, lineage);
  return {
    id: region.id,
    file_id: region.sourceId,
    start_s: round(Math.max(0, region.startS)),
    duration_s: round(Math.max(0, region.durationS)),
    offset_s: round(Math.max(0, region.offsetS)),
    gain: Number.isFinite(region.gain) ? region.gain : 1,
    rate: rateOf(region),
    lineage_line: lineage ? describeLineage(region, lineage) : null,
    lineage: lineage ? lineageToWire(lineage) : null,
    source_bars: bars ? { from_bar: bars.fromBar, to_bar: bars.toBar, bars: bars.bars } : null,
  };
}

/** The lanes that will be rendered, in the producer's own order, with their regions. */
export function tracksToWire(arrangement: ArrangementLike): ExportTrack[] {
  return arrangement.tracks
    .filter((track) => track.ephemeral !== true)
    .map((track, index) => ({
      id: track.id,
      name: track.name,
      position: index,
      gain: clampGain(track.gain),
      muted: track.muted,
      soloed: track.soloed,
      provenance: track.provenance,
      regions: arrangement.regions.filter((r) => r.trackId === track.id).map(regionToWire),
    }));
}

/**
 * The key the export is named after, and the record it was measured on.
 *
 * The first exported lane whose record has a measured key wins; nothing
 * averages, votes or infers. When lanes disagree the readme lists each lane's
 * own record, which is the truthful answer to "what key is this song in".
 */
export function songKeyOf(tracks: readonly ExportTrack[], keyOf?: ExportOptions["keyOf"]): ExportSongKey | null {
  for (const track of tracks) {
    for (const region of track.regions) {
      const measured = keyOf?.(region.file_id) ?? null;
      const tonic = measured?.tonic ?? null;
      const mode = measured?.mode ?? null;
      if (tonic && (mode === "major" || mode === "minor")) {
        return {
          tonic,
          mode,
          from_file_id: region.file_id,
          from_file_name: region.lineage?.file_name ?? null,
        };
      }
    }
  }
  return null;
}

export function songLengthS(tracks: readonly ExportTrack[]): number {
  let end = 0;
  for (const track of tracks) {
    for (const region of track.regions) end = Math.max(end, region.start_s + region.duration_s);
  }
  return round(end);
}

/**
 * Mute and solo are decided by `lib/session/mix.ts` and nothing else, so the
 * zip can never disagree with the transport about what was audible. The wire
 * shape carries fewer fields than a lane, so it is widened rather than cast.
 */
function asLane(track: ExportTrack): SessionTrack {
  return { id: track.id, name: track.name, gain: track.gain, muted: track.muted, soloed: track.soloed,
    fileId: null, origin: "file", provenance: track.provenance };
}

/** Which lanes the export will actually render. */
export function exportedTracks(tracks: readonly ExportTrack[], includeMuted = false): ExportTrack[] {
  const soloMode = anySoloed(tracks.map(asLane));
  return tracks.filter((t) => includeMuted || audible(asLane(t), soloMode));
}

/** Lanes in the song that the zip will not contain, and why. Nothing goes missing quietly. */
export function heldBackTracks(tracks: readonly ExportTrack[], includeMuted = false): { track: ExportTrack; reason: string }[] {
  if (includeMuted) return [];
  const soloMode = anySoloed(tracks.map(asLane));
  return tracks
    .filter((t) => !audible(asLane(t), soloMode))
    .map((track) => ({ track, reason: track.muted ? "muted" : "not soloed" }));
}

export function estimateBytes(
  trackCount: number,
  lengthS: number,
  sampleRate: number,
  bitDepth: number,
  format: ExportFormat,
): number {
  const bytesPerSample = bitDepth === 16 ? 2 : 3;
  const pcm = Math.max(0, trackCount) * Math.max(0, lengthS) * sampleRate * EXPORT_CHANNELS * bytesPerSample;
  return Math.round(pcm * FORMAT_RATIO[format]);
}

/**
 * What the panel shows before the producer commits to a render, including the
 * one reason the export cannot run at all. The arithmetic is the same as
 * `bundle.py`, so the browser and the job agree about what is too big.
 */
export function estimateExport(request: ExportSongRequest): ExportEstimate {
  const includeMuted = request.include_muted === true;
  const tracks = exportedTracks(request.song.tracks, includeMuted);
  const regions = tracks.reduce((n, t) => n + t.regions.length, 0);
  const lengthS = songLengthS(request.song.tracks);
  const bytes = estimateBytes(
    tracks.length,
    lengthS,
    request.sample_rate ?? DEFAULT_EXPORT_SAMPLE_RATE,
    request.bit_depth ?? DEFAULT_EXPORT_BIT_DEPTH,
    request.format ?? DEFAULT_EXPORT_FORMAT,
  );
  const allRegions = request.song.tracks.reduce((n, t) => n + t.regions.length, 0);
  let blocked: string | null = null;
  if (request.song.tracks.length === 0 || allRegions === 0) blocked = "There is nothing on the timeline to export yet.";
  else if (tracks.length === 0) blocked = "Every lane is muted, so there is nothing to export.";
  else if (request.song.tracks.length > EXPORT_MAX_TRACKS) blocked = `The export takes at most ${EXPORT_MAX_TRACKS} lanes; this song has ${request.song.tracks.length}.`;
  else if (lengthS > EXPORT_MAX_LENGTH_S) blocked = `The export takes at most ${EXPORT_MAX_LENGTH_S / 60} minutes; this song is ${(lengthS / 60).toFixed(1)}.`;
  else if (bytes > EXPORT_CAP_BYTES) blocked = `This export would be about ${formatBytes(bytes)}; the cap is ${formatBytes(EXPORT_CAP_BYTES)}. ${capAdvice(request.format ?? DEFAULT_EXPORT_FORMAT, request.bit_depth ?? DEFAULT_EXPORT_BIT_DEPTH)}`;
  return { tracks: tracks.length, regions, length_s: lengthS, bytes, over_cap: bytes > EXPORT_CAP_BYTES, blocked };
}

export function capAdvice(format: ExportFormat, bitDepth: number): string {
  const options: string[] = [];
  if (format !== "flac") options.push("export as FLAC (about 40% smaller, and lossless)");
  if (bitDepth > 16) options.push("drop to 16-bit");
  options.push("mute the lanes you do not need yet, or export a shorter section");
  return `Try: ${options.join("; ")}.`;
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round(n)} B`;
}

/** `Midnight-Flip_92bpm_Fm` — the folder everything unzips into. Mirrors `naming.py`. */
export function exportFolderName(song: Pick<ExportSong, "name" | "bpm" | "key">): string {
  const parts = [safeToken(song.name, "song")];
  if (song.bpm && song.bpm > 0) parts.push(bpmToken(song.bpm));
  if (song.key) parts.push(keyToken(song.key.tonic, song.key.mode));
  return parts.join("_");
}

export function exportZipName(song: Pick<ExportSong, "name" | "bpm" | "key">): string {
  return `${exportFolderName(song)}_stems.zip`;
}

export function bpmToken(bpm: number): string {
  const rounded = Math.round(bpm);
  return Math.abs(bpm - rounded) <= 0.05 ? `${rounded}bpm` : `${bpm.toFixed(1)}bpm`;
}

export function safeToken(name: string, fallback = "track"): string {
  const collapsed = String(name ?? "")
    .replace(/[\\/]+/g, "-")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._#-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return collapsed.slice(0, 60).replace(/[-._]+$/, "") || fallback;
}

/** The request body for `POST /api/export/song`. */
export function buildExportRequest(arrangement: ArrangementLike, options: ExportOptions = {}): ExportSongRequest {
  const tracks = tracksToWire(arrangement);
  const song: ExportSong = {
    name: (options.name ?? "").trim() || "Untitled song",
    bpm: options.bpm ?? null,
    beats_per_bar: options.beatsPerBar && options.beatsPerBar > 0 ? options.beatsPerBar : 4,
    key: songKeyOf(exportedTracks(tracks, options.includeMuted === true), options.keyOf),
    master_gain: Number.isFinite(options.masterGain ?? 1) ? (options.masterGain ?? 1) : 1,
    tracks,
  };
  return {
    song,
    format: options.format ?? DEFAULT_EXPORT_FORMAT,
    bit_depth: options.bitDepth ?? DEFAULT_EXPORT_BIT_DEPTH,
    sample_rate: DEFAULT_EXPORT_SAMPLE_RATE,
    include_muted: options.includeMuted === true,
    midi_ids: options.midiIds ?? [],
  };
}

/** Every library file the song references, so the route can resolve them under RLS. */
export function referencedFileIds(song: ExportSong): string[] {
  const seen = new Set<string>();
  for (const track of song.tracks) for (const region of track.regions) seen.add(region.file_id);
  return [...seen];
}
