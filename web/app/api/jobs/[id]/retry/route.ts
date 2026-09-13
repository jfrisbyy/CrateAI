// POST /api/jobs/[id]/retry — requeue a failed job (or a queued one whose
// dispatch failed) and dispatch it again.

import type { JobResponse } from "@/lib/api/types";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, HttpError, json, requireUser, requireUuid } from "@/lib/http";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "job id");
    const { data: job, error } = await supabase.from("jobs").select("*").eq("id", id).maybeSingle();
    if (error) throw dbError(error, "Loading the job");
    if (!job) throw new HttpError(404, "Job not found.");
    if (job.status === "running" || job.status === "done") {
      throw new HttpError(409, `This job is ${job.status}; only failed or stuck jobs can be retried.`);
    }

    const requeued = await supabase
      .from("jobs")
      .update({ status: "queued", error: null, result: null, progress: null, started_at: null, finished_at: null, modal_call_id: null })
      .eq("id", id)
      .select("*")
      .single();
    if (requeued.error) throw dbError(requeued.error, "Requeueing the job");

    if (job.kind === "analyze" && job.file_id) {
      await supabase.from("files").update({ status: "queued" }).eq("id", job.file_id).eq("status", "failed");
    }

    const dispatch = await dispatchJob(id, supabase);
    const response: JobResponse = { job: requeued.data, dispatch };
    return json(response);
  });
}
