// Stems API (browser side) and the response shapes its routes return.
// Same fetch conventions as lib/api/client.ts; `apiFetch` is shared by the
// chops and midi modules until client.ts exports its own `call`.

import { ApiError } from "./client";
import type { JobResponse } from "./types";
import { effective } from "@/lib/report/effective";
import type { FileKind, FileRow, FileStatus, StemRow } from "@/lib/types/db";
import type { AnalysisReport, Mode } from "@/lib/types/report";

export type StemModelId = "htdemucs_ft" | "htdemucs_6s" | "bs_roformer";

export interface StemModel {
  id: StemModelId;
  stems: readonly string[];
  /** one line, shown under the select */
  describe: string;
}

/** analysis/lockedgroove/stems/separate.py: MODELS, in the order the tab offers them. */
export const STEM_MODELS: ReadonlyArray<StemModel> = [
  {
    id: "htdemucs_ft",
    stems: ["drums", "bass", "vocals", "other"],
    describe: "Demucs v4, fine-tuned. Drums, bass, vocals and other; the default and the best all-round split.",
  },
  {
    id: "htdemucs_6s",
    stems: ["drums", "bass", "vocals", "other", "guitar", "piano"],
    describe: "Demucs v4, six stems. Adds guitar and piano; slightly less clean on the other four.",
  },
  {
    id: "bs_roformer",
    stems: ["vocals", "instrumental"],
    describe: "BS-RoFormer. Vocals and instrumental only, with the cleanest vocal of the three.",
  },
];

export const DEFAULT_STEM_MODEL: StemModelId = "htdemucs_ft";
export const STEM_MODEL_IDS = STEM_MODELS.map((m) => m.id) as [StemModelId, ...StemModelId[]];

/** Display order of stem names inside one model's group (and on the pads). */
export const STEM_ORDER: readonly string[] = ["drums", "bass", "vocals", "other", "guitar", "piano", "instrumental"];

export function stemOrderIndex(stem: string): number {
  const i = STEM_ORDER.indexOf(stem);
  return i < 0 ? STEM_ORDER.length : i;
}

/** The development stand-in labels its rows `<model>-fake` (jobs/stems.py). */
export function isStandInModel(model: string): boolean {
  return model.endsWith("-fake");
}

export function baseModelOf(model: string): string {
  return model.replace(/-fake$/, "");
}

export interface FileVitals {
  bpm: number | null;
  bpm_confidence: number | null;
  key: { tonic: string; mode: Mode } | null;
  key_confidence: number | null;
}

/** The subset of a derived file's row the lists need (the report itself stays server-side). */
export interface DerivedFileSummary {
  id: string;
  kind: FileKind;
  status: FileStatus;
  duration_s: number | null;
  original_filename: string;
  vitals: FileVitals | null;
}

export interface StemWithFile extends StemRow {
  file: DerivedFileSummary | null;
}

export interface StemsListResponse {
  stems: StemWithFile[];
}

export interface SeparateRequest {
  model: StemModelId;
}

/** BPM and key with their confidence, read from the effective report. */
export function vitalsOf(report: AnalysisReport | null | undefined): FileVitals | null {
  if (!report) return null;
  const eff = effective(report);
  return {
    bpm: eff.tempo?.bpm ?? null,
    bpm_confidence: eff.tempo?.confidence ?? null,
    key: eff.key ? { tonic: eff.key.tonic, mode: eff.key.mode } : null,
    key_confidence: eff.key?.confidence ?? null,
  };
}

export function summarizeFile(file: Pick<FileRow, "id" | "kind" | "status" | "duration_s" | "original_filename" | "report">): DerivedFileSummary {
  return {
    id: file.id,
    kind: file.kind,
    status: file.status,
    duration_s: file.duration_s,
    original_filename: file.original_filename,
    vitals: vitalsOf(file.report),
  };
}

/** One fetch, JSON in and out, `{ error }` bodies thrown as ApiError (lib/api/client.ts conventions). */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
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

export const stemsApi = {
  list: (fileId: string) => apiFetch<StemsListResponse>(`/api/files/${encodeURIComponent(fileId)}/stems`),
  separate: (fileId: string, body: SeparateRequest) =>
    apiFetch<JobResponse>(`/api/files/${encodeURIComponent(fileId)}/stems`, { method: "POST", body: JSON.stringify(body) }),
};
