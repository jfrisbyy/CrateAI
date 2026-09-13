// POST /api/files/prepare — dedupe check before any bytes move.
// { sha256, filename, size_bytes, content_type }
//   -> { status: "exists", file } | { status: "upload", storage_path }

import { z } from "zod";
import type { PrepareResponse } from "@/lib/api/types";
import { checkStorageQuota } from "@/lib/billing/quota";
import { getUsage } from "@/lib/billing/usage";
import { handle, HttpError, json, parseBody, requireUser } from "@/lib/http";
import { extensionOf, libraryPath, SHA256_RE } from "@/lib/storage/paths";
import { AUDIO_EXTENSIONS } from "@/lib/upload/fs";

const schema = z.object({
  sha256: z.string().regex(SHA256_RE, "sha256 must be 64 hex characters"),
  filename: z.string().min(1).max(512),
  size_bytes: z.number().int().min(0).max(2 * 1024 * 1024 * 1024),
  content_type: z.string().max(128),
});

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = await parseBody(req, schema);

    const ext = extensionOf(body.filename);
    if (!(AUDIO_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new HttpError(415, `Only audio files can be uploaded (${AUDIO_EXTENSIONS.join(", ")}).`);
    }

    const { data: existing, error } = await supabase
      .from("files")
      .select("*")
      .eq("sha256", body.sha256)
      .maybeSingle();
    if (error) throw new HttpError(500, `Could not check the library: ${error.message}`);

    if (!existing) {
      const decision = checkStorageQuota(await getUsage(supabase, user.id), body.size_bytes);
      if (!decision.ok) throw new HttpError(413, decision.reason);
    }
    const response: PrepareResponse = existing
      ? { status: "exists", file: existing }
      : { status: "upload", storage_path: libraryPath(user.id, body.sha256, ext) };
    return json(response);
  });
}
