// GET /api/files?kind=&parent= — the caller's library, newest first.

import type { NextRequest } from "next/server";
import type { FilesListResponse } from "@/lib/api/types";
import { handle, HttpError, json, requireUser, UUID_RE } from "@/lib/http";
import { FILE_KINDS, type FileKind } from "@/lib/types/db";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const kind = req.nextUrl.searchParams.get("kind");
    const parent = req.nextUrl.searchParams.get("parent");

    let query = supabase.from("files").select("*").order("created_at", { ascending: false }).limit(1000);
    if (kind) {
      if (!(FILE_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `Unknown kind "${kind}".`);
      query = query.eq("kind", kind as FileKind);
    }
    if (parent) {
      if (!UUID_RE.test(parent)) throw new HttpError(400, "Invalid parent id.");
      query = query.eq("parent_file_id", parent);
    }
    const { data, error } = await query;
    if (error) throw new HttpError(500, `Could not list files: ${error.message}`);
    const response: FilesListResponse = { files: data };
    return json(response);
  });
}
