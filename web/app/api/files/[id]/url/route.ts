// GET /api/files/[id]/url — a 10-minute signed playback URL for a file the caller owns.

import type { SignedUrlResponse } from "@/lib/api/types";
import { dbError, handle, HttpError, json, requireUser, requireUuid } from "@/lib/http";
import { AUDIO_BUCKET, SIGNED_URL_TTL_S } from "@/lib/storage/paths";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "file id");
    const { data: file, error } = await supabase.from("files").select("storage_path").eq("id", id).maybeSingle();
    if (error) throw dbError(error, "Loading the file");
    if (!file) throw new HttpError(404, "File not found.");

    const signed = await supabase.storage.from(AUDIO_BUCKET).createSignedUrl(file.storage_path, SIGNED_URL_TTL_S);
    if (signed.error || !signed.data) {
      // A row whose object is not there (an upload that never finished, or
      // audio removed underneath the row) is a missing resource, not a server
      // fault. Anything else storage says stays a 500 so an outage still shows.
      const message = signed.error?.message ?? "unknown error";
      if (/not found/i.test(message)) throw new HttpError(404, "The audio for this file is not in storage.");
      throw new HttpError(500, `Could not sign the playback URL: ${message}`);
    }
    const response: SignedUrlResponse = { url: signed.data.signedUrl, expires_in: SIGNED_URL_TTL_S };
    return json(response, { headers: { "cache-control": "private, no-store" } });
  });
}
