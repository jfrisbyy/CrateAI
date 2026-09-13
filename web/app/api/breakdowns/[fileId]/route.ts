// GET  /api/breakdowns/[fileId]?all=1  — the latest breakdown (every version with all=1), the
//                                        file's pending breakdown/stems/analyze jobs, the stems map.
// POST /api/breakdowns/[fileId] { web_context? } — queue a `breakdown` job (CONTRACTS section 5)
//                                        and dispatch it; 409 while one is queued or running.
//
// The breakdown job composes from what is measured now and queues what is
// missing (stems, per-stem analyze, the Phase 4 stages); the tab re-requests a
// breakdown when those jobs finish, so the document fills in by versions.

import { z } from "zod";
import type { BreakdownGetResponse } from "@/lib/api/breakdown";
import type { JobResponse } from "@/lib/api/types";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, HttpError, json, requireUser, requireUuid } from "@/lib/http";
import { BREAKDOWN_JOB_KINDS, type StemLink } from "@/lib/narration/jobs";
import type { Json } from "@/lib/types/db";

const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonSchema), z.record(z.string(), jsonSchema)]),
);

const postSchema = z.object({
  web_context: z.record(z.string(), jsonSchema).nullable().optional(),
});

/** POST bodies may be empty; anything present must validate. */
async function parseOptionalBody(req: Request): Promise<z.infer<typeof postSchema>> {
  const text = await req.text();
  if (!text.trim()) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Body must be JSON.");
  }
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "Invalid request body.", parsed.error.issues);
  return parsed.data;
}

export async function GET(req: Request, ctx: { params: Promise<{ fileId: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const fileId = requireUuid((await ctx.params).fileId, "file id");
    const all = new URL(req.url).searchParams.get("all") === "1";

    const { data: file, error } = await supabase.from("files").select("id").eq("id", fileId).maybeSingle();
    if (error) throw dbError(error, "Loading the file");
    if (!file) throw new HttpError(404, "File not found.");

    const rows = await supabase
      .from("breakdowns")
      .select("*")
      .eq("file_id", fileId)
      .order("version", { ascending: false })
      .limit(all ? 50 : 1);
    if (rows.error) throw dbError(rows.error, "Loading the breakdown");

    const stemRows = await supabase.from("stems").select("stem, stem_file_id, created_at").eq("file_id", fileId).order("created_at", { ascending: true });
    if (stemRows.error) throw dbError(stemRows.error, "Loading the stems");
    const latest = new Map<string, string>();
    for (const s of stemRows.data) latest.set(s.stem, s.stem_file_id); // the latest separation wins
    const stems: StemLink[] = [...latest].map(([stem, stem_file_id]) => ({ stem, stem_file_id }));

    const jobs = await supabase
      .from("jobs")
      .select("*")
      .in("file_id", [fileId, ...stems.map((s) => s.stem_file_id)])
      .in("kind", [...BREAKDOWN_JOB_KINDS])
      .in("status", ["queued", "running"])
      .order("created_at", { ascending: false });
    if (jobs.error) throw dbError(jobs.error, "Loading the jobs");

    const response: BreakdownGetResponse = {
      breakdown: rows.data[0] ?? null,
      breakdowns: rows.data,
      jobs: jobs.data,
      stems,
    };
    return json(response);
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ fileId: string }> }) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const fileId = requireUuid((await ctx.params).fileId, "file id");
    const body = await parseOptionalBody(req);

    const { data: file, error } = await supabase.from("files").select("id, status").eq("id", fileId).maybeSingle();
    if (error) throw dbError(error, "Loading the file");
    if (!file) throw new HttpError(404, "File not found.");
    if (file.status === "failed") throw new HttpError(409, "Analysis failed on this file; retry it before running the breakdown.");

    const pending = await supabase
      .from("jobs")
      .select("id, status")
      .eq("file_id", fileId)
      .eq("kind", "breakdown")
      .in("status", ["queued", "running"])
      .limit(1);
    if (pending.error) throw dbError(pending.error, "Checking for a running breakdown");
    if (pending.data.length > 0) throw new HttpError(409, "A breakdown is already queued for this file.", { job_id: pending.data[0]!.id });

    const params: Record<string, Json> = {};
    if (body.web_context) params.web_context = body.web_context;

    const job = await supabase
      .from("jobs")
      .insert({ user_id: user.id, file_id: fileId, kind: "breakdown", status: "queued", params })
      .select("*")
      .single();
    if (job.error) throw dbError(job.error, "Queueing the breakdown");

    const dispatch = await dispatchJob(job.data.id, supabase);
    const response: JobResponse = { job: job.data, dispatch };
    return json(response, { status: 201 });
  });
}
