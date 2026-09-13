// Browser-side client for the comparison routes (docs/CONTRACTS.md section 7):
//   GET  /api/compare?a=&b=   the latest comparison for the pair (b optional: the latest for a)
//   POST /api/compare          queue a `compare` job for { file_a_id, file_b_id }

import type { ComparisonRow } from "@/lib/types/db";
import { requestJson } from "./breakdown";
import type { JobResponse } from "./types";

export interface CompareRequest {
  file_a_id: string;
  file_b_id: string;
}

export interface ComparisonGetResponse {
  comparison: ComparisonRow | null;
}

export const compareApi = {
  get: (fileAId: string, fileBId?: string) => {
    const q = new URLSearchParams({ a: fileAId });
    if (fileBId) q.set("b", fileBId);
    return requestJson<ComparisonGetResponse>(`/api/compare?${q.toString()}`);
  },
  run: (body: CompareRequest) => requestJson<JobResponse>("/api/compare", { method: "POST", body: JSON.stringify(body) }),
};

/** The `compare` job for a pair, read off a jobs row's params. */
export function comparePairOf(params: unknown): CompareRequest | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const p = params as Record<string, unknown>;
  if (typeof p.file_a_id !== "string" || typeof p.file_b_id !== "string") return null;
  return { file_a_id: p.file_a_id, file_b_id: p.file_b_id };
}
