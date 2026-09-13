// POST /api/search { query, limit?, kind?, current_file_id? } — hybrid library
// search (BUILD_PACKET section 12, Phase 6).
//
// Returns { results: [{ file, matched, similarity? }], parsed, mode, note,
// files } where `files` is results[].file for the shell's search state, which
// reads `res.files` and `res.parsed` (components/shell/searchState.tsx).
// `mode` is "vector" when the text went through the CLAP embedding and
// "filters" when it fell back to structured filters plus a name match; `note`
// says why ("text search needs the embed job / compute").

import { z } from "zod";
import { handle, json, parseBody, requireUser, UUID_RE } from "@/lib/http";
import { runLibrarySearch } from "@/lib/search/server";
import { FILE_KINDS } from "@/lib/types/db";

const schema = z.object({
  query: z.string().max(500),
  limit: z.number().int().min(1).max(200).optional(),
  kind: z.enum(FILE_KINDS).optional(),
  current_file_id: z.string().regex(UUID_RE).nullable().optional(),
});

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = await parseBody(req, schema);
    const result = await runLibrarySearch(supabase, user.id, body.query, {
      limit: body.limit,
      kind: body.kind,
      currentFileId: body.current_file_id ?? null,
    });
    return json({
      results: result.results,
      parsed: result.parsed,
      mode: result.mode,
      note: result.note,
      files: result.results.map((r) => r.file),
    });
  });
}
