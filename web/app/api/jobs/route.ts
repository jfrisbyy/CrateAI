// POST /api/jobs { kind, file_id?, params } — create and dispatch any job kind.

import { z } from "zod";
import type { JobResponse } from "@/lib/api/types";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, HttpError, json, parseBody, requireUser, UUID_RE } from "@/lib/http";
import { JOB_KINDS, type Json } from "@/lib/types/db";

const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonSchema), z.record(z.string(), jsonSchema)]),
);

const schema = z.object({
  kind: z.enum(JOB_KINDS),
  file_id: z.string().regex(UUID_RE).nullable().optional(),
  params: z.record(z.string(), jsonSchema).optional(),
});

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = await parseBody(req, schema);

    if (body.file_id) {
      const { data: file, error } = await supabase.from("files").select("id").eq("id", body.file_id).maybeSingle();
      if (error) throw dbError(error, "Loading the file");
      if (!file) throw new HttpError(404, "File not found.");
    }

    const job = await supabase
      .from("jobs")
      .insert({
        user_id: user.id,
        file_id: body.file_id ?? null,
        kind: body.kind,
        status: "queued",
        params: (body.params ?? {}) as Json,
      })
      .select("*")
      .single();
    if (job.error) throw dbError(job.error, "Creating the job");

    const dispatch = await dispatchJob(job.data.id, supabase);
    const response: JobResponse = { job: job.data, dispatch };
    return json(response, { status: 201 });
  });
}
