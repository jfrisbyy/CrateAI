// POST /api/loops/[id]/render — queue a `render_loop` job for the loop.
// params { loop_id, crossfade_ms: 12, snap_zero_crossing: true } (CONTRACTS section 5).

import type { JobResponse } from "@/lib/api/types";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, HttpError, json, requireUser, requireUuid } from "@/lib/http";

const CROSSFADE_MS = 12;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const id = requireUuid((await ctx.params).id, "loop id");
    const { data: loop, error } = await supabase.from("loops").select("id, file_id").eq("id", id).maybeSingle();
    if (error) throw dbError(error, "Loading the loop");
    if (!loop) throw new HttpError(404, "Loop not found.");

    const job = await supabase
      .from("jobs")
      .insert({
        user_id: user.id,
        file_id: loop.file_id,
        kind: "render_loop",
        status: "queued",
        params: { loop_id: loop.id, crossfade_ms: CROSSFADE_MS, snap_zero_crossing: true },
      })
      .select("*")
      .single();
    if (job.error) throw dbError(job.error, "Queueing the render");

    const dispatch = await dispatchJob(job.data.id, supabase);
    const response: JobResponse = { job: job.data, dispatch };
    return json(response, { status: 201 });
  });
}
