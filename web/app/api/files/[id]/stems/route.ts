// GET  /api/files/[id]/stems — the file's stems rows, each with its stem file
//      (id, kind, status, duration, vitals from the effective report).
// POST /api/files/[id]/stems { model } — queue a `stems` job (CONTRACTS section 5)
//      and dispatch it. One in-flight separation per model per file.

import { z } from "zod";
import type { JobResponse } from "@/lib/api/types";
import { STEM_MODEL_IDS, summarizeFile, type DerivedFileSummary, type StemsListResponse } from "@/lib/api/stems";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, HttpError, json, parseBody, requireUser, requireUuid } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "file id");
    const { data: stems, error } = await supabase.from("stems").select("*").eq("file_id", id).order("created_at", { ascending: true });
    if (error) throw dbError(error, "Listing stems");

    const byId = new Map<string, DerivedFileSummary>();
    const fileIds = [...new Set(stems.map((s) => s.stem_file_id))];
    if (fileIds.length > 0) {
      const files = await supabase.from("files").select("id, kind, status, duration_s, original_filename, report").in("id", fileIds);
      if (files.error) throw dbError(files.error, "Loading the stem files");
      for (const f of files.data) byId.set(f.id, summarizeFile(f));
    }
    const response: StemsListResponse = { stems: stems.map((s) => ({ ...s, file: byId.get(s.stem_file_id) ?? null })) };
    return json(response, { headers: { "cache-control": "private, no-store" } });
  });
}

const separateSchema = z.object({ model: z.enum(STEM_MODEL_IDS) });

export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const id = requireUuid((await ctx.params).id, "file id");
    const body = await parseBody(req, separateSchema);

    const { data: file, error } = await supabase.from("files").select("id, status").eq("id", id).maybeSingle();
    if (error) throw dbError(error, "Loading the file");
    if (!file) throw new HttpError(404, "File not found.");
    if (file.status === "uploading") throw new HttpError(409, "The upload has not finished.");

    const inFlight = await supabase
      .from("jobs")
      .select("id, params")
      .eq("file_id", id)
      .eq("kind", "stems")
      .in("status", ["queued", "running"])
      .limit(20);
    if (inFlight.error) throw dbError(inFlight.error, "Checking running jobs");
    const sameModel = inFlight.data.find((j) => typeof j.params === "object" && j.params !== null && !Array.isArray(j.params) && j.params.model === body.model);
    if (sameModel) throw new HttpError(409, `Separation with ${body.model} is already queued for this file.`);

    const job = await supabase
      .from("jobs")
      .insert({ user_id: user.id, file_id: id, kind: "stems", status: "queued", params: { model: body.model } })
      .select("*")
      .single();
    if (job.error) throw dbError(job.error, "Queueing the separation");

    const dispatch = await dispatchJob(job.data.id, supabase);
    const response: JobResponse = { job: job.data, dispatch };
    return json(response, { status: 201 });
  });
}
