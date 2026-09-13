// GET /api/beatbox/transcriptions — the caller's beatbox MIDI rows (kind 'beatbox'), newest
// first, each with a 10-minute signed download URL for the .mid.

import type { Transcription, TranscriptionsResponse } from "@/lib/api/beatbox";
import { dbError, handle, json, requireUser } from "@/lib/http";
import { AUDIO_BUCKET, SIGNED_URL_TTL_S } from "@/lib/storage/paths";

export async function GET() {
  return handle(async () => {
    const { supabase } = await requireUser();
    const rows = await supabase.from("midi").select("*").eq("kind", "beatbox").order("created_at", { ascending: false }).limit(50);
    if (rows.error) throw dbError(rows.error, "Listing transcriptions");

    const urlByPath = new Map<string, string>();
    const paths = Array.from(new Set(rows.data.map((m) => m.storage_path).filter((p) => p.length > 0)));
    if (paths.length) {
      const signed = await supabase.storage.from(AUDIO_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL_S, { download: true });
      for (const s of signed.data ?? []) if (s.path && s.signedUrl && !s.error) urlByPath.set(s.path, s.signedUrl);
    }
    const transcriptions: Transcription[] = rows.data.map((midi) => ({ midi, download_url: urlByPath.get(midi.storage_path) ?? null }));
    const response: TranscriptionsResponse = { transcriptions };
    return json(response, { headers: { "cache-control": "private, no-store" } });
  });
}
