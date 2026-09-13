// Browser-side client for the breakdown routes (docs/CONTRACTS.md section 7):
//   GET  /api/breakdowns/[fileId]?all=1      the latest breakdown (or every version), pending jobs, the stems map
//   POST /api/breakdowns/[fileId]            queue a new breakdown version
//   POST /api/breakdowns/[fileId]/narrate    stream the narration (newline-delimited JSON events)
// Same conventions as lib/api/client.ts; errors are ApiError.

import { jobLabel, jobRequest, type StemLink } from "@/lib/narration/jobs";
import { NarrationEventParser, type NarrationWireEvent } from "@/lib/narration/stream";
import type { BreakdownRow, JobRow, Json } from "@/lib/types/db";
import { ApiError } from "./client";
import type { JobResponse } from "./types";

export interface BreakdownGetResponse {
  /** the latest version, or null when the breakdown has not run */
  breakdown: BreakdownRow | null;
  /** every version, newest first, when `all` was asked for; otherwise the latest alone */
  breakdowns: BreakdownRow[];
  /** queued or running breakdown, stems and analyze jobs on the file and its stems */
  jobs: JobRow[];
  /** stem name -> the stem's file id (the latest separation) */
  stems: StemLink[];
}

export interface BreakdownRunRequest {
  web_context?: Json;
}

export interface NarrateRequest {
  version?: number;
}

export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
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

export const breakdownApi = {
  get: (fileId: string, opts: { all?: boolean } = {}) =>
    requestJson<BreakdownGetResponse>(`/api/breakdowns/${encodeURIComponent(fileId)}${opts.all ? "?all=1" : ""}`),
  run: (fileId: string, body: BreakdownRunRequest = {}) =>
    requestJson<JobResponse>(`/api/breakdowns/${encodeURIComponent(fileId)}`, { method: "POST", body: JSON.stringify(body) }),
  /** Returns the raw streaming response; read it with `readNarrationStream`. */
  narrate: (fileId: string, body: NarrateRequest = {}, signal?: AbortSignal) =>
    fetch(`/api/breakdowns/${encodeURIComponent(fileId)}/narrate`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      signal,
    }),
};

/** Read a narration response to the end, handing each event to `onEvent` as it lands. */
export async function readNarrationStream(res: Response, onEvent: (event: NarrationWireEvent) => void): Promise<void> {
  if (!res.ok) {
    const text = await res.text();
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = JSON.parse(text) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // not JSON; keep the status line
    }
    throw new ApiError(res.status, message);
  }
  if (!res.body) throw new ApiError(res.status, "The narration stream was empty.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new NarrationEventParser();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const event of parser.push(decoder.decode(value, { stream: true }))) onEvent(event);
  }
  for (const event of parser.push(decoder.decode())) onEvent(event);
  for (const event of parser.flush()) onEvent(event);
}

/** The POST /api/jobs body for a missing entry's job (see lib/narration/jobs.ts). */
export const missingJobRequest = jobRequest;
export const missingJobLabel = jobLabel;
export type { StemLink };
