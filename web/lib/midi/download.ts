// Server-side: midi rows with a signed download URL each (10 minutes,
// CONTRACTS section 2). One storage call for the whole list.

import type { MidiWithUrl } from "@/lib/api/midi";
import { AUDIO_BUCKET, SIGNED_URL_TTL_S } from "@/lib/storage/paths";
import type { ServerSupabase } from "@/lib/supabase/server";
import type { MidiRow } from "@/lib/types/db";
import { basenameOf } from "./manifest";

/** A row whose object cannot be signed gets `download_url: null` rather than failing the list. */
export async function withDownloadUrls(supabase: ServerSupabase, rows: MidiRow[]): Promise<MidiWithUrl[]> {
  if (rows.length === 0) return [];
  // `download: true` makes the object answer with an attachment disposition:
  // the storage host is another origin, where an anchor's `download` is ignored.
  const signed = await supabase.storage.from(AUDIO_BUCKET).createSignedUrls(
    rows.map((r) => r.storage_path),
    SIGNED_URL_TTL_S,
    { download: true },
  );
  const byPath = new Map<string, string>();
  if (!signed.error && signed.data) {
    for (const item of signed.data) if (item.signedUrl && !item.error && item.path) byPath.set(item.path, item.signedUrl);
  }
  return rows.map((r) => ({ ...r, download_url: byPath.get(r.storage_path) ?? null, filename: basenameOf(r.storage_path) }));
}
