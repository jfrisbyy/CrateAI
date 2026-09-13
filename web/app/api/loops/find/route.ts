// POST /api/loops/find { file_id, bars?, top_k? } — run the loop finder.
//
// Contract (documented in docs/HANDOFF_web.md for the compute side): this
// inserts a `jobs` row of kind `analyze` with
//   params { task: "find_loops", bars: [1, 2, 4, 8], top_k: 12 }
// and dispatches it. Compute treats an analyze job with task=find_loops as
// the loop finder: it runs loops/finder.py over the effective report and
// writes `loops` rows with origin 'finder', replacing that file's earlier
// finder loops. jobs.result carries { loop_ids: [...] }.

import { z } from "zod";
import type { JobResponse } from "@/lib/api/types";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, HttpError, json, parseBody, requireUser, UUID_RE } from "@/lib/http";

const schema = z.object({
  file_id: z.string().regex(UUID_RE),
  bars: z.array(z.number().int().min(1).max(64)).min(1).max(8).optional(),
  top_k: z.number().int().min(1).max(50).optional(),
});

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = await parseBody(req, schema);

    const { data: file, error } = await supabase.from("files").select("id, status, report").eq("id", body.file_id).maybeSingle();
    if (error) throw dbError(error, "Loading the file");
    if (!file) throw new HttpError(404, "File not found.");
    if (!file.report || file.status !== "ready") {
      throw new HttpError(409, "Finding loops needs the analysis first; wait for the file to be ready.");
    }

    const job = await supabase
      .from("jobs")
      .insert({
        user_id: user.id,
        file_id: file.id,
        kind: "analyze",
        status: "queued",
        params: { task: "find_loops", bars: body.bars ?? [1, 2, 4, 8], top_k: body.top_k ?? 12 },
      })
      .select("*")
      .single();
    if (job.error) throw dbError(job.error, "Queueing the loop finder");

    const dispatch = await dispatchJob(job.data.id, supabase);
    const response: JobResponse = { job: job.data, dispatch };
    return json(response, { status: 201 });
  });
}
