// Browser client for the hybrid search and the embeddings status. The shell's
// search state keeps using `api.search` (lib/api/client.ts, which reads
// `files` and `parsed`); the SearchBox calls `searchLibrary` for the matched
// fields and the mode note.

import { ApiError } from "@/lib/api/client";
import type { SearchHit } from "@/lib/search/merge";
import type { ParsedQuery } from "@/lib/search/parse";
import type { SearchMode } from "@/lib/search/hybrid";
import type { FileKind, FileRow, JobRow } from "@/lib/types/db";

export interface LibrarySearchRequest {
  query: string;
  limit?: number;
  kind?: FileKind;
  current_file_id?: string | null;
}

export interface LibrarySearchResponse {
  results: SearchHit[];
  files: FileRow[];
  parsed: ParsedQuery;
  mode: SearchMode;
  note: string | null;
}

export interface EmbeddingsStatus {
  embedded_count: number;
  ready_count: number;
  missing_file_ids: string[];
}

export interface QueueEmbeddingsResponse {
  queued: JobRow[];
  skipped: number;
  dispatch_failures: number;
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

export function searchLibrary(body: LibrarySearchRequest): Promise<LibrarySearchResponse> {
  return request<LibrarySearchResponse>("/api/search", { method: "POST", body: JSON.stringify(body) });
}

export function embeddingsStatus(): Promise<EmbeddingsStatus> {
  return request<EmbeddingsStatus>("/api/embeddings");
}

export function queueEmbeddings(fileIds?: string[]): Promise<QueueEmbeddingsResponse> {
  return request<QueueEmbeddingsResponse>("/api/embeddings", { method: "POST", body: JSON.stringify(fileIds ? { file_ids: fileIds } : {}) });
}
