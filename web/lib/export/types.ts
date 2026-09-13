// The export's wire shapes: what the browser posts, what compute writes back.
//
// The song is not persisted yet (docs/HANDOFF_timeline.md section 8: the
// migration is written and nothing reads or writes those tables), so the
// arrangement travels in the request body and lands in `jobs.params.song`.
// Every field here is snake_case because it is the other side of
// `analysis/lockedgroove/export/song.py`; the one mapping from the session's
// camelCase types happens in `request.ts` and nowhere else.
//
// When `song_sessions` does land, the route grows a `{ session_id }` form that
// loads the same shape out of the tables. Nothing below has to change.

export const EXPORT_FORMATS = ["flac", "wav"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const EXPORT_BIT_DEPTHS = [16, 24] as const;
export type ExportBitDepth = (typeof EXPORT_BIT_DEPTHS)[number];
export const EXPORT_SAMPLE_RATES = [44100, 48000] as const;
export type ExportSampleRate = (typeof EXPORT_SAMPLE_RATES)[number];

export const DEFAULT_EXPORT_FORMAT: ExportFormat = "flac";
export const DEFAULT_EXPORT_BIT_DEPTH: ExportBitDepth = 24;
export const DEFAULT_EXPORT_SAMPLE_RATE: ExportSampleRate = 44100;

/** Mirrors `EXPORT_CAP_BYTES` in `analysis/lockedgroove/export/bundle.py`. */
export const EXPORT_CAP_BYTES = 1024 * 1024 * 1024;
/** Mirrors `MAX_TRACKS` / `MAX_LENGTH_S` in the same file, so the panel can refuse first. */
export const EXPORT_MAX_TRACKS = 24;
export const EXPORT_MAX_LENGTH_S = 900;
/** Stems are stereo; the renderer doubles a mono source so a DAW never guesses. */
export const EXPORT_CHANNELS = 2;

/** Bytes on disk per byte of PCM. Pessimistic for FLAC on purpose: a cap should under-promise. */
export const FORMAT_RATIO: Record<ExportFormat, number> = { flac: 0.62, wav: 1 };

export interface ExportLineage {
  file_id: string | null;
  file_name: string | null;
  parent_file_id: string | null;
  kind: string | null;
  stem: string | null;
  separation_model: string | null;
  separation_model_label: string | null;
  take_start_s: number | null;
  take_end_s: number | null;
  downbeat_s: number;
  source_duration_s: number | null;
  source_bpm: number | null;
  source_beats_per_bar: number;
  cents: number;
  stretch: number;
  candidate_id: string | null;
  reason: string | null;
  confidence: number | null;
}

export interface ExportSourceBars {
  from_bar: number;
  to_bar: number;
  bars: number;
}

export interface ExportRegion {
  id: string;
  file_id: string;
  start_s: number;
  duration_s: number;
  offset_s: number;
  gain: number;
  rate: number;
  /** derived by `describeLineage` in lib/session/lineage.ts — the one place that can say this */
  lineage_line: string | null;
  lineage: ExportLineage | null;
  source_bars: ExportSourceBars | null;
}

export interface ExportTrack {
  id: string;
  name: string;
  position: number;
  gain: number;
  muted: boolean;
  soloed: boolean;
  provenance: string | null;
  regions: ExportRegion[];
}

export interface ExportSongKey {
  tonic: string;
  mode: "major" | "minor";
  from_file_id: string | null;
  from_file_name: string | null;
}

export interface ExportSong {
  name: string;
  bpm: number | null;
  beats_per_bar: number;
  key: ExportSongKey | null;
  master_gain: number;
  tracks: ExportTrack[];
}

export interface ExportSongRequest {
  song: ExportSong;
  format?: ExportFormat;
  bit_depth?: ExportBitDepth;
  sample_rate?: ExportSampleRate;
  /** render lanes the producer cannot hear; off by default (see the handoff) */
  include_muted?: boolean;
  /** MIDI rows to put in the zip; the route resolves each one under RLS */
  midi_ids?: string[];
}

/** `jobs.result` of a finished `export` job. */
export interface ExportJobResult {
  storage_path: string;
  filename: string;
  folder: string;
  size_bytes: number;
  size_human: string;
  estimated_bytes: number;
  cap_bytes: number;
  format: ExportFormat;
  bit_depth: number;
  sample_rate: number;
  channels: number;
  length_s: number;
  length_samples: number;
  bpm: number | null;
  beats_per_bar: number;
  key: { tonic: string; mode: string } | null;
  tempo_map: boolean;
  stems: { position: number; track_id: string; name: string; file: string; peak_dbfs: number | null; clipped: boolean }[];
  not_exported: { name: string; reason: string }[];
  midi: { file: string; kind: string; midi_id: string }[];
  notes: string[];
}

/** What the panel shows before anything is queued. */
export interface ExportEstimate {
  tracks: number;
  regions: number;
  length_s: number;
  bytes: number;
  over_cap: boolean;
  /** why the export cannot run at all, or null when it can */
  blocked: string | null;
}
