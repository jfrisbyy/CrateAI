// POST /api/compare { file_a_id, file_b_id } — queue a `compare` job (CONTRACTS section 5):
//     a is "mine", b is "the reference"; the job writes a `comparisons` row.
// GET  /api/compare?a=&b=  — the latest comparison for the pair; with only `a`, the latest
//     comparison of that file against anything (so the tab can restore its last reference).

import { z } from "zod";
import type { ComparisonGetResponse } from "@/lib/api/compare";
import { comparePairOf } from "@/lib/api/compare";
import type { JobResponse } from "@/lib/api/types";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, HttpError, json, parseBody, requireUser, requireUuid, UUID_RE } from "@/lib/http";

const postSchema = z
  .object({
    file_a_id: z.string().regex(UUID_RE),
    file_b_id: z.string().regex(UUID_RE),
  })
  .refine((b) => b.file_a_id !== b.file_b_id, { message: "Pick two different files.", path: ["file_b_id"] });

export async function GET(req: Request) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const url = new URL(req.url);
    const a = requireUuid(url.searchParams.get("a") ?? undefined, "file id a");
    const bParam = url.searchParams.get("b");
    const b = bParam ? requireUuid(bParam, "file id b") : null;

    let query = supabase.from("comparisons").select("*").eq("file_a_id", a);
    if (b) query = query.eq("file_b_id", b);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw dbError(error, "Loading the comparison");
    const response: ComparisonGetResponse = { comparison: data ?? null };
    return json(response);
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = await parseBody(req, postSchema);

    // Both files must be the caller's (RLS) and analyzed: the job refuses otherwise.
    const files = await supabase
      .from("files")
      .select("id, status")
      .in("id", [body.file_a_id, body.file_b_id])
      .not("report", "is", null);
    if (files.error) throw dbError(files.error, "Loading the files");
    const found = new Set(files.data.map((f) => f.id));
    if (!found.has(body.file_a_id) || !found.has(body.file_b_id)) {
      throw new HttpError(409, "Both files need a finished analysis before they can be compared.");
    }

    const pending = await supabase
      .from("jobs")
      .select("id, params")
      .eq("file_id", body.file_a_id)
      .eq("kind", "compare")
      .in("status", ["queued", "running"]);
    if (pending.error) throw dbError(pending.error, "Checking for a running comparison");
    const running = pending.data.find((j) => {
      const pair = comparePairOf(j.params);
      return pair !== null && pair.file_a_id === body.file_a_id && pair.file_b_id === body.file_b_id;
    });
    if (running) throw new HttpError(409, "This comparison is already queued.", { job_id: running.id });

    const job = await supabase
      .from("jobs")
      .insert({
        user_id: user.id,
        file_id: body.file_a_id,
        kind: "compare",
        status: "queued",
        params: { file_a_id: body.file_a_id, file_b_id: body.file_b_id },
      })
      .select("*")
      .single();
    if (job.error) throw dbError(job.error, "Queueing the comparison");

    const dispatch = await dispatchJob(job.data.id, supabase);
    const response: JobResponse = { job: job.data, dispatch };
    return json(response, { status: 201 });
  });
}
