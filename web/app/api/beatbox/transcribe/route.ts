// POST /api/beatbox/transcribe { recording_path, grid_file_id?, bpm? } — queue
// `beatbox_transcribe` (CONTRACTS section 5) against the caller's profile. The grid comes
// from a chosen file's effective beats or from a free tempo; one of the two is required.

import { z } from "zod";
import type { JobResponse } from "@/lib/api/types";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, HttpError, json, parseBody, requireUser, UUID_RE } from "@/lib/http";
import type { Json } from "@/lib/types/db";
import { ownRecordingPath } from "../paths";

const schema = z
  .object({
    recording_path: z.string().min(1).max(300),
    grid_file_id: z.string().regex(UUID_RE).optional(),
    bpm: z.number().min(30).max(300).optional(),
  })
  .refine((v) => v.grid_file_id !== undefined || v.bpm !== undefined, { message: "Choose a free tempo (bpm) or a file's grid (grid_file_id)." });

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = await parseBody(req, schema);
    if (!ownRecordingPath(body.recording_path, user.id)) throw new HttpError(400, "The recording must come from your beatbox uploads.");

    const profile = await supabase.from("beatbox_profiles").select("enabled").eq("user_id", user.id).maybeSingle();
    if (profile.error) throw dbError(profile.error, "Loading the beatbox profile");
    if (!profile.data) throw new HttpError(409, "No beatbox profile yet; enroll your kick, snare and hat first.");
    if (!profile.data.enabled) throw new HttpError(409, "Your beatbox profile is under 85% accuracy; record more examples before transcribing.");

    if (body.grid_file_id) {
      const file = await supabase.from("files").select("id, status, report").eq("id", body.grid_file_id).maybeSingle();
      if (file.error) throw dbError(file.error, "Loading the grid file");
      if (!file.data) throw new HttpError(404, "Grid file not found.");
      if (file.data.status !== "ready" || !file.data.report) throw new HttpError(409, "That file has no beat grid yet; analyze it first.");
    }

    const params: Record<string, Json> = { recording_path: body.recording_path };
    if (body.grid_file_id) params.grid_file_id = body.grid_file_id;
    if (body.bpm !== undefined) params.bpm = body.bpm;

    const job = await supabase
      .from("jobs")
      .insert({ user_id: user.id, file_id: null, kind: "beatbox_transcribe", status: "queued", params })
      .select("*")
      .single();
    if (job.error) throw dbError(job.error, "Queueing the transcription");

    const dispatch = await dispatchJob(job.data.id, supabase);
    const response: JobResponse = { job: job.data, dispatch };
    return json(response, { status: 201 });
  });
}
