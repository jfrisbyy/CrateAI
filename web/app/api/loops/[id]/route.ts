// PATCH /api/loops/[id] { start_s?, end_s?, name?, bars? }; DELETE /api/loops/[id].

import { z } from "zod";
import type { LoopResponse } from "@/lib/api/types";
import { dbError, handle, HttpError, json, parseBody, requireUser, requireUuid } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    start_s: z.number().min(0).optional(),
    end_s: z.number().positive().optional(),
    name: z.string().trim().max(120).nullable().optional(),
    bars: z.number().int().positive().max(512).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change." });

export async function PATCH(req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "loop id");
    const body = await parseBody(req, patchSchema);

    const { data: loop, error } = await supabase.from("loops").select("*").eq("id", id).maybeSingle();
    if (error) throw dbError(error, "Loading the loop");
    if (!loop) throw new HttpError(404, "Loop not found.");

    const start = body.start_s ?? loop.start_s;
    const end = body.end_s ?? loop.end_s;
    if (end <= start) throw new HttpError(400, "The loop must end after it starts.");

    const changes: { start_s?: number; end_s?: number; name?: string | null; bars?: number | null } = {};
    if (body.start_s !== undefined) changes.start_s = body.start_s;
    if (body.end_s !== undefined) changes.end_s = body.end_s;
    if (body.name !== undefined) changes.name = body.name === "" ? null : body.name;
    if (body.bars !== undefined) changes.bars = body.bars;

    const updated = await supabase.from("loops").update(changes).eq("id", id).select("*").single();
    if (updated.error) throw dbError(updated.error, "Updating the loop");
    const response: LoopResponse = { loop: updated.data };
    return json(response);
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "loop id");
    const { error, count } = await supabase.from("loops").delete({ count: "exact" }).eq("id", id);
    if (error) throw dbError(error, "Deleting the loop");
    if (!count) throw new HttpError(404, "Loop not found.");
    return json({ ok: true as const });
  });
}
