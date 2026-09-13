// POST /api/files/complete — after the tus upload: insert the files row
// (status queued), insert an analyze job, dispatch. Returns { file, job, dispatch }.

import { z } from "zod";
import type { CompleteResponse } from "@/lib/api/types";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, HttpError, json, parseBody, requireUser } from "@/lib/http";
import { AUDIO_BUCKET, extensionOf, libraryPath, SHA256_RE } from "@/lib/storage/paths";
import { AUDIO_EXTENSIONS } from "@/lib/upload/fs";

const schema = z.object({
  sha256: z.string().regex(SHA256_RE),
  storage_path: z.string().min(1).max(1024),
  original_filename: z.string().min(1).max(512),
  size_bytes: z.number().int().min(0),
  content_type: z.string().max(128),
});

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = await parseBody(req, schema);

    const ext = extensionOf(body.original_filename);
    if (!(AUDIO_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new HttpError(415, "Only audio files can be added to the library.");
    }
    // The path is derived from the caller and the hash; never trust a free-form one.
    const expectedPath = libraryPath(user.id, body.sha256, ext);
    if (body.storage_path !== expectedPath) {
      throw new HttpError(400, "storage_path does not match this file's hash.");
    }

    // The object must actually be there (RLS: only the owner can sign it).
    const signed = await supabase.storage.from(AUDIO_BUCKET).createSignedUrl(expectedPath, 60);
    if (signed.error) {
      throw new HttpError(409, "The upload did not finish; nothing is stored at that path yet.", signed.error.message);
    }

    const inserted = await supabase
      .from("files")
      .insert({
        user_id: user.id,
        sha256: body.sha256,
        original_filename: body.original_filename,
        storage_path: expectedPath,
        size_bytes: body.size_bytes,
        format: ext,
        kind: "original",
        status: "queued",
      })
      .select("*")
      .single();

    if (inserted.error) {
      if (inserted.error.code === "23505") {
        // Already in the library (a retry after a lost response): return it.
        const { data: existing } = await supabase.from("files").select("*").eq("sha256", body.sha256).single();
        if (existing) {
          const response: CompleteResponse = { file: existing, job: null, dispatch: null };
          return json(response);
        }
      }
      throw dbError(inserted.error, "Adding the file");
    }
    const file = inserted.data;

    const job = await supabase
      .from("jobs")
      .insert({ user_id: user.id, file_id: file.id, kind: "analyze", status: "queued", params: {} })
      .select("*")
      .single();
    if (job.error) throw dbError(job.error, "Queueing analysis");

    const dispatch = await dispatchJob(job.data.id, supabase);
    const response: CompleteResponse = { file, job: job.data, dispatch };
    return json(response, { status: 201 });
  });
}
