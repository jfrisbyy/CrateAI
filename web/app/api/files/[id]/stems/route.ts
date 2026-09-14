// GET  /api/files/[id]/stems — the file's stems rows, each with its stem file
//      (id, kind, status, duration, vitals from the effective report).
// POST /api/files/[id]/stems { stems?, model? } — queue a `stems` job
//      (CONTRACTS section 5) and dispatch it. One in-flight separation per
//      split per file.
//
// The request names the *split* it wants, not a model. Separation is the
// irreversible step and the registry in analysis/lockedgroove/stems/separate.py
// is ordered by quality, so the best separator that makes those stems should
// run — and only the worker knows which checkpoints are installed in its image.
// This route used to require a model id from a hard-coded list of three, which
// meant that ordering never ran for a request from the tab. `model` survives as
// the escape hatch for a producer who wants a specific separator; the worker
// honours it and reports in the job result when something better was there.

import { z } from "zod";
import type { JobResponse } from "@/lib/api/types";
import { describeStems, splitFor, stemsAskKey, stemsAskOf, summarizeFile, type DerivedFileSummary, type StemsListResponse } from "@/lib/api/stems";
import { ALL_STEMS, DEFAULT_STEMS, STEM_MODELS } from "@/lib/types/stemModels";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, HttpError, json, parseBody, requireUser, requireUuid } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "file id");
    const { data: stems, error } = await supabase.from("stems").select("*").eq("file_id", id).order("created_at", { ascending: true });
    if (error) throw dbError(error, "Listing stems");

    const byId = new Map<string, DerivedFileSummary>();
    const fileIds = [...new Set(stems.map((s) => s.stem_file_id))];
    if (fileIds.length > 0) {
      const files = await supabase.from("files").select("id, kind, status, duration_s, original_filename, report").in("id", fileIds);
      if (files.error) throw dbError(files.error, "Loading the stem files");
      for (const f of files.data) byId.set(f.id, summarizeFile(f));
    }
    const response: StemsListResponse = { stems: stems.map((s) => ({ ...s, file: byId.get(s.stem_file_id) ?? null })) };
    return json(response, { headers: { "cache-control": "private, no-store" } });
  });
}

const MODEL_IDS = STEM_MODELS.map((m) => m.id) as [string, ...string[]];
const STEM_NAMES = ALL_STEMS as unknown as [string, ...string[]];

const separateSchema = z.object({
  stems: z.array(z.enum(STEM_NAMES)).min(1).max(ALL_STEMS.length).optional(),
  model: z.enum(MODEL_IDS).optional(),
});

export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const id = requireUuid((await ctx.params).id, "file id");
    const body = await parseBody(req, separateSchema);
    // Naming a model means "give me what that model gives"; the default split
    // is only the default when nothing was named. Defaulting both ways round
    // would queue `bs_roformer` against a request for drums and bass, which the
    // worker can only refuse.
    const spec = body.model ? STEM_MODELS.find((m) => m.id === body.model)! : null;
    const explicit = body.stems ? [...new Set(body.stems)] : null;
    const wanted = explicit ?? (spec ? [...spec.stems] : [...DEFAULT_STEMS]);

    if (spec) {
      const missing = wanted.filter((x) => !spec.stems.includes(x));
      if (missing.length > 0) {
        throw new HttpError(400, `${spec.id} does not produce ${describeStems(missing)}; it returns ${describeStems(spec.stems)}.`);
      }
    } else if (!splitFor(wanted)) {
      // Not every subset is a split some decent separator makes. Say which are,
      // rather than queueing a job the worker will refuse.
      throw new HttpError(400, `No separator produces exactly ${describeStems(wanted)}. Ask for ${describeStems(DEFAULT_STEMS)}, or vocals and instrumental, or the six-stem split.`);
    }

    const { data: file, error } = await supabase.from("files").select("id, status").eq("id", id).maybeSingle();
    if (error) throw dbError(error, "Loading the file");
    if (!file) throw new HttpError(404, "File not found.");
    if (file.status === "uploading") throw new HttpError(409, "The upload has not finished.");

    const inFlight = await supabase
      .from("jobs")
      .select("id, params")
      .eq("file_id", id)
      .eq("kind", "stems")
      .in("status", ["queued", "running"])
      .limit(20);
    if (inFlight.error) throw dbError(inFlight.error, "Checking running jobs");

    // De-duplicate on the split, not on the model: the model is the worker's
    // choice now, so the client cannot key on it. A request that names a model
    // is its own key, so asking for the reference separator by name while the
    // default one runs is allowed.
    const key = stemsAskKey({ stems: spec ? null : wanted, model: spec?.id ?? null });
    const running = inFlight.data.find((j) => stemsAskKey(stemsAskOf(j.params)) === key);
    if (running) {
      throw new HttpError(409, spec
        ? `Separation with ${spec.id} is already queued for this file.`
        : `A ${describeStems(wanted)} separation is already queued for this file.`);
    }

    const job = await supabase
      .from("jobs")
      .insert({
        user_id: user.id,
        file_id: id,
        kind: "stems",
        status: "queued",
        // `stems` rides along only when it was actually asked for: a bare
        // `model` lets the worker use that model's own outputs.
        params: spec ? (explicit ? { model: spec.id, stems: wanted } : { model: spec.id }) : { stems: wanted },
      })
      .select("*")
      .single();
    if (job.error) throw dbError(job.error, "Queueing the separation");

    const dispatch = await dispatchJob(job.data.id, supabase);
    const response: JobResponse = { job: job.data, dispatch };
    return json(response, { status: 201 });
  });
}
