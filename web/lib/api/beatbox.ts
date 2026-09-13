// Browser client for the Beatbox routes (app/api/beatbox/**): the profile,
// signed uploads for recordings, enrollment, transcription, corrections.
// Same fetch conventions as lib/api/client.ts.

import { ApiError } from "./client";
import type { JobResponse } from "./types";
import type { BeatboxCorrection } from "@/lib/beatbox/stepview";
import { AUDIO_BUCKET } from "@/lib/storage/paths";
import { createClient } from "@/lib/supabase/client";
import type { BeatboxProfileRow, JobRow, MidiRow } from "@/lib/types/db";

/** OPEN_QUESTIONS I.30: kick, snare, hat at enrollment; the class list is stored per profile. */
export const DEFAULT_CLASSES: readonly string[] = ["kick", "snare", "hat"];
export const TARGET_HITS_PER_CLASS = 20;
/** analysis/lockedgroove/beatbox/train.py MIN_ACCURACY */
export const MIN_ACCURACY = 0.85;

export interface ProfileResponse {
  profile: BeatboxProfileRow | null;
}

export interface UploadUrlRequest {
  name: string;
}

export interface UploadUrlResponse {
  storage_path: string;
  signed_url: string;
  token: string;
}

export interface TrainRequest {
  examples: Array<{ class: string; storage_path: string }>;
}

export interface TranscribeRequest {
  recording_path: string;
  grid_file_id?: string;
  bpm?: number;
}

export interface Transcription {
  midi: MidiRow;
  /** signed URL for the .mid (10 minutes), null when signing failed */
  download_url: string | null;
}

export interface TranscriptionsResponse {
  transcriptions: Transcription[];
}

export interface CorrectionsRequest {
  corrections: BeatboxCorrection[];
}

export interface TranscriptionResponse {
  midi: MidiRow;
}

/** jobs.result of a `beatbox_train` job (analysis/lockedgroove/jobs/beatbox_train.py). */
export interface TrainResult {
  cv_accuracy: number;
  enabled: boolean;
  message: string;
  sample_count: number;
  per_class_counts: Record<string, number>;
  classes: string[];
  profile_id?: string;
}

/** jobs.result of a `beatbox_transcribe` job. */
export interface TranscribeResult {
  midi_id: string;
  hit_count: number;
  storage_path: string;
  classes: string[];
  bpm: number | null;
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

const post = <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const beatboxApi = {
  profile: () => request<ProfileResponse>("/api/beatbox/profile"),
  uploadUrl: (body: UploadUrlRequest) => post<UploadUrlResponse>("/api/beatbox/upload-url", body),
  train: (body: TrainRequest) => post<JobResponse>("/api/beatbox/train", body),
  transcribe: (body: TranscribeRequest) => post<JobResponse>("/api/beatbox/transcribe", body),
  transcriptions: () => request<TranscriptionsResponse>("/api/beatbox/transcriptions"),
  saveCorrections: (midiId: string, corrections: BeatboxCorrection[]) =>
    request<TranscriptionResponse>(`/api/beatbox/transcriptions/${midiId}`, { method: "PATCH", body: JSON.stringify({ corrections }) }),
  /**
   * Upload a recording to Storage with the signed upload URL from
   * `uploadUrl`; the token authorizes exactly that object, no session needed.
   */
  uploadToSigned: async (target: UploadUrlResponse, blob: Blob): Promise<void> => {
    const contentType = blob.type || "application/octet-stream";
    const { error } = await createClient().storage.from(AUDIO_BUCKET).uploadToSignedUrl(target.storage_path, target.token, blob, { contentType, upsert: false });
    if (error) throw new ApiError(500, `Upload failed: ${error.message}`);
  },
};

// ---- job helpers ------------------------------------------------------------

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function trainResultOf(job: JobRow | null | undefined): TrainResult | null {
  if (!job || job.status !== "done") return null;
  const r = record(job.result);
  if (!r || typeof r.cv_accuracy !== "number") return null;
  const counts: Record<string, number> = {};
  const rawCounts = record(r.per_class_counts);
  if (rawCounts) for (const [k, v] of Object.entries(rawCounts)) if (typeof v === "number") counts[k] = v;
  return {
    cv_accuracy: r.cv_accuracy,
    enabled: r.enabled === true,
    message: typeof r.message === "string" ? r.message : "",
    sample_count: typeof r.sample_count === "number" ? r.sample_count : 0,
    per_class_counts: counts,
    classes: Array.isArray(r.classes) ? r.classes.filter((c): c is string => typeof c === "string") : [],
    profile_id: typeof r.profile_id === "string" ? r.profile_id : undefined,
  };
}

export function transcribeResultOf(job: JobRow | null | undefined): TranscribeResult | null {
  if (!job || job.status !== "done") return null;
  const r = record(job.result);
  if (!r || typeof r.midi_id !== "string") return null;
  return {
    midi_id: r.midi_id,
    hit_count: typeof r.hit_count === "number" ? r.hit_count : 0,
    storage_path: typeof r.storage_path === "string" ? r.storage_path : "",
    classes: Array.isArray(r.classes) ? r.classes.filter((c): c is string => typeof c === "string") : [],
    bpm: typeof r.bpm === "number" ? r.bpm : null,
  };
}

/** The tempo and grid source a transcription was made against (notes JSON: bpm, grid_file_id). */
export function transcriptionMetaOf(midi: MidiRow): { bpm: number | null; grid_file_id: string | null } {
  const r = record(midi.notes);
  return {
    bpm: typeof r?.bpm === "number" ? r.bpm : null,
    grid_file_id: typeof r?.grid_file_id === "string" ? r.grid_file_id : null,
  };
}
