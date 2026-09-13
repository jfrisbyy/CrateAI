// GET /api/revoices/[id] — one re-voice with its MIDI row (the editable notes) and its render file.

import type { RevoiceResponse } from "@/lib/api/revoice";
import { dbError, handle, HttpError, json, requireUser, requireUuid } from "@/lib/http";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "re-voice id");
    const revoice = await supabase.from("revoices").select("*").eq("id", id).maybeSingle();
    if (revoice.error) throw dbError(revoice.error, "Loading the re-voice");
    if (!revoice.data) throw new HttpError(404, "Re-voice not found.");

    const [midi, render] = await Promise.all([
      revoice.data.midi_id ? supabase.from("midi").select("*").eq("id", revoice.data.midi_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
      revoice.data.render_file_id
        ? supabase.from("files").select("id, original_filename, status, duration_s, kind").eq("id", revoice.data.render_file_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (midi.error) throw dbError(midi.error, "Loading the MIDI");
    if (render.error) throw dbError(render.error, "Loading the render");
    const response: RevoiceResponse = { revoice: revoice.data, midi: midi.data ?? null, render: render.data ?? null };
    return json(response);
  });
}
