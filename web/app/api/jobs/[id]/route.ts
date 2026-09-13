// GET /api/jobs/[id] — one job row.

import type { JobResponse } from "@/lib/api/types";
import { dbError, handle, HttpError, json, requireUser, requireUuid } from "@/lib/http";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "job id");
    const { data, error } = await supabase.from("jobs").select("*").eq("id", id).maybeSingle();
    if (error) throw dbError(error, "Loading the job");
    if (!data) throw new HttpError(404, "Job not found.");
    const response: JobResponse = { job: data };
    return json(response);
  });
}
