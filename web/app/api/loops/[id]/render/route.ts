// POST /api/loops/[id]/render — queue a `render_loop` job for the loop.
// params { loop_id, crossfade_ms: 12, snap_zero_crossing: true } (CONTRACTS section 5).
//
// Exporting is where a producer takes a candidate out of the rack and into the
// library, so this is where a `loop_pick` correction is logged when the one they
// took is not the one we put first (principle 7). A re-export of a loop that
// already has a render is the same choice again, and writes nothing.

import type { JobResponse } from "@/lib/api/types";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, HttpError, json, requireUser, requireUuid } from "@/lib/http";
import { recordLoopPick } from "@/lib/report/loopCorrections";

const CROSSFADE_MS = 12;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const id = requireUuid((await ctx.params).id, "loop id");
    const { data: loop, error } = await supabase.from("loops").select("*").eq("id", id).maybeSingle();
    if (error) throw dbError(error, "Loading the loop");
    if (!loop) throw new HttpError(404, "Loop not found.");

    const pick = loop.render_file_id ? null : (await recordLoopPick(supabase, user.id, loop)).correction;

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
    const response: JobResponse = { job: job.data, dispatch, correction: pick };
    return json(response, { status: 201 });
  });
}
