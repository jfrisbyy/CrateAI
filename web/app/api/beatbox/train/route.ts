// POST /api/beatbox/train { examples: [{ class, storage_path }] } — queue `beatbox_train`
// (CONTRACTS section 5). Every path must be one of the caller's own beatbox recordings.

import { z } from "zod";
import type { JobResponse } from "@/lib/api/types";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, HttpError, json, parseBody, requireUser } from "@/lib/http";
import { ownRecordingPath } from "../paths";

const CLASS_RE = /^[a-z][a-z0-9_]{0,31}$/;

const schema = z.object({
  examples: z
    .array(z.object({ class: z.string().regex(CLASS_RE, "class must be a short lowercase word"), storage_path: z.string().min(1).max(300) }))
    .min(1)
    .max(200),
});

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = await parseBody(req, schema);
    for (const ex of body.examples) {
      if (!ownRecordingPath(ex.storage_path, user.id)) throw new HttpError(400, "Every recording must come from your beatbox uploads.");
    }
    const classes = new Set(body.examples.map((e) => e.class));
    if (classes.size < 2) throw new HttpError(400, "Record at least two classes before training.");

    const job = await supabase
      .from("jobs")
      .insert({ user_id: user.id, file_id: null, kind: "beatbox_train", status: "queued", params: { examples: body.examples } })
      .select("*")
      .single();
    if (job.error) throw dbError(job.error, "Queueing the training");

    const dispatch = await dispatchJob(job.data.id, supabase);
    const response: JobResponse = { job: job.data, dispatch };
    return json(response, { status: 201 });
  });
}
