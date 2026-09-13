// POST /api/beatbox/upload-url { name } — a signed upload URL for one recording at
// library/{user_id}/beatbox/{safe name}.wav|webm (the only place the admin client is used on
// this surface; the token authorizes exactly that object). Without a service role key the
// caller's own client signs it, which the storage insert policy on library/{uid}/ also allows.

import { z } from "zod";
import type { UploadUrlResponse } from "@/lib/api/beatbox";
import { handle, HttpError, json, parseBody, requireUser } from "@/lib/http";
import { AUDIO_BUCKET } from "@/lib/storage/paths";
import { tryAdminClient } from "@/lib/supabase/admin";
import { recordingPath, safeRecordingName } from "../paths";

const schema = z.object({ name: z.string().trim().min(1).max(120) });

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = await parseBody(req, schema);
    const safe = safeRecordingName(body.name);
    if (!safe) throw new HttpError(400, "The recording name must end in .wav or .webm.");
    const storagePath = recordingPath(user.id, safe);

    const client = tryAdminClient() ?? supabase;
    const signed = await client.storage.from(AUDIO_BUCKET).createSignedUploadUrl(storagePath);
    if (signed.error || !signed.data) throw new HttpError(500, `Could not sign the upload: ${signed.error?.message ?? "unknown error"}`);
    const response: UploadUrlResponse = { storage_path: storagePath, signed_url: signed.data.signedUrl, token: signed.data.token };
    return json(response, { status: 201, headers: { "cache-control": "private, no-store" } });
  });
}
