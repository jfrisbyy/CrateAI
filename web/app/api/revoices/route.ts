// POST /api/revoices { file_id, instrument, path, keep_groove?, notes? } — queue a `revoice` job
// with params exactly as analysis/lockedgroove/jobs/revoice.py reads them:
// { instrument, path, keep_groove, notes? }. `notes` (edited in the piano roll) makes the
// compute render without re-transcribing. The neural path is refused here with the compute's
// own reason (revoice/neural.py REASON) instead of queueing a job that fails with it.

import { z } from "zod";
import { INSTRUMENT_IDS, NEURAL_REASON } from "@/lib/api/revoice";
import type { JobResponse } from "@/lib/api/types";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, HttpError, json, parseBody, requireUser, UUID_RE } from "@/lib/http";
import type { Json } from "@/lib/types/db";

const noteSchema = z
  .object({
    pitch: z.number().int().min(0).max(127),
    start_s: z.number().min(0).max(36000),
    end_s: z.number().min(0).max(36000),
    velocity: z.number().int().min(1).max(127).optional(),
  })
  .refine((n) => n.end_s > n.start_s, { message: "end_s must be after start_s" });

const schema = z.object({
  file_id: z.string().regex(UUID_RE),
  instrument: z.string().refine((id) => INSTRUMENT_IDS.includes(id), { message: "unknown instrument" }),
  path: z.enum(["symbolic", "neural"]),
  keep_groove: z.boolean().optional(),
  notes: z.array(noteSchema).max(5000).optional(),
});

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = await parseBody(req, schema);
    if (body.path === "neural") throw new HttpError(400, NEURAL_REASON);

    const file = await supabase.from("files").select("id, status").eq("id", body.file_id).maybeSingle();
    if (file.error) throw dbError(file.error, "Loading the file");
    if (!file.data) throw new HttpError(404, "File not found.");
    if (file.data.status !== "ready") throw new HttpError(409, "Re-voice needs the file's analysis; wait for it to be ready.");

    const params: Record<string, Json> = { instrument: body.instrument, path: "symbolic", keep_groove: body.keep_groove ?? false };
    if (body.notes) params.notes = body.notes.map((n) => ({ pitch: n.pitch, start_s: n.start_s, end_s: n.end_s, velocity: n.velocity ?? 100 }));

    const job = await supabase
      .from("jobs")
      .insert({ user_id: user.id, file_id: body.file_id, kind: "revoice", status: "queued", params })
      .select("*")
      .single();
    if (job.error) throw dbError(job.error, "Queueing the re-voice");

    const dispatch = await dispatchJob(job.data.id, supabase);
    const response: JobResponse = { job: job.data, dispatch };
    return json(response, { status: 201 });
  });
}
