// The browser's side of the export: queue one, then watch it.
//
// Deliberately its own small client rather than a line in `lib/api/client.ts`,
// which belongs to another seam. Same conventions: JSON in and out, an
// `{ error }` body thrown with its status.

import type { JobResponse } from "@/lib/api/types";
import type { JobRow } from "@/lib/types/db";
import type { ExportJobResult, ExportSongRequest } from "./types";

export class ExportRequestError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "ExportRequestError";
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    throw new ExportRequestError(res.status, err?.error ?? `${res.status} ${res.statusText}`, err?.details);
  }
  return body as T;
}

export function queueExport(request: ExportSongRequest): Promise<JobResponse> {
  return call<JobResponse>("/api/export/song", { method: "POST", body: JSON.stringify(request) });
}

export function readExportJob(jobId: string): Promise<JobResponse> {
  return call<JobResponse>(`/api/jobs/${jobId}`);
}

/** The zip is fetched with the caller's own session; this is just where it lives. */
export function exportDownloadHref(jobId: string): string {
  return `/api/export/${jobId}/download`;
}

export function exportResultOf(job: JobRow | null | undefined): ExportJobResult | null {
  const raw = job?.result;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const result = raw as Partial<ExportJobResult>;
  return typeof result.storage_path === "string" && typeof result.filename === "string" ? (result as ExportJobResult) : null;
}
