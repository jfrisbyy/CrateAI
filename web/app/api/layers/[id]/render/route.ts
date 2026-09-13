// POST /api/layers/[id]/render — queue a `layer` job: params { layer_id } (CONTRACTS section 5).
// The job carries no file_id (it belongs to the layer, not to one of its files); the tab finds
// it by params.layer_id.

import type { JobResponse } from "@/lib/api/types";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, HttpError, json, requireUser, requireUuid } from "@/lib/http";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const id = requireUuid((await ctx.params).id, "layer id");
    const layer = await supabase.from("layers").select("id").eq("id", id).maybeSingle();
    if (layer.error) throw dbError(layer.error, "Loading the layer");
    if (!layer.data) throw new HttpError(404, "Layer not found.");
    const items = await supabase.from("layer_items").select("id, muted").eq("layer_id", id);
    if (items.error) throw dbError(items.error, "Loading the lanes");
    if (items.data.length === 0) throw new HttpError(409, "Add a lane before rendering.");
    if (items.data.every((i) => i.muted)) throw new HttpError(409, "Every lane is muted; unmute one before rendering.");

    const job = await supabase
      .from("jobs")
      .insert({ user_id: user.id, file_id: null, kind: "layer", status: "queued", params: { layer_id: id } })
      .select("*")
      .single();
    if (job.error) throw dbError(job.error, "Queueing the render");

    const dispatch = await dispatchJob(job.data.id, supabase);
    const response: JobResponse = { job: job.data, dispatch };
    return json(response, { status: 201 });
  });
}
