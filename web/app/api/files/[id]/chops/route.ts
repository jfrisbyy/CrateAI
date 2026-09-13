// GET  /api/files/[id]/chops — the file's chops in index order, each with its
//      chop file (status, duration).
// POST /api/files/[id]/chops { mode, ...params } — queue a `chop` job
//      (analysis/lockedgroove/jobs/chop.py params) and dispatch it. Every run
//      replaces the file's chops (compute's `replace` default).

import { z } from "zod";
import { CHOP_LIMITS, type ChopsListResponse } from "@/lib/api/chops";
import { summarizeFile, type DerivedFileSummary } from "@/lib/api/stems";
import type { JobResponse } from "@/lib/api/types";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, HttpError, json, parseBody, requireUser, requireUuid } from "@/lib/http";
import type { Json } from "@/lib/types/db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "file id");
    const { data: chops, error } = await supabase.from("chops").select("*").eq("source_file_id", id).order("index", { ascending: true }).limit(1000);
    if (error) throw dbError(error, "Listing chops");

    const byId = new Map<string, DerivedFileSummary>();
    const fileIds = [...new Set(chops.map((c) => c.chop_file_id).filter((v): v is string => v !== null))];
    if (fileIds.length > 0) {
      const files = await supabase.from("files").select("id, kind, status, duration_s, original_filename, report").in("id", fileIds);
      if (files.error) throw dbError(files.error, "Loading the chop files");
      for (const f of files.data) byId.set(f.id, summarizeFile(f));
    }
    const response: ChopsListResponse = { chops: chops.map((c) => ({ ...c, file: c.chop_file_id ? (byId.get(c.chop_file_id) ?? null) : null })) };
    return json(response, { headers: { "cache-control": "private, no-store" } });
  });
}

const chopSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("transients"),
    count: z.number().int().min(1).max(CHOP_LIMITS.count),
    min_gap_ms: z.number().min(5).max(CHOP_LIMITS.min_gap_ms),
  }),
  z
    .object({
      mode: z.literal("grid"),
      start_bar: z.number().int().min(0).max(4096),
      end_bar: z.number().int().min(0).max(4096),
      divisions: z.number().int().min(1).max(CHOP_LIMITS.divisions),
    })
    .refine((v) => v.end_bar >= v.start_bar, { message: "end_bar must not be before start_bar" })
    .refine((v) => (v.end_bar - v.start_bar + 1) * v.divisions <= 1024, { message: "That would make more than 1024 chops." }),
  z.object({
    mode: z.literal("manual"),
    markers_s: z.array(z.number().min(0)).min(1).max(CHOP_LIMITS.markers),
  }),
]);

export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const id = requireUuid((await ctx.params).id, "file id");
    const body = await parseBody(req, chopSchema);

    const { data: file, error } = await supabase.from("files").select("id, status, duration_s, report").eq("id", id).maybeSingle();
    if (error) throw dbError(error, "Loading the file");
    if (!file) throw new HttpError(404, "File not found.");
    if (file.status === "uploading") throw new HttpError(409, "The upload has not finished.");
    if (body.mode === "grid" && file.report === null) throw new HttpError(409, "Grid chops need the beat grid; analyze the file first.");
    if (body.mode === "manual" && file.duration_s !== null && body.markers_s.every((m) => m >= file.duration_s!)) {
      throw new HttpError(400, "Every marker is past the end of the file.");
    }

    const params: Record<string, Json> =
      body.mode === "transients"
        ? { mode: "transients", count: body.count, min_gap_ms: body.min_gap_ms }
        : body.mode === "grid"
          ? { mode: "grid", start_bar: body.start_bar, end_bar: body.end_bar, divisions: body.divisions }
          : { mode: "manual", markers_s: [...body.markers_s].sort((a, b) => a - b) };

    const job = await supabase
      .from("jobs")
      .insert({ user_id: user.id, file_id: id, kind: "chop", status: "queued", params })
      .select("*")
      .single();
    if (job.error) throw dbError(job.error, "Queueing the chop");

    const dispatch = await dispatchJob(job.data.id, supabase);
    const response: JobResponse = { job: job.data, dispatch };
    return json(response, { status: 201 });
  });
}
