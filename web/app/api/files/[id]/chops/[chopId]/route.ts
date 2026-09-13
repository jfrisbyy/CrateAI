// PATCH /api/files/[id]/chops/[chopId] { name } — rename a chop (the pad label).

import { z } from "zod";
import type { ChopResponse } from "@/lib/api/chops";
import { dbError, handle, HttpError, json, parseBody, requireUser, requireUuid } from "@/lib/http";

type Ctx = { params: Promise<{ id: string; chopId: string }> };

const patchSchema = z.object({ name: z.string().trim().max(120).nullable() });

export async function PATCH(req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const params = await ctx.params;
    const fileId = requireUuid(params.id, "file id");
    const chopId = requireUuid(params.chopId, "chop id");
    const body = await parseBody(req, patchSchema);
    const { data, error } = await supabase
      .from("chops")
      .update({ name: body.name === "" ? null : body.name })
      .eq("id", chopId)
      .eq("source_file_id", fileId)
      .select("*")
      .maybeSingle();
    if (error) throw dbError(error, "Renaming the chop");
    if (!data) throw new HttpError(404, "Chop not found.");
    const response: ChopResponse = { chop: data };
    return json(response);
  });
}
