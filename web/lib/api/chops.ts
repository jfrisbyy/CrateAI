// Chops API (browser side) and the response shapes its routes return.

import type { JobResponse } from "./types";
import { apiFetch, type DerivedFileSummary } from "./stems";
import type { ChopRow } from "@/lib/types/db";

export type ChopMode = "transients" | "grid" | "manual";

export const CHOP_MODES: ReadonlyArray<{ id: ChopMode; label: string; describe: string }> = [
  { id: "transients", label: "Transients", describe: "Slice at onsets, strongest first, at least the minimum gap apart." },
  { id: "grid", label: "Grid", describe: "Equal slices per bar across a bar range, following the beat grid." },
  { id: "manual", label: "Manual", describe: "Slice at markers you place; each chop runs to the next marker." },
];

/** Defaults mirror analysis/lockedgroove/jobs/chop.py and chops/chop.py. */
export const CHOP_DEFAULTS = { count: 16, min_gap_ms: 40, divisions: 4, bars: 4 } as const;
export const CHOP_LIMITS = { count: 128, min_gap_ms: 2000, divisions: 64, markers: 256 } as const;

/** Bars are 0-based here, as compute expects; the tab shows them 1-based. */
export type ChopRequest =
  | { mode: "transients"; count: number; min_gap_ms: number }
  | { mode: "grid"; start_bar: number; end_bar: number; divisions: number }
  | { mode: "manual"; markers_s: number[] };

export interface ChopWithFile extends ChopRow {
  file: DerivedFileSummary | null;
}

export interface ChopsListResponse {
  chops: ChopWithFile[];
}

export interface ChopResponse {
  chop: ChopRow;
}

export interface ChopRenameRequest {
  name: string | null;
}

export function bundlePath(fileId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}/bundle`;
}

export const chopsApi = {
  list: (fileId: string) => apiFetch<ChopsListResponse>(`/api/files/${encodeURIComponent(fileId)}/chops`),
  chop: (fileId: string, body: ChopRequest) =>
    apiFetch<JobResponse>(`/api/files/${encodeURIComponent(fileId)}/chops`, { method: "POST", body: JSON.stringify(body) }),
  rename: (fileId: string, chopId: string, body: ChopRenameRequest) =>
    apiFetch<ChopResponse>(`/api/files/${encodeURIComponent(fileId)}/chops/${encodeURIComponent(chopId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /** The kit zip as a Blob; `{ error }` bodies (413 over the cap, 409 nothing to bundle) are thrown. */
  bundle: async (fileId: string): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch(bundlePath(fileId), { credentials: "same-origin" });
    if (!res.ok) {
      const text = await res.text();
      let message = `${res.status} ${res.statusText}`;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        // not JSON; keep the status line
      }
      throw new Error(message);
    }
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = /filename="([^"]+)"/.exec(disposition);
    return { blob: await res.blob(), filename: match?.[1] ?? "kit.zip" };
  },
};
