// MIDI API (browser side): extraction jobs, the list with download links,
// pads recordings saved as .mid, and the response shapes its routes return.

import type { JobResponse } from "./types";
import { apiFetch } from "./stems";
import type { MidiRow } from "@/lib/types/db";

export type MidiExtractKind = "melody" | "drums" | "chords" | "groove";

/** The compute `midi` job kinds (analysis/lockedgroove/jobs/midi.py). */
export const MIDI_EXTRACT_KINDS: ReadonlyArray<{ id: MidiExtractKind; label: string; describe: string }> = [
  { id: "melody", label: "Melody", describe: "Basic Pitch on the file (or its stem); notes you can fix." },
  { id: "drums", label: "Drums", describe: "Classified hits at their measured times; the offsets survive." },
  { id: "chords", label: "Chords", describe: "The chord segments as block chords." },
  { id: "groove", label: "Groove", describe: "A one-bar template of the measured swing and offsets." },
];

export const MIDI_EXTRACT_KIND_IDS = MIDI_EXTRACT_KINDS.map((k) => k.id) as [MidiExtractKind, ...MidiExtractKind[]];

export interface MidiWithUrl extends MidiRow {
  /** signed, 10 minutes; null when signing failed for that row */
  download_url: string | null;
  filename: string;
}

export interface MidiListResponse {
  midi: MidiWithUrl[];
}

export interface MidiExtractRequest {
  kind: MidiExtractKind;
}

/** One pad hit as recorded; `pad` is 0-based (pitch = 36 + pad), `time_s` from the record start. */
export interface PadHitInput {
  time_s: number;
  pad: number;
  chop_file_id: string | null;
  velocity: number;
}

export interface PadsMidiRequest {
  file_id: string;
  bpm: number;
  bars: number;
  beats_per_bar?: number;
  hits: PadHitInput[];
}

export interface PadsMidiResponse {
  midi: MidiWithUrl;
}

export interface MidiDownloadResponse {
  url: string;
  expires_in: number;
  filename: string;
}

export const midiApi = {
  list: (fileId: string) => apiFetch<MidiListResponse>(`/api/files/${encodeURIComponent(fileId)}/midi`),
  extract: (fileId: string, body: MidiExtractRequest) =>
    apiFetch<JobResponse>(`/api/files/${encodeURIComponent(fileId)}/midi`, { method: "POST", body: JSON.stringify(body) }),
  savePads: (body: PadsMidiRequest) => apiFetch<PadsMidiResponse>("/api/midi/pads", { method: "POST", body: JSON.stringify(body) }),
  download: (midiId: string) => apiFetch<MidiDownloadResponse>(`/api/midi/${encodeURIComponent(midiId)}/download`),
};
