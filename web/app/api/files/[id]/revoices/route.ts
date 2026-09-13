// GET /api/files/[id]/revoices — the file's re-voices, newest first, each with its MIDI row
// (notes JSON the piano roll edits) and its render file (status, duration).

import type { RenderFileLite, RevoiceDetail, RevoicesListResponse } from "@/lib/api/revoice";
import { dbError, handle, json, requireUser, requireUuid } from "@/lib/http";
import type { MidiRow } from "@/lib/types/db";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const fileId = requireUuid((await ctx.params).id, "file id");
    const revoices = await supabase.from("revoices").select("*").eq("source_file_id", fileId).order("created_at", { ascending: false }).limit(100);
    if (revoices.error) throw dbError(revoices.error, "Listing re-voices");

    const midiIds = revoices.data.map((r) => r.midi_id).filter((x): x is string => x !== null);
    const renderIds = revoices.data.map((r) => r.render_file_id).filter((x): x is string => x !== null);
    const [midi, renders] = await Promise.all([
      midiIds.length ? supabase.from("midi").select("*").in("id", midiIds) : Promise.resolve({ data: [] as MidiRow[], error: null }),
      renderIds.length
        ? supabase.from("files").select("id, original_filename, status, duration_s, kind").in("id", renderIds)
        : Promise.resolve({ data: [] as RenderFileLite[], error: null }),
    ]);
    if (midi.error) throw dbError(midi.error, "Loading the MIDI");
    if (renders.error) throw dbError(renders.error, "Loading the renders");
    const midiById = new Map(midi.data.map((m) => [m.id, m]));
    const renderById = new Map(renders.data.map((f) => [f.id, f]));
    const list: RevoiceDetail[] = revoices.data.map((revoice) => ({
      revoice,
      midi: revoice.midi_id ? (midiById.get(revoice.midi_id) ?? null) : null,
      render: revoice.render_file_id ? (renderById.get(revoice.render_file_id) ?? null) : null,
    }));
    const response: RevoicesListResponse = { revoices: list };
    return json(response);
  });
}
