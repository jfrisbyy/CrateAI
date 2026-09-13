// GET /api/export/[id]/download — the finished zip, streamed to the caller.
//
// `[id]` is the export job's id. The zip is a derived artefact under the
// caller's own prefix (`derived/{user_id}/bundles/{job_id}.zip`, CONTRACTS
// section 2) and is downloaded by the creating user only (principle 6).
//
// **It is fetched with the caller's client, never the service role.** The kit
// export once fetched with the service role and trusted the path on the row,
// which made it possible to serve another user's audio by writing a path by
// hand. Here the row is the caller's *job*, the path comes off its result, and
// the storage policy — which only lets a user read `derived/{their id}/` — is
// what actually decides. A path that is not theirs fails at storage, not at a
// check someone can forget to write.

import { dbError, handle, HttpError, requireUser, requireUuid } from "@/lib/http";
import type { ExportJobResult } from "@/lib/export/types";
import { AUDIO_BUCKET } from "@/lib/storage/paths";

function resultOf(raw: unknown): ExportJobResult | null {
  if (!raw || typeof raw !== "object") return null;
  const result = raw as Partial<ExportJobResult>;
  if (typeof result.storage_path !== "string" || typeof result.filename !== "string") return null;
  return result as ExportJobResult;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const id = requireUuid((await ctx.params).id, "export id");

    const { data: job, error } = await supabase.from("jobs").select("id, kind, status, error, result").eq("id", id).maybeSingle();
    if (error) throw dbError(error, "Loading the export");
    if (!job || job.kind !== "export") throw new HttpError(404, "Export not found.");
    if (job.status === "failed") throw new HttpError(409, job.error ?? "The export failed.");
    if (job.status !== "done") throw new HttpError(409, "The export is still rendering.");

    const result = resultOf(job.result);
    if (!result) throw new HttpError(500, "The export finished without a file.");

    // Belt as well as braces: the path compute wrote should be the caller's own
    // prefix, and a mismatch means something is wrong upstream, not that we
    // should try the fetch anyway.
    if (!result.storage_path.startsWith(`derived/${user.id}/`)) {
      throw new HttpError(403, "That export does not belong to you.");
    }

    const downloaded = await supabase.storage.from(AUDIO_BUCKET).download(result.storage_path);
    if (downloaded.error || !downloaded.data) {
      throw new HttpError(502, `Could not fetch the export: ${downloaded.error?.message ?? "no data"}`);
    }
    const bytes = new Uint8Array(await downloaded.data.arrayBuffer());

    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-length": String(bytes.byteLength),
        "content-disposition": `attachment; filename="${result.filename.replace(/[^A-Za-z0-9._-]/g, "-")}"`,
        "cache-control": "private, no-store",
      },
    });
  });
}
