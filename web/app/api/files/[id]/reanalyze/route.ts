// POST /api/files/[id]/reanalyze { stages? } — queue `analyze` with a newer
// analysis_version so compute's idempotency check lets it run again. With
// `stages`, only those report sections are recomputed (compute merges them
// into the existing report via base_report; see docs/HANDOFF_web.md).

import { z } from "zod";
import type { JobResponse } from "@/lib/api/types";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, HttpError, json, parseBody, requireUser, requireUuid } from "@/lib/http";
import { REPORT_SECTIONS } from "@/lib/types/report";

const schema = z.object({
  stages: z.array(z.enum([...REPORT_SECTIONS, "tags"])).min(1).max(20).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const id = requireUuid((await ctx.params).id, "file id");
    const body = req.headers.get("content-length") === "0" ? {} : await parseBody(req, schema).catch(() => ({}) as z.infer<typeof schema>);

    const { data: file, error } = await supabase.from("files").select("id, analysis_version, status").eq("id", id).maybeSingle();
    if (error) throw dbError(error, "Loading the file");
    if (!file) throw new HttpError(404, "File not found.");

    const params: Record<string, unknown> = { analysis_version: file.analysis_version + 1 };
    if (body.stages) params.stages = body.stages;

    const job = await supabase
      .from("jobs")
      .insert({ user_id: user.id, file_id: id, kind: "analyze", status: "queued", params: params as never })
      .select("*")
      .single();
    if (job.error) throw dbError(job.error, "Queueing analysis");

    if (file.status === "ready" || file.status === "failed") {
      await supabase.from("files").update({ status: "queued" }).eq("id", id);
    }

    const dispatch = await dispatchJob(job.data.id, supabase);
    const response: JobResponse = { job: job.data, dispatch };
    return json(response, { status: 201 });
  });
}
