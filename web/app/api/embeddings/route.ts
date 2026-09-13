// GET  /api/embeddings — which of the caller's ready files carry a CLAP
//      embedding: { embedded_count, ready_count, missing_file_ids }.
// POST /api/embeddings { file_ids? } — queue an `embed` job for each ready
//      file without one (all of them when file_ids is omitted, capped), the
//      same way POST /api/jobs { kind: "embed" } does, skipping files that
//      already have an embed job queued or running.

import { z } from "zod";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, json, parseBody, requireUser, UUID_RE } from "@/lib/http";
import type { JobRow } from "@/lib/types/db";

const MAX_QUEUE = 200;

async function missingFileIds(supabase: Awaited<ReturnType<typeof requireUser>>["supabase"]): Promise<{ ready: string[]; embedded: Set<string> }> {
  const [files, embeddings] = await Promise.all([
    supabase.from("files").select("id").eq("status", "ready").limit(5000),
    supabase.from("embeddings").select("file_id").limit(5000),
  ]);
  if (files.error) throw dbError(files.error, "Listing files");
  if (embeddings.error) throw dbError(embeddings.error, "Listing embeddings");
  return { ready: files.data.map((f) => f.id), embedded: new Set(embeddings.data.map((e) => e.file_id)) };
}

export async function GET() {
  return handle(async () => {
    const { supabase } = await requireUser();
    const { ready, embedded } = await missingFileIds(supabase);
    const missing = ready.filter((id) => !embedded.has(id));
    return json({ embedded_count: ready.length - missing.length, ready_count: ready.length, missing_file_ids: missing });
  });
}

const schema = z.object({
  file_ids: z.array(z.string().regex(UUID_RE)).max(MAX_QUEUE).optional(),
});

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = req.headers.get("content-length") === "0" ? {} : await parseBody(req, schema);
    const { ready, embedded } = await missingFileIds(supabase);
    const wanted = body.file_ids ? body.file_ids.filter((id) => ready.includes(id)) : ready.filter((id) => !embedded.has(id));
    const targets = wanted.slice(0, MAX_QUEUE);

    const inFlight = await supabase.from("jobs").select("file_id").eq("kind", "embed").in("status", ["queued", "running"]).limit(5000);
    if (inFlight.error) throw dbError(inFlight.error, "Listing embed jobs");
    const busy = new Set(inFlight.data.map((j) => j.file_id));

    const queued: JobRow[] = [];
    let skipped = 0;
    let dispatchFailures = 0;
    for (const fileId of targets) {
      if (busy.has(fileId)) {
        skipped++;
        continue;
      }
      const job = await supabase
        .from("jobs")
        .insert({ user_id: user.id, file_id: fileId, kind: "embed", status: "queued", params: {} })
        .select("*")
        .single();
      if (job.error) throw dbError(job.error, "Queueing the embed job");
      const dispatch = await dispatchJob(job.data.id, supabase);
      if (!dispatch.ok) dispatchFailures++;
      queued.push(job.data);
    }
    return json({ queued, skipped, dispatch_failures: dispatchFailures }, { status: 201 });
  });
}
