// GET  /api/files/[id]/midi — the file's midi rows, newest first, each with a
//      10-minute signed download URL.
// POST /api/files/[id]/midi { kind } — queue a compute `midi` job
//      (melody | drums | chords | groove) and dispatch it.

import { z } from "zod";
import { MIDI_EXTRACT_KIND_IDS, type MidiListResponse } from "@/lib/api/midi";
import type { JobResponse } from "@/lib/api/types";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, HttpError, json, parseBody, requireUser, requireUuid } from "@/lib/http";
import { withDownloadUrls } from "@/lib/midi/download";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "file id");
    const { data, error } = await supabase.from("midi").select("*").eq("source_file_id", id).order("created_at", { ascending: false }).limit(200);
    if (error) throw dbError(error, "Listing MIDI");
    const response: MidiListResponse = { midi: await withDownloadUrls(supabase, data) };
    return json(response, { headers: { "cache-control": "private, no-store" } });
  });
}

const extractSchema = z.object({ kind: z.enum(MIDI_EXTRACT_KIND_IDS) });

export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const id = requireUuid((await ctx.params).id, "file id");
    const body = await parseBody(req, extractSchema);

    const { data: file, error } = await supabase.from("files").select("id, status, report").eq("id", id).maybeSingle();
    if (error) throw dbError(error, "Loading the file");
    if (!file) throw new HttpError(404, "File not found.");
    if (file.report === null) throw new HttpError(409, "MIDI extraction needs the tempo and grid; analyze the file first.");

    const job = await supabase
      .from("jobs")
      .insert({ user_id: user.id, file_id: id, kind: "midi", status: "queued", params: { kind: body.kind } })
      .select("*")
      .single();
    if (job.error) throw dbError(job.error, "Queueing MIDI extraction");

    const dispatch = await dispatchJob(job.data.id, supabase);
    const response: JobResponse = { job: job.data, dispatch };
    return json(response, { status: 201 });
  });
}
