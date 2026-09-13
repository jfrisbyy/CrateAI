// GET /api/midi/[id]/download — a 10-minute signed URL for a .mid the caller owns.

import type { MidiDownloadResponse } from "@/lib/api/midi";
import { dbError, handle, HttpError, json, requireUser, requireUuid } from "@/lib/http";
import { basenameOf } from "@/lib/midi/manifest";
import { AUDIO_BUCKET, SIGNED_URL_TTL_S } from "@/lib/storage/paths";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "midi id");
    const { data: row, error } = await supabase.from("midi").select("storage_path").eq("id", id).maybeSingle();
    if (error) throw dbError(error, "Loading the MIDI");
    if (!row) throw new HttpError(404, "MIDI not found.");

    const signed = await supabase.storage.from(AUDIO_BUCKET).createSignedUrl(row.storage_path, SIGNED_URL_TTL_S, {
      download: basenameOf(row.storage_path),
    });
    if (signed.error || !signed.data) {
      // As in /api/files/[id]/url: a missing object is a 404, a broken storage
      // call is still a 500.
      const message = signed.error?.message ?? "unknown error";
      if (/not found/i.test(message)) throw new HttpError(404, "That MIDI file is not in storage.");
      throw new HttpError(500, `Could not sign the download URL: ${message}`);
    }
    const response: MidiDownloadResponse = { url: signed.data.signedUrl, expires_in: SIGNED_URL_TTL_S, filename: basenameOf(row.storage_path) };
    return json(response, { headers: { "cache-control": "private, no-store" } });
  });
}
