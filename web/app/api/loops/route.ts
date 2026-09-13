// GET /api/loops?file_id= — loops for a file, best first.
// POST /api/loops { file_id, start_s, end_s, name?, bars? } — a user loop.

import type { NextRequest } from "next/server";
import { z } from "zod";
import type { LoopResponse, LoopsListResponse } from "@/lib/api/types";
import { dbError, handle, HttpError, json, parseBody, requireUser, UUID_RE } from "@/lib/http";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const fileId = req.nextUrl.searchParams.get("file_id");
    if (!fileId || !UUID_RE.test(fileId)) throw new HttpError(400, "file_id is required.");
    const { data, error } = await supabase
      .from("loops")
      .select("*")
      .eq("file_id", fileId)
      .order("score", { ascending: false, nullsFirst: false })
      .order("start_s", { ascending: true })
      .limit(200);
    if (error) throw dbError(error, "Listing loops");
    const response: LoopsListResponse = { loops: data };
    return json(response);
  });
}

const createSchema = z
  .object({
    file_id: z.string().regex(UUID_RE),
    start_s: z.number().min(0),
    end_s: z.number().positive(),
    name: z.string().trim().max(120).nullable().optional(),
    bars: z.number().int().positive().max(512).nullable().optional(),
  })
  .refine((v) => v.end_s > v.start_s, { message: "end_s must be after start_s" });

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = await parseBody(req, createSchema);

    const { data: file, error } = await supabase.from("files").select("id, duration_s").eq("id", body.file_id).maybeSingle();
    if (error) throw dbError(error, "Loading the file");
    if (!file) throw new HttpError(404, "File not found.");
    if (file.duration_s !== null && body.start_s > file.duration_s) {
      throw new HttpError(400, "The loop starts after the end of the file.");
    }

    const inserted = await supabase
      .from("loops")
      .insert({
        user_id: user.id,
        file_id: body.file_id,
        start_s: body.start_s,
        end_s: body.end_s,
        name: body.name ?? null,
        bars: body.bars ?? null,
        origin: "user",
      })
      .select("*")
      .single();
    if (inserted.error) throw dbError(inserted.error, "Creating the loop");
    const response: LoopResponse = { loop: inserted.data };
    return json(response, { status: 201 });
  });
}
