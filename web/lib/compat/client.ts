// Browser client for POST /api/compat ("what in my crate works with this?"),
// with the request and response shapes both sides import. Same fetch conventions
// as lib/api/client.ts: JSON in and out, errors as { error } -> ApiError.

import { ApiError } from "@/lib/api/client";
import type { FileKind, FileRow } from "@/lib/types/db";
import type { CompatMatch } from "./matches";
import type { Mode } from "./theory";

export type { CompatMatch };

export interface CompatRequest {
  file_id: string;
  limit?: number;
  /** widest stretch offered, as max(r, 1/r) - 1: 0.06 transparent, 0.14 usable */
  stretch_tolerance?: number;
  /** how far the caller will pitch a file to make it fit */
  max_semitones?: number;
  /** halvings or doublings the fold may use; 1 is half-time and double-time */
  max_octaves?: number;
  kind?: FileKind | null;
  /** keyless material (a drum break) fits anything harmonically; false hides it */
  include_keyless?: boolean;
}

/** The open file's own vitals, so the panel can say what it is matching against. */
export interface CompatSource {
  file_id: string;
  name: string;
  bpm: number | null;
  bpm_confidence: number | null;
  tonic: string | null;
  mode: Mode | null;
  key_confidence: number | null;
}

export interface CompatResponse {
  source: CompatSource;
  matches: CompatMatch[];
  /** how many rows the database filter handed over before scoring */
  considered: number;
  /** why the answer is thin, when it is: no analysis yet, no embeddings, nothing in range */
  note: string | null;
  method: string;
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

export const compatApi = {
  find: (body: CompatRequest) => request<CompatResponse>("/api/compat", { method: "POST", body: JSON.stringify(body) }),
};

export type { FileRow };
