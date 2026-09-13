// GET /api/layers/[id] — one layer, its lanes, and the lane files' vitals.
// PATCH /api/layers/[id] { name?, tempo_bpm?, key? } — the target tempo and key (null = the
// first lane's, as the compute plans it) and the name.
// DELETE /api/layers/[id] — the layer and its lanes (the render stays in the library).

import { z } from "zod";
import { dbError, handle, HttpError, json, parseBody, requireUser, requireUuid } from "@/lib/http";
import { PITCH_CLASSES } from "@/lib/music/keys";
import type { LayerRow } from "@/lib/types/db";
import { layerResponse, loadLayer } from "../load";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "layer id");
    const layer = await loadLayer(supabase, id);
    return json(await layerResponse(supabase, layer));
  });
}

const keySchema = z.object({ tonic: z.enum(PITCH_CLASSES), mode: z.enum(["major", "minor"]) });

const patchSchema = z
  .object({
    name: z.string().trim().max(120).nullable().optional(),
    tempo_bpm: z.number().min(20).max(400).nullable().optional(),
    key: keySchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change." });

export async function PATCH(req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "layer id");
    const body = await parseBody(req, patchSchema);
    await loadLayer(supabase, id);

    const changes: { name?: string | null; tempo_bpm?: number | null; key?: LayerRow["key"] } = {};
    if (body.name !== undefined) changes.name = body.name === "" ? null : body.name;
    if (body.tempo_bpm !== undefined) changes.tempo_bpm = body.tempo_bpm;
    if (body.key !== undefined) changes.key = body.key;

    const updated = await supabase.from("layers").update(changes).eq("id", id).select("*").single();
    if (updated.error) throw dbError(updated.error, "Updating the layer");
    return json(await layerResponse(supabase, updated.data));
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "layer id");
    const { error, count } = await supabase.from("layers").delete({ count: "exact" }).eq("id", id);
    if (error) throw dbError(error, "Deleting the layer");
    if (!count) throw new HttpError(404, "Layer not found.");
    return json({ ok: true as const });
  });
}
