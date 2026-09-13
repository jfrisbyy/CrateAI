// PATCH /api/layers/[id]/items/[itemId] { offset_s?, gain_db?, stretch_ratio?, pitch_semitones?,
// muted?, stretch_mode?, filter?, position? } — the lane's editable state (BUILD_PACKET section 9).
// DELETE /api/layers/[id]/items/[itemId] — remove the lane.

import { z } from "zod";
import type { LayerItemResponse } from "@/lib/api/layers";
import { dbError, handle, HttpError, json, parseBody, requireUser, requireUuid } from "@/lib/http";
import type { LayerItemUpdate } from "@/lib/types/db";

type Ctx = { params: Promise<{ id: string; itemId: string }> };

const hz = z.number().min(10).max(20000).nullable().optional();

const patchSchema = z
  .object({
    offset_s: z.number().min(-3600).max(3600).optional(),
    gain_db: z.number().min(-60).max(24).optional(),
    stretch_ratio: z.number().min(0.25).max(4).optional(),
    pitch_semitones: z.number().min(-24).max(24).optional(),
    muted: z.boolean().optional(),
    stretch_mode: z.enum(["transient", "smooth"]).optional(),
    filter: z.object({ highpass_hz: hz, lowpass_hz: hz }).nullable().optional(),
    position: z.number().int().min(0).max(64).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change." });

export async function PATCH(req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const params = await ctx.params;
    const id = requireUuid(params.id, "layer id");
    const itemId = requireUuid(params.itemId, "lane id");
    const body = await parseBody(req, patchSchema);

    const changes: LayerItemUpdate = {};
    if (body.offset_s !== undefined) changes.offset_s = body.offset_s;
    if (body.gain_db !== undefined) changes.gain_db = body.gain_db;
    if (body.stretch_ratio !== undefined) changes.stretch_ratio = body.stretch_ratio;
    if (body.pitch_semitones !== undefined) changes.pitch_semitones = body.pitch_semitones;
    if (body.muted !== undefined) changes.muted = body.muted;
    if (body.stretch_mode !== undefined) changes.stretch_mode = body.stretch_mode;
    if (body.filter !== undefined) {
      const f = body.filter;
      const hp = f?.highpass_hz ?? null;
      const lp = f?.lowpass_hz ?? null;
      if (hp !== null && lp !== null && hp >= lp) throw new HttpError(400, "The high-pass must sit below the low-pass.");
      changes.filter = f === null || (hp === null && lp === null) ? null : { highpass_hz: hp, lowpass_hz: lp };
    }
    if (body.position !== undefined) changes.position = body.position;

    const updated = await supabase.from("layer_items").update(changes).eq("id", itemId).eq("layer_id", id).select("*").maybeSingle();
    if (updated.error) throw dbError(updated.error, "Updating the lane");
    if (!updated.data) throw new HttpError(404, "Lane not found.");
    const response: LayerItemResponse = { item: updated.data };
    return json(response);
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const params = await ctx.params;
    const id = requireUuid(params.id, "layer id");
    const itemId = requireUuid(params.itemId, "lane id");
    const { error, count } = await supabase.from("layer_items").delete({ count: "exact" }).eq("id", itemId).eq("layer_id", id);
    if (error) throw dbError(error, "Removing the lane");
    if (!count) throw new HttpError(404, "Lane not found.");
    return json({ ok: true as const });
  });
}
