// POST /api/files/[id]/edits { field, value } — merge one user edit into
// report.user_edits and log a corrections row (predicted = analyzed value,
// corrected = the new value). Principle 7.

import type { EditResponse } from "@/lib/api/types";
import { dbError, handle, HttpError, json, parseBody, requireUser, requireUuid } from "@/lib/http";
import { applyEdit, editRequestSchema, predictedFor } from "@/lib/report/edits";
import type { Json } from "@/lib/types/db";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const id = requireUuid((await ctx.params).id, "file id");
    const edit = await parseBody(req, editRequestSchema);

    const { data: file, error } = await supabase.from("files").select("*").eq("id", id).maybeSingle();
    if (error) throw dbError(error, "Loading the file");
    if (!file) throw new HttpError(404, "File not found.");
    if (!file.report) throw new HttpError(409, "This file has not been analyzed yet; edits need a report to attach to.");

    const now = new Date().toISOString();
    const nextReport = applyEdit(file.report, edit, now);
    const predicted = predictedFor(file.report, edit);

    const updated = await supabase
      .from("files")
      .update({ report: nextReport })
      .eq("id", id)
      .select("*")
      .single();
    if (updated.error) throw dbError(updated.error, "Saving the edit");

    const correction = await supabase
      .from("corrections")
      .insert({
        user_id: user.id,
        file_id: id,
        field: edit.field,
        predicted,
        corrected: edit.value as Json,
      })
      .select("*")
      .single();
    if (correction.error) throw dbError(correction.error, "Logging the correction");

    const response: EditResponse = { file: updated.data, correction: correction.data };
    return json(response);
  });
}
