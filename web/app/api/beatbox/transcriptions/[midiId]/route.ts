// PATCH /api/beatbox/transcriptions/[midiId] { corrections: [{ hit_index, corrected_class }] }
// Stores the user's class corrections into the midi row's notes JSON (the whole list replaces
// the previous one). Principle 7: they are ground truth for the next enrollment; the compute
// side reads `notes.corrections` when it retrains (a hook noted in the handoff).

import { z } from "zod";
import type { TranscriptionResponse } from "@/lib/api/beatbox";
import { dbError, handle, HttpError, json, parseBody, requireUser, requireUuid } from "@/lib/http";
import type { Json } from "@/lib/types/db";

const CLASS_RE = /^[a-z][a-z0-9_]{0,31}$/;

const schema = z.object({
  corrections: z.array(z.object({ hit_index: z.number().int().min(0), corrected_class: z.string().regex(CLASS_RE) })).max(2000),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ midiId: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).midiId, "transcription id");
    const body = await parseBody(req, schema);

    const midi = await supabase.from("midi").select("*").eq("id", id).eq("kind", "beatbox").maybeSingle();
    if (midi.error) throw dbError(midi.error, "Loading the transcription");
    if (!midi.data) throw new HttpError(404, "Transcription not found.");
    const notes = midi.data.notes;
    const base: { [key: string]: Json | undefined } = notes && typeof notes === "object" && !Array.isArray(notes) ? { ...notes } : {};
    const hitCount = Array.isArray(base.hits) ? base.hits.length : null;
    const seen = new Set<number>();
    for (const c of body.corrections) {
      if (hitCount !== null && c.hit_index >= hitCount) throw new HttpError(400, `hit_index ${c.hit_index} is past the last hit (${hitCount - 1}).`);
      if (seen.has(c.hit_index)) throw new HttpError(400, `hit_index ${c.hit_index} appears twice.`);
      seen.add(c.hit_index);
    }
    const next: Json = { ...base, corrections: body.corrections, corrected_at: new Date().toISOString() };

    const updated = await supabase.from("midi").update({ notes: next }).eq("id", id).select("*").single();
    if (updated.error) throw dbError(updated.error, "Saving the corrections");
    const response: TranscriptionResponse = { midi: updated.data };
    return json(response);
  });
}
