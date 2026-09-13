// POST /api/layers/[id]/items { file_id } — add a lane at the end, at the defaults.

import { z } from "zod";
import type { LayerItemResponse } from "@/lib/api/layers";
import { dbError, handle, HttpError, json, parseBody, requireUser, requireUuid, UUID_RE } from "@/lib/http";

const schema = z.object({ file_id: z.string().regex(UUID_RE) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const id = requireUuid((await ctx.params).id, "layer id");
    const body = await parseBody(req, schema);

    const layer = await supabase.from("layers").select("id").eq("id", id).maybeSingle();
    if (layer.error) throw dbError(layer.error, "Loading the layer");
    if (!layer.data) throw new HttpError(404, "Layer not found.");
    const file = await supabase.from("files").select("id").eq("id", body.file_id).maybeSingle();
    if (file.error) throw dbError(file.error, "Loading the file");
    if (!file.data) throw new HttpError(404, "File not found.");

    const last = await supabase.from("layer_items").select("position").eq("layer_id", id).order("position", { ascending: false }).limit(1);
    if (last.error) throw dbError(last.error, "Loading the lanes");
    const position = (last.data[0]?.position ?? -1) + 1;
    if (position >= 16) throw new HttpError(400, "A layer holds at most 16 lanes.");

    const inserted = await supabase
      .from("layer_items")
      .insert({ user_id: user.id, layer_id: id, file_id: body.file_id, position })
      .select("*")
      .single();
    if (inserted.error) throw dbError(inserted.error, "Adding the lane");
    const response: LayerItemResponse = { item: inserted.data };
    return json(response, { status: 201 });
  });
}
