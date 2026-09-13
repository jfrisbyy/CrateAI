// Browser client for the Layers routes (app/api/layers/**), with the request
// and response shapes both sides import. Same fetch conventions as
// lib/api/client.ts: JSON in and out, errors as { error } -> ApiError.

import { ApiError } from "./client";
import type { DispatchInfo, JobResponse } from "./types";
import type { FileKind, FileStatus, JobRow, LayerItemRow, LayerRow } from "@/lib/types/db";

export type LayerKey = { tonic: string; mode: "major" | "minor" };
export type StretchMode = LayerItemRow["stretch_mode"];
export type LaneFilter = { highpass_hz?: number | null; lowpass_hz?: number | null };

/** What a lane shows about its file, from the file's effective report (computed in the route). */
export interface LaneFileVitals {
  file_id: string;
  name: string;
  kind: FileKind;
  status: FileStatus;
  duration_s: number | null;
  bpm: number | null;
  bpm_confidence: number | null;
  key: LayerKey | null;
  key_confidence: number | null;
  first_downbeat_s: number | null;
  /** false for drums and other non-tonal material: the compute applies no pitch shift to it */
  tonal: boolean;
}

export interface LayerSummary {
  layer: LayerRow;
  items: LayerItemRow[];
}

export interface LayersListResponse {
  layers: LayerSummary[];
}

export interface LayerResponse {
  layer: LayerRow;
  items: LayerItemRow[];
  files: LaneFileVitals[];
}

export interface LayerItemResponse {
  item: LayerItemRow;
}

export interface LayerCreateRequest {
  name?: string | null;
  file_ids: string[];
}

export interface LayerPatchRequest {
  name?: string | null;
  tempo_bpm?: number | null;
  key?: LayerKey | null;
}

export interface LayerItemCreateRequest {
  file_id: string;
}

export interface LayerItemPatchRequest {
  offset_s?: number;
  gain_db?: number;
  stretch_ratio?: number;
  pitch_semitones?: number;
  muted?: boolean;
  stretch_mode?: StretchMode;
  filter?: LaneFilter | null;
  position?: number;
}

/** analysis/lockedgroove/combine/align.py AlignPlan.to_json() */
export interface PlanItem {
  file_id: string;
  stretch_ratio: number;
  pitch_semitones: number;
  offset_s: number;
  reason: string;
}

export interface AlignPlan {
  target_bpm: number;
  target_key: LayerKey | null;
  items: PlanItem[];
}

/** jobs.result of a `layer` job (analysis/lockedgroove/jobs/layer.py). */
export interface LayerJobResult {
  layer_id: string;
  render_file_id: string | null;
  analyze_job_id: string | null;
  plan: AlignPlan | null;
  applied: Array<PlanItem & { item_id: string }>;
  sample_rate: number | null;
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
const patch = <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

export const layersApi = {
  list: (fileId: string) => request<LayersListResponse>(`/api/layers?file_id=${encodeURIComponent(fileId)}`),
  create: (body: LayerCreateRequest) => post<LayerResponse>("/api/layers", body),
  get: (id: string) => request<LayerResponse>(`/api/layers/${id}`),
  update: (id: string, body: LayerPatchRequest) => patch<LayerResponse>(`/api/layers/${id}`, body),
  remove: (id: string) => del<{ ok: true }>(`/api/layers/${id}`),
  addItem: (id: string, body: LayerItemCreateRequest) => post<LayerItemResponse>(`/api/layers/${id}/items`, body),
  updateItem: (id: string, itemId: string, body: LayerItemPatchRequest) => patch<LayerItemResponse>(`/api/layers/${id}/items/${itemId}`, body),
  removeItem: (id: string, itemId: string) => del<{ ok: true }>(`/api/layers/${id}/items/${itemId}`),
  render: (id: string) => post<JobResponse>(`/api/layers/${id}/render`),
};

export type { DispatchInfo };

// ---- job helpers ------------------------------------------------------------

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The layer id a `layer` job renders, or null for any other job. */
export function layerIdOf(job: JobRow): string | null {
  if (job.kind !== "layer") return null;
  const id = record(job.params)?.layer_id;
  return typeof id === "string" ? id : null;
}

function planItem(v: unknown): PlanItem | null {
  const r = record(v);
  if (!r || typeof r.file_id !== "string") return null;
  return {
    file_id: r.file_id,
    stretch_ratio: typeof r.stretch_ratio === "number" ? r.stretch_ratio : 1,
    pitch_semitones: typeof r.pitch_semitones === "number" ? r.pitch_semitones : 0,
    offset_s: typeof r.offset_s === "number" ? r.offset_s : 0,
    reason: typeof r.reason === "string" ? r.reason : "",
  };
}

function keyOf(v: unknown): LayerKey | null {
  const r = record(v);
  if (!r || typeof r.tonic !== "string") return null;
  return { tonic: r.tonic, mode: r.mode === "major" ? "major" : "minor" };
}

/** Parse a done `layer` job's result; null when the job is not done or the shape is unknown. */
export function layerJobResult(job: JobRow | undefined | null): LayerJobResult | null {
  if (!job || job.status !== "done") return null;
  const r = record(job.result);
  if (!r || typeof r.layer_id !== "string") return null;
  const plan = record(r.plan);
  const applied: LayerJobResult["applied"] = [];
  if (Array.isArray(r.applied)) {
    for (const a of r.applied) {
      const item = planItem(a);
      const itemId = record(a)?.item_id;
      if (item && typeof itemId === "string") applied.push({ ...item, item_id: itemId });
    }
  }
  return {
    layer_id: r.layer_id,
    render_file_id: typeof r.render_file_id === "string" ? r.render_file_id : null,
    analyze_job_id: typeof r.analyze_job_id === "string" ? r.analyze_job_id : null,
    plan: plan && typeof plan.target_bpm === "number"
      ? {
          target_bpm: plan.target_bpm,
          target_key: keyOf(plan.target_key),
          items: Array.isArray(plan.items) ? plan.items.map(planItem).filter((x): x is PlanItem => x !== null) : [],
        }
      : null,
    applied,
    sample_rate: typeof r.sample_rate === "number" ? r.sample_rate : null,
  };
}

/** Items still at their defaults receive the compute's alignment plan at render time (jobs/layer.py). */
export function itemAtDefaults(item: Pick<LayerItemRow, "stretch_ratio" | "pitch_semitones" | "offset_s">): boolean {
  return item.stretch_ratio === 1 && item.pitch_semitones === 0 && item.offset_s === 0;
}
