// POST /api/midi/pads { file_id, bpm, bars, beats_per_bar?, hits } — a pads
// recording as a .mid: one note per hit at its measured time (pitch 36 + pad),
// tempo meta from bpm. The bytes go to derived/{user}/{file}/midi/pads-{ts}.mid
// with the admin storage client (users cannot write under derived/); the
// `midi` row is inserted under RLS with the caller's client.

import { z } from "zod";
import type { PadsMidiResponse } from "@/lib/api/midi";
import { dbError, handle, HttpError, json, parseBody, requireUser, UUID_RE } from "@/lib/http";
import { withDownloadUrls } from "@/lib/midi/download";
import { padHitsToNotesJson, writePadsMidi } from "@/lib/midi/writer";
import { AUDIO_BUCKET, derivedPrefix } from "@/lib/storage/paths";
import { tryAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/types/db";

const MAX_HITS = 4096;

const schema = z.object({
  file_id: z.string().regex(UUID_RE),
  bpm: z.number().min(20).max(400),
  bars: z.number().int().min(1).max(256),
  beats_per_bar: z.number().int().min(1).max(12).optional(),
  hits: z
    .array(
      z.object({
        time_s: z.number().min(-1).max(60 * 60),
        pad: z.number().int().min(0).max(15),
        chop_file_id: z.string().regex(UUID_RE).nullable(),
        velocity: z.number().min(0).max(1),
      }),
    )
    .min(1)
    .max(MAX_HITS),
});

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = await parseBody(req, schema);
    const admin = tryAdminClient();
    if (!admin) throw new HttpError(503, "SUPABASE_SERVICE_ROLE_KEY is not set; saving MIDI needs it to write the file.");

    const { data: file, error } = await supabase.from("files").select("id").eq("id", body.file_id).maybeSingle();
    if (error) throw dbError(error, "Loading the file");
    if (!file) throw new HttpError(404, "File not found.");

    const beatsPerBar = body.beats_per_bar ?? 4;
    const bytes = writePadsMidi(body.hits, { bpm: body.bpm, beatsPerBar, name: "pads" });
    const storagePath = `${derivedPrefix(user.id, file.id)}/midi/pads-${Date.now()}.mid`;
    const uploaded = await admin.storage.from(AUDIO_BUCKET).upload(storagePath, bytes, { contentType: "audio/midi", upsert: false });
    if (uploaded.error) throw new HttpError(500, `Could not store the MIDI file: ${uploaded.error.message}`);

    const notes: Json = {
      notes: padHitsToNotesJson(body.hits, body.bpm, beatsPerBar) as unknown as Json,
      meta: { bpm: body.bpm, source: "pads", beats_per_bar: beatsPerBar, bars: body.bars, quantized: false },
      hits: body.hits as unknown as Json,
    };
    const inserted = await supabase
      .from("midi")
      .insert({ user_id: user.id, source_file_id: file.id, kind: "drums", storage_path: storagePath, notes })
      .select("*")
      .single();
    if (inserted.error) {
      await admin.storage.from(AUDIO_BUCKET).remove([storagePath]);
      throw dbError(inserted.error, "Saving the MIDI row");
    }

    const [row] = await withDownloadUrls(supabase, [inserted.data]);
    const response: PadsMidiResponse = { midi: row ?? { ...inserted.data, download_url: null, filename: storagePath.split("/").pop() ?? "pads.mid" } };
    return json(response, { status: 201 });
  });
}
