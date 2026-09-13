// /api/files/[id] — GET one file; PATCH title/artist; DELETE row + storage objects.

import { z } from "zod";
import type { FileResponse } from "@/lib/api/types";
import { dbError, handle, HttpError, json, parseBody, requireUser, requireUuid } from "@/lib/http";
import { AUDIO_BUCKET, derivedPrefix } from "@/lib/storage/paths";
import type { ServerSupabase } from "@/lib/supabase/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "file id");
    const { data, error } = await supabase.from("files").select("*").eq("id", id).maybeSingle();
    if (error) throw dbError(error, "Loading the file");
    if (!data) throw new HttpError(404, "File not found.");
    const response: FileResponse = { file: data };
    return json(response);
  });
}

const patchSchema = z
  .object({
    title: z.string().trim().max(200).nullable().optional(),
    artist: z.string().trim().max(200).nullable().optional(),
  })
  .refine((v) => v.title !== undefined || v.artist !== undefined, { message: "Nothing to change." });

export async function PATCH(req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "file id");
    const body = await parseBody(req, patchSchema);
    const changes: { title?: string | null; artist?: string | null } = {};
    if (body.title !== undefined) changes.title = body.title === "" ? null : body.title;
    if (body.artist !== undefined) changes.artist = body.artist === "" ? null : body.artist;
    const { data, error } = await supabase.from("files").update(changes).eq("id", id).select("*").maybeSingle();
    if (error) throw dbError(error, "Updating the file");
    if (!data) throw new HttpError(404, "File not found.");
    const response: FileResponse = { file: data };
    return json(response);
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const id = requireUuid((await ctx.params).id, "file id");
    const { data: file, error } = await supabase.from("files").select("*").eq("id", id).maybeSingle();
    if (error) throw dbError(error, "Loading the file");
    if (!file) throw new HttpError(404, "File not found.");

    // Storage first (the row is what makes the object findable).
    const paths = [file.storage_path, ...(await listRecursive(supabase, derivedPrefix(user.id, file.id)))];
    const removed = await supabase.storage.from(AUDIO_BUCKET).remove(paths);
    if (removed.error) throw new HttpError(500, `Could not delete the audio: ${removed.error.message}`);

    const deleted = await supabase.from("files").delete().eq("id", id);
    if (deleted.error) throw dbError(deleted.error, "Deleting the file");
    return json({ ok: true as const });
  });
}

/** All object paths under a prefix (Supabase Storage lists one level at a time). */
async function listRecursive(supabase: ServerSupabase, prefix: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  const { data, error } = await supabase.storage.from(AUDIO_BUCKET).list(prefix, { limit: 1000 });
  if (error || !data) return [];
  const out: string[] = [];
  for (const entry of data) {
    const path = `${prefix}/${entry.name}`;
    if (entry.id) out.push(path);
    else out.push(...(await listRecursive(supabase, path, depth + 1)));
  }
  return out;
}
