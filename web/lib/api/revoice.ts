// Browser client for the Re-voice routes (app/api/revoices/**,
// app/api/files/[id]/revoices) and the instrument list the tab offers.
// Same fetch conventions as lib/api/client.ts.

import { ApiError } from "./client";
import type { JobResponse } from "./types";
import type { FileRow, JobRow, MidiRow, RevoiceRow } from "@/lib/types/db";

/**
 * Mirrors INSTRUMENTS in analysis/lockedgroove/revoice/symbolic.py (id -> GM
 * program + label). Keep the two lists in step: the revoice job refuses an
 * id it does not know.
 */
export const INSTRUMENTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "upright_piano", label: "Upright piano" },
  { id: "rhodes", label: "Rhodes electric piano" },
  { id: "wurlitzer", label: "Wurlitzer" },
  { id: "organ", label: "Drawbar organ" },
  { id: "acoustic_guitar", label: "Acoustic guitar (steel)" },
  { id: "nylon_guitar", label: "Acoustic guitar (nylon)" },
  { id: "electric_guitar", label: "Electric guitar (clean)" },
  { id: "upright_bass", label: "Upright bass" },
  { id: "electric_bass", label: "Electric bass (finger)" },
  { id: "strings", label: "String ensemble" },
  { id: "brass", label: "Brass section" },
  { id: "trumpet", label: "Trumpet" },
  { id: "saxophone", label: "Tenor sax" },
  { id: "flute", label: "Flute" },
  { id: "vibraphone", label: "Vibraphone" },
  { id: "synth_lead", label: "Synth lead (square)" },
  { id: "synth_pad", label: "Synth pad (warm)" },
  { id: "choir", label: "Choir aahs" },
];

export const INSTRUMENT_IDS: readonly string[] = INSTRUMENTS.map((i) => i.id);
export const DEFAULT_INSTRUMENT = "acoustic_guitar";

export function instrumentLabel(id: string): string {
  return INSTRUMENTS.find((i) => i.id === id)?.label ?? id;
}

/** analysis/lockedgroove/revoice/neural.py REASON: what the compute answers for path "neural". */
export const NEURAL_REASON =
  "neural re-voice is not shipped: the DDSP and RAVE candidates are evaluated in Phase 7 and recorded in docs/PROPOSALS.md; use path='symbolic' (returns editable MIDI)";

/** BUILD_PACKET section 10, the accuracy note, shown once in the tab. */
export const ACCURACY_NOTE =
  "The symbolic path is only as good as the transcription: polyphonic sources will have wrong or missing notes. Fix the notes in the roll and re-render.";

export type RevoicePath = RevoiceRow["path"];

/** One note as the compute stores it and reads it back (chops/midi.py NoteEvent.to_json). */
export interface RevoiceNote {
  pitch: number;
  start_s: number;
  end_s: number;
  velocity: number;
}

export type RenderFileLite = Pick<FileRow, "id" | "original_filename" | "status" | "duration_s" | "kind">;

export interface RevoiceDetail {
  revoice: RevoiceRow;
  midi: MidiRow | null;
  render: RenderFileLite | null;
}

export interface RevoicesListResponse {
  revoices: RevoiceDetail[];
}

export interface RevoiceResponse {
  revoice: RevoiceRow;
  midi: MidiRow | null;
  render: RenderFileLite | null;
}

export interface RevoiceCreateRequest {
  file_id: string;
  instrument: string;
  path: RevoicePath;
  keep_groove?: boolean;
  /** edited notes: the compute renders these without re-transcribing */
  notes?: RevoiceNote[];
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    credentials: "same-origin",
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const err = body as { error?: string; details?: unknown } | null;
    throw new ApiError(res.status, err?.error ?? `${res.status} ${res.statusText}`, err?.details);
  }
  return body as T;
}

export const revoiceApi = {
  list: (fileId: string) => request<RevoicesListResponse>(`/api/files/${fileId}/revoices`),
  get: (id: string) => request<RevoiceResponse>(`/api/revoices/${id}`),
  create: (body: RevoiceCreateRequest) => request<JobResponse>("/api/revoices", { method: "POST", body: JSON.stringify(body) }),
};

// ---- notes JSON helpers ---------------------------------------------------------

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The notes list and tempo inside a midi row's notes JSON ({ notes: [...], meta, bpm }). */
export function midiNotesOf(midi: MidiRow | null | undefined): { notes: unknown[]; bpm: number | null; meta: Record<string, unknown> | null } {
  const r = record(midi?.notes);
  if (!r) return { notes: [], bpm: null, meta: null };
  return {
    notes: Array.isArray(r.notes) ? r.notes : [],
    bpm: typeof r.bpm === "number" && r.bpm > 0 ? r.bpm : null,
    meta: record(r.meta),
  };
}

/** The compute's notes about a render (revoices.params.notes: renderer quality, transcription caveat). */
export function revoiceNotesOf(revoice: RevoiceRow): string[] {
  const r = record(revoice.params);
  if (!r || !Array.isArray(r.notes)) return [];
  return r.notes.filter((n): n is string => typeof n === "string");
}

export function revoiceKeepGroove(revoice: RevoiceRow): boolean {
  return record(revoice.params)?.keep_groove === true;
}

export function isRevoiceJobFor(job: JobRow, fileId: string): boolean {
  return job.kind === "revoice" && job.file_id === fileId;
}

/** The revoice id a done `revoice` job wrote, from jobs.result. */
export function revoiceIdOf(job: JobRow): string | null {
  const id = record(job.result)?.revoice_id;
  return typeof id === "string" ? id : null;
}
