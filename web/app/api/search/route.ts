// POST /api/search { query, limit?, kind? } — library search.
//
// Phase 0/1: parse structured filters (lib/search/parse.ts) and call the
// `library_filter` RPC. `text_query` is returned but not yet used; the hybrid
// parser and CLAP nearest-neighbour search arrive in Phase 6 (see the SEAM
// note in lib/search/parse.ts).

import { z } from "zod";
import type { SearchResponse } from "@/lib/api/types";
import { handle, HttpError, json, parseBody, requireUser } from "@/lib/http";
import { parseQuery } from "@/lib/search/parse";
import { FILE_KINDS } from "@/lib/types/db";

const schema = z.object({
  query: z.string().max(500),
  limit: z.number().int().min(1).max(200).optional(),
  kind: z.enum(FILE_KINDS).optional(),
});

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const body = await parseBody(req, schema);
    const parsed = parseQuery(body.query);
    const kind = body.kind ?? parsed.kind;

    const { data, error } = await supabase.rpc("library_filter", {
      p_bpm_min: parsed.bpm_min,
      p_bpm_max: parsed.bpm_max,
      p_tonic: parsed.tonic,
      p_mode: parsed.mode,
      p_kind: kind,
      p_limit: body.limit ?? 50,
    });
    if (error) throw new HttpError(500, `Search failed: ${error.message}`);

    // Until the text embedding exists, a leftover text query narrows by name.
    const needle = parsed.text_query?.toLowerCase() ?? null;
    const files = needle
      ? data.filter((f) => `${f.original_filename} ${f.title ?? ""} ${f.artist ?? ""}`.toLowerCase().includes(needle))
      : data;

    const response: SearchResponse = { files, parsed: { ...parsed, kind } };
    return json(response);
  });
}
