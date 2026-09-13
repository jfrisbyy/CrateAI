// POST /api/export/song — queue an `export` job for the arrangement in the body.
//
// The song lives in browser memory (docs/HANDOFF_timeline.md section 8: the
// persistence migration is written and nothing reads or writes those tables),
// so it travels in the request rather than being read from a table. That makes
// every file id in it caller input, and this route is where ownership is
// settled: each one is selected through the caller's own RLS client before the
// job row exists, so a job is never created against a record the caller cannot
// read. Compute checks again (row `user_id` and storage prefix) because a
// `files` row is a pointer; see docs/HANDOFF_export.md.
//
// Rendering a multi-minute multitrack arrangement is compute work, so this
// route does no audio: it writes a `jobs` row and dispatches it like every
// other job kind, and the usual quota check and `usage_events` metering apply
// through `dispatchJob` and the compute runner.

import type { JobResponse } from "@/lib/api/types";
import { dispatchJob } from "@/lib/compute/dispatch";
import { exportSongSchema, fileIdsOf, regionCount, songLengthS } from "@/lib/export/request";
import { capAdvice, estimateBytes, exportedTracks, formatBytes } from "@/lib/export/song";
import { EXPORT_CAP_BYTES, EXPORT_MAX_LENGTH_S } from "@/lib/export/types";
import { dbError, handle, HttpError, json, parseBody, requireUser } from "@/lib/http";
import type { Json } from "@/lib/types/db";

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = await parseBody(req, exportSongSchema);

    if (regionCount(body) === 0) throw new HttpError(409, "There is nothing on the timeline to export yet.");
    const lengthS = songLengthS(body);
    if (lengthS > EXPORT_MAX_LENGTH_S) {
      throw new HttpError(413, `The export takes at most ${EXPORT_MAX_LENGTH_S / 60} minutes; this song is ${(lengthS / 60).toFixed(1)}.`);
    }

    const audible = exportedTracks(body.song.tracks, body.include_muted);
    if (audible.length === 0) throw new HttpError(409, "Every lane is muted, so there is nothing to export.");

    // The same arithmetic the job uses, so a song that cannot be rendered is
    // refused now rather than after minutes of compute.
    const estimated = estimateBytes(audible.length, lengthS, body.sample_rate, body.bit_depth, body.format);
    if (estimated > EXPORT_CAP_BYTES) {
      throw new HttpError(
        413,
        `This export would be about ${formatBytes(estimated)}; the cap is ${formatBytes(EXPORT_CAP_BYTES)}. ${capAdvice(body.format, body.bit_depth)}`,
      );
    }

    // Ownership, under RLS: a file the caller cannot select does not come back.
    const fileIds = fileIdsOf(body);
    const { data: files, error } = await supabase.from("files").select("id").in("id", fileIds);
    if (error) throw dbError(error, "Loading the records the song is built from");
    const found = new Set((files ?? []).map((f) => f.id));
    const missing = fileIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new HttpError(404, `The song references ${missing.length} record${missing.length === 1 ? "" : "s"} you cannot open; it was not exported.`, missing);
    }

    let midiIds: string[] = [];
    if (body.midi_ids.length > 0) {
      const midi = await supabase.from("midi").select("id").in("id", body.midi_ids);
      if (midi.error) throw dbError(midi.error, "Loading the MIDI");
      const readable = new Set((midi.data ?? []).map((m) => m.id));
      midiIds = body.midi_ids.filter((id) => readable.has(id));
      if (midiIds.length !== body.midi_ids.length) {
        throw new HttpError(404, "The export references MIDI you cannot open; it was not exported.");
      }
    }

    const job = await supabase
      .from("jobs")
      .insert({
        user_id: user.id,
        file_id: null,
        kind: "export",
        status: "queued",
        params: {
          song: body.song,
          format: body.format,
          bit_depth: body.bit_depth,
          sample_rate: body.sample_rate,
          include_muted: body.include_muted,
          midi_ids: midiIds,
        } as unknown as Json,
      })
      .select("*")
      .single();
    if (job.error) throw dbError(job.error, "Queueing the export");

    const dispatch = await dispatchJob(job.data.id, supabase);
    const response: JobResponse = { job: job.data, dispatch };
    return json(response, { status: 201 });
  });
}
